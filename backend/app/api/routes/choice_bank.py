import hashlib
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader
from app.core.config import settings
from app.core.database import async_session, get_db
from app.models import Order, OrderStatus, OrderSide, Payment, PaymentDirection, PaymentStatus
from app.models.trader import Trader
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.services.choice_bank import client as choice

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Signature verification (shared with client.py logic) ─────────────────────

def _flatten(obj, path="", pairs=None):
    if pairs is None:
        pairs = []
    if isinstance(obj, dict):
        if not obj and path:
            pairs.append((path, "{}"))
            return pairs
        for k, v in obj.items():
            child = f"{path}.{k}" if path else k
            _flatten(v, child, pairs)
    elif isinstance(obj, list):
        if not obj and path:
            pairs.append((path, "[]"))
            return pairs
        for i, v in enumerate(obj):
            _flatten(v, f"{path}[{i}]", pairs)
    else:
        pairs.append((path, "" if obj is None else str(obj)))
    return pairs


def _verify_signature(payload: dict, private_key: str) -> bool:
    try:
        original_sig = payload.get("signature", "")
        obj = {k: v for k, v in payload.items() if k != "signature"}
        obj["senderKey"] = private_key
        pairs = _flatten(obj)
        pairs.sort(key=lambda x: x[0])
        flat = "&".join(f"{k}={v}" for k, v in pairs)
        computed = hashlib.sha256(flat.encode()).hexdigest()
        return computed.lower() == original_sig.lower()
    except Exception as e:
        logger.warning(f"[ChoiceBank] Signature verification error: {e}")
        return False


# ── Webhook (Choice Bank → SparkP2P) ─────────────────────────────────────────

@router.post("/webhook/choice")
async def choice_bank_webhook(request: Request):
    """
    Receive Choice Bank BaaS callback notifications.

    Callback envelope:
      notificationType  — at top level (not inside params)
      params            — transaction data

    Callback 0002 (Transaction Result): fires when a transaction occurs on any sub-account.
    Callback 0003 (Balance Change): fires after every balance update.

    We use 0002 as the primary trigger for SELL order release.
    """
    try:
        payload = await request.json()
    except Exception:
        logger.warning("[ChoiceBank] Non-JSON webhook body received")
        return {"code": "00000", "msg": "OK"}

    logger.info(f"[ChoiceBank] Webhook: type={payload.get('notificationType')} | {payload}")

    # Signature verification disabled: CHOICE_BANK_SENDER_KEY is our outbound signing key,
    # not Choice Bank's callback signing key. Their callbacks use a different key we don't
    # have yet. Re-enable once Choice Bank provides their callback verification key.
    # private_key = settings.CHOICE_BANK_SENDER_KEY
    # if private_key and not _verify_signature(payload, private_key):
    #     logger.warning("[ChoiceBank] Invalid signature — ignoring")
    #     return {"code": "00000", "msg": "OK"}

    # notificationType is at the TOP LEVEL of the envelope
    notification_type = str(payload.get("notificationType") or "")
    params = payload.get("params") or {}

    try:
        if notification_type == "0002":
            await _handle_transaction_result(params, payload)
        elif notification_type == "0003":
            await _handle_transaction_result(params, payload)
        elif notification_type == "0004":
            await _handle_bulk_transfer_result(params, payload)
        else:
            logger.info(f"[ChoiceBank] Unhandled notification type {notification_type!r}")
    except Exception as exc:
        # Always return 200 to Choice Bank — a 500 causes retries and eventual URL blacklisting.
        logger.error(f"[ChoiceBank] Webhook error (type={notification_type}): {exc}", exc_info=True)

    return {"code": "00000", "msg": "Processed successfully"}


