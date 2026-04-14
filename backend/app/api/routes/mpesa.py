import logging
import re

from fastapi import APIRouter, Request, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.matching.engine import MatchingEngine
from app.services.settlement.engine import SettlementEngine
from app.models import Order, OrderStatus, Trader, Payment, PaymentDirection, PaymentStatus
from app.models.wallet import Wallet, WalletTransaction, TransactionType

from sqlalchemy import select

import httpx
from app.services.mpesa.client import mpesa_client

logger = logging.getLogger(__name__)

router = APIRouter()


# ── C2B Setup & Test ──────────────────────────────────────────────

@router.post("/c2b/register")
async def register_c2b_urls():
    """Register C2B confirmation and validation URLs with Safaricom."""
    try:
        result = await mpesa_client.register_c2b_urls()
        return {"status": "success", "result": result}
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response else {}
        logger.error(f"C2B URL registration failed: {e} - {body}")
        return {"status": "error", "detail": str(e), "response": body}
    except Exception as e:
        logger.error(f"C2B URL registration failed: {e}")
        return {"status": "error", "detail": str(e)}


@router.post("/c2b/simulate")
async def simulate_c2b_payment(
    request: Request,
    db: AsyncSession = Depends(get_db),
    amount: float = 6500,
    account: str = "P2P-T001-98765",
    phone: str = "254708374149",
    sender_first_name: str = "JOHN",
    sender_last_name: str = "DOE",
):
    """
    Simulate a C2B payment locally — calls our own confirm endpoint
    as if Safaricom sent the callback. For testing without sandbox.
    """
    import uuid
    from datetime import datetime

    fake_callback = {
        "TransactionType": "Pay Bill",
        "TransID": f"SIM{uuid.uuid4().hex[:8].upper()}",
        "TransTime": datetime.now().strftime("%Y%m%d%H%M%S"),
        "TransAmount": str(amount),
        "BusinessShortCode": "174379",
        "BillRefNumber": account,
        "InvoiceNumber": "",
        "OrgAccountBalance": "50000.00",
        "ThirdPartyTransID": "",
        "MSISDN": phone,
        "FirstName": sender_first_name,
        "MiddleName": "",
        "LastName": sender_last_name,
    }

    logger.info(f"Simulating C2B payment: {fake_callback}")

    # Process through the same confirmation handler
    amount_f = float(fake_callback["TransAmount"])
    bill_ref = fake_callback["BillRefNumber"]
    sender_name = f"{sender_first_name} {sender_last_name}".strip()
    txn_id = fake_callback["TransID"]

    result = {"payment_received": True, "transaction_id": txn_id, "matched": False}

    if bill_ref.startswith("P2P-"):
        engine = MatchingEngine(db)
        order = await engine.match_c2b_payment(
            amount=amount_f,
            bill_ref_number=bill_ref,
            phone=phone,
            sender_name=sender_name,
            mpesa_transaction_id=txn_id,
            raw_callback=fake_callback,
        )

        if order:
            result["matched"] = True
            result["order_id"] = str(order.id)
            result["order_status"] = order.status.value
            result["binance_order"] = order.binance_order_number
            # Skip actual Binance release in simulation
            logger.info(f"Simulated payment matched to order {order.binance_order_number}")
        else:
            result["message"] = "Payment received but no matching order found"
    else:
        result["message"] = f"Non-P2P payment: ref={bill_ref}"

    return {"status": "success", "result": result}


# ── C2B Callbacks ─────────────────────────────────────────────────

