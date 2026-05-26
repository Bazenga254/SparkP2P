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

    # Verify signature when key is configured
    private_key = settings.CHOICE_BANK_SENDER_KEY
    if private_key:
        if not _verify_signature(payload, private_key):
            logger.warning("[ChoiceBank] Invalid signature — ignoring")
            return {"code": "00000", "msg": "OK"}
    else:
        logger.warning("[ChoiceBank] CHOICE_BANK_SENDER_KEY not set — skipping verification (sandbox)")

    # notificationType is at the TOP LEVEL of the envelope
    notification_type = str(payload.get("notificationType") or "")
    params = payload.get("params") or {}

    if notification_type == "0002":
        await _handle_transaction_result(params, payload)
    elif notification_type == "0003":
        # 0003 is the primary callback for inbound payments (paybill, M-Pesa C2B, etc.)
        await _handle_transaction_result(params, payload)
    else:
        logger.info(f"[ChoiceBank] Unhandled notification type {notification_type!r}")

    return {"code": "00000", "msg": "Processed successfully"}


async def _handle_transaction_result(params: dict, raw: dict):
    """
    Callback 0002 — Transaction Result.
    Fires for every transaction (inbound and outbound) on any sub-account.
    We only act on successful inbound credits to a trader's account.
    """
    tx_id       = params.get("txId") or params.get("externalTxId") or ""
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

    # txStatus codes per Choice Bank API docs (Type/Status IDs page):
    #   -1 = Timeout,  1 = Pending,  2 = Processing,  4 = Failed,  8 = SUCCESS
    # For 0003 (Balance Change): txStatus is absent — a credit posting IS already success.
    # We process only when txStatus is 8 (success) OR absent (0003 pay-in).
    if tx_status:  # absent = empty string from `or ""` → skip this block
        if str(tx_status) not in ("8", "success", "completed", "00000"):
            logger.info(f"[ChoiceBank] Skipping non-success transaction: status={tx_status}")
            return

    # Known outbound TTID codes from Choice Bank API docs.
    # Skip these to avoid accidentally treating a payout as an inbound payment.
    _OUTBOUND_TX_TYPES = {
        "TTID0001",  # Withdraw to M-PESA
        "TTID0002",  # Transfer Out
        "TTID0005",  # M-PESA Paybill/Till
        "TTID0006",  # Utility Payment
        "TTID0009",  # FCY Transfer Out
        "TTID0024",  # Cash Withdrawal
        "TTID0025",  # Mpesa IMT
        "TTID0027",  # CNY Transfer
    }
    if tx_type and tx_type.upper() in _OUTBOUND_TX_TYPES:
        logger.info(f"[ChoiceBank] Outbound transaction: txType={tx_type}, KES {amount}")
        try:
            async with async_session() as _db:
                _tr = await _db.execute(select(Trader).where(Trader.choice_account_id == account_id))
                _trader = _tr.scalar_one_or_none()
                if _trader:
                    from app.api.routes.telegram import notify_trader
                    _recipient = sender_name or sender_phone or "Unknown"
                    _tg_msg = (
                        "📤 KES " + f"{amount:,.0f}" +
                        " sent from your Choice Bank" + chr(10) +
                        "To: " + _recipient + chr(10) +
                        "Ref: " + (tx_id or "N/A")
                    )
                    await notify_trader(_trader, _tg_msg)
        except Exception as _e:
            logger.warning(f"[ChoiceBank] Outbound notify failed: {_e}")
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
                f"({trader.full_name}) — saving unmatched"
            )
            db.add(Payment(
                trader_id=trader.id,
                direction=PaymentDirection.INBOUND,
                mpesa_transaction_id=tx_id,
                transaction_type="CHOICE_INBOUND",
                amount=amount,
                phone=sender_phone,
                bill_ref_number=account_id,
                sender_name=sender_name,
                status=PaymentStatus.PENDING,
                raw_callback=raw,
            ))
            await db.commit()
            try:
                from app.api.routes.telegram import notify_trader
                _tg_msg = (
                    "💰 KES " + f"{amount:,.0f}" +
                    " received in your Choice Bank" + chr(10) +
                    "From: " + (sender_name or sender_phone or "Unknown") + chr(10) +
                    "⚠️ No active sell order — payment saved for review."
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
    status = data.get("status")

    if status in (3, 7, "3", "7"):
        account_id     = data.get("accountId") or data.get("account_id") or ""
        account_number = data.get("accountNumber") or data.get("account_number") or ""

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

    mobile = (trader.phone or "").lstrip("+").lstrip("254").lstrip("0")
    if len(mobile) != 9:
        raise HTTPException(status_code=400, detail="Invalid phone number for STK push")

    result = await client.deposit_from_mpesa(trader.choice_account_id, mobile, body.amount)
    return {"txId": result.get("data", {}).get("txId") or result.get("txId"), "status": "stk_sent"}


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