async def _handle_transaction_result(params: dict, raw: dict):
    """
    Callback 0002 — Transaction Result.
    Fires for every transaction (inbound and outbound) on any sub-account.
    We only act on successful inbound credits to a trader's account.
    """
    tx_id        = params.get("txId") or ""
    external_ref = (params.get("extInfo") or {}).get("externalTxId") or params.get("externalTxId") or ""
    account_id  = params.get("accountId") or ""
    tx_status   = params.get("txStatus") or ""
    tx_type     = params.get("txType") or ""       # distinguishes credit vs debit
    try:
        amount  = float(params.get("amount") or 0)
    except (TypeError, ValueError):
        amount  = 0.0

    sender_name  = (params.get("extInfo") or {}).get("counterpartyName") or \
                   params.get("oppoAccountName") or ""
    sender_phone = (params.get("extInfo") or {}).get("oppoPhoneNumber") or \
                   params.get("oppoAccountId") or ""

    logger.info(
        f"[ChoiceBank] webhook: txId={tx_id}, account={account_id}, "
        f"status={tx_status}, type={tx_type}, KES {amount}"
    )

    # txStatus: -1=Timeout, 1=Pending, 2=Processing, 4=Failed, 8=SUCCESS
    _tx_success = not tx_status or str(tx_status) in ("8", "success", "completed", "00000")
    _tx_failed  = bool(tx_status) and str(tx_status) in ("4", "-1", "failed", "timeout")

    _OUTBOUND_TX_TYPES = {
        "TTID0001", "TTID0002", "TTID0005", "TTID0006",
        "TTID0009", "TTID0024", "TTID0025", "TTID0027",
    }
    if tx_type and tx_type.upper() in _OUTBOUND_TX_TYPES:
        logger.info(f"[ChoiceBank] Outbound tx: txType={tx_type}, status={tx_status}, KES {amount}")
        try:
            async with async_session() as _db:
                _tr = await _db.execute(select(Trader).where(Trader.choice_account_id == account_id))
                _trader = _tr.scalar_one_or_none()
                if _trader:
                    _recipient = sender_name or sender_phone or "Unknown"
                    _existing = (await _db.execute(
                        select(Payment).where(Payment.mpesa_transaction_id == tx_id)
                    )).scalar_one_or_none() if tx_id else None

                    # Idempotency: skip if already processed
                    if _existing and _existing.status in (PaymentStatus.COMPLETED, PaymentStatus.FAILED):
                        logger.info(f"[ChoiceBank] 0002: duplicate webhook for already-settled Payment {_existing.id} ({_existing.status}) — skipping")
                        return

                    _credits_refunded = False
                    if _existing and _existing.status == PaymentStatus.PENDING:
                        if _tx_success:
                            _existing.status = PaymentStatus.COMPLETED
                            if tx_id:
                                _existing.mpesa_receipt_number = tx_id
                            await _db.commit()
                            logger.info(f"[ChoiceBank] 0002: Payment {_existing.id} PENDING->COMPLETED")
                        elif _tx_failed:
                            _existing.status = PaymentStatus.FAILED
                            await _db.commit()
                            # Credits retired — no refund needed (withdrawal fee is withheld by Choice Bank).
                            logger.info(f"[ChoiceBank] 0002: Payment {_existing.id} PENDING->FAILED")
                    elif _tx_success:
                        _db.add(Payment(
                            trader_id=_trader.id,
                            direction=PaymentDirection.OUTBOUND,
                            mpesa_transaction_id=tx_id or f"cb_out_{_trader.id}_{amount}",
                            transaction_type="CHOICE_OUTBOUND",
                            amount=amount,
                            phone=sender_phone,
                            destination=sender_phone or sender_name,
                            sender_name=sender_name,
                            remarks=f"Choice Bank outbound - txType {tx_type}",
                            status=PaymentStatus.COMPLETED,
                            raw_callback=raw,
                        ))
                        await _db.commit()
                    elif _tx_failed and tx_id:
                        # No PENDING record (e.g. test/direct API call) — record as FAILED for idempotency
                        _db.add(Payment(
                            trader_id=_trader.id,
                            direction=PaymentDirection.OUTBOUND,
                            mpesa_transaction_id=tx_id,
                            transaction_type="CHOICE_OUTBOUND",
                            amount=amount,
                            remarks=f"CB outbound failed - txType {tx_type} (no app record)",
                            status=PaymentStatus.FAILED,
                            raw_callback=raw,
                        ))
                        await _db.commit()

                    from app.api.routes.telegram import notify_trader
                    if _tx_success:
                        _tg = "ok KES " + f"{amount:,.0f}" + " withdrawal COMPLETED" + chr(10) + "Ref: " + (tx_id or "N/A")
                    elif _tx_failed:
                        _refund_note = " (20 credits refunded)" if _credits_refunded else ""
                        _tg = "fail KES " + f"{amount:,.0f}" + " withdrawal FAILED" + _refund_note + chr(10) + "Ref: " + (tx_id or "N/A")
                    else:
                        _tg = None
                    if _tg:
                        await notify_trader(_trader, _tg)
        except Exception as _e:
            logger.warning(f"[ChoiceBank] Outbound notify/save failed: {_e}")
        return

    if not _tx_success:
        logger.info(f"[ChoiceBank] Skipping non-success inbound: status={tx_status}")
        return

    if not account_id or amount <= 0:
        logger.warning("[ChoiceBank] Missing accountId or zero amount — skipping")
        return

    async with async_session() as db:
        # Find trader by their Choice Bank account ID
        trader_result = await db.execute(
            select(Trader).where(Trader.choice_account_id == account_id)
        )
        trader = trader_result.scalar_one_or_none()

        if not trader:
            # Idempotency: don't insert if this tx_id is already recorded
            if tx_id:
                dup = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == tx_id))
                if dup.scalar_one_or_none():
                    logger.info(f"[ChoiceBank] Duplicate webhook (no trader): txId={tx_id} — skipping")
                    return
            logger.warning(f"[ChoiceBank] No trader found for account {account_id} — saving unmatched")
            db.add(Payment(
                direction=PaymentDirection.INBOUND,
                mpesa_transaction_id=tx_id,
                mpesa_receipt_number=external_ref,
                transaction_type="CHOICE_INBOUND",
                amount=amount,
                phone=sender_phone,
                bill_ref_number=account_id,
                sender_name=sender_name,
                status=PaymentStatus.PENDING,
                raw_callback=raw,
            ))
            await db.commit()
            return

        # Find trader's pending SELL order (most recent first)
        order_result = await db.execute(
            select(Order).where(
                Order.trader_id == trader.id,
                Order.side == OrderSide.SELL,
                Order.status == OrderStatus.PENDING,
            ).order_by(Order.created_at.desc()).limit(1)
        )
        order = order_result.scalar_one_or_none()

        if not order:
            logger.warning(
                f"[ChoiceBank] No pending SELL order for trader {trader.id} "
                f"({trader.full_name}) — checking for pending deposit or saving as unmatched"
            )
            # Try to match a pending CHOICE_DEPOSIT STK push (same trader, same amount, last 60 min)
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=60)
            pending_dep = (await db.execute(
                select(Payment).where(
                    Payment.trader_id == trader.id,
                    Payment.transaction_type == "CHOICE_DEPOSIT",
                    Payment.status == PaymentStatus.PENDING,
                    Payment.amount == amount,
                    Payment.created_at >= cutoff,
                ).order_by(Payment.created_at.desc()).limit(1)
            )).scalar_one_or_none()

            if pending_dep:
                # Mark the pending deposit as completed — no duplicate record needed
                pending_dep.status = PaymentStatus.COMPLETED
                pending_dep.mpesa_transaction_id = tx_id or pending_dep.mpesa_transaction_id
                pending_dep.mpesa_receipt_number = external_ref or pending_dep.mpesa_receipt_number
                pending_dep.sender_name = sender_name or pending_dep.sender_name
                await db.commit()
                logger.info(f"[ChoiceBank] Matched CHOICE_DEPOSIT for trader {trader.id}, amount={amount}")
            else:
                # General inbound (e.g. manual transfer from someone else)
                inbound_pmt = Payment(
                    trader_id=trader.id,
                    direction=PaymentDirection.INBOUND,
                    mpesa_transaction_id=tx_id,
                    mpesa_receipt_number=external_ref,
                    transaction_type="CHOICE_INBOUND",
                    amount=amount,
                    phone=sender_phone,
                    bill_ref_number=account_id,
                    sender_name=sender_name,
                    status=PaymentStatus.COMPLETED,
                    raw_callback=raw,
                )
                db.add(inbound_pmt)
                await db.flush()
                # Auto-credit trader wallet for every unmatched inbound deposit
                wallet_res = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
                wallet = wallet_res.scalar_one_or_none()
                if not wallet:
                    wallet = Wallet(trader_id=trader.id)
                    db.add(wallet)
                    await db.flush()
                wallet.balance      += amount
                wallet.total_earned += amount
                wallet.daily_volume += amount
                db.add(WalletTransaction(
                    trader_id=trader.id,
                    wallet_id=wallet.id,
                    transaction_type=TransactionType.SELL_CREDIT,
                    amount=amount,
                    balance_after=wallet.balance,
                    description=f"Manual deposit via Choice Bank paybill",
                ))
                await db.commit()
            try:
                from app.api.routes.telegram import notify_trader
                _tg_msg = (
                    "💰 KES " + f"{amount:,.0f}" +
                    " received in your Choice Bank" + chr(10) +
                    "From: " + (sender_name or sender_phone or "Unknown") + chr(10) +
                    ("✅ Deposit confirmed!" if pending_dep else "⚠️ No active sell order — saved for review.")
                )
                await notify_trader(trader, _tg_msg)
            except Exception as _e:
                logger.warning(f"[ChoiceBank] Unmatched inbound notify failed: {_e}")
            return

        # Overpayment (more than KES 5 over the order): flag as disputed
        if amount > order.fiat_amount + 5:
            logger.warning(
                f"[ChoiceBank] Overpayment for order {order.binance_order_number}: "
                f"expected KES {order.fiat_amount:.2f}, received KES {amount:.2f}"
            )
            order.status = OrderStatus.DISPUTED
            await db.commit()
            return

        # Idempotency: skip if this tx_id was already recorded
        if tx_id:
            dup_check = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == tx_id))
            if dup_check.scalar_one_or_none():
                logger.info(f"[ChoiceBank] Duplicate webhook for order {order.binance_order_number}: txId={tx_id} — skipping")
                return

        # Save this payment (may be partial or exact)
        is_partial = amount < order.fiat_amount - 5
        db.add(Payment(
            order_id=order.id,
            trader_id=trader.id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=tx_id,
            transaction_type="CHOICE_INBOUND",
            amount=amount,
            phone=sender_phone,
            bill_ref_number=account_id,
            sender_name=sender_name,
            status=PaymentStatus.COMPLETED,
            raw_callback=raw,
        ))
        await db.flush()

        # Sum all inbound Choice Bank payments already recorded for this order
        total_result = await db.execute(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.order_id == order.id,
                Payment.direction == PaymentDirection.INBOUND,
                Payment.status == PaymentStatus.COMPLETED,
                Payment.transaction_type == "CHOICE_INBOUND",
            )
        )
        total_received = float(total_result.scalar() or 0)

        if total_received < order.fiat_amount - 5:
            # Still partial — log and wait for the next payment
            logger.info(
                f"[ChoiceBank] PARTIAL: {tx_id} → order {order.binance_order_number} "
                f"KES {amount} received, KES {total_received:.2f} total so far "
                f"(need KES {order.fiat_amount:.2f})"
            )
            await db.commit()
            return

        # Full amount reached — mark order as payment received
        order.status = OrderStatus.PAYMENT_RECEIVED
        order.payment_confirmed_at = datetime.now(timezone.utc)
        if sender_phone:
            order.counterparty_phone = sender_phone
        if sender_name:
            order.counterparty_name = sender_name

        # Credit wallet with the incremental amount (this payment only, not double-count)
        wallet_result = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
        wallet = wallet_result.scalar_one_or_none()
        if not wallet:
            wallet = Wallet(trader_id=trader.id)
            db.add(wallet)
            await db.flush()

        wallet.balance      += amount
        wallet.total_earned += amount
        wallet.daily_volume += amount
        if not is_partial:
            wallet.daily_trades += 1  # only count a new trade for single-shot payments

        db.add(WalletTransaction(
            trader_id=trader.id,
            wallet_id=wallet.id,
            order_id=order.id,
            transaction_type=TransactionType.SELL_CREDIT,
            amount=amount,
            balance_after=wallet.balance,
            description=f"Choice Bank inbound {'(partial top-up)' if is_partial else 'payment'}",
        ))

        await db.commit()
        logger.info(
            f"[ChoiceBank] MATCHED: {tx_id} → order {order.binance_order_number} "
            f"(Trader: {trader.full_name}, KES {amount}, total KES {total_received:.2f}) → PAYMENT_RECEIVED"
        )
        try:
            from app.api.routes.telegram import notify_trader
            _tg_msg = (
                "💰 KES " + f"{amount:,.0f}" +
                " received — payment confirmed!" + chr(10) +
                "From: " + (sender_name or sender_phone or "Unknown") + chr(10) +
                "Order: " + (order.binance_order_number or "")
            )
            await notify_trader(trader, _tg_msg)
        except Exception as _e:
            logger.warning(f"[ChoiceBank] Matched inbound notify failed: {_e}")