@router.post("/c2b/validate")
async def c2b_validation(request: Request):
    """M-Pesa C2B validation callback. Accept all payments."""
    data = await request.json()
    logger.info(f"C2B Validation: {data}")

    # You can add validation logic here (reject payments that don't match)
    # For now, accept all
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/c2b/confirm")
async def c2b_confirmation(request: Request, db: AsyncSession = Depends(get_db)):
    """
    M-Pesa C2B confirmation callback.
    This is called when a buyer pays to our Paybill.
    """
    data = await request.json()
    logger.info(f"C2B Confirmation: {data}")

    amount = float(data.get("TransAmount", 0))
    bill_ref = data.get("BillRefNumber", "")
    phone = data.get("MSISDN", "")
    sender_name = f"{data.get('FirstName', '')} {data.get('MiddleName', '')} {data.get('LastName', '')}".strip()
    txn_id = data.get("TransID", "")

    # Route based on account reference prefix
    # P2PT0001         → direct wallet deposit (new format, no hyphens — I&M compatible)
    # P2P-T0001        → direct wallet deposit (legacy format, still accepted)
    # P2P-T0001-98765  → P2P trade payment (trader prefix + Binance order number)
    # DEP-1            → legacy wallet deposit format (kept for backward compatibility)
    if re.match(r'^P2P-?T\d{4}$', bill_ref):
        # Exact trader deposit reference: P2PT0001 or P2P-T0001 (no order number suffix)
        try:
            trader_id = int(re.sub(r'^P2P-?T', '', bill_ref))  # strip P2PT or P2P-T
            await _credit_wallet_deposit(trader_id, amount, txn_id, phone, sender_name, db)
        except (ValueError, IndexError):
            logger.error(f"Invalid P2P deposit reference: {bill_ref}")
    elif bill_ref.startswith("P2P-") or bill_ref.startswith("P2PT"):
        # This is a P2P trade payment (sell side — buyer pays us)
        engine = MatchingEngine(db)
        order = await engine.match_c2b_payment(
            amount=amount,
            bill_ref_number=bill_ref,
            phone=phone,
            sender_name=sender_name,
            mpesa_transaction_id=txn_id,
            raw_callback=data,
        )

        if order:
            # Credit the trader's wallet with the sell amount
            await _credit_wallet_for_sell(order, amount, db)

            # Store confirmation message for the bot to send before releasing
            order.pending_chat_message = (
                f"Payment of KES {amount:,.0f} received from {sender_name}. "
                f"M-Pesa Receipt: {txn_id}. "
                f"Releasing your crypto now..."
            )
            await db.commit()

            # Notify trader
            from app.api.routes.traders import add_notification
            add_notification(
                order.trader_id,
                f"Payment Received: KES {amount:,.0f}",
                f"From {sender_name}. Receipt: {txn_id}. Auto-releasing crypto...",
                "payment"
            )

            # Payment matched — trigger auto-release
            await _trigger_auto_release(order, db)
    elif bill_ref.startswith("DEP-"):
        # Legacy wallet deposit format (DEP-{trader_id}) — kept for backward compatibility
        try:
            trader_id = int(bill_ref.split("-")[1])
            await _credit_wallet_deposit(trader_id, amount, txn_id, phone, sender_name, db)
        except (ValueError, IndexError):
            logger.error(f"Invalid deposit reference: {bill_ref}")
    else:
        # Not a P2P payment — forward to existing website handler if needed
        logger.info(f"Non-P2P payment received: ref={bill_ref}, amount={amount}")

    # Adjust paybill balance in real-time
    adjust_paybill_balance(amount, direction="in")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}



def _calculate_safaricom_bsc(amount: float) -> float:
    """Safaricom Business Service Charge deducted from paybill on C2B receipts."""
    bands = [
        (49, 0), (100, 1), (150, 2), (250, 3), (500, 5),
        (1000, 10), (1500, 14), (2500, 21), (3500, 28),
        (5000, 35), (7500, 48), (10000, 61), (15000, 78),
        (20000, 90), (25000, 100), (30000, 110), (35000, 117),
    ]
    for limit, fee in bands:
        if amount <= limit:
            return float(fee)
    return round(amount * 0.0034, 2)


