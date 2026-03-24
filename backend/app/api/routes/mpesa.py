import logging

from fastapi import APIRouter, Request, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.matching.engine import MatchingEngine
from app.services.settlement.engine import SettlementEngine
from app.models import Order, OrderStatus, Trader
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
    if bill_ref.startswith("P2P-"):
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
            # Payment matched — trigger auto-release
            await _trigger_auto_release(order, db)
    elif bill_ref.startswith("DEP-"):
        # This is a wallet deposit (manual Paybill payment)
        # Extract trader ID from account reference: DEP-{trader_id}
        try:
            trader_id = int(bill_ref.split("-")[1])
            await _credit_wallet_deposit(trader_id, amount, txn_id, phone, sender_name, db)
        except (ValueError, IndexError):
            logger.error(f"Invalid deposit reference: {bill_ref}")
    else:
        # Not a P2P payment — forward to existing website handler if needed
        logger.info(f"Non-P2P payment received: ref={bill_ref}, amount={amount}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


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

    # Record transaction
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
    await db.commit()

    logger.info(f"Deposit credited: KES {amount} to trader {trader_id} (ref: {mpesa_txn_id})")

    # Send email notification
    try:
        from app.services.email import send_deposit_received
        send_deposit_received(trader.email, trader.full_name, amount, wallet.balance)
    except Exception as e:
        logger.error(f"Failed to send deposit email: {e}")


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

        # Record fee transaction
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
async def b2c_result(request: Request):
    """B2C result callback — payment to trader's M-Pesa completed."""
    data = await request.json()
    logger.info(f"B2C Result: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/b2c/timeout")
async def b2c_timeout(request: Request):
    """B2C timeout callback."""
    data = await request.json()
    logger.warning(f"B2C Timeout: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── B2B Callbacks ─────────────────────────────────────────────────

@router.post("/b2b/result")
async def b2b_result(request: Request):
    """B2B result callback — payment to bank/paybill/till completed."""
    data = await request.json()
    logger.info(f"B2B Result: {data}")
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/b2b/timeout")
async def b2b_timeout(request: Request):
    """B2B timeout callback."""
    data = await request.json()
    logger.warning(f"B2B Timeout: {data}")
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
