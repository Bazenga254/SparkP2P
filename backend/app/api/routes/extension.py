"""
Extension <-> VPS API routes.

The Chrome extension is the trading engine: it polls Binance for orders,
reports them here, and executes actions (release, mark-as-paid, send message)
that the VPS tells it to perform.

Flow:
  1. Extension polls Binance every ~10s (from user's browser = correct IP)
  2. Extension POSTs order data to /api/ext/report-orders
  3. VPS matches M-Pesa payments, returns actions (release, pay, message)
  4. Extension executes actions on Binance
  5. Extension reports results back to VPS
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models import Order, OrderSide, OrderStatus, Trader, Payment, PaymentStatus, PaymentDirection
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.im_sweep import ImSweep
from app.models.batch import WithdrawalBatch, BatchItem
from app.services.settlement.engine import SettlementEngine
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────

class BinanceOrderData(BaseModel):
    orderNumber: str = ""
    advNo: Optional[str] = None
    tradeType: str = "SELL"
    totalPrice: float = 0
    amount: float = 0
    price: float = 0
    asset: str = "USDT"
    buyerNickname: Optional[str] = None
    sellerNickname: Optional[str] = None
    orderStatus: Optional[int] = None  # 1=pending, 2=buyer paid, 3=releasing
    sellerPaymentMethod: Optional[str] = None
    sellerPaymentPhone: Optional[str] = None
    sellerPaymentAccount: Optional[str] = None
    counterparty: Optional[str] = None


class ReportOrdersRequest(BaseModel):
    sell_orders: list[BinanceOrderData] = []
    buy_orders: list[BinanceOrderData] = []
    cancelled_order_numbers: list[str] = []       # Order numbers from Binance Cancelled history tab
    completed_buy_order_numbers: list[str] = []   # BUY order numbers from Binance Completed history tab
    active_order_numbers: list[str] = []          # Orders bot is actively processing (never auto-cancel these)


class ActionItem(BaseModel):
    action: str  # "release", "pay", "send_message"
    order_number: str
    message: Optional[str] = None


class ReportReleaseRequest(BaseModel):
    order_number: str
    success: bool
    error: Optional[str] = None


class ReportPaymentSentRequest(BaseModel):
    order_number: str
    success: bool
    error: Optional[str] = None


class ReportMessageSentRequest(BaseModel):
    order_number: str
    success: bool


# ── Routes ───────────────────────────────────────────────────────

@router.post("/report-orders")
async def report_orders(
    data: ReportOrdersRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension reports current Binance orders to VPS.
    VPS stores/updates them and returns actions the extension should execute.
    """
    actions: list[dict] = []

    # Process sell orders (buyer pays us KES, we release crypto)
    for order_data in data.sell_orders:
        action = await _process_reported_sell_order(order_data, trader, db)
        if action:
            actions.append(action)

    # Process buy orders (we pay seller KES, seller releases crypto to us)
    for order_data in data.buy_orders:
        action = await _process_reported_buy_order(order_data, trader, db)
        if action:
            actions.append(action)

    # Mark explicitly cancelled orders (read from Binance Cancelled history tab)
    for order_number in data.cancelled_order_numbers:
        cancel_result = await db.execute(
            select(Order).where(
                Order.binance_order_number == order_number,
                Order.trader_id == trader.id,
                Order.status == OrderStatus.PENDING,
            )
        )
        cancelled_order = cancel_result.scalar_one_or_none()
        if cancelled_order:
            cancelled_order.status = OrderStatus.CANCELLED
            cancelled_order.cancelled_at = datetime.now(timezone.utc)
            logger.info(f"Order {order_number} marked CANCELLED (from Binance history tab)")

    # Mark completed buy orders (seller released crypto — from Binance Completed history tab)
    for order_number in data.completed_buy_order_numbers:
        comp_result = await db.execute(
            select(Order).where(
                Order.binance_order_number == order_number,
                Order.trader_id == trader.id,
                Order.side == OrderSide.BUY,
                Order.status == OrderStatus.PAYMENT_SENT,
            )
        )
        completed_order = comp_result.scalar_one_or_none()
        if completed_order:
            await _complete_buy_order(completed_order, trader, db)

    # Also auto-cancel PENDING orders absent from the active list for >3 minutes
    # (fallback in case the cancelled tab scan misses something)
    # Never auto-cancel orders the bot is actively processing on the order detail page
    reported_numbers = {o.orderNumber for o in data.sell_orders + data.buy_orders}
    protected_numbers = set(data.active_order_numbers)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=3)
    stale_result = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status == OrderStatus.PENDING,
            Order.created_at < cutoff,
        )
    )
    for order in stale_result.scalars().all():
        if order.binance_order_number not in reported_numbers and \
           order.binance_order_number not in protected_numbers:
            order.status = OrderStatus.CANCELLED
            order.cancelled_at = datetime.now(timezone.utc)
            logger.info(
                f"Order {order.binance_order_number} auto-cancelled "
                f"(absent from bot report for trader {trader.id})"
            )

    # Reactivate any order the bot is actively processing that got wrongly cancelled
    for order_number in protected_numbers:
        react_result = await db.execute(
            select(Order).where(
                Order.trader_id == trader.id,
                Order.binance_order_number == order_number,
                Order.status == OrderStatus.CANCELLED,
            )
        )
        reactivate = react_result.scalar_one_or_none()
        if reactivate:
            reactivate.status = OrderStatus.PENDING
            logger.info(f"Order {order_number} reactivated — bot is actively processing it on Binance")

    # Update last sync timestamp — used by frontend to detect initial scan complete
    trader.last_extension_sync = datetime.now(timezone.utc)
    await db.commit()

    return {"actions": actions}