async def _credit_wallet_deposit(
    trader_id: int, amount: float, mpesa_txn_id: str,
    phone: str, sender_name: str, db: AsyncSession,
):
    """Credit trader's wallet when they deposit via Paybill (DEP-{id})."""
    from app.models import Trader
    from app.models.wallet import Wallet, WalletTransaction, TransactionType

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        logger.error(f"Deposit: trader {trader_id} not found")
        return

    # Get or create wallet
    result = await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))
    wallet = result.scalar_one_or_none()
    if not wallet:
        wallet = Wallet(trader_id=trader_id, balance=0, reserved=0)
        db.add(wallet)
        await db.flush()

    # Credit wallet
    wallet.balance += amount
    wallet.total_earned += amount

    # Record wallet transaction
    txn = WalletTransaction(
        trader_id=trader_id,
        wallet_id=wallet.id,
        transaction_type=TransactionType.DEPOSIT,
        amount=amount,
        balance_after=wallet.balance,
        description=f"Paybill deposit from {sender_name or phone}",
        mpesa_receipt=mpesa_txn_id,
        status="completed",
    )
    db.add(txn)

    # Also create Payment record for admin transaction visibility
    payment = Payment(
        trader_id=trader_id,
        direction=PaymentDirection.INBOUND,
        transaction_type="C2B",
        amount=amount,
        phone=phone,
        sender_name=sender_name or "",
        bill_ref_number=f"DEP-{trader_id}",
        mpesa_transaction_id=mpesa_txn_id,
        status=PaymentStatus.COMPLETED,
    )
    db.add(payment)

    await db.commit()

    logger.info(f"Deposit credited: KES {amount} to trader {trader_id} (ref: {mpesa_txn_id})")

    # Push in-app notification for real-time dashboard update
    try:
        from app.api.routes.traders import add_notification
        add_notification(
            trader_id,
            f"Deposit Received: KES {amount:,.0f}",
            f"Your wallet has been credited. New balance: KES {wallet.balance:,.0f}",
            "payment"
        )
    except Exception as e:
        logger.error(f"Failed to push deposit notification: {e}")

    # Send email + SMS notifications
    try:
        from app.services.email import send_deposit_received
        send_deposit_received(trader.email, trader.full_name, amount, wallet.balance)
    except Exception as e:
        logger.error(f"Failed to send deposit email: {e}")

    try:
        from app.services.sms import sms_deposit_received
        sms_deposit_received(trader.phone, amount, wallet.balance)
    except Exception as e:
        logger.error(f"Failed to send deposit SMS: {e}")


async def _credit_wallet_for_sell(order: Order, amount: float, db: AsyncSession):
    """
    Credit the trader's wallet when a sell order payment is received (C2B).
    The buyer paid KES to our Paybill — we credit the trader's wallet.
    """
    try:
        result = await db.execute(
            select(Wallet).where(Wallet.trader_id == order.trader_id)
        )
        wallet = result.scalar_one_or_none()

        if not wallet:
            wallet = Wallet(trader_id=order.trader_id)
            db.add(wallet)
            await db.flush()

        # Deduct platform fee
        from app.core.config import settings
        platform_fee = settings.PLATFORM_FEE_PER_TRADE
        net_amount = amount - platform_fee

        wallet.balance += net_amount
        wallet.total_earned += net_amount
        wallet.total_fees_paid += platform_fee

        # Record credit transaction
        credit_txn = WalletTransaction(
            trader_id=order.trader_id,
            wallet_id=wallet.id,
            order_id=order.id,
            transaction_type=TransactionType.SELL_CREDIT,
            amount=net_amount,
            balance_after=wallet.balance,
            description=f"Sell order {order.binance_order_number} - KES {amount:,.0f} received (fee: {platform_fee})",
        )
        db.add(credit_txn)

        # Record platform fee transaction
        if platform_fee > 0:
            fee_txn = WalletTransaction(
                trader_id=order.trader_id,
                wallet_id=wallet.id,
                order_id=order.id,
                transaction_type=TransactionType.PLATFORM_FEE,
                amount=-platform_fee,
                balance_after=wallet.balance,
                description=f"Platform fee for order {order.binance_order_number}",
            )
            db.add(fee_txn)

        await db.flush()
        logger.info(
            f"Wallet credited KES {net_amount} for sell order {order.binance_order_number}, "
            f"trader {order.trader_id}, new balance: {wallet.balance}"
        )

    except Exception as e:
        logger.error(f"Failed to credit wallet for sell order {order.binance_order_number}: {e}")