async def _handle_bulk_transfer_result(params: dict, raw: dict):
    """
    Callback 0004 — Merchant Bulk Transfer Result.
    Fires when a batch_disburse() transfer completes or fails.
    Updates the Payment record from PENDING to COMPLETED/FAILED.
    """
    order_id = params.get("orderId") or ""
    result_array = params.get("resultArray") or []

    logger.info(f"[ChoiceBank] 0004 bulk result: orderId={order_id}, items={len(result_array)}")

    for item in result_array:
        tx_id     = item.get("txId") or ""
        tx_status = str(item.get("txStatus") or "")
        try:
            amount = float(item.get("amount") or 0)
        except (ValueError, TypeError):
            amount = 0.0

        success = tx_status in ("SUCCESS", "8", "success", "00000")

        async with async_session() as _db:
            from app.models import Payment, PaymentStatus
            pmt = (await _db.execute(
                select(Payment).where(Payment.mpesa_transaction_id == order_id)
            )).scalar_one_or_none()

            if not pmt:
                logger.warning(f"[ChoiceBank] 0004: no Payment found for orderId={order_id}")
                continue

            pmt.status = PaymentStatus.COMPLETED if success else PaymentStatus.FAILED
            if tx_id:
                pmt.mpesa_receipt_number = tx_id
            await _db.commit()
            logger.info(f"[ChoiceBank] 0004: Payment {pmt.id} → {'COMPLETED' if success else 'FAILED'}")

            trader = await _db.get(Trader, pmt.trader_id)
            if trader:
                try:
                    from app.api.routes.telegram import notify_trader
                    if success:
                        msg = (
                            "✅ KES " + f"{amount:,.0f}" + " bank withdrawal COMPLETED" + chr(10) +
                            "Ref: " + (tx_id or order_id)
                        )
                    else:
                        msg = (
                            "❌ KES " + f"{amount:,.0f}" + " bank withdrawal FAILED" + chr(10) +
                            "Ref: " + order_id + chr(10) +
                            "Status: " + tx_status
                        )
                    await notify_trader(trader, msg)
                except Exception as _e:
                    logger.warning(f"[ChoiceBank] 0004 notify failed: {_e}")