@router.post("/report-release")
async def report_release(
    data: ReportReleaseRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Extension reports that it released crypto on Binance."""
    result = await db.execute(
        select(Order).where(
            Order.binance_order_number == data.order_number,
            Order.trader_id == trader.id,
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if data.success:
        order.status = OrderStatus.RELEASED
        order.released_at = datetime.now(timezone.utc)
        await db.commit()

        logger.info(f"Order {data.order_number} released via extension for trader {trader.full_name}")

        # Notify trader
        from app.api.routes.traders import add_notification
        add_notification(
            trader.id,
            f"Crypto Released: {order.crypto_amount} {order.crypto_currency}",
            f"Order {data.order_number} — KES {order.fiat_amount:,.0f} at rate {order.exchange_rate}",
            "release"
        )

        # Send SMS notification
        try:
            from app.services.sms import send_sms
            send_sms(
                trader.phone,
                f"SparkP2P: Order complete! {order.crypto_amount} {order.crypto_currency} released. "
                f"KES {order.fiat_amount:,.0f} credited to your wallet. Ref: {data.order_number[-8:]}"
            )
        except Exception as e:
            logger.warning(f"SMS notification failed: {e}")

        # Trigger settlement
        settlement = SettlementEngine(db)
        if trader.batch_settlement_enabled:
            await settlement.auto_settle_if_threshold(trader.id)
        else:
            await settlement.settle_order(order)
    else:
        logger.error(
            f"Extension failed to release order {data.order_number}: {data.error}"
        )
        order.status = OrderStatus.DISPUTED
        await db.commit()

    return {"status": "ok"}


@router.post("/report-payment-sent")
async def report_payment_sent(
    data: ReportPaymentSentRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Extension reports that it marked order as paid on Binance (buy side)."""
    result = await db.execute(
        select(Order).where(
            Order.binance_order_number == data.order_number,
            Order.trader_id == trader.id,
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if data.success:
        order.status = OrderStatus.PAYMENT_SENT
        order.payment_sent_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"Buy order {data.order_number} marked as paid via extension")
    else:
        logger.error(
            f"Extension failed to mark order {data.order_number} as paid: {data.error}"
        )

    return {"status": "ok"}


@router.post("/report-message-sent")
async def report_message_sent(
    data: ReportMessageSentRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Extension reports that it sent a chat message on Binance."""
    if data.success:
        logger.info(f"Chat message sent for order {data.order_number} via extension")
    else:
        logger.warning(f"Failed to send chat message for order {data.order_number}")
    return {"status": "ok"}


class ReportBuyCompletedRequest(BaseModel):
    order_number: str


@router.post("/report-buy-completed")
async def report_buy_completed(
    data: ReportBuyCompletedRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app reports that a buy order has completed on Binance
    (seller released crypto to buyer's wallet).
    Can be called directly when the desktop app detects completion in real time,
    as an alternative to waiting for the next idle scan.
    """
    result = await db.execute(
        select(Order).where(
            Order.binance_order_number == data.order_number,
            Order.trader_id == trader.id,
            Order.side == OrderSide.BUY,
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Buy order not found")

    if order.status == OrderStatus.COMPLETED:
        return {"status": "ok", "message": "Already completed"}

    if order.status != OrderStatus.PAYMENT_SENT:
        logger.warning(
            f"report-buy-completed called for order {data.order_number} "
            f"in unexpected status {order.status}"
        )

    await _complete_buy_order(order, trader, db)
    await db.commit()

    return {"status": "ok"}


class ReportBuyExpiredRequest(BaseModel):
    order_number: str
    seller_name: str = "Unknown"
    amount: float = 0
    minutes_waited: int = 0


@router.post("/report-buy-expired")
async def report_buy_expired(
    data: ReportBuyExpiredRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app reports that a buy order expired or was cancelled AFTER we already
    sent KES to the seller — meaning we paid but never received crypto.
    Marks the order DISPUTED and fires urgent alerts so the trader can appeal on Binance.
    """
    result = await db.execute(
        select(Order).where(
            Order.binance_order_number == data.order_number,
            Order.trader_id == trader.id,
            Order.side == OrderSide.BUY,
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Buy order not found")

    if order.status == OrderStatus.DISPUTED:
        return {"status": "ok", "message": "Already disputed"}

    if order.status == OrderStatus.COMPLETED:
        return {"status": "ok", "message": "Order already completed — no dispute needed"}

    order.status = OrderStatus.DISPUTED
    await db.commit()

    logger.error(
        f"🚨 Buy order {data.order_number} EXPIRED after payment — "
        f"trader {trader.full_name} paid KES {order.fiat_amount:,.0f} but received no crypto!"
    )

    # Urgent in-app notification
    try:
        from app.api.routes.traders import add_notification
        add_notification(
            trader.id,
            f"⚠️ Action Required — Buy Order {data.order_number[-8:]}",
            (
                f"Your bot has paused your buy ad. You sent KES {order.fiat_amount:,.0f} "
                f"to {data.seller_name or 'the seller'} for {order.crypto_amount} {order.crypto_currency} "
                f"but the crypto has not been released. Please log into Binance and resolve order {data.order_number}."
            ),
            "dispute",
        )
    except Exception as e:
        logger.warning(f"Failed to send in-app notification for expired buy order: {e}")

    # Urgent SMS
    try:
        from app.services.sms import send_sms
        send_sms(
            trader.phone,
            f"SparkP2P ALERT: Your buy ad has been paused. You sent KES {order.fiat_amount:,.0f} "
            f"to {data.seller_name or 'a seller'} but crypto was NOT released. "
            f"Log into Binance & resolve order ...{data.order_number[-8:]}",
        )
    except Exception as e:
        logger.warning(f"SMS failed for expired buy order {data.order_number}: {e}")

    # Email notification with full dispute details
    try:
        from app.services.email import send_email
        seller = data.seller_name or "Unknown"
        kes_amount = data.amount or (order.fiat_amount if order else 0)
        crypto_amount = order.crypto_amount if order else "?"
        crypto_currency = order.crypto_currency if order else "USDT"
        mins = data.minutes_waited or 0
        html = f"""
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#ffffff">
          <div style="background:#f97316;padding:16px 20px;border-radius:8px 8px 0 0">
            <h2 style="color:#ffffff;margin:0;font-size:18px">&#9888;&nbsp; SparkP2P — Your Buy Ad Has Been Paused</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
            <p style="margin-top:0">Hi <strong>{trader.full_name}</strong>,</p>
            <p>Your SparkP2P bot has detected that a buy order was not fulfilled after payment was sent.
            To protect your funds, <strong>your buy ad has been automatically paused</strong> until you review and resolve this order.</p>

            <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
              <tr style="background:#fef3c7"><td style="padding:10px 14px;font-weight:600;width:40%">Order Number</td><td style="padding:10px 14px;font-family:monospace">{data.order_number}</td></tr>
              <tr><td style="padding:10px 14px;font-weight:600">Amount Sent</td><td style="padding:10px 14px;color:#dc2626;font-weight:600">KES {kes_amount:,.0f}</td></tr>
              <tr style="background:#fef3c7"><td style="padding:10px 14px;font-weight:600">Crypto Expected</td><td style="padding:10px 14px">{crypto_amount} {crypto_currency}</td></tr>
              <tr><td style="padding:10px 14px;font-weight:600">Seller</td><td style="padding:10px 14px">{seller}</td></tr>
              <tr style="background:#fef3c7"><td style="padding:10px 14px;font-weight:600">Time Elapsed</td><td style="padding:10px 14px">{mins} minutes without release</td></tr>
            </table>

            <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:14px 18px;border-radius:4px;margin:20px 0">
              <p style="margin:0 0 10px 0;font-weight:600;color:#991b1b">Required Action</p>
              <ol style="margin:0;padding-left:18px;color:#374151;line-height:1.8">
                <li>Log into your <strong>Binance account</strong></li>
                <li>Navigate to <strong>P2P → Orders</strong> and locate order <code style="background:#fee2e2;padding:2px 6px;border-radius:3px">{data.order_number}</code></li>
                <li>Click <strong>Appeal</strong> and select <em>"I have made a payment but the seller has not released the crypto"</em></li>
                <li>Submit supporting evidence (your I&amp;M Bank payment receipt)</li>
                <li>Once resolved, return to <strong>SparkP2P → Settings</strong> to re-enable your buy ad</li>
              </ol>
            </div>

            <p style="color:#6b7280;font-size:13px">Your sell ad is still active. Only the buy ad has been paused to prevent additional exposure while this issue is being resolved.</p>
          </div>
          <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:16px">SparkP2P Automated Alert &middot; Do not reply to this email</p>
        </div>"""
        send_email(
            trader.email,
            f"[SparkP2P] Buy Ad Paused — Order {data.order_number[-8:]} Requires Your Attention",
            html,
        )
    except Exception as e:
        logger.warning(f"Email failed for expired buy order {data.order_number}: {e}")

    return {"status": "ok"}


@router.get("/pending-actions")
async def get_pending_actions(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension polls this to check for orders needing action.
    Returns orders where payment_received but not yet released,
    or buy-side orders needing payment.
    """
    actions: list[dict] = []

    # Sell side: payment received, needs release
    result = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.side == OrderSide.SELL,
            Order.status == OrderStatus.PAYMENT_RECEIVED,
        )
    )
    for order in result.scalars().all():
        if trader.auto_release_enabled:
            actions.append({
                "action": "release",
                "order_number": order.binance_order_number,
            })

    # Buy side: orders where VPS already sent B2C payment, extension needs to mark as paid
    result = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.side == OrderSide.BUY,
            Order.status == OrderStatus.PAYMENT_SENT,
        )
    )
    for order in result.scalars().all():
        actions.append({
            "action": "mark_as_paid",
            "order_number": order.binance_order_number,
        })

    return {"actions": actions}


class VerifyPaymentData(BaseModel):
    binance_order_number: str
    fiat_amount: float  # Expected KES amount from Binance order
    mpesa_codes_from_chat: Optional[List[str]] = None  # M-Pesa codes extracted from the buyer's chat messages


@router.post("/verify-payment")
async def verify_payment(
    data: VerifyPaymentData,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Bot calls this BEFORE releasing crypto on a SELL order.
    Checks that a real M-Pesa payment was received via Safaricom C2B callback.
    Returns verified=True only if the payment was matched and confirmed by Safaricom.
    This prevents releasing crypto when a buyer fake-clicks "I have paid".
    """
    # ── Step 1: Try direct M-Pesa code lookup from buyer's chat message ──────
    # Query by transaction ID only — no status filter in WHERE because the DB
    # stores status as uppercase ('COMPLETED') while the Python enum value is
    # lowercase ('completed'), causing SQLAlchemy to produce an invalid enum
    # comparison that silently returns no rows. Status is checked in Python.
    if data.mpesa_codes_from_chat:
        for code in data.mpesa_codes_from_chat:
            pay_result = await db.execute(
                select(Payment).where(Payment.mpesa_transaction_id == code)
            )
            direct_payment = pay_result.scalar_one_or_none()
            if direct_payment:
                # Accept any completed-like status (handles DB/enum case mismatch)
                status_val = str(direct_payment.status).upper().replace('PAYMENTSTATUS.', '')
                if status_val not in ('COMPLETED', 'PAYMENT_RECEIVED'):
                    continue
                logger.info(f"M-Pesa code {code} matched directly in Payment table for order {data.binance_order_number}")
                return {
                    "verified": True,
                    "reason": f"M-Pesa code {code} confirmed in our records",
                    "mpesa_receipt": code,
                    "amount_received": direct_payment.amount,
                    "payer_phone": direct_payment.phone,
                    "payer_name": direct_payment.sender_name,
                }

    # ── Step 2: Amount + time-window match against Payment table ─────────────
    # Runs ALWAYS when fiat_amount is provided. No status filter in WHERE for
    # same reason as Step 1 (DB/enum case mismatch). Extended to 24h window
    # so payments made earlier in the day are still matched.
    if data.fiat_amount:
        window = datetime.now(timezone.utc) - timedelta(hours=24)
        amount_result = await db.execute(
            select(Payment).where(
                Payment.trader_id == trader.id,
                Payment.amount.between(data.fiat_amount - 5, data.fiat_amount + 5),
                Payment.created_at >= window,
                Payment.direction == PaymentDirection.INBOUND,
            ).order_by(Payment.id.desc())
        )
        for row in amount_result.scalars().all():
            status_val = str(row.status).upper().replace('PAYMENTSTATUS.', '')
            if status_val in ('COMPLETED', 'PAYMENT_RECEIVED'):
                logger.info(f"M-Pesa payment matched by amount KES {data.fiat_amount} for order {data.binance_order_number}")
                return {
                    "verified": True,
                    "reason": f"M-Pesa payment matched by amount KES {data.fiat_amount}",
                    "mpesa_receipt": row.mpesa_transaction_id,
                    "amount_received": row.amount,
                    "payer_phone": row.phone,
                    "payer_name": row.sender_name,
                }

    # ── Step 3: Order-status check ────────────────────────────────────────────
    result = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.binance_order_number == data.binance_order_number,
            Order.side == OrderSide.SELL,
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        return {
            "verified": False,
            "reason": f"Order {data.binance_order_number} not found in our system. No M-Pesa payment received.",
        }

    # If status is PAYMENT_RECEIVED/RELEASED/COMPLETED the C2B callback matched it
    if order.status in (OrderStatus.PAYMENT_RECEIVED, OrderStatus.RELEASED, OrderStatus.COMPLETED):
        pay_result = await db.execute(
            select(Payment).where(
                Payment.order_id == order.id,
                Payment.status == PaymentStatus.COMPLETED,
            ).order_by(Payment.id.desc())
        )
        payment = pay_result.scalar_one_or_none()
        if payment and abs(payment.amount - data.fiat_amount) > 5:
            return {
                "verified": False,
                "reason": f"Amount mismatch: expected KES {data.fiat_amount}, received KES {payment.amount}.",
            }
        return {
            "verified": True,
            "reason": "M-Pesa payment confirmed by Safaricom C2B callback",
            "mpesa_receipt": payment.mpesa_transaction_id if payment else None,
            "amount_received": payment.amount if payment else order.fiat_amount,
            "payer_phone": payment.phone if payment else None,
            "payer_name": payment.sender_name if payment else None,
        }

    # Order exists but no payment matched — tell the bot to wait
    return {
        "verified": False,
        "reason": f"No M-Pesa payment received yet. Order status: {order.status.value}.",
    }


@router.post("/heartbeat")
async def heartbeat(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension sends heartbeat every 30 seconds.
    Updates last_seen timestamp and clears intentional-stop flag.
    """
    trader.updated_at = datetime.now(timezone.utc)
    trader.bot_intentionally_stopped = False
    await db.commit()
    return {"status": "ok", "trader_id": trader.id}


@router.post("/bot-stopped")
async def bot_stopped(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this on graceful quit.
    Suppresses offline alerts in bot_monitor until the next heartbeat.
    """
    trader.bot_intentionally_stopped = True
    await db.commit()
    return {"status": "ok"}


class BinanceAccountData(BaseModel):
    balances: list = []
    completed_orders: list = []
    active_ads: list = []
    payment_methods: list = []


@router.post("/report-account-data")
async def report_account_data(
    data: BinanceAccountData,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Extension reports Binance account data (completed orders, ads, etc.)
    This data is displayed on the SparkP2P dashboard."""
    import json

    # Store as JSON in trader's record (or a separate table)
    # For now, store in a simple cache approach
    cache_data = {
        "balances": data.balances,
        "completed_orders": data.completed_orders[:20],
        "active_ads": data.active_ads,
        "payment_methods": data.payment_methods,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Store in trader's metadata (reuse fraud_check_result field or add new)
    # Let's use a simple approach — store as JSON in a known location
    from app.models.wallet import Wallet
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    # We'll store binance data in the trader's updated_at as a signal
    # and cache in memory. For persistence, let's use a simple DB approach.
    # Store serialized in trader record
    trader.updated_at = datetime.now(timezone.utc)
    await db.commit()

    # Store in local file cache on VPS
    import os
    cache_dir = "/tmp/sparkp2p_cache"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, f"trader_{trader.id}_binance.json")
    with open(cache_file, "w") as f:
        json.dump(cache_data, f)

    logger.info(f"Stored Binance account data for trader {trader.id}: {len(data.completed_orders)} orders, {len(data.active_ads)} ads")
    return {"status": "ok"}


class MarketPriceData(BaseModel):
    buy_prices: list = []
    sell_prices: list = []
    best_buy: float = 0
    best_sell: float = 0
    spread: float = 0
    total_ads_scanned: int = 0
    timestamp: str = ""


# In-memory market prices per trader
_market_prices: dict[int, dict] = {}


@router.post("/market-prices")
async def report_market_prices(
    data: MarketPriceData,
    trader: Trader = Depends(get_current_trader),
):
    """Desktop bot reports current market prices from P2P page."""
    _market_prices[trader.id] = {
        "buy_prices": data.buy_prices[:5],
        "sell_prices": data.sell_prices[:5],
        "best_buy": data.best_buy,
        "best_sell": data.best_sell,
        "spread": data.spread,
        "total_ads_scanned": data.total_ads_scanned,
        "timestamp": data.timestamp,
    }
    return {"status": "ok"}


@router.get("/market-prices")
async def get_market_prices(
    trader: Trader = Depends(get_current_trader),
):
    """Get current market prices for spread calculator."""
    return _market_prices.get(trader.id, {
        "best_buy": 0, "best_sell": 0, "spread": 0,
        "buy_prices": [], "sell_prices": [],
    })


@router.get("/my-ad-prices")
async def get_my_ad_prices(
    trader: Trader = Depends(get_current_trader),
):
    """
    Return trader's current Binance P2P ad prices for the spread calculator.
    Vision-scraped prices (updated every ~1 min by the desktop bot) take priority.
    Falls back to Binance API if Vision prices are not available.
    """
    # Return Vision-scraped prices if they exist (fresh data from desktop bot)
    if trader.ad_buy_price or trader.ad_sell_price:
        return {
            "buy": trader.ad_buy_price,
            "sell": trader.ad_sell_price,
            "connected": bool(trader.binance_connected),
            "source": "vision",
            "updated_at": trader.ad_prices_updated_at.isoformat() if trader.ad_prices_updated_at else None,
        }

    # Fallback: fetch via Binance API
    if not trader.binance_connected or not trader.binance_cookies:
        return {"buy": None, "sell": None, "connected": False}
    try:
        from app.services.binance.client import BinanceP2PClient, BinanceSessionExpired
        client = BinanceP2PClient.from_trader(trader)
        ads = await client.get_my_ads()
        buy_price = None
        sell_price = None
        for ad in ads:
            trade_type = (ad.get("tradeType") or ad.get("advType") or "").upper()
            price = ad.get("price") or (ad.get("adv", {}) or {}).get("price")
            try:
                price = float(price) if price else None
            except (ValueError, TypeError):
                price = None
            if price:
                if trade_type == "BUY" and buy_price is None:
                    buy_price = price
                elif trade_type == "SELL" and sell_price is None:
                    sell_price = price
        return {"buy": buy_price, "sell": sell_price, "connected": True, "source": "api"}
    except Exception as e:
        return {"buy": None, "sell": None, "connected": True, "error": str(e)}


class AdPricesReport(BaseModel):
    buy: Optional[float] = None
    sell: Optional[float] = None


@router.post("/report-ad-prices")
async def report_ad_prices(
    data: AdPricesReport,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Called by the desktop bot every ~1 min after Vision-scraping the My Ads page.
    Stores the trader's current buy/sell ad prices for the spread calculator.
    """
    if data.buy is not None:
        trader.ad_buy_price = data.buy
    if data.sell is not None:
        trader.ad_sell_price = data.sell
    trader.ad_prices_updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "buy": trader.ad_buy_price, "sell": trader.ad_sell_price}


@router.get("/account-data")
async def get_account_data(
    trader: Trader = Depends(get_current_trader),
):
    """Get cached Binance account data for display on dashboard."""
    import json, os

    cache_file = f"/tmp/sparkp2p_cache/trader_{trader.id}_binance.json"
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            return json.load(f)
    return {"balances": [], "completed_orders": [], "active_ads": [], "payment_methods": [], "updated_at": None}


class VerifyIdentityData(BaseModel):
    p2p_real_name: str = ""


@router.post("/verify-identity")
async def verify_identity(
    data: VerifyIdentityData,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop bot scans the real name from Binance P2P payment methods after login.
    We compare it against the registered full_name to detect account switching fraud.
    """
    p2p_name = " ".join(data.p2p_real_name.strip().upper().split())
    registered_name = " ".join((trader.full_name or "").strip().upper().split())

    if not p2p_name:
        return {"verified": True, "message": "No name found, skipping check"}

    if p2p_name != registered_name:
        logger.warning(
            f"Identity mismatch for trader {trader.id} ({trader.email}): "
            f"Binance P2P name='{p2p_name}', registered='{registered_name}'"
        )
        return {
            "verified": False,
            "message": f"The Binance account name '{p2p_name}' does not match your registered name '{registered_name}'. Please log in with your own Binance account."
        }

    # Save the verified name on the trader record
    trader.binance_username = p2p_name
    trader.updated_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info(f"Identity verified for trader {trader.id}: {p2p_name}")
    return {"verified": True, "message": "Identity verified"}


# ── Internal helpers ──────────────────────────────────────────────

async def _complete_buy_order(order: Order, trader: Trader, db: AsyncSession) -> None:
    """
    Mark a buy order as completed — seller has released crypto to the buyer's Binance wallet.
    Called when the desktop app reports the order in the Completed history tab.
    The KES was already debited when B2C was sent, so no wallet changes are needed here.
    """
    order.status = OrderStatus.COMPLETED
    order.settled_at = datetime.now(timezone.utc)

    # Update trader lifetime stats
    trader.total_trades += 1
    trader.total_volume += order.fiat_amount

    logger.info(
        f"Buy order {order.binance_order_number} COMPLETED — "
        f"{order.crypto_amount} {order.crypto_currency} received by trader {trader.full_name}"
    )

    # In-app notification
    try:
        from app.api.routes.traders import add_notification
        add_notification(
            trader.id,
            f"Buy Complete: {order.crypto_amount} {order.crypto_currency} Received",
            f"Order {order.binance_order_number} — Paid KES {order.fiat_amount:,.0f} at {order.exchange_rate:,.2f}",
            "buy_complete",
        )
    except Exception as e:
        logger.warning(f"Failed to send in-app notification for buy order {order.binance_order_number}: {e}")

    # SMS notification
    try:
        from app.services.sms import send_sms
        send_sms(
            trader.phone,
            f"SparkP2P: Buy done! {order.crypto_amount} {order.crypto_currency} received on Binance. "
            f"Paid KES {order.fiat_amount:,.0f}. Ref: {order.binance_order_number[-8:]}",
        )
    except Exception as e:
        logger.warning(f"SMS failed for buy order completion {order.binance_order_number}: {e}")


async def _process_reported_sell_order(
    order_data: BinanceOrderData,
    trader: Trader,
    db: AsyncSession,
) -> Optional[dict]:
    """
    Process a sell-side order reported by the extension.
    Creates the order in DB if new, checks if payment was received.
    Returns an action dict if the extension should do something.
    """
    order_number = order_data.orderNumber

    # Enforce sell order minimum: KES 100 (lowered — GPT-4o sometimes misreads amounts)
    if order_data.totalPrice < 100:
        logger.warning(
            f"Sell order {order_number} below minimum (KES {order_data.totalPrice:,.0f} < KES 100). Skipping."
        )
        return None

    # Check if we already track this order
    result = await db.execute(
        select(Order).where(Order.binance_order_number == order_number)
    )
    existing = result.scalar_one_or_none()

    if existing:
        # If Binance shows this order as cancelled/expired, update our record
        if order_data.orderStatus in (5, 6):
            if existing.status == OrderStatus.PENDING:
                existing.status = OrderStatus.CANCELLED if order_data.orderStatus == 5 else OrderStatus.EXPIRED
                if order_data.orderStatus == 5:
                    existing.cancelled_at = datetime.now(timezone.utc)
                await db.commit()
                logger.info(f"Order {order_number} marked {existing.status.value} from Binance status")
            return None
        # Already tracked — check if payment was received and needs release
        if existing.status == OrderStatus.PAYMENT_RECEIVED and trader.auto_release_enabled:
            existing.status = OrderStatus.RELEASING
            # Include confirmation chat message if pending
            chat_msg = existing.pending_chat_message
            if chat_msg:
                existing.pending_chat_message = None  # Clear after sending
            await db.commit()
            return {
                "action": "release",
                "order_number": order_number,
                "message": chat_msg,  # Bot sends this before clicking Release
            }
        return None

    # Create new order
    amount = order_data.totalPrice
    crypto_amount = order_data.amount
    rate = order_data.price
    currency = order_data.asset

    prefix = f"T{trader.id:04d}"
    account_ref = f"P2P-{prefix}-{order_number}"
    display_account = f"P2P{prefix}"  # What buyer types in M-Pesa/bank — no hyphens

    order = Order(
        trader_id=trader.id,
        binance_order_number=order_number,
        binance_ad_number=order_data.advNo,
        side=OrderSide.SELL,
        crypto_amount=crypto_amount,
        crypto_currency=currency,
        fiat_amount=amount,
        exchange_rate=rate,
        account_reference=account_ref,
        counterparty_name=order_data.buyerNickname,
    )
    db.add(order)
    await db.commit()

    logger.info(f"New sell order tracked: {order_number} for trader {trader.full_name}")

    # Tell extension to send payment instructions via chat
    paybill = settings.MPESA_SHORTCODE
    message = (
        f"Hi! Please send KES {amount:,.0f} to:\n"
        f"M-Pesa Paybill: {paybill}\n"
        f"Account Number: {display_account}\n"
        f"Account Holder: {trader.full_name}\n\n"
        f"You will receive a confirmation message once payment is received. "
        f"Your crypto will be released automatically."
    )
    return {"action": "send_message", "order_number": order_number, "message": message}


async def _process_reported_buy_order(
    order_data: BinanceOrderData,
    trader: Trader,
    db: AsyncSession,
) -> Optional[dict]:
    """
    Process a buy-side order reported by the extension.
    Creates the order in DB if new.
    If auto-pay is enabled:
      1. Check trader's wallet balance
      2. Reserve the amount (deduct from balance, add to reserved)
      3. Send B2C payment to seller from platform Paybill
      4. Tell extension to mark as paid on Binance
    If insufficient balance, send notification and skip.
    """
    from app.services.mpesa.client import mpesa_client
    from app.services.email import send_insufficient_balance, send_seller_paid

    order_number = order_data.orderNumber

    # Enforce buy order minimum: KES 1,000 (real floor enforced on Binance ad)
    if order_data.totalPrice < 1000:
        logger.warning(
            f"Buy order {order_number} below minimum (KES {order_data.totalPrice:,.0f} < KES 1,000). Skipping."
        )
        return None

    # Check if we already track this order
    result = await db.execute(
        select(Order).where(Order.binance_order_number == order_number)
    )
    existing = result.scalar_one_or_none()

    if existing:
        # If we already sent payment, tell extension to mark as paid
        if existing.status == OrderStatus.PAYMENT_SENT:
            return {"action": "mark_as_paid", "order_number": order_number}
        return None

    # Create new order
    amount = order_data.totalPrice
    crypto_amount = order_data.amount
    rate = order_data.price
    currency = order_data.asset

    order = Order(
        trader_id=trader.id,
        binance_order_number=order_number,
        binance_ad_number=order_data.advNo,
        side=OrderSide.BUY,
        crypto_amount=crypto_amount,
        crypto_currency=currency,
        fiat_amount=amount,
        exchange_rate=rate,
        counterparty_name=order_data.sellerNickname,
        seller_payment_method=order_data.sellerPaymentMethod,
        seller_payment_destination=order_data.sellerPaymentPhone or order_data.sellerPaymentAccount,
    )
    db.add(order)
    await db.flush()

    logger.info(f"New buy order tracked: {order_number} for trader {trader.full_name}")

    # Auto-pay if enabled and within limits
    if not (trader.auto_pay_enabled and amount <= trader.max_single_trade):
        await db.commit()
        return None

    # Check wallet balance
    wallet_result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = wallet_result.scalar_one_or_none()

    if not wallet or wallet.balance < amount:
        # Insufficient balance
        current_balance = wallet.balance if wallet else 0
        logger.warning(
            f"Insufficient balance for buy order {order_number}: "
            f"need KES {amount}, have KES {current_balance}"
        )
        order.status = OrderStatus.PENDING
        await db.commit()

        # Send notification
        send_insufficient_balance(trader.email, trader.full_name, amount, current_balance)
        return None

    # Determine seller destination
    seller_dest = None
    if order.seller_payment_destination:
        seller_dest = order.seller_payment_destination
    elif order.counterparty_phone:
        seller_dest = order.counterparty_phone

    if not seller_dest:
        # Cannot auto-pay without seller payment info
        logger.warning(f"No seller payment info for buy order {order_number}, requesting details")
        await db.commit()
        return {"action": "pay", "order_number": order_number}

    # ── Check if seller is on SparkP2P (internal transfer = FREE) ──
    from app.services.internal_transfer import find_trader_by_phone, transfer_between_wallets

    seller_trader = await find_trader_by_phone(db, seller_dest)

    if seller_trader and seller_trader.id != trader.id:
        # Seller is on SparkP2P! Do an internal wallet-to-wallet transfer (FREE)
        logger.info(
            f"Buy order {order_number}: seller {seller_dest} is SparkP2P trader "
            f"#{seller_trader.id} ({seller_trader.full_name}). Using internal transfer (FREE)."
        )
        try:
            await transfer_between_wallets(
                db=db,
                from_trader_id=trader.id,
                to_trader_id=seller_trader.id,
                amount=amount,
                description=f"Buy order {order_number} - internal transfer to seller {seller_trader.full_name}",
                order_id=order.id,
            )

            # Mark order as payment sent
            order.status = OrderStatus.PAYMENT_SENT
            order.payment_sent_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(f"Internal transfer completed for buy order {order_number}: KES {amount:,.0f} FREE")

            # Tell extension to mark as paid on Binance
            return {"action": "mark_as_paid", "order_number": order_number}

        except Exception as e:
            logger.error(f"Internal transfer failed for buy order {order_number}: {e}")
            order.status = OrderStatus.PENDING
            await db.commit()
            return None

    # ── Seller is NOT on SparkP2P — use B2C ──
    # Reserve the funds (deduct from balance, add to reserved)
    wallet.balance -= amount
    wallet.reserved += amount

    # Record reservation transaction
    reserve_txn = WalletTransaction(
        trader_id=trader.id,
        wallet_id=wallet.id,
        order_id=order.id,
        transaction_type=TransactionType.BUY_RESERVE,
        amount=-amount,
        balance_after=wallet.balance,
        description=f"Reserved for buy order {order_number}",
    )
    db.add(reserve_txn)
    await db.flush()

    # Automated trading: SparkP2P covers ALL Safaricom B2C fees
    # The trader pays NOTHING for bot-executed buy orders
    # This is the core value of the subscription

    logger.info(f"Buy order {order_number}: SparkP2P covers B2C fee (automated trading = free for trader)")

    try:
        b2c_result = await mpesa_client.send_b2c(
            phone=seller_dest,
            amount=amount,
            remarks=f"P2P buy {order_number}",
            occasion=f"SparkP2P-{order_number}",
        )
        logger.info(f"B2C sent for buy order {order_number}: {b2c_result}")

        # Mark order as payment sent
        order.status = OrderStatus.PAYMENT_SENT
        order.payment_sent_at = datetime.now(timezone.utc)

        # Deduct from reserved
        wallet.reserved -= amount

        # Record debit transaction
        debit_txn = WalletTransaction(
            trader_id=trader.id,
            wallet_id=wallet.id,
            order_id=order.id,
            transaction_type=TransactionType.BUY_DEBIT,
            amount=-amount,
            balance_after=wallet.balance,
            description=f"Payment sent to seller for order {order_number}",
        )
        db.add(debit_txn)
        await db.commit()

        # Send email notification
        send_seller_paid(
            trader.email, trader.full_name, amount,
            order_data.sellerNickname or "Unknown", order_number,
        )

        # Tell extension to mark as paid on Binance
        return {"action": "mark_as_paid", "order_number": order_number}

    except Exception as e:
        logger.error(f"B2C payment failed for buy order {order_number}: {e}")
        # Release reserved funds back to balance
        wallet.balance += amount
        wallet.reserved -= amount

        release_txn = WalletTransaction(
            trader_id=trader.id,
            wallet_id=wallet.id,
            order_id=order.id,
            transaction_type=TransactionType.BUY_RELEASE,
            amount=amount,
            balance_after=wallet.balance,
            description=f"Funds released - B2C failed for order {order_number}",
        )
        db.add(release_txn)
        order.status = OrderStatus.PENDING
        await db.commit()
        return None


# ─── I&M Bank withdrawal job queue ───────────────────────────────────────────

@router.get("/pending-bank-withdrawals")
async def get_pending_bank_withdrawals(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app polls this to get pending I&M bank withdrawals queued for execution."""
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    # Only return withdrawals where the M-PESA sweep has already completed.
    # If a sweep is still pending, the money isn't in the I&M business account yet.
    traders_with_pending_sweep = select(ImSweep.trader_id).where(ImSweep.status == "pending")

    result = await db.execute(
        select(WalletTransaction, Trader).join(
            Trader, Trader.id == WalletTransaction.trader_id
        ).where(
            WalletTransaction.settlement_method.in_(["bank", "bank_paybill"]),
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.trader_id.notin_(traders_with_pending_sweep),
        ).order_by(WalletTransaction.created_at)
    )
    rows = result.all()
    jobs = []
    for t, tr in rows:
        jobs.append({
            "id": t.id,
            "amount": abs(t.amount),
            "destination": t.destination or "",
            "destination_account": t.destination or "",
            "destination_name": (tr.full_name or "").upper().strip(),
            "trader_id": tr.id,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        })
    return {"jobs": jobs}


class BankWithdrawalCompleteRequest(BaseModel):
    tx_id: int
    reference: Optional[str] = None  # I&M transaction reference if captured


@router.post("/bank-withdrawal-complete")
async def bank_withdrawal_complete(
    data: BankWithdrawalCompleteRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this after successfully executing an I&M bank transfer."""
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(WalletTransaction, Trader, Wallet)
        .join(Trader, Trader.id == WalletTransaction.trader_id)
        .join(Wallet, Wallet.trader_id == WalletTransaction.trader_id)
        .where(WalletTransaction.id == data.tx_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Transaction not found")
    tx, tx_trader, tx_wallet = row

    tx.status = "completed"
    tx.processed_by = "auto:im_bot"
    tx.processed_at = datetime.now(timezone.utc)
    if data.reference:
        tx.description = (tx.description or "") + f" | I&M ref: {data.reference}"

    # Complete the pending fee transactions created alongside this withdrawal
    fee_result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == tx.trader_id,
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type.in_([
                TransactionType.PLATFORM_FEE,
                TransactionType.SETTLEMENT_FEE,
            ]),
        )
    )
    for fee_tx in fee_result.scalars().all():
        fee_tx.status = "completed"

    # Mark the queued Payment record as completed now that transfer actually happened
    spk_ref = f"SPK-{str(tx.id).zfill(6)}"
    pay_result = await db.execute(
        select(Payment).where(Payment.bill_ref_number == spk_ref)
    )
    payment = pay_result.scalar_one_or_none()
    if payment:
        payment.status = PaymentStatus.COMPLETED
        if data.reference:
            payment.mpesa_transaction_id = data.reference

    await db.commit()

    net_amount = abs(tx.amount)
    remaining = tx_wallet.balance

    # SMS notification — now that the transfer is actually done
    try:
        from app.services.sms import send_otp_sms
        send_otp_sms(
            tx_trader.phone,
            f"SparkP2P: KES {net_amount:,.0f} sent to your I&M Bank account. "
            f"Remaining balance: KES {remaining:,.0f}."
        )
    except Exception as e:
        logger.warning(f"Failed to send bank withdrawal SMS to {tx_trader.phone}: {e}")

    # Email notification
    try:
        from app.services.email import send_email
        send_email(
            tx_trader.email,
            "SparkP2P - Withdrawal Sent",
            f"""
            <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <div style="text-align: center; margin-bottom: 30px;">
                    <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
                </div>
                <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
                    <h2 style="color: #10b981; font-size: 20px; margin: 0 0 12px;">Withdrawal Sent</h2>
                    <p style="color: #9ca3af; font-size: 14px;">
                        Hi {tx_trader.full_name}, your withdrawal to I&M Bank has been completed.
                    </p>
                    <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin: 16px 0;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="color: #9ca3af;">Amount Sent</span>
                            <span style="color: #10b981; font-weight: 600;">KES {net_amount:,.0f}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="color: #9ca3af;">Reference</span>
                            <span style="color: #fff;">SPK-{str(tx.id).zfill(6)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #9ca3af;">Remaining Balance</span>
                            <span style="color: #fff; font-weight: 600;">KES {remaining:,.0f}</span>
                        </div>
                    </div>
                </div>
            </div>
            """,
        )
    except Exception as e:
        logger.warning(f"Failed to send bank withdrawal email to {tx_trader.email}: {e}")

    # Report success so system health clears any degraded I&M state
    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_success("im_bank"))

    return {"status": "ok", "tx_id": tx.id}


@router.post("/bank-withdrawal-failed")
async def bank_withdrawal_failed(
    data: BankWithdrawalCompleteRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this if I&M transfer failed — requeues as pending for retry."""
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    result = await db.execute(
        select(WalletTransaction).where(WalletTransaction.id == data.tx_id)
    )
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    tx.status = "pending"
    tx.processed_by = None
    await db.commit()

    # Report I&M failure so system health can alert admin after threshold
    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_failure("im_bank", data.reference or "Bank transfer failed"))

    return {"status": "requeued", "tx_id": tx.id}


# ── Session flag reset — called on desktop app startup ───────────────────────

@router.post("/reset-session-flags")
async def reset_session_flags(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this on startup before Chrome opens.
    Resets all browser-session flags to False so the UI never shows
    stale 'Connected' badges from the previous run.
    Vision will re-confirm and set them back to True during this session.
    """
    trader.im_connected = False
    trader.mpesa_portal_connected = False
    # Clear gmail_cookies so gmail_connected also becomes False
    trader.gmail_cookies = None
    await db.commit()
    return {"status": "ok", "reset": ["im_connected", "gmail_connected", "mpesa_portal_connected"]}


# ── M-PESA Org Portal Sweep endpoints ────────────────────────────────────────

@router.get("/pending-mpesa-sweeps")
async def get_pending_mpesa_sweeps(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app polls this to get pending M-PESA sweeps queued for execution."""
    result = await db.execute(
        select(ImSweep).where(
            ImSweep.status == "pending",
        ).order_by(ImSweep.created_at)
    )
    sweeps = result.scalars().all()
    return {
        "sweeps": [
            {
                "sweep_id": s.id,
                "amount": s.amount,
                "reference": (
                    f"BATCH{s.batch_id}" if s.batch_id
                    else (f"WD{s.withdrawal_tx_id}" if s.withdrawal_tx_id else f"SW{s.id}")
                ),
                "is_batch": bool(s.batch_id),
                "batch_id": s.batch_id,
            }
            for s in sweeps
        ]
    }


class MpesaSweepResultRequest(BaseModel):
    sweep_id: int
    amount: Optional[float] = None
    reference: Optional[str] = None
    error: Optional[str] = None


@router.post("/mpesa-sweep-complete")
async def mpesa_sweep_complete(
    data: MpesaSweepResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this after successfully submitting a M-PESA org portal sweep."""
    result = await db.execute(select(ImSweep).where(ImSweep.id == data.sweep_id))
    sweep = result.scalar_one_or_none()
    if not sweep:
        raise HTTPException(status_code=404, detail="Sweep not found")
    sweep.status = "completed"
    sweep.completed_at = datetime.now(timezone.utc)

    batch_id = sweep.batch_id
    expected_amount = sweep.amount
    if batch_id:
        # Batch sweep submitted — record swept_at but hold in 'sweeping' until
        # the bot confirms the money arrived in the I&M account
        batch_result = await db.execute(select(WithdrawalBatch).where(WithdrawalBatch.id == batch_id))
        batch = batch_result.scalar_one_or_none()
        if batch and batch.status == "sweeping":
            batch.swept_at = datetime.now(timezone.utc)
            logger.info(
                f"Batch {batch_id} sweep submitted (KES {expected_amount:,.0f}). "
                f"Holding in 'sweeping' until I&M balance confirmed."
            )

    await db.commit()

    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_success("mpesa_org"))

    return {
        "status": "ok",
        "sweep_id": sweep.id,
        "is_batch": bool(batch_id),
        "batch_id": batch_id,
        "needs_balance_check": bool(batch_id),
        "expected_amount": expected_amount,
    }


class BatchBalanceVerifyRequest(BaseModel):
    batch_id: int
    im_balance: float        # current SPARK FREELANCE SOLUTIONS KES balance
    im_balance_before: Optional[float] = None  # balance before sweep (optional)


@router.post("/batch-balance-verified")
async def batch_balance_verified(
    data: BatchBalanceVerifyRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Bot calls this after reading the I&M account balance post-sweep.
    If balance >= batch total, advances batch to 'disbursing'.
    Otherwise returns verified=False so the bot can retry or give up.
    """
    result = await db.execute(select(WithdrawalBatch).where(WithdrawalBatch.id == data.batch_id))
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")

    batch.im_balance_after = data.im_balance
    if data.im_balance_before is not None:
        batch.im_balance_before = data.im_balance_before

    # Accept if I&M balance covers at least 98% of the batch total
    sufficient = data.im_balance >= batch.total_amount * 0.98

    if sufficient:
        batch.balance_verified = True
        batch.status = "disbursing"
        await db.commit()
        logger.info(
            f"Batch {batch.id}: I&M balance KES {data.im_balance:,.0f} confirmed "
            f"(need KES {batch.total_amount:,.0f}) — advancing to disbursing"
        )
        return {"verified": True, "proceed": True, "batch_id": batch.id}
    else:
        await db.commit()
        logger.warning(
            f"Batch {batch.id}: I&M balance KES {data.im_balance:,.0f} insufficient "
            f"(need KES {batch.total_amount:,.0f}) — not proceeding yet"
        )
        return {
            "verified": False,
            "proceed": False,
            "im_balance": data.im_balance,
            "required": batch.total_amount,
        }


@router.post("/mpesa-sweep-failed")
async def mpesa_sweep_failed(
    data: MpesaSweepResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this if the M-PESA org portal sweep failed.
    Marks sweep failed, cancels the pending WalletTransaction, restores
    the wallet balance, and notifies the trader via SMS + email.
    """
    result = await db.execute(select(ImSweep).where(ImSweep.id == data.sweep_id))
    sweep = result.scalar_one_or_none()
    if not sweep:
        raise HTTPException(status_code=404, detail="Sweep not found")
    sweep.status = "failed"
    sweep.failure_reason = (data.error or "Unknown error")[:500]

    # ── Batch sweep failed: refund ALL batch items ────────────────────────────
    if sweep.batch_id:
        batch_result = await db.execute(select(WithdrawalBatch).where(WithdrawalBatch.id == sweep.batch_id))
        batch = batch_result.scalar_one_or_none()
        if batch:
            batch.status = "failed"

        items_result = await db.execute(
            select(BatchItem).where(
                BatchItem.batch_id == sweep.batch_id,
                BatchItem.status == "queued",
            )
        )
        failed_items = items_result.scalars().all()
        total_refunded = 0
        for item in failed_items:
            item.status = "failed"
            item.failure_reason = (data.error or "Sweep failed")[:500]

            # Find and cancel all pending transactions for this trader
            group_result = await db.execute(
                select(WalletTransaction).where(
                    WalletTransaction.trader_id == item.trader_id,
                    WalletTransaction.status == "pending",
                    WalletTransaction.transaction_type.in_([
                        TransactionType.WITHDRAWAL,
                        TransactionType.PLATFORM_FEE,
                        TransactionType.SETTLEMENT_FEE,
                    ]),
                )
            )
            group_txns = group_result.scalars().all()
            refund_amount = sum(abs(t.amount) for t in group_txns)

            for t in group_txns:
                t.status = "cancelled"
                t.description = (t.description or "") + " | CANCELLED: batch sweep failed"

            # Reverse Payment record
            if item.wallet_tx_id:
                spk_ref = f"SPK-{str(item.wallet_tx_id).zfill(6)}"
                pay_result = await db.execute(
                    select(Payment).where(Payment.bill_ref_number == spk_ref)
                )
                payment = pay_result.scalar_one_or_none()
                if payment:
                    payment.status = PaymentStatus.REVERSED

            # Restore wallet balance
            wallet_result = await db.execute(
                select(Wallet).where(Wallet.trader_id == item.trader_id)
            )
            item_wallet = wallet_result.scalar_one_or_none()
            if item_wallet and refund_amount > 0:
                item_wallet.balance += refund_amount
                item_wallet.total_withdrawn -= item.net_amount
                item_wallet.total_fees_paid -= item.fee_amount

            total_refunded += refund_amount

            # Notify trader
            tr_result = await db.execute(select(Trader).where(Trader.id == item.trader_id))
            item_trader = tr_result.scalar_one_or_none()
            if item_trader and refund_amount > 0:
                try:
                    from app.services.sms import send_otp_sms
                    send_otp_sms(
                        item_trader.phone,
                        f"SparkP2P: Your batch withdrawal of KES {refund_amount:,.0f} failed "
                        f"(M-PESA sweep error). Amount refunded to your wallet. Please try again."
                    )
                except Exception as e:
                    logger.warning(f"Batch item refund SMS failed for trader {item.trader_id}: {e}")

        await db.commit()

        from app.services import system_health
        import asyncio
        asyncio.create_task(system_health.report_failure("mpesa_org", data.error or "Batch sweep failed"))

        return {
            "status": "failed",
            "sweep_id": sweep.id,
            "is_batch": True,
            "batch_id": sweep.batch_id,
            "items_refunded": len(failed_items),
            "total_refunded": total_refunded,
        }
    # ─────────────────────────────────────────────────────────────────────────

    # Find the pending WalletTransaction + wallet for this trader and reverse it
    tx_result = await db.execute(
        select(WalletTransaction, Wallet)
        .join(Wallet, Wallet.trader_id == WalletTransaction.trader_id)
        .where(
            WalletTransaction.trader_id == sweep.trader_id,
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
        )
        .order_by(WalletTransaction.created_at.desc())
        .limit(1)
    )
    tx_row = tx_result.first()

    refunded_amount = 0
    tx_trader = None
    if tx_row:
        pending_tx, wallet = tx_row

        # Cancel all pending transactions for this withdrawal group (withdrawal + fees).
        # Include zero-amount fee transactions (SETTLEMENT_FEE can be 0 for bank withdrawals).
        group_result = await db.execute(
            select(WalletTransaction).where(
                WalletTransaction.trader_id == sweep.trader_id,
                WalletTransaction.status == "pending",
                WalletTransaction.transaction_type.in_([
                    TransactionType.WITHDRAWAL,
                    TransactionType.PLATFORM_FEE,
                    TransactionType.SETTLEMENT_FEE,
                ]),
            )
        )
        group_txns = group_result.scalars().all()
        total_to_refund = sum(abs(t.amount) for t in group_txns)

        for t in group_txns:
            t.status = "cancelled"
            t.description = (t.description or "") + " | CANCELLED: sweep failed"

        # Reverse the queued Payment record so admin sees it as cancelled, not completed
        withdrawal_tx = next((t for t in group_txns if t.transaction_type == TransactionType.WITHDRAWAL), None)
        if withdrawal_tx:
            spk_ref = f"SPK-{str(withdrawal_tx.id).zfill(6)}"
            pay_result = await db.execute(select(Payment).where(Payment.bill_ref_number == spk_ref))
            payment = pay_result.scalar_one_or_none()
            if payment:
                payment.status = PaymentStatus.REVERSED

        # Restore wallet balance and totals
        wallet.balance += total_to_refund
        wallet.total_withdrawn -= abs(pending_tx.amount)
        wallet.total_fees_paid -= sum(abs(t.amount) for t in group_txns if t.transaction_type != TransactionType.WITHDRAWAL)
        refunded_amount = total_to_refund

        # Look up the trader for notifications
        tr_result = await db.execute(select(Trader).where(Trader.id == sweep.trader_id))
        tx_trader = tr_result.scalar_one_or_none()

    await db.commit()

    # Notify trader
    if tx_trader and refunded_amount > 0:
        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                tx_trader.phone,
                f"SparkP2P: Your withdrawal of KES {refunded_amount:,.0f} could not be processed "
                f"(M-PESA sweep failed). KES {refunded_amount:,.0f} has been refunded to your wallet."
            )
        except Exception as e:
            logger.warning(f"Failed to send sweep-failed SMS: {e}")
        try:
            from app.services.email import send_email
            send_email(
                tx_trader.email,
                "SparkP2P - Withdrawal Failed",
                f"""
                <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                    <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
                        <h2 style="color: #ef4444; font-size: 20px; margin: 0 0 12px;">Withdrawal Failed</h2>
                        <p style="color: #9ca3af; font-size: 14px;">
                            Hi {tx_trader.full_name}, your withdrawal could not be completed because the
                            M-PESA sweep failed (insufficient M-PESA org balance).
                        </p>
                        <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin: 16px 0;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                                <span style="color: #9ca3af;">Amount Refunded</span>
                                <span style="color: #10b981; font-weight: 600;">KES {refunded_amount:,.0f}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span style="color: #9ca3af;">Error</span>
                                <span style="color: #ef4444; font-size: 12px;">{(data.error or 'Sweep failed')[:80]}</span>
                            </div>
                        </div>
                        <p style="color: #9ca3af; font-size: 13px;">Your balance has been fully restored. Please try again once the M-PESA org account is recharged.</p>
                    </div>
                </div>
                """,
            )
        except Exception as e:
            logger.warning(f"Failed to send sweep-failed email: {e}")

    # Report failure so system health can alert admin after threshold
    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_failure("mpesa_org", data.error or "Sweep failed"))

    return {"status": "failed", "sweep_id": sweep.id, "refunded": refunded_amount}


@router.post("/reset-pending-sweep")
async def reset_pending_sweep(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Called by desktop when I&M transfer fails after a sweep.
    Resets the most recent completed sweep (within last 2h) back to 'pending'
    so the bot retries the full M-PESA → I&M flow from scratch on next poll.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    result = await db.execute(
        select(ImSweep)
        .where(
            ImSweep.trader_id == trader.id,
            ImSweep.status == "completed",
            ImSweep.created_at >= cutoff,
        )
        .order_by(ImSweep.created_at.desc())
        .limit(1)
    )
    sweep = result.scalar_one_or_none()
    if not sweep:
        return {"reset": False, "reason": "No recent completed sweep found"}

    sweep.status = "pending"
    sweep.failure_reason = "I&M transfer failed — auto-retrying from M-PESA sweep"
    await db.commit()
    logger.info(f"Sweep {sweep.id} reset to pending for retry (I&M transfer failure)")
    return {"reset": True, "sweep_id": sweep.id}


# ═══════════════════════════════════════════════════════════
# BATCH WITHDRAWAL DISBURSEMENT
# ═══════════════════════════════════════════════════════════

@router.get("/pending-batch-disbursements")
async def get_pending_batch_disbursements(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this after a batch sweep completes.
    Returns all queued batch items whose batch is in 'disbursing' state.
    """
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(BatchItem, Trader)
        .join(Trader, Trader.id == BatchItem.trader_id)
        .join(WithdrawalBatch, WithdrawalBatch.id == BatchItem.batch_id)
        .where(
            WithdrawalBatch.status == "disbursing",
            BatchItem.status == "queued",
        )
        .order_by(BatchItem.created_at)
    )
    rows = result.all()

    jobs = []
    for item, tr in rows:
        jobs.append({
            "item_id": item.id,
            "batch_id": item.batch_id,
            "amount": item.net_amount,
            "destination": item.destination or "",
            "destination_account": item.destination or "",
            "destination_name": item.destination_name or (tr.full_name or "").upper().strip(),
            "trader_id": item.trader_id,
            "wallet_tx_id": item.wallet_tx_id,
        })

    return {"jobs": jobs}


class BatchItemResultRequest(BaseModel):
    item_id: int
    reference: Optional[str] = None
    error: Optional[str] = None


@router.post("/batch-item-complete")
async def batch_item_complete(
    data: BatchItemResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this after successfully completing one I&M transfer in a batch."""
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(select(BatchItem).where(BatchItem.id == data.item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Batch item not found")

    item.status = "completed"
    item.completed_at = datetime.now(timezone.utc)
    if data.reference:
        item.im_reference = data.reference

    # Complete the withdrawal WalletTransaction
    if item.wallet_tx_id:
        tx_result = await db.execute(
            select(WalletTransaction).where(WalletTransaction.id == item.wallet_tx_id)
        )
        tx = tx_result.scalar_one_or_none()
        if tx:
            tx.status = "completed"
            tx.processed_by = "auto:im_bot"
            tx.processed_at = datetime.now(timezone.utc)
            if data.reference:
                tx.description = (tx.description or "") + f" | I&M ref: {data.reference}"

            # Mark the outbound Payment record as completed
            spk_ref = f"SPK-{str(tx.id).zfill(6)}"
            pay_result = await db.execute(
                select(Payment).where(Payment.bill_ref_number == spk_ref)
            )
            payment = pay_result.scalar_one_or_none()
            if payment:
                payment.status = PaymentStatus.COMPLETED
                if data.reference:
                    payment.mpesa_transaction_id = data.reference

    # Complete pending fee transactions for this trader
    fee_result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == item.trader_id,
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type.in_([
                TransactionType.PLATFORM_FEE,
                TransactionType.SETTLEMENT_FEE,
            ]),
        )
    )
    for fee_tx in fee_result.scalars().all():
        fee_tx.status = "completed"

    # Check if entire batch is now complete
    from sqlalchemy import func as sa_func
    remaining_result = await db.execute(
        select(sa_func.count(BatchItem.id)).where(
            BatchItem.batch_id == item.batch_id,
            BatchItem.status == "queued",
        )
    )
    if (remaining_result.scalar() or 0) == 0:
        batch_result = await db.execute(
            select(WithdrawalBatch).where(WithdrawalBatch.id == item.batch_id)
        )
        batch = batch_result.scalar_one_or_none()
        if batch:
            batch.status = "completed"
            batch.completed_at = datetime.now(timezone.utc)
            logger.info(f"Batch {item.batch_id} fully completed")

    await db.commit()

    # Notify trader
    tr_result = await db.execute(select(Trader).where(Trader.id == item.trader_id))
    item_trader = tr_result.scalar_one_or_none()
    wallet_result = await db.execute(
        select(Wallet).where(Wallet.trader_id == item.trader_id)
    )
    item_wallet = wallet_result.scalar_one_or_none()
    remaining_bal = item_wallet.balance if item_wallet else 0

    if item_trader:
        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                item_trader.phone,
                f"SparkP2P: KES {item.net_amount:,.0f} sent to your I&M Bank account. "
                f"Remaining balance: KES {remaining_bal:,.0f}."
            )
        except Exception as e:
            logger.warning(f"Batch item complete SMS failed for trader {item.trader_id}: {e}")

        try:
            from app.services.email import send_email
            ref_display = data.reference or f"SPK-{str(item.wallet_tx_id).zfill(6)}" if item.wallet_tx_id else "N/A"
            send_email(
                item_trader.email,
                "SparkP2P - Withdrawal Sent",
                f"""
                <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                    <div style="text-align:center;margin-bottom:30px;">
                        <h1 style="color:#f59e0b;font-size:28px;margin:0;">SparkP2P</h1>
                    </div>
                    <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                        <h2 style="color:#10b981;font-size:20px;margin:0 0 12px;">Withdrawal Sent</h2>
                        <p style="color:#9ca3af;font-size:14px;">
                            Hi {item_trader.full_name}, your withdrawal to I&M Bank has been completed.
                        </p>
                        <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;">
                            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                                <span style="color:#9ca3af;">Amount Sent</span>
                                <span style="color:#10b981;font-weight:600;">KES {item.net_amount:,.0f}</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                                <span style="color:#9ca3af;">Reference</span>
                                <span style="color:#fff;">{ref_display}</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;">
                                <span style="color:#9ca3af;">Remaining Balance</span>
                                <span style="color:#fff;font-weight:600;">KES {remaining_bal:,.0f}</span>
                            </div>
                        </div>
                    </div>
                </div>
                """,
            )
        except Exception as e:
            logger.warning(f"Batch item complete email failed for trader {item.trader_id}: {e}")

    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_success("im_bank"))

    return {"status": "ok", "item_id": item.id}


@router.post("/batch-item-failed")
async def batch_item_failed(
    data: BatchItemResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this if an I&M transfer for one batch item fails.
    Refunds the individual trader and marks their item failed.
    Other batch items are unaffected.
    """
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(select(BatchItem).where(BatchItem.id == data.item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Batch item not found")

    item.status = "failed"
    item.failure_reason = (data.error or "Transfer failed")[:500]

    # Cancel pending wallet transactions and restore balance
    group_result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == item.trader_id,
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type.in_([
                TransactionType.WITHDRAWAL,
                TransactionType.PLATFORM_FEE,
                TransactionType.SETTLEMENT_FEE,
            ]),
        )
    )
    group_txns = group_result.scalars().all()
    total_refund = sum(abs(t.amount) for t in group_txns)
    for t in group_txns:
        t.status = "cancelled"
        t.description = (t.description or "") + " | CANCELLED: batch item transfer failed"

    # Reverse Payment record
    if item.wallet_tx_id:
        spk_ref = f"SPK-{str(item.wallet_tx_id).zfill(6)}"
        pay_result = await db.execute(select(Payment).where(Payment.bill_ref_number == spk_ref))
        payment = pay_result.scalar_one_or_none()
        if payment:
            payment.status = PaymentStatus.REVERSED

    # Restore wallet
    wallet_result = await db.execute(select(Wallet).where(Wallet.trader_id == item.trader_id))
    item_wallet = wallet_result.scalar_one_or_none()
    if item_wallet and total_refund > 0:
        item_wallet.balance += total_refund
        item_wallet.total_withdrawn -= item.net_amount
        item_wallet.total_fees_paid -= item.fee_amount

    await db.commit()

    # Notify trader
    tr_result = await db.execute(select(Trader).where(Trader.id == item.trader_id))
    item_trader = tr_result.scalar_one_or_none()
    if item_trader and total_refund > 0:
        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                item_trader.phone,
                f"SparkP2P: Your batch withdrawal of KES {total_refund:,.0f} could not be "
                f"completed (I&M transfer error). Amount refunded to your wallet. Please try again."
            )
        except Exception as e:
            logger.warning(f"Batch item failed SMS error for trader {item.trader_id}: {e}")

    from app.services import system_health
    import asyncio
    asyncio.create_task(system_health.report_failure("im_bank", data.error or "Batch item transfer failed"))

    return {"status": "failed", "item_id": item.id, "refunded": total_refund}


# ═══════════════════════════════════════════════════════════
# PAYBILL STATEMENT SYNC — Desktop pushes scraped transactions
# ═══════════════════════════════════════════════════════════

class PaybillTxItem(BaseModel):
    mpesa_ref: str
    direction: str            # inbound | outbound
    amount: float
    phone: Optional[str] = None
    counterparty_name: Optional[str] = None
    balance_after: Optional[float] = None
    transaction_type: Optional[str] = None
    remarks: Optional[str] = None
    transaction_at: Optional[str] = None  # ISO string


class SyncPaybillRequest(BaseModel):
    transactions: List[PaybillTxItem]


@router.post("/sync-paybill-statement")
async def sync_paybill_statement(
    data: SyncPaybillRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app pushes scraped paybill statement rows. Upserts by mpesa_ref."""
    from app.models.paybill_statement import PaybillStatement
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    inserted = 0
    skipped = 0

    for tx in data.transactions:
        if not tx.mpesa_ref:
            continue

        # Check if already exists
        existing = (await db.execute(
            select(PaybillStatement).where(PaybillStatement.mpesa_ref == tx.mpesa_ref)
        )).scalar_one_or_none()

        if existing:
            skipped += 1
            continue

        tx_at = None
        if tx.transaction_at:
            try:
                tx_at = datetime.fromisoformat(tx.transaction_at.replace('Z', '+00:00'))
            except Exception:
                pass

        stmt = PaybillStatement(
            mpesa_ref=tx.mpesa_ref,
            direction=tx.direction,
            amount=tx.amount,
            phone=tx.phone,
            counterparty_name=tx.counterparty_name,
            balance_after=tx.balance_after,
            transaction_type=tx.transaction_type,
            remarks=tx.remarks,
            transaction_at=tx_at,
            source='portal_sync',
        )
        db.add(stmt)
        inserted += 1

    await db.commit()
    logger.info(f"[PaybillSync] Inserted {inserted}, skipped {skipped} duplicates")
    return {"inserted": inserted, "skipped": skipped}