async def _trigger_auto_release(order: Order, db: AsyncSession):
    """
    Mark order as PAYMENT_RECEIVED so the Chrome extension picks it up
    and releases crypto on Binance (from the user's browser = correct IP).

    The old approach called Binance from the VPS, which caused IP mismatch
    issues. Now the extension polls /api/ext/pending-actions or gets the
    action back from /api/ext/report-orders and executes the release.
    """
    try:
        result = await db.execute(
            select(Trader).where(Trader.id == order.trader_id)
        )
        trader = result.scalar_one_or_none()

        if not trader or not trader.auto_release_enabled:
            logger.info(f"Auto-release skipped for order {order.binance_order_number}")
            return

        # Mark as payment_received — the extension will see this and release
        # (order.status was already set to PAYMENT_RECEIVED by the matching engine,
        #  but we confirm it here for clarity)
        if order.status != OrderStatus.PAYMENT_RECEIVED:
            order.status = OrderStatus.PAYMENT_RECEIVED
            await db.commit()

        logger.info(
            f"Payment confirmed for order {order.binance_order_number} — "
            f"waiting for extension to release"
        )

    except Exception as e:
        logger.error(f"Auto-release setup failed for order {order.binance_order_number}: {e}")
        order.status = OrderStatus.DISPUTED
        await db.commit()


# ── B2C Callbacks ─────────────────────────────────────────────────

@router.post("/b2c/result")
async def b2c_result(request: Request, db: AsyncSession = Depends(get_db)):
    """B2C result callback — payment to trader's M-Pesa completed.
    Safaricom sends the actual M-Pesa receipt code here.
    """
    data = await request.json()
    import json as _json
    print(f"B2C RESULT RAW: {_json.dumps(data)[:500]}")

    try:
        result = data.get("Result", {})
        conversation_id = result.get("ConversationID", "")
        result_code = result.get("ResultCode")
        result_desc = result.get("ResultDesc", "")

        # Extract receipt and details from ResultParameters
        params = {}
        for item in (result.get("ResultParameters", {}).get("ResultParameter", [])):
            params[item.get("Key", "")] = item.get("Value", "")

        mpesa_receipt = params.get("TransactionReceipt", "")
        receiver_name = params.get("ReceiverPartyPublicName", "")
        amount = params.get("TransactionAmount", "")

        receiver_phone = params.get("B2CRecipientIsRegisteredCustomer", "")
        # ReceiverPartyPublicName format: "254712345678 - BONITO CHELUGET SAMOEI"
        clean_name = receiver_name.split(" - ", 1)[1].strip() if " - " in receiver_name else receiver_name

        logger.info(f"B2C Receipt: {mpesa_receipt}, Amount: {amount}, Receiver: {clean_name}, Code: {result_code}")

        # Update phone verification if this was a verification B2C
        try:
            from app.api.routes.traders import _phone_verifications, update_phone_verification
            print(f"B2C VERIFY: ConvID={conversation_id}, name={clean_name}, code={result_code}, pending={list(_phone_verifications.keys())}")
            if result_code == 0:
                for phone, v in list(_phone_verifications.items()):
                    if v.get("conversation_id") == conversation_id:
                        update_phone_verification(phone, clean_name or "UNKNOWN", "verified")
                        logger.info(f"Phone verification updated: {phone} = {clean_name}")
                        break
                else:
                    logger.warning(f"No matching verification found for ConvID {conversation_id}")
        except Exception as ve:
            logger.warning(f"Phone verification update error: {ve}")

        # Find and update the payment record by ConversationID
        if conversation_id and mpesa_receipt:
            stmt = select(Payment).where(
                Payment.mpesa_transaction_id == conversation_id
            )
            r = await db.execute(stmt)
            payment = r.scalar_one_or_none()

            if payment:
                payment.mpesa_transaction_id = mpesa_receipt  # Replace ConversationID with actual receipt
                if receiver_name:
                    payment.sender_name = receiver_name  # Store receiver name
                if result_code == 0:
                    payment.status = PaymentStatus.COMPLETED
                    # Deduct from paybill balance in real-time
                    if payment.amount:
                        adjust_paybill_balance(payment.amount, direction="out")
                else:
                    payment.status = PaymentStatus.FAILED
                    payment.remarks = (payment.remarks or "") + f" | B2C failed: {result_desc}"
                await db.commit()
                logger.info(f"Updated payment with receipt {mpesa_receipt}")
            else:
                logger.warning(f"No payment found for ConversationID {conversation_id}")

    except Exception as e:
        logger.error(f"B2C result processing error: {e}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/b2c/timeout")