async def _handle_balance_change(params: dict):
    """Callback 0003 — Balance Change. Log only; order status managed by 0002."""
    logger.info(
        f"[ChoiceBank] 0003 balance change: account={params.get('accountId')}, "
        f"KES {params.get('amount')}, balance={params.get('balance')}"
    )


# ── Onboarding Routes (SparkP2P → Choice Bank) ───────────────────────────────

class WalletOnboardRequest(BaseModel):
    trader_id: int
    first_name: str
    last_name: str
    middle_name: str = ""
    mobile: str               # 9-digit (no 254/0 prefix)
    id_number: str
    birthday: str             # yyyy-mm-dd
    gender: int               # 0=female, 1=male
    email: str = ""
    address: str = ""
    front_photo_b64: str      # National ID front
    back_photo_b64: str       # National ID back
    selfie_b64: str


class CurrentOnboardRequest(BaseModel):
    trader_id: int
    first_name: str
    last_name: str
    middle_name: str = ""
    mobile: str
    id_number: str
    birthday: str
    gender: int
    email: str = ""
    address: str = ""
    kra_pin: str
    employment_status: str
    monthly_income: str


class OtpConfirmRequest(BaseModel):
    trader_id: int
    onboarding_request_id: str
    otp: str


class TransferRequest(BaseModel):
    trader_id: int
    payee_mobile: str         # 9-digit phone number (no 254/0 prefix)
    amount: float
    payee_bank_code: str      # from get_bank_codes(); e.g. M-Pesa code
    payee_name: str = ""
    remark: str = ""