async def b2c_timeout(request: Request):
    """B2C timeout callback."""
    data = await request.json()
    logger.warning(f"B2C Timeout: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── Account Balance ───────────────────────────────────────────────

import asyncio
import json as _json
from datetime import datetime, timezone as _tz
from fastapi.responses import StreamingResponse

# In-memory cache: {"available": float, "updated_at": str, "source": str}
_paybill_balance_cache: dict = {}
# SSE subscribers: set of asyncio.Queue
_balance_subscribers: set = set()


def _broadcast_balance():
    """Push current balance to all SSE subscribers."""
    msg = _json.dumps(_paybill_balance_cache)
    dead = set()
    for q in _balance_subscribers:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.add(q)
    _balance_subscribers.difference_update(dead)


def adjust_paybill_balance(amount: float, direction: str = "in"):
    """Adjust cached balance immediately when a payment is processed.
    direction='in' for C2B deposits, 'out' for B2C payouts."""
    global _paybill_balance_cache
    if not _paybill_balance_cache.get("available"):
        return  # No baseline yet — wait for first Safaricom callback
    delta = amount if direction == "in" else -amount
    _paybill_balance_cache["available"] = round(_paybill_balance_cache["available"] + delta, 2)
    _paybill_balance_cache["updated_at"] = datetime.now(_tz.utc).isoformat()
    _paybill_balance_cache["source"] = "realtime"
    _broadcast_balance()


@router.get("/balance/stream")
async def paybill_balance_stream(request: Request):
    """SSE stream — pushes balance update immediately when it changes."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _balance_subscribers.add(queue)

    async def event_generator():
        try:
            # Send current value immediately on connect
            if _paybill_balance_cache:
                yield f"data: {_json.dumps(_paybill_balance_cache)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"  # prevent proxy timeout
        finally:
            _balance_subscribers.discard(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/balance/refresh")
async def refresh_paybill_balance():
    """Trigger Safaricom account balance query. Result arrives via /balance/result."""
    try:
        result = await mpesa_client.query_account_balance()
        logger.info(f"Balance query triggered: {result}")
        return {"status": "queued", "result": result}
    except Exception as e:
        logger.error(f"Balance query failed: {e}")
        return {"status": "error", "detail": str(e)}


@router.get("/balance")
async def get_paybill_balance():
    """Return cached paybill balance."""
    if not _paybill_balance_cache:
        return {"available": None, "updated_at": None, "message": "No balance data yet"}
    return _paybill_balance_cache


@router.post("/balance/result")
async def paybill_balance_result(request: Request):
    """Safaricom callback with account balance result — updates cache and pushes via SSE."""
    global _paybill_balance_cache
    data = await request.json()
    logger.info(f"Balance Result: {data}")

    try:
        result = data.get("Result", {})
        result_code = result.get("ResultCode")
        if result_code == 0:
            params = {}
            for item in result.get("ResultParameters", {}).get("ResultParameter", []):
                params[item.get("Key", "")] = item.get("Value", "")

            # Parse: "Working Account|KES|50.00|50.00|0.00|0.00"
            balance_str = params.get("AccountBalance", "")
            total_available = 0.0
            accounts = {}
            for entry in balance_str.split("&"):
                parts = entry.split("|")
                if len(parts) >= 3:
                    avail = float(parts[2]) if parts[2] else 0
                    total_available += avail
                    accounts[parts[0].strip()] = {
                        "currency": parts[1].strip(),
                        "available": avail,
                        "reserved": float(parts[3]) if len(parts) > 3 and parts[3] else 0,
                    }

            _paybill_balance_cache = {
                "available": total_available,
                "accounts": accounts,
                "updated_at": datetime.now(_tz.utc).isoformat(),
                "source": "safaricom",
            }
            logger.info(f"Paybill balance updated: KES {total_available}")
            _broadcast_balance()
        else:
            logger.warning(f"Balance query failed: code={result_code}, data={data}")
    except Exception as e:
        logger.error(f"Balance result parse error: {e}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/balance/timeout")
async def paybill_balance_timeout(request: Request):
    data = await request.json()
    logger.warning(f"Balance query timeout: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── B2B Callbacks ─────────────────────────────────────────────────

@router.post("/b2b/result")
async def b2b_result(request: Request, db: AsyncSession = Depends(get_db)):
    """B2B result callback — parse outcome and auto-refund wallet if transfer failed."""
    data = await request.json()
    logger.info(f"B2B Result: {data}")
    try:
        result = data.get("Result", data)
        result_code = int(result.get("ResultCode", -1))
        conversation_id = result.get("ConversationID", "")
        originator_id = result.get("OriginatorConversationID", "")
        result_desc = result.get("ResultDesc", "unknown")

        # Find the matching outbound payment
        payment = None
        for cid in [conversation_id, originator_id]:
            if not cid:
                continue
            r = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == cid))
            payment = r.scalar_one_or_none()
            if payment:
                break

        if not payment:
            logger.warning(f"B2B result: no payment found for ConversationID={conversation_id} / OriginatorID={originator_id}")
            return {"ResultCode": 0, "ResultDesc": "Accepted"}

        if result_code == 0:
            if payment.status != PaymentStatus.COMPLETED:
                payment.status = PaymentStatus.COMPLETED
                logger.info(f"B2B payment {payment.id} confirmed: KES {payment.amount} to {payment.destination}")
        else:
            if payment.status == PaymentStatus.FAILED:
                # Already failed and refunded — skip to avoid double-refund on Daraja retry
                logger.warning(f"B2B result: payment {payment.id} already FAILED, skipping duplicate refund")
                return {"ResultCode": 0, "ResultDesc": "Accepted"}
            payment.status = PaymentStatus.FAILED
            logger.warning(
                f"B2B payment {payment.id} FAILED (code {result_code}): {result_desc}. "
                f"Refunding KES {payment.amount} to trader {payment.trader_id}"
            )
            await _refund_failed_withdrawal(
                db, payment.trader_id, payment.amount,
                f"Refund: failed B2B withdrawal — {result_desc}"
            )

        await db.commit()
    except Exception as e:
        logger.error(f"B2B result handler error: {e}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


async def _refund_failed_withdrawal(db: AsyncSession, trader_id: int, amount: float, description: str):
    """Credit back a trader's wallet after a failed B2B/B2C withdrawal.

    Refunds the main withdrawal amount PLUS any platform/settlement fees that
    were charged alongside it (within a 30-second window), since the transfer
    never actually completed.
    """
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import and_

    wallet_r = await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))
    wallet = wallet_r.scalar_one_or_none()
    if not wallet:
        logger.error(f"Refund skipped: no wallet found for trader {trader_id}")
        return

    # Look for platform/settlement fees charged within 30s of the failed withdrawal
    # (they are recorded immediately after the withdrawal debit)
    now = datetime.now(timezone.utc)
    fee_types = [TransactionType.PLATFORM_FEE, TransactionType.SETTLEMENT_FEE]
    fee_r = await db.execute(
        select(WalletTransaction).where(
            and_(
                WalletTransaction.trader_id == trader_id,
                WalletTransaction.transaction_type.in_(fee_types),
                WalletTransaction.created_at >= now - timedelta(seconds=30),
            )
        )
    )
    fee_txns = fee_r.scalars().all()
    fee_total = sum(abs(t.amount) for t in fee_txns)
    total_refund = amount + fee_total

    # Mark the matching pending WITHDRAWAL wallet transaction as failed
    withdrawal_r = await db.execute(
        select(WalletTransaction).where(
            and_(
                WalletTransaction.trader_id == trader_id,
                WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
                WalletTransaction.status == "pending",
                WalletTransaction.created_at >= now - timedelta(seconds=30),
            )
        ).order_by(WalletTransaction.created_at.desc()).limit(1)
    )
    withdrawal_txn = withdrawal_r.scalar_one_or_none()
    if withdrawal_txn:
        withdrawal_txn.status = "failed"

    wallet.balance += total_refund
    if wallet.total_withdrawn >= amount:
        wallet.total_withdrawn -= amount

    txn = WalletTransaction(
        trader_id=trader_id,
        wallet_id=wallet.id,
        transaction_type=TransactionType.ADJUSTMENT,
        amount=total_refund,
        balance_after=wallet.balance,
        description=f"{description} (incl. KES {fee_total:.2f} fees)" if fee_total > 0 else description,
        status="completed",
    )
    db.add(txn)
    logger.info(f"Refunded KES {total_refund} (withdrawal={amount}, fees={fee_total}) to trader {trader_id}. New balance: {wallet.balance}")


@router.post("/b2b/timeout")
async def b2b_timeout(request: Request, db: AsyncSession = Depends(get_db)):
    """B2B timeout — treat as failed and refund the trader's wallet."""
    data = await request.json()
    logger.warning(f"B2B Timeout: {data}")
    try:
        originator_id = data.get("OriginatorConversationID", "")
        conversation_id = data.get("ConversationID", "")
        payment = None
        for cid in [conversation_id, originator_id]:
            if not cid:
                continue
            r = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == cid))
            payment = r.scalar_one_or_none()
            if payment:
                break
        if payment and payment.status != PaymentStatus.FAILED:
            payment.status = PaymentStatus.FAILED
            await _refund_failed_withdrawal(
                db, payment.trader_id, payment.amount,
                "Refund: B2B payment timeout — Safaricom did not confirm transfer"
            )
            await db.commit()
            logger.warning(f"B2B timeout refund: KES {payment.amount} to trader {payment.trader_id}")
    except Exception as e:
        logger.error(f"B2B timeout handler error: {e}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── Transaction Status Callbacks (used for payment resolution) ─────

@router.post("/status/result")
async def transaction_status_result(request: Request, db: AsyncSession = Depends(get_db)):
    """Safaricom Transaction Status callback — used to verify unmatched payments."""
    from app.api.routes.admin import _pending_resolutions
    data = await request.json()
    logger.info(f"Transaction Status Result: {data}")

    try:
        result = data.get("Result", {})
        result_code = result.get("ResultCode")

        # Extract the original transaction ID from the result
        params = {}
        for item in result.get("ResultParameters", {}).get("ResultParameter", []):
            params[item.get("Key", "")] = item.get("Value", "")

        original_ref = params.get("OriginalTransactionID", "") or result.get("TransactionID", "")
        safaricom_amount = float(params.get("Amount", 0))

        pending = _pending_resolutions.get(original_ref)
        if not pending:
            logger.warning(f"No pending resolution for {original_ref}")
            return {"ResultCode": 0, "ResultDesc": "Accepted"}

        if result_code != 0:
            pending["status"] = "failed"
            pending["message"] = f"Safaricom could not verify this transaction: {result.get('ResultDesc', 'Unknown error')}"
            logger.warning(f"Resolution failed for {original_ref}: {result.get('ResultDesc')}")
            return {"ResultCode": 0, "ResultDesc": "Accepted"}

        # Amount tolerance check (±5 KES)
        expected = pending["amount"]
        if abs(safaricom_amount - expected) > 5:
            pending["status"] = "failed"
            pending["message"] = f"Amount mismatch: Safaricom shows KES {safaricom_amount:,.0f} but you entered KES {expected:,.0f}"
            logger.warning(f"Amount mismatch for {original_ref}: expected {expected}, got {safaricom_amount}")
            return {"ResultCode": 0, "ResultDesc": "Accepted"}

        # Final duplicate check before crediting
        existing = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == original_ref))
        if existing.scalar_one_or_none():
            pending["status"] = "failed"
            pending["message"] = "This transaction has already been credited."
            return {"ResultCode": 0, "ResultDesc": "Accepted"}

        # Credit wallet
        trader_id = pending["trader_id"]
        sender_name = params.get("DebitPartyName", "")

        result_q = await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))
        wallet = result_q.scalar_one_or_none()
        if not wallet:
            wallet = Wallet(trader_id=trader_id, balance=0, reserved=0)
            db.add(wallet)
            await db.flush()

        wallet.balance += safaricom_amount
        wallet.total_earned += safaricom_amount

        txn = WalletTransaction(
            trader_id=trader_id,
            wallet_id=wallet.id,
            transaction_type=TransactionType.DEPOSIT,
            amount=safaricom_amount,
            balance_after=wallet.balance,
            description=f"Resolved deposit - verified by Safaricom",
            mpesa_receipt=original_ref,
            status="completed",
        )
        db.add(txn)

        payment = Payment(
            trader_id=trader_id,
            direction=PaymentDirection.INBOUND,
            transaction_type="C2B",
            amount=safaricom_amount,
            phone="",
            sender_name=sender_name,
            bill_ref_number="RESOLVED",
            mpesa_transaction_id=original_ref,
            status=PaymentStatus.COMPLETED,
        )
        db.add(payment)
        await db.commit()

        # Adjust paybill balance
        adjust_paybill_balance(safaricom_amount, direction="in")

        # Notify trader
        try:
            from app.api.routes.traders import add_notification
            add_notification(trader_id, f"Deposit Resolved: KES {safaricom_amount:,.0f}",
                             f"Your wallet has been credited. Receipt: {original_ref}", "payment")
        except Exception:
            pass

        pending["status"] = "credited"
        pending["credited_amount"] = safaricom_amount
        pending["message"] = f"✓ Verified by Safaricom. KES {safaricom_amount:,.0f} credited to trader's wallet."
        logger.info(f"Resolved payment {original_ref}: KES {safaricom_amount} credited to trader {trader_id}")

    except Exception as e:
        logger.error(f"Transaction status result error: {e}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/status/timeout")