@router.post("/choice/onboard/wallet")
async def onboard_wallet(body: WalletOnboardRequest, db: AsyncSession = Depends(get_db)):
    """
    Initiate wallet account creation for a trader.
    Returns onboardingRequestId — use it for OTP confirmation and status polling.
    """
    result = await choice.create_wallet_account(
        user_id=str(body.trader_id),
        first_name=body.first_name,
        last_name=body.last_name,
        middle_name=body.middle_name,
        mobile=body.mobile,
        id_number=body.id_number,
        birthday=body.birthday,
        gender=body.gender,
        email=body.email,
        address=body.address,
        front_photo_b64=body.front_photo_b64,
        back_photo_b64=body.back_photo_b64,
        selfie_b64=body.selfie_b64,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Onboarding failed"))

    onboarding_id = result.get("data", {}).get("onboardingRequestId")

    # Store onboarding request ID on the trader for OTP + status polling
    trader = await db.get(Trader, body.trader_id)
    if trader:
        trader.choice_kyc_status = f"onboarding:{onboarding_id}"
        await db.commit()

    return {"onboardingRequestId": onboarding_id}


@router.post("/choice/onboard/current")
async def onboard_current(body: CurrentOnboardRequest, db: AsyncSession = Depends(get_db)):
    """
    Initiate current account creation (no transaction limits).
    Selfie must be verified via Smile ID SDK on the frontend before calling this.
    """
    result = await choice.create_current_account(
        user_id=str(body.trader_id),
        first_name=body.first_name,
        last_name=body.last_name,
        middle_name=body.middle_name,
        mobile=body.mobile,
        id_number=body.id_number,
        birthday=body.birthday,
        gender=body.gender,
        email=body.email,
        address=body.address,
        kra_pin=body.kra_pin,
        employment_status=body.employment_status,
        monthly_income=body.monthly_income,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Onboarding failed"))

    onboarding_id = result.get("data", {}).get("onboardingRequestId")

    trader = await db.get(Trader, body.trader_id)
    if trader:
        trader.choice_kyc_status = f"onboarding:{onboarding_id}"
        await db.commit()

    return {"onboardingRequestId": onboarding_id}


class UploadMediaRequest(BaseModel):
    onboarding_request_id: str
    media_type: str     # KYCF00001=ID front, KYCF00002=ID back, KYCF00006=selfie
    media_b64: str      # base64-encoded jpg/jpeg image
    content_type: str = "image"


@router.post("/choice/onboard/upload-media")
async def upload_kyc_document(body: UploadMediaRequest):
    """
    Upload a single KYC document for current account onboarding.
    Must be called after POST /choice/onboard/current, within 30 minutes.

    Required documents for National ID (idType=101):
      KYCF00001 — ID front (jpg)
      KYCF00002 — ID back (jpg)
      KYCF00006 — Selfie (jpg) — must be Smile ID verified on frontend first

    Call this endpoint once per document. All three must be uploaded before
    Choice Bank starts KYC review.
    """
    result = await choice.upload_kyc_media(
        onboarding_request_id=body.onboarding_request_id,
        media_type=body.media_type,
        media_b64=body.media_b64,
        content_type=body.content_type,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Media upload failed"))
    return {"status": "uploaded", "mediaType": body.media_type}


@router.post("/choice/onboard/otp")
async def confirm_onboarding_otp(body: OtpConfirmRequest, db: AsyncSession = Depends(get_db)):
    """Confirm the OTP received by the trader to proceed with wallet account creation."""
    result = await choice.confirm_otp(body.onboarding_request_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "OTP confirmation failed"))
    return {"status": "confirmed"}


@router.get("/choice/onboard/status/{onboarding_request_id}")
async def check_onboarding_status(onboarding_request_id: str, trader_id: int, db: AsyncSession = Depends(get_db)):
    """
    Poll onboarding status. When status=3 or 7 the account is active.
    Saves choice_account_id and choice_account_number to the trader on success.
    """
    result = await choice.get_onboarding_status(onboarding_request_id)
    data = result.get("data") or {}
    # Choice returns the onboarding state as `onboardingStatus` (3 = passed, 7 = active),
    # NOT `status` — reading the wrong field meant approvals were never captured here.
    status = data.get("onboardingStatus", data.get("status"))

    if status in (3, 7, "3", "7"):
        account_id     = data.get("accountId") or data.get("account_id") or ""
        account_number = data.get("accountNumber") or data.get("account_number") or account_id

        if account_id:
            trader = await db.get(Trader, trader_id)
            if trader:
                trader.choice_account_id     = account_id
                trader.choice_account_number = account_number
                trader.choice_kyc_status     = "approved"
                await db.commit()
                logger.info(
                    f"[ChoiceBank] Trader {trader_id} account activated: "
                    f"accountId={account_id}, number={account_number}"
                )

    return {
        "status": status,
        "accountId": data.get("accountId"),
        "accountNumber": data.get("accountNumber"),
        "raw": data,
    }


class DepositRequest(BaseModel):
    amount: int  # whole KES amount
    mobile: str = ""  # optional override phone; if empty, uses trader's registered phone


def _normalize_mobile(raw: str) -> str:
    """Normalize any Kenyan phone format to 9-digit local number (e.g. 712345678)."""
    raw = raw.strip().replace(" ", "").replace("-", "")
    if raw.startswith("+254"):
        raw = raw[4:]
    elif raw.startswith("254"):
        raw = raw[3:]
    elif raw.startswith("0"):
        raw = raw[1:]
    return raw


@router.post("/choice/deposit")
async def stk_push_deposit(
    body: DepositRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Trigger M-Pesa STK push to deposit into the trader's Choice Bank account."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    if body.amount < 1:
        raise HTTPException(status_code=400, detail="Amount must be at least KES 1")

    raw_phone = body.mobile.strip() if body.mobile and body.mobile.strip() else (trader.phone or "")
    mobile = _normalize_mobile(raw_phone)
    if len(mobile) != 9 or not mobile.isdigit():
        raise HTTPException(status_code=400, detail="Invalid phone number — enter a valid Kenyan number")

    result = await choice.deposit_from_mpesa(trader.choice_account_id, mobile, body.amount)
    tx_id = result.get("data", {}).get("txId") or result.get("txId") or ""

    # Log the initiated deposit so it appears in the merchant's transaction history
    try:
        p = Payment(
            trader_id=trader.id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=tx_id or f"cb_stk_{trader.id}_{body.amount}",
            transaction_type="CHOICE_DEPOSIT",
            amount=body.amount,
            phone=mobile,
            sender_name="Choice Bank STK Push",
            remarks=f"Deposit via M-Pesa STK to Choice Bank",
            status=PaymentStatus.PENDING,
        )
        db.add(p)
        await db.commit()
    except Exception as _log_err:
        logger.warning(f"Failed to log deposit to payments: {_log_err}")

    return {"txId": tx_id, "status": "stk_sent"}


@router.get("/choice/balance/{trader_id}")
async def get_trader_balance(trader_id: int, db: AsyncSession = Depends(get_db)):
    """Get the live Choice Bank balance for a trader's sub-account."""
    trader = await db.get(Trader, trader_id)
    if not trader or not trader.choice_account_id:
        raise HTTPException(status_code=404, detail="Trader has no Choice Bank account")

    result = await choice.get_account_details(trader.choice_account_id)
    data = result.get("data") or {}
    return {
        "accountId":     data.get("accountId"),
        "accountNumber": data.get("accountNumber") or trader.choice_account_number,
        "balance":       data.get("balance"),
        "currency":      data.get("currency", "KES"),
        "status":        data.get("accountStatus"),
        "shortCode":     data.get("shortCode"),
    }


@router.post("/choice/transfer")
async def initiate_transfer(body: TransferRequest, db: AsyncSession = Depends(get_db)):
    """
    Send money from a trader's Choice Bank account to a mobile number (B2C).
    Used for BUY orders — pays the seller via M-Pesa or Airtel.
    payee_mobile: 9-digit phone number without 254/0 prefix.
    """
    trader = await db.get(Trader, body.trader_id)
    if not trader or not trader.choice_account_id:
        raise HTTPException(status_code=404, detail="Trader has no Choice Bank account")

    result = await choice.transfer(
        payer_account_id=trader.choice_account_id,
        payee_account_id=body.payee_mobile,
        amount=body.amount,
        payee_bank_code=body.payee_bank_code,
        payee_name=body.payee_name,
        remark=body.remark or "SparkP2P P2P order payment",
        notify_mobile=body.payee_mobile,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer failed"))

    tx_id = (result.get("data") or {}).get("txId", "")
    logger.info(
        f"[ChoiceBank] Transfer initiated: txId={tx_id}, "
        f"KES {body.amount} → {body.payee_mobile}"
    )
    try:
        from app.api.routes.telegram import notify_trader
        _tg_msg = (
            "📤 KES " + f"{body.amount:,.0f}" +
            " sent via Choice Bank" + chr(10) +
            "To: " + (body.payee_name or body.payee_mobile) + chr(10) +
            "Ref: " + (tx_id or "N/A")
        )
        await notify_trader(trader, _tg_msg)
    except Exception as _e:
        logger.warning(f"[ChoiceBank] Transfer notify failed: {_e}")
    return {"txId": tx_id, "status": "submitted"}


@router.get("/choice/bank-codes")
async def get_bank_codes():
    """Return all supported payment channel codes (call once to identify M-Pesa code)."""
    result = await choice.get_bank_codes()
    return result.get("data") or result


# ── Payments Hub — user-facing "Send Money" (OTP-confirmed) ───────────────────
# Mirrors the proven withdraw-to-M-Pesa flow (transfer → sendOtp → confirmOperation) but lets the
# trader send to ANY M-Pesa number, not just their own settlement phone.

class SendMoneyInitiate(BaseModel):
    payee_phone: str
    amount: float
    payee_name: str = ""
    remark: str = ""


class SendMoneyConfirm(BaseModel):
    otp: str


_pending_send_money: dict[int, dict] = {}


def _normalize_msisdn(phone: str) -> str:
    p = (phone or "").strip().replace(" ", "")
    if p.startswith("+254"):
        p = p[4:]
    elif p.startswith("254"):
        p = p[3:]
    elif p.startswith("0"):
        p = p[1:]
    return p


@router.post("/choice/pay/send-money/initiate")
async def send_money_initiate(body: SendMoneyInitiate, trader: Trader = Depends(get_current_trader)):
    """Step 1: start a Choice Bank → M-Pesa transfer to an arbitrary number; OTP is sent to the
    trader's registered phone."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    phone = _normalize_msisdn(body.payee_phone)
    if len(phone) != 9 or not phone.isdigit() or phone[0] not in ("7", "1"):
        raise HTTPException(status_code=400, detail="Enter a valid Kenyan phone number (e.g. 0712345678)")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if body.amount > 250000:
        raise HTTPException(status_code=400, detail="M-Pesa transfers are limited to KES 250,000 per transaction")

    try:
        result = await choice.transfer(
            payer_account_id=trader.choice_account_id,
            payee_account_id=phone,
            amount=body.amount,
            payee_bank_code="M-PESA",
            payee_name=body.payee_name or "",
            remark=body.remark or "SparkP2P send money",
            notify_mobile=phone,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transfer initiation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer rejected"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")

    try:
        await choice.send_otp(tx_id)
    except Exception as exc:
        logger.warning(f"[ChoiceBank] send-money sendOtp failed: {exc}")

    _pending_send_money[trader.id] = {"tx_id": tx_id, "amount": body.amount, "phone": phone, "name": body.payee_name}
    return {"status": "otp_sent", "message": "Enter the OTP Choice Bank sent to your registered phone to confirm this transfer."}


@router.post("/choice/pay/send-money/confirm")
async def send_money_confirm(body: SendMoneyConfirm, trader: Trader = Depends(get_current_trader)):
    """Step 2: confirm the OTP to release the transfer."""
    pending = _pending_send_money.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    try:
        result = await choice.confirm_otp(pending["tx_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_send_money.pop(trader.id, None)
    try:
        from app.api.routes.telegram import notify_trader
        _to = pending.get("name") or ("0" + pending["phone"])
        await notify_trader(trader, f"\U0001F4E4 KES {pending['amount']:,.0f} sent via Choice Bank to {_to}\nRef: {pending['tx_id']}")
    except Exception:
        pass
    return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}