async def transaction_status_timeout(request: Request):
    data = await request.json()
    logger.warning(f"Transaction Status Timeout: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── STK Push Callback ─────────────────────────────────────────────

@router.post("/stkpush/callback")
async def stk_push_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """STK Push result callback. Routes subscription payments to subscription handler."""
    data = await request.json()
    logger.info(f"STK Push Callback: {data}")

    body = data.get("Body", {}).get("stkCallback", {})
    result_code = body.get("ResultCode")
    checkout_id = body.get("CheckoutRequestID", "")

    if checkout_id:
        # Check if this is a subscription payment
        from app.models.subscription import Subscription, SubscriptionStatus
        from datetime import datetime, timedelta, timezone as tz
        result = await db.execute(
            select(Subscription).where(Subscription.mpesa_checkout_id == checkout_id)
        )
        sub = result.scalar_one_or_none()
        if sub:
            if result_code == 0:
                now = datetime.now(tz.utc)
                sub.status = SubscriptionStatus.ACTIVE
                sub.started_at = now
                sub.expires_at = now + timedelta(days=30)

                # Extract receipt number
                metadata = body.get("CallbackMetadata", {}).get("Item", [])
                for item in metadata:
                    if item.get("Name") == "MpesaReceiptNumber":
                        sub.mpesa_transaction_id = item.get("Value")
                        break

                # Update trader tier
                trader_result = await db.execute(
                    select(Trader).where(Trader.id == sub.trader_id)
                )
                trader = trader_result.scalar_one_or_none()
                if trader:
                    from app.models.subscription import SubscriptionPlan
                    tier_map = {"starter": "standard", "pro": "pro"}
                    trader.tier = tier_map.get(sub.plan.value, "standard")

                await db.commit()
                logger.info(f"Subscription {sub.id} activated via STK callback")

                # Send activation email
                if trader:
                    from app.services.email import send_subscription_activated
                    send_subscription_activated(
                        trader.email, trader.full_name,
                        sub.plan.value,
                        sub.expires_at.strftime("%B %d, %Y") if sub.expires_at else "30 days",
                    )
            else:
                sub.status = SubscriptionStatus.EXPIRED
                await db.commit()
                logger.warning(f"Subscription {sub.id} payment failed via STK callback: code={result_code}")

            return {"ResultCode": 0, "ResultDesc": "Accepted"}

    return {"ResultCode": 0, "ResultDesc": "Accepted"}
