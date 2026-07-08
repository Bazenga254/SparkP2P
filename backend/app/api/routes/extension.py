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
from collections import deque
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func, or_, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models import Order, OrderSide, OrderStatus, Trader, Payment, PaymentStatus, PaymentDirection
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.im_sweep import ImSweep
from app.models.batch import WithdrawalBatch, BatchItem
from app.services.settlement.engine import SettlementEngine
from app.api.deps import get_current_trader, get_current_trader_id

logger = logging.getLogger(__name__)

router = APIRouter()

# ── In-memory bot log store ───────────────────────────────────────
# Keyed by trader_id. Each deque holds up to 500 recent log entries.
_trader_bot_logs: dict[int, deque] = {}
_BOT_LOG_MAX = 500


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
    buyer_30d_trades: Optional[int] = None   # scraped from order page — used for DD screening
    buyer_all_trades: Optional[int] = None   # scraped from order page — used for DD screening


class ReportOrdersRequest(BaseModel):
    sell_orders: list[BinanceOrderData] = []
    buy_orders: list[BinanceOrderData] = []
    cancelled_order_numbers: list[str] = []       # Order numbers from Binance Cancelled history tab
    completed_buy_order_numbers: list[str] = []   # BUY order numbers from Binance Completed history tab
    completed_sell_order_numbers: list[str] = []  # SELL order numbers from Binance Completed history tab
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
    channel: Optional[str] = None  # 'MPESA' or 'BANK' — rail used to pay the seller (for credit fee)


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
            ).with_for_update()
        )
        completed_order = comp_result.scalar_one_or_none()
        if completed_order:
            if completed_order.status not in [OrderStatus.COMPLETED, OrderStatus.RELEASED]:
                if completed_order.status == OrderStatus.PENDING:
                    completed_order.status = OrderStatus.PAYMENT_SENT
                await _complete_buy_order(completed_order, trader, db, notify=True)
        else:
            # Order completed while bot was offline and full data couldn't be parsed — create stub.
            stub = Order(
                trader_id=trader.id,
                binance_order_number=order_number,
                crypto_currency='USDT',
                side=OrderSide.BUY,
                status=OrderStatus.COMPLETED,
                fiat_amount=0,
                crypto_amount=0,
                exchange_rate=0,
                released_at=datetime.now(timezone.utc),
            )
            db.add(stub)
            logger.info(f"Recorded offline-completed buy order {order_number} for trader {trader.id}")

    # Mark completed sell orders (we released crypto — from Binance Completed history tab)
    for order_number in data.completed_sell_order_numbers:
        sell_comp_result = await db.execute(
            select(Order).where(
                Order.binance_order_number == order_number,
                Order.trader_id == trader.id,
                Order.side == OrderSide.SELL,
            )
        )
        sell_completed = sell_comp_result.scalar_one_or_none()
        if sell_completed:
            if sell_completed.status not in [OrderStatus.RELEASED, OrderStatus.COMPLETED]:
                await _complete_sell_order(sell_completed, trader, db)
        else:
            stub = Order(
                trader_id=trader.id,
                binance_order_number=order_number,
                side=OrderSide.SELL,
                status=OrderStatus.RELEASED,
                fiat_amount=0,
                crypto_amount=0,
                exchange_rate=0,
                released_at=datetime.now(timezone.utc),
            )
            db.add(stub)
            logger.info(f"Recorded offline-completed sell order {order_number} for trader {trader.id}")

    # Auto-cancel PENDING SELL orders absent from the active list for >8 minutes.
    # BUY orders are excluded: the bot manages their full lifecycle explicitly (I&M payment
    # can take 5+ minutes, leaving a second pending buy order unprotected for the entire
    # duration). Buy-side cancellations are handled by the Binance Cancelled tab scan.
    reported_numbers = {o.orderNumber for o in data.sell_orders + data.buy_orders}
    protected_numbers = set(data.active_order_numbers)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=8)
    stale_result = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status == OrderStatus.PENDING,
            Order.side == OrderSide.SELL,
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

    # Reactivate any order the bot is actively processing that got wrongly cancelled or expired.
    # Binance P2P allows payment windows up to 24 hours; the poller must not pre-empt the bot.
    for order_number in protected_numbers:
        react_result = await db.execute(
            select(Order).where(
                Order.trader_id == trader.id,
                Order.binance_order_number == order_number,
                Order.status.in_([OrderStatus.CANCELLED, OrderStatus.EXPIRED]),
            )
        )
        reactivate = react_result.scalar_one_or_none()
        if reactivate:
            old_status = reactivate.status.value
            reactivate.status = OrderStatus.PENDING
            logger.info(f"Order {order_number} reactivated ({old_status} → PENDING) — bot is actively processing it on Binance")

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
        _was_released = order.status in (OrderStatus.RELEASED, OrderStatus.COMPLETED)
        order.status = OrderStatus.RELEASED
        order.released_at = datetime.now(timezone.utc)
        # Credits retired — billing is now subscription + per-tier rate limits (no per-order charge).
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

        # Notify trader via Telegram (free); SMS only if no Telegram linked
        try:
            from app.api.routes.telegram import notify_trader
            sent = await notify_trader(
                trader,
                f"✅ SparkP2P: Order complete! {order.crypto_amount} {order.crypto_currency} released. "
                f"KES {order.fiat_amount:,.0f} credited to your wallet. Ref: {data.order_number[-8:]}"
            )
            if not sent:
                from app.services.sms import send_sms
                send_sms(
                    trader.phone,
                    f"SparkP2P: Order complete! {order.crypto_amount} {order.crypto_currency} released. "
                    f"KES {order.fiat_amount:,.0f} credited to your wallet. Ref: {data.order_number[-8:]}"
                )
        except Exception as e:
            logger.warning(f"Order release notification failed: {e}")

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
        _already_sent = order.status == OrderStatus.PAYMENT_SENT
        # Never downgrade a COMPLETED/RELEASED order back to PAYMENT_SENT.
        # This happens when a payment retry succeeds after the order was already marked done.
        if order.status not in (OrderStatus.COMPLETED, OrderStatus.RELEASED):
            order.status = OrderStatus.PAYMENT_SENT
            order.payment_sent_at = datetime.now(timezone.utc)
        # Buy order = outbound payment to the seller via Choice Bank. Choice Bank withholds the KES
        # fee on its side (debits amount + fee from the trader's account) and remits our markup
        # monthly — so no credit charge here. Record the fee once for reconciliation.
        if not _already_sent:
            try:
                from app.services.outbound_fees import outbound_fee as _outbound_fee
                _ch = (data.channel or "BANK").upper()
                order.choice_fee = _outbound_fee(_ch, order.fiat_amount or 0)
            except Exception as _e:
                logger.warning(f"buy-order fee record failed for {data.order_number}: {_e}")
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
    notify: bool = True  # False when bot restarted mid-order or completion detected offline


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
        ).with_for_update()
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Buy order not found")

    if order.status in [OrderStatus.COMPLETED, OrderStatus.RELEASED]:
        return {"status": "ok", "message": "Already completed"}

    if order.status != OrderStatus.PAYMENT_SENT:
        logger.warning(
            f"report-buy-completed called for order {data.order_number} "
            f"in unexpected status {order.status}"
        )

    await _complete_buy_order(order, trader, db, notify=data.notify)
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

    # Subscription gate: no auto buy/sell/release when the plan is expired (locked) or the daily
    # trade cap is reached. Returns no actions so the bot stays idle. Choice Bank is unaffected.
    from app.services.enforcement import can_auto_trade
    _allowed, _reason = await can_auto_trade(db, trader)
    if not _allowed:
        return {"actions": [], "locked": _reason}

    # Sell side: payment received, needs release — only if mode allows sell automation
    sell_automated = (trader.bot_trade_mode or 'both') in ('both', 'sell_only')
    if sell_automated:
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
    # Only if mode allows buy automation
    buy_automated = (trader.bot_trade_mode or 'both') in ('both', 'buy_only')
    if buy_automated:
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
    max_age_minutes: Optional[int] = None  # If set: only match payments within this many minutes; uses exact amount (±1 KES)


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
    # ── Step 1: Fetch order — needed for double-spend guard and time-window ──
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

    # ── Step 2: Try direct M-Pesa code lookup from buyer's chat message ──────
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
                status_val = str(direct_payment.status).upper().replace('PAYMENTSTATUS.', '')
                if status_val not in ('COMPLETED', 'PAYMENT_RECEIVED'):
                    continue
                # Reject if this code was already matched to a DIFFERENT order
                if direct_payment.order_id is not None and direct_payment.order_id != order.id:
                    logger.warning(
                        f"M-Pesa code {code} already used for order_id={direct_payment.order_id}, "
                        f"rejecting for {data.binance_order_number}"
                    )
                    return {
                        "verified": False,
                        "reason": f"already_used: M-Pesa code {code} was already used in a previous transaction. Ask buyer to send a new payment.",
                        "mpesa_receipt": code,
                    }
                # Reject if the payment predates this order (recycled old screenshot)
                if direct_payment.created_at < order.created_at:
                    logger.warning(
                        f"M-Pesa code {code} (created {direct_payment.created_at}) predates "
                        f"order {data.binance_order_number} (created {order.created_at}), rejecting"
                    )
                    return {
                        "verified": False,
                        "reason": f"already_used: M-Pesa code {code} is from a transaction that predates this order. Ask buyer to send a new payment.",
                        "mpesa_receipt": code,
                    }
                # Amount gate — a genuine code is NOT enough; the payment must cover the order
                # (whole-figure, cents ignored). Prevents releasing a large order for a small real payment.
                if data.fiat_amount and int(direct_payment.amount) < int(data.fiat_amount):
                    logger.warning(
                        f"M-Pesa code {code} underpaid: KES {direct_payment.amount} < order KES {data.fiat_amount} "
                        f"for {data.binance_order_number}"
                    )
                    return {
                        "verified": False,
                        "reason": (f"underpaid: this M-Pesa payment was KES {direct_payment.amount:,.0f} but the order "
                                   f"is KES {data.fiat_amount:,.0f}. Ask the buyer to pay the difference."),
                        "mpesa_receipt": code,
                        "amount_received": direct_payment.amount,
                    }
                logger.info(f"M-Pesa code {code} matched directly in Payment table for order {data.binance_order_number}")
                # Lock this payment to the order so it can never be reused for another order
                if direct_payment.order_id is None:
                    direct_payment.order_id = order.id
                    await db.commit()
                return {
                    "verified": True,
                    "reason": f"M-Pesa code {code} confirmed in our records",
                    "mpesa_receipt": code,
                    "amount_received": direct_payment.amount,
                    "payer_phone": direct_payment.phone,
                    "payer_name": direct_payment.sender_name,
                }

    # ── Step 3: Amount-match (double-spend protection already in WHERE clause) ─
    # Window starts at order creation — payments before the order are never valid.
    # Excludes payments already linked to a DIFFERENT order (order_id must be NULL
    # or this order's id). If multiple unlinked payments have the same amount, we
    # cannot safely pick one — ask buyer to type their M-Pesa code instead.
    # When max_age_minutes is set (quick-check mode): use exact amount (±1 KES) and
    # restrict to payments received within that many minutes of now.
    if data.fiat_amount:
        amount_tolerance = 1 if data.max_age_minutes else 5
        time_floor = (
            datetime.now(timezone.utc) - timedelta(minutes=data.max_age_minutes)
            if data.max_age_minutes else order.created_at
        )
        amount_result = await db.execute(
            select(Payment).where(
                Payment.trader_id == trader.id,
                # Whole-figure: lower bound = floored order amount (no underpayment), small over-tolerance to still match.
                Payment.amount.between(int(data.fiat_amount), data.fiat_amount + amount_tolerance),
                Payment.created_at >= time_floor,
                Payment.direction == PaymentDirection.INBOUND,
                or_(Payment.order_id.is_(None), Payment.order_id == order.id),
            ).order_by(Payment.id.desc())
        )
        candidates = [
            row for row in amount_result.scalars().all()
            if str(row.status).upper().replace('PAYMENTSTATUS.', '') in ('COMPLETED', 'PAYMENT_RECEIVED')
        ]
        linked_to_this = [c for c in candidates if c.order_id == order.id]
        unlinked = [c for c in candidates if c.order_id is None]

        if linked_to_this:
            row = linked_to_this[0]
            logger.info(f"M-Pesa payment linked to order {data.binance_order_number}: {row.mpesa_transaction_id}")
            return {
                "verified": True,
                "reason": f"M-Pesa payment KES {row.amount} confirmed for this order",
                "mpesa_receipt": row.mpesa_transaction_id,
                "amount_received": row.amount,
                "payer_phone": row.phone,
                "payer_name": row.sender_name,
            }
        elif len(unlinked) == 1:
            row = unlinked[0]
            logger.info(f"M-Pesa payment matched by amount KES {data.fiat_amount} for order {data.binance_order_number}")
            # Lock this payment to the order so it can never be reused for another order
            row.order_id = order.id
            await db.commit()
            return {
                "verified": True,
                "reason": f"M-Pesa payment matched by amount KES {data.fiat_amount}",
                "mpesa_receipt": row.mpesa_transaction_id,
                "amount_received": row.amount,
                "payer_phone": row.phone,
                "payer_name": row.sender_name,
            }
        elif len(unlinked) > 1:
            logger.warning(
                f"Ambiguous: {len(unlinked)} unlinked payments of KES {data.fiat_amount} "
                f"for order {data.binance_order_number} — cannot auto-release"
            )
            return {
                "verified": False,
                "reason": f"ambiguous_multiple_matches: {len(unlinked)} payments of KES {data.fiat_amount} found. Ask buyer to type their M-Pesa code.",
            }

    # ── Step 4: Order-status check ────────────────────────────────────────────
    # If the C2B webhook already matched and flipped the order status, trust it.
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


class BotLogRequest(BaseModel):
    level: str
    message: str
    time: str  # ISO timestamp from desktop app


@router.post("/bot-log")
async def receive_bot_log(
    data: BotLogRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app pushes each log entry here. Persisted to the DB so admins can review a
    trader's logs even across backend restarts (also kept in memory for fast live reads)."""
    tid = trader.id
    if tid not in _trader_bot_logs:
        _trader_bot_logs[tid] = deque(maxlen=_BOT_LOG_MAX)
    _trader_bot_logs[tid].append({
        "level": data.level,
        "message": data.message,
        "time": data.time,
    })
    try:
        from app.models.bot_log import BotLog
        from sqlalchemy import text as _sqltext
        db.add(BotLog(trader_id=tid, level=(data.level or "")[:20], message=data.message, time=(data.time or "")[:40]))
        # Keep the table tidy — drop this trader's log lines older than 14 days.
        await db.execute(_sqltext(
            "DELETE FROM bot_logs WHERE trader_id = :t AND created_at < now() - interval '14 days'"
        ), {"t": tid})
        await db.commit()
    except Exception as _e:
        logger.warning(f"bot-log persist failed for trader {tid}: {_e}")
    return {"ok": True}


# ── Per-trader Binance relay (the desktop executes the trader's Binance calls on its own IP) ──

class RelayResultRequest(BaseModel):
    job_id: str
    body: Any = None


@router.get("/relay/poll")
async def relay_poll(request: Request, trader_id: int = Depends(get_current_trader_id)):
    """Desktop long-polls here. Returns the next signed Binance job for THIS trader to execute on
    its own IP, or {job: None} if none arrives within the wait window. The desktop must pin the
    host to Binance and only forward the returned path/params/body/headers.

    Auth is token-only (no DB) so the 25s wait does NOT hold a pool connection — otherwise every
    online trader polling back-to-back pins a connection and exhausts the DB pool."""
    from app.services.binance import relay_router
    from app.api.deps import get_client_ip
    job = await relay_router.next_job(trader_id, wait=25.0, client_ip=get_client_ip(request))
    return job or {"job": None}


@router.post("/relay/result")
async def relay_result(data: RelayResultRequest, _tid: int = Depends(get_current_trader_id)):
    """Desktop posts back the Binance response (parsed JSON) for a job it executed."""
    from app.services.binance import relay_router
    delivered = relay_router.deliver_result(data.job_id, data.body)
    return {"ok": delivered}


@router.get("/relay/status")
async def relay_status(trader_id: int = Depends(get_current_trader_id)):
    """Whether THIS trader's relay (desktop app or phone) is currently online — i.e. it has
    long-polled within the presence window. The connect/API screen uses this to tell a merchant
    to start their relay before testing API keys. Token-only auth (no DB), like /relay/poll."""
    from app.services.binance import relay_router
    return {"online": relay_router.is_connected(trader_id)}


@router.get("/notifications/poll")
async def notifications_poll(after: int = 0, trader_id: int = Depends(get_current_trader_id)):
    """Phone relay polls this for new alerts to post as native notifications. Token-only auth (no
    DB) so it doesn't hold a pool connection."""
    from app.services import push_queue
    items, last = push_queue.poll(trader_id, after)
    return {"items": items, "last_id": last}


@router.post("/heartbeat")
async def heartbeat(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension sends heartbeat every 30 seconds.
    Only updates the last-seen timestamp — does NOT touch bot_intentionally_stopped
    to avoid a race where an in-flight heartbeat clears the flag set by /bot-stopped.
    """
    _now = datetime.now(timezone.utc)
    trader.updated_at = _now
    trader.last_extension_sync = _now  # presence signal — drives Online status on dashboard + admin
    await db.commit()
    return {"status": "ok", "trader_id": trader.id}


@router.post("/bot-stopped")
async def bot_stopped(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this on graceful quit.
    Suppresses offline alerts in bot_monitor until /bot-started is called.
    """
    trader.bot_intentionally_stopped = True
    await db.commit()
    return {"status": "ok"}


@router.post("/bot-started")
async def bot_started(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop app calls this when the bot first connects and starts polling.
    Clears the intentional-stop flag so the monitor resumes alerting.
    """
    trader.bot_intentionally_stopped = False
    trader.updated_at = datetime.now(timezone.utc)
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

async def _complete_buy_order(order: Order, trader: Trader, db: AsyncSession, notify: bool = True) -> None:
    """
    Mark a buy order as completed — seller has released crypto to the buyer's Binance wallet.
    notify=True  → real-time detection (report-buy-completed): send SMS + in-app notification.
    notify=False → historical scan (completed_buy_order_numbers): update DB silently, no SMS.

    Uses an atomic UPDATE ... WHERE status NOT IN (COMPLETED, RELEASED) RETURNING id so that
    two concurrent calls for the same order can never both send SMS — only the one that wins
    the UPDATE gets a returned row and proceeds; the loser bails out immediately.
    """
    if order.status == OrderStatus.COMPLETED:
        logger.debug(f"Buy order {order.binance_order_number} already COMPLETED — skipping")
        return

    now = datetime.now(timezone.utc)
    result = await db.execute(
        sql_update(Order)
        .where(
            Order.id == order.id,
            Order.status.notin_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
        )
        .values(status=OrderStatus.COMPLETED, settled_at=now)
        .returning(Order.id)
    )
    if result.scalar_one_or_none() is None:
        logger.info(f"Buy order {order.binance_order_number} already COMPLETED by concurrent request — skipping SMS")
        order.status = OrderStatus.COMPLETED
        return

    # We own this completion — sync in-memory object and update stats
    order.status = OrderStatus.COMPLETED
    order.settled_at = now
    trader.total_trades += 1
    trader.total_volume += order.fiat_amount

    logger.info(
        f"Buy order {order.binance_order_number} COMPLETED — "
        f"{order.crypto_amount} {order.crypto_currency} received by trader {trader.full_name}"
        + ("" if notify else " (historical scan — no SMS)")
    )

    if not notify:
        return

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

    # Notify trader via Telegram (free); SMS only if no Telegram linked
    try:
        from app.api.routes.telegram import notify_trader
        sent = await notify_trader(
            trader,
            f"✅ SparkP2P: Buy done! {order.crypto_amount} {order.crypto_currency} received on Binance. "
            f"Paid KES {order.fiat_amount:,.0f}. Ref: {order.binance_order_number[-8:]}",
        )
        if not sent:
            from app.services.sms import send_sms
            send_sms(
                trader.phone,
                f"SparkP2P: Buy done! {order.crypto_amount} {order.crypto_currency} received on Binance. "
                f"Paid KES {order.fiat_amount:,.0f}. Ref: {order.binance_order_number[-8:]}",
            )
    except Exception as e:
        logger.warning(f"Buy order completion notification failed {order.binance_order_number}: {e}")


async def _complete_sell_order(order: Order, trader: Trader, db: AsyncSession) -> None:
    """
    Mark a sell order as released — we sold crypto and the buyer paid KES.
    Called when the bot reports the order in the Binance Completed history tab.
    Runs settlement to credit the trader's wallet and sends SMS notification.
    """
    order.status = OrderStatus.RELEASED
    order.released_at = datetime.now(timezone.utc)

    trader.total_trades += 1
    trader.total_volume += order.fiat_amount
    # Credits retired — billing is now subscription + per-tier rate limits (no per-order charge).

    logger.info(
        f"Sell order {order.binance_order_number} RELEASED (reconcile) — "
        f"KES {order.fiat_amount:,.0f} for trader {trader.full_name}"
    )

    try:
        from app.api.routes.traders import add_notification
        add_notification(
            trader.id,
            f"Sell Complete: KES {order.fiat_amount:,.0f} Received",
            f"Order {order.binance_order_number} — {order.crypto_amount} {order.crypto_currency} released",
            "release",
        )
    except Exception as e:
        logger.warning(f"In-app notification failed for sell order {order.binance_order_number}: {e}")

    try:
        from app.api.routes.telegram import notify_trader
        sent = await notify_trader(
            trader,
            f"✅ SparkP2P: Sell done! KES {order.fiat_amount:,.0f} received. "
            f"{order.crypto_amount} {order.crypto_currency} released. Ref: {order.binance_order_number[-8:]}",
        )
        if not sent:
            from app.services.sms import send_sms
            send_sms(
                trader.phone,
                f"SparkP2P: Sell done! KES {order.fiat_amount:,.0f} received. "
                f"{order.crypto_amount} {order.crypto_currency} released. Ref: {order.binance_order_number[-8:]}",
            )
    except Exception as e:
        logger.warning(f"Sell order completion notification failed {order.binance_order_number}: {e}")

    try:
        settlement = SettlementEngine(db)
        if trader.batch_settlement_enabled:
            await settlement.auto_settle_if_threshold(trader.id)
        else:
            await settlement.settle_order(order)
    except Exception as e:
        logger.warning(f"Settlement failed for sell order {order.binance_order_number}: {e}")


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
        sell_automated = (trader.bot_trade_mode or 'both') in ('both', 'sell_only')
        if existing.status == OrderStatus.PAYMENT_RECEIVED and trader.auto_release_enabled and sell_automated:
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
        fraud_check_result={
            "buyer_30d_trades": order_data.buyer_30d_trades,
            "buyer_all_trades": order_data.buyer_all_trades,
        } if (order_data.buyer_30d_trades is not None or order_data.buyer_all_trades is not None) else None,
    )
    db.add(order)
    await db.commit()

    logger.info(f"New sell order tracked: {order_number} for trader {trader.full_name}")

    # Only send payment instructions if sell automation is enabled
    sell_automated = (trader.bot_trade_mode or 'both') in ('both', 'sell_only')
    if not sell_automated:
        return None

    # Tell extension to send payment instructions via chat.
    # buyer_nickname is included so the bot can run DD screening before sending.
    # Prefer Choice Bank: paying to the Choice paybill + the trader's Choice account number lands
    # the funds directly in their Choice account AND auto-matches the order (the Choice webhook
    # matches the pending SELL order by trader + amount, then auto-releases). Fall back to the
    # central M-Pesa paybill + P2P account ref for traders without a Choice account.
    # Sent as 4 SEPARATE chat messages so the buyer can copy each value cleanly: intro, paybill,
    # account number, account name. `message` keeps the combined blob for backward-compat with
    # older desktop builds that only read a single `message`.
    if trader.choice_account_number:
        messages = [
            f"Hi! Please send KES {amount:,.0f} via M-Pesa to the Paybill below. Your crypto is released automatically once payment is received 👇",
            f"Paybill Number: {settings.CHOICE_BANK_PAYBILL}",
            f"Account Number: {trader.choice_account_number}",
            f"Account Name: {trader.full_name}",
        ]
    else:
        messages = [
            f"Hi! Please send KES {amount:,.0f} via M-Pesa to the Paybill below. Your crypto is released automatically once payment is received 👇",
            f"M-Pesa Paybill: {settings.MPESA_SHORTCODE}",
            f"Account Number: {display_account}",
            f"Account Holder: {trader.full_name}",
        ]
    return {"action": "send_message", "order_number": order_number, "messages": messages,
            "message": "\n".join(messages), "buyer_nickname": order_data.buyerNickname or "",
            "fiat_amount": float(order_data.totalPrice or 0)}


async def _process_reported_buy_order(
    order_data: BinanceOrderData,
    trader: Trader,
    db: AsyncSession,
) -> Optional[dict]:
    """
    Track a buy-side order reported by the extension.
    Creates the order in DB if new.
    Payment is handled entirely by the Electron desktop app via I&M Bank portal.
    """
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
        # If we already sent payment, tell extension to mark as paid (only if buy mode active)
        buy_automated = (trader.bot_trade_mode or 'both') in ('both', 'buy_only')
        if existing.status == OrderStatus.PAYMENT_SENT and buy_automated:
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

    await db.commit()
    return None


# ─── Counterparty screening helpers ──────────────────────────────────────────

@router.get("/check-returning-buyer")
async def check_returning_buyer(
    nickname: str,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Returns whether a buyer nickname has any completed sell orders with this trader.
    Returning clients bypass DD screening thresholds."""
    result = await db.execute(
        select(Order.id).where(
            Order.trader_id == trader.id,
            Order.counterparty_name == nickname,
            Order.status == OrderStatus.COMPLETED,
        ).limit(1)
    )
    existing = result.scalar_one_or_none()
    return {"is_returning": existing is not None}


@router.get("/counterparty-stats")
async def counterparty_stats(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
):
    """EP-19 via relay: full buyer profile + prior-trade count for a given order.
    Returns normalized stats for Telegram screening — confirmed Binance fields."""
    if not trader.binance_api_key or not trader.binance_api_secret:
        return {"ok": False, "error": "no_api_key"}
    try:
        from app.core.security import decrypt_data
        from app.services.binance.sapi_client import get_counterparty_statistic, relay_trader
        relay_trader.set(trader.id)   # route via this trader's desktop in per_trader mode
        api_key = decrypt_data(trader.binance_api_key)
        api_secret = decrypt_data(trader.binance_api_secret)
        d = await get_counterparty_statistic(api_key, api_secret, order_number)
    except Exception as e:
        logger.warning("counterparty-stats failed for order %s: %s", order_number, e)
        return {"ok": False, "error": str(e)}

    trades_30d = d.get("completedOrderNumOfLatest30day")
    trades_all = d.get("completedOrderNum")
    rate_30d   = d.get("finishRateLatest30Day")
    avg_pay    = d.get("avgPayTime")
    reg_days   = d.get("registerDays")
    with_us    = d.get("numberOfTradesWithCounterpartyCompleted30day") or 0

    return {
        "ok": True,
        "trades_30d": trades_30d,
        "trades_all": trades_all,
        "last30dTrades": trades_30d,
        "allTimeTrades": trades_all,
        "completionRate": (f"{rate_30d*100:.2f}%" if rate_30d is not None else "N/A"),
        "avgPayMins": (f"{avg_pay/60:.2f}" if avg_pay is not None else "N/A"),
        "registeredDays": reg_days,
        "tradedBefore": with_us > 0,
        "tradesWithUs30d": with_us,
        "raw": d,
    }


@router.get("/active-orders")
async def get_active_orders(
    trader: Trader = Depends(get_current_trader),
):
    """Fetch active Binance P2P orders via stored session credentials.

    Desktop bot calls this instead of querying Binance directly from the
    browser — decouples order detection from the Puppeteer page state.
    Returns combined BUY + SELL active orders in a normalised format.
    """
    if not trader.binance_cookies:
        return {"ok": False, "error": "no_session", "orders": []}

    try:
        from app.services.binance.client import BinanceP2PClient
        client = BinanceP2PClient.from_trader(trader)

        # Fetch both sides concurrently
        import asyncio
        sell_raw, buy_raw = await asyncio.gather(
            client.get_pending_orders("SELL"),
            client.get_pending_orders("BUY"),
            return_exceptions=True,
        )
    except Exception as e:
        logger.warning("active-orders session fetch failed for trader %s: %s", trader.id, e)
        return {"ok": False, "error": str(e), "orders": []}

    seen_order_numbers: set = set()
    orders = []
    for raw, side in ((sell_raw, "SELL"), (buy_raw, "BUY")):
        if isinstance(raw, Exception) or not isinstance(raw, list):
            continue
        for o in raw:
            order_number = str(o.get("orderNumber") or o.get("orderId") or "")
            if len(order_number) < 15:
                continue
            if order_number in seen_order_numbers:
                logger.warning("active-orders: duplicate order %s skipped (appeared in both SELL and BUY lists)", order_number)
                continue
            seen_order_numbers.add(order_number)
            fiat   = float(o.get("totalPrice") or o.get("fiatAmount") or 0)
            crypto = float(o.get("amount") or o.get("cryptoAmount") or 0)
            price  = float(o.get("unitPrice") or o.get("price") or 0)
            counterparty = (
                o.get("buyerNickname") or o.get("sellerNickname")
                or o.get("counterPartyNickName") or ""
            )
            # Use Binance's own tradeType field if present; fall back to the side we requested
            binance_type = (str(o.get("tradeType") or "")).upper()
            trade_type = binance_type if binance_type in ("SELL", "BUY") else side
            orders.append({
                "orderNumber": order_number,
                "tradeType": trade_type,
                "totalPrice": fiat,
                "amount": crypto,
                "price": price,
                "asset": "USDT",
                "status": "Pending Payment",
                "counterparty": counterparty,
            })

    return {"ok": True, "orders": orders}


@router.get("/order-detail")
async def get_order_detail(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
):
    """Return full order detail including payment info.

    Tries SAPI (API key) first — works even when session cookies are expired.
    Falls back to cookie-based client if SAPI is unavailable.
    """
    # ── SAPI path (API key) — preferred, no cookie dependency ────────────────
    if trader.binance_api_key and trader.binance_api_secret:
        try:
            from app.services.binance.sapi_client import get_order_payment_details, relay_trader
            from app.core.security import decrypt_data
            relay_trader.set(trader.id)
            api_key    = decrypt_data(trader.binance_api_key)
            api_secret = decrypt_data(trader.binance_api_secret)
            d = await get_order_payment_details(api_key, api_secret, order_number)
            phone = None
            account_number = None
            bank_name = None
            for f in (d.get("fields") or []):
                lbl = (f.get("label") or "").lower()
                val = (f.get("value") or "").strip()
                if not val:
                    continue
                if not phone and any(w in lbl for w in ("phone", "mobile", "number")):
                    phone = val
                if not account_number and any(w in lbl for w in ("account", "card")):
                    account_number = val
                if not bank_name and "bank" in lbl:
                    bank_name = val
            phone = phone or d.get("pay_account") or None
            method_raw = str(d.get("method") or "").lower()
            if any(k in method_raw for k in ("pesalink", "equity", "kcb", "coop", "i&m", "im bank")):
                method = "other_bank"
            elif any(k in method_raw for k in ("mpesa", "m-pesa", "safaricom")):
                method = "mpesa"
            else:
                method = "mpesa"
            return {
                "ok": True,
                "method": method,
                "phone": phone,
                "account_number": account_number or None,
                "bank_name": bank_name or None,
                "fiat_amount": d.get("fiat_amount"),
                "counterparty_name": d.get("name") or d.get("counterparty_nickname"),
                "trades_30d": d.get("trades_30d"),
                "trades_all": d.get("trades_all"),
                "completion_rate": d.get("completion_rate"),
                "account_age_days": d.get("account_age_days"),
                "avg_pay_mins": d.get("avg_pay_mins"),
            }
        except Exception as e:
            logger.warning("order-detail SAPI path failed for %s: %s — falling back to cookies", order_number, e)

    # ── Cookie path (legacy) ──────────────────────────────────────────────────
    if not trader.binance_cookies:
        return {"ok": False, "error": "no_session"}

    try:
        from app.services.binance.client import BinanceP2PClient
        client = BinanceP2PClient.from_trader(trader)
        d = await client.get_order_detail(order_number)
    except Exception as e:
        logger.warning("order-detail failed for %s: %s", order_number, e)
        return {"ok": False, "error": str(e)}

    if not d:
        return {"ok": False, "error": "empty_response"}

    # Extract payment details from payInfo array
    pay_info = d.get("payInfo") or d.get("tradePayInfo") or d.get("sellerPayInfo") or []
    pi = pay_info[0] if isinstance(pay_info, list) and pay_info else {}

    method_raw = str(pi.get("payMethodName") or pi.get("payType") or "").lower()
    if "i" in method_raw and "m" in method_raw and "bank" in method_raw:
        method = "im_bank"
    elif any(k in method_raw for k in ("mpesa", "m-pesa", "safaricom")):
        method = "mpesa"
    elif any(k in method_raw for k in ("equity", "kcb", "coop", "bank", "pesalink")):
        method = "other_bank"
    else:
        method = "mpesa"

    fields = pi.get("fields") or []
    def _fv(key):
        for f in fields:
            if key in str(f.get("identifier") or f.get("fieldName") or "").lower():
                return str(f.get("value") or f.get("fieldValue") or "").strip()
        return ""

    phone          = _fv("phone") or _fv("mobile") or _fv("number")
    account_number = _fv("account") or _fv("card")
    bank_name      = _fv("bank") or pi.get("payMethodName") or ""

    # Counterparty info
    cp = d.get("counterPartyUserInfoVo") or d.get("sellerInfo") or {}
    name          = cp.get("nickName") or d.get("sellerNickname") or d.get("buyerNickname") or ""
    trades_30d    = cp.get("lastMonthOrderNum") or cp.get("tradeCount30d")
    trades_all    = cp.get("orderCount") or cp.get("tradeCountTotal")
    rate_raw      = cp.get("monthFinishRate") or cp.get("completionRate")
    completion    = f"{float(rate_raw)*100:.1f}%" if rate_raw is not None else ""
    reg_days      = cp.get("registerDays")
    avg_pay_secs  = cp.get("avgPayTime")
    avg_pay_mins  = round(float(avg_pay_secs) / 60, 1) if avg_pay_secs else None

    fiat_amount   = float(d.get("totalPrice") or d.get("fiatAmount") or 0)

    return {
        "ok": True,
        "method": method,
        "phone": phone or None,
        "account_number": account_number or None,
        "bank_name": bank_name or None,
        "fiat_amount": fiat_amount,
        "counterparty_name": name,
        "trades_30d": trades_30d,
        "trades_all": trades_all,
        "completion_rate": completion,
        "account_age_days": reg_days,
        "avg_pay_mins": avg_pay_mins,
    }


# ─── EP-13 sell order state (SAPI HMAC) ──────────────────────────────────────

@router.get("/sell-order-state")
async def sell_order_state(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """EP-13 via SAPI HMAC: return normalised order state + payment method.
    Replaces DOM/Vision state detection in the desktop sell-order loop."""
    from app.services.binance.sapi_client import get_order_payment_details, relay_trader
    api_key, api_secret = _sapi_creds(trader)
    relay_trader.set(trader.id)
    try:
        d = await get_order_payment_details(api_key, api_secret, order_number)
    except Exception as e:
        logger.warning("sell-order-state EP-13 failed for %s: %s", order_number, e)
        return {"ok": False, "error": str(e), "state": "unknown"}

    # Persist the counterparty's verified/legal name (best-effort, once) for payer name-match.
    buyer_real_name = str(d.get("counterparty_real_name") or "").strip()
    if buyer_real_name:
        try:
            _or = await db.execute(select(Order).where(
                Order.binance_order_number == order_number,
                Order.trader_id == trader.id,
            ))
            _o = _or.scalar_one_or_none()
            if _o and not _o.counterparty_real_name:
                _o.counterparty_real_name = buyer_real_name
                await db.commit()
        except Exception:
            pass

    raw_status = d.get("order_status", "")

    # Map Binance order status strings → our internal state names
    # Binance returns both string names and numeric codes. Two numeric schemes appear:
    # tens (10/20/30/…) and single digits (1=awaiting, 2=buyer-paid, 4=cancelled, 5=completed).
    # "2" (buyer marked paid, awaiting release) was previously unmapped → "unknown", so the
    # bot re-instructed paid orders instead of releasing them. The desktop still re-checks the
    # actual Choice Bank payment before releasing, so this only controls which branch runs.
    _AWAITING  = {"WAS_CREATED", "TRADING", "PENDING", "20", "10", "1"}
    _VERIFY    = {"TAKER_PAID", "BUYER_PAID", "PAYING", "CONFIRM_RELEASING", "30", "2"}
    _COMPLETE  = {"COMPLETED", "SELLER_RELEASED", "SUCCESS", "40", "50", "70", "5"}
    _CANCELLED = {"CANCELLED", "CANCELLED_BY_SYSTEM", "60", "80", "4"}

    if raw_status in _AWAITING:
        state = "awaiting_payment"
    elif raw_status in _VERIFY:
        state = "verify_payment"
    elif raw_status in _COMPLETE:
        state = "order_complete"
    elif raw_status in _CANCELLED:
        state = "cancelled"
    else:
        state = "unknown"

    # Determine payment method from EP-13 raw_pay_type / method name
    raw_method = str(d.get("method") or "").lower()
    raw_pay    = str(d.get("raw_pay_type") or "").lower()
    _bank_keywords = ("pesalink", "bank", "equity", "kcb", "coop", "stanchart",
                      "absa", "ncba", "dtb", "stanbic", "family", "i&m", "im bank")
    if any(k in raw_method or k in raw_pay for k in _bank_keywords):
        payment_method = "pesalink"
    else:
        payment_method = "mpesa"

    return {
        "ok": True,
        "state": state,
        "raw_status": raw_status,
        "payment_method": payment_method,
        "buyer_name": d.get("counterparty_nickname"),
        "buyer_real_name": buyer_real_name,
        "amount": d.get("fiat_amount"),
        "trades_30d": d.get("trades_30d"),
        "trades_all": d.get("trades_all"),
        "completion_rate": d.get("completion_rate"),
        "account_age_days": d.get("account_age_days"),
        "avg_pay_mins": d.get("avg_pay_mins"),
    }


# ─── Order action endpoints (SAPI — HMAC signed, relay-routed) ───────────────

def _sapi_creds(trader: Trader):
    """Return (api_key, api_secret) or raise HTTPException if not set."""
    from app.core.security import decrypt_data
    if not trader.binance_api_key or not trader.binance_api_secret:
        raise HTTPException(status_code=400, detail="no_api_key")
    return decrypt_data(trader.binance_api_key), decrypt_data(trader.binance_api_secret)


class OrderActionRequest(BaseModel):
    order_number: str


@router.post("/mark-paid")
async def mark_order_paid(
    data: OrderActionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """EP-17: mark a BUY order as paid after sending money to the seller."""
    from app.services.binance.sapi_client import mark_order_as_paid, relay_trader
    api_key, api_secret = _sapi_creds(trader)
    relay_trader.set(trader.id)
    try:
        resp = await mark_order_as_paid(api_key, api_secret, data.order_number)
        ok = resp.get("code") == "000000" or resp.get("success") is True
        return {"ok": ok, "raw": resp}
    except Exception as e:
        logger.warning("mark-paid failed for %s: %s", data.order_number, e)
        return {"ok": False, "error": str(e)}


@router.post("/cancel-order")
async def cancel_binance_order(
    data: OrderActionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """EP-9: cancel an order (called when trader declines via Telegram)."""
    from app.services.binance.sapi_client import cancel_order, relay_trader
    api_key, api_secret = _sapi_creds(trader)
    relay_trader.set(trader.id)
    try:
        resp = await cancel_order(api_key, api_secret, data.order_number)
        ok = resp.get("code") == "000000" or resp.get("success") is True
        return {"ok": ok, "raw": resp}
    except Exception as e:
        logger.warning("cancel-order failed for %s: %s", data.order_number, e)
        return {"ok": False, "error": str(e)}


@router.post("/release-coin")
async def release_coin_endpoint(
    data: OrderActionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """EP-20: release crypto to buyer on a SELL order after payment confirmed."""
    from app.services.binance.sapi_client import release_coin_2fa, relay_trader
    from app.core.security import binance_totp_secret
    api_key, api_secret = _sapi_creds(trader)
    relay_trader.set(trader.id)
    _totp = binance_totp_secret(trader)
    try:
        resp = await release_coin_2fa(api_key, api_secret, data.order_number, totp_secret=_totp)
        ok = resp.get("code") == "000000" or resp.get("success") is True
        if ok:
            # Update our DB record
            result = await db.execute(
                select(Order).where(
                    Order.trader_id == trader.id,
                    Order.binance_order_number == data.order_number,
                )
            )
            order = result.scalar_one_or_none()
            if order:
                order.status = OrderStatus.COMPLETED
                await db.commit()
        return {"ok": ok, "raw": resp}
    except Exception as e:
        logger.warning("release-coin failed for %s: %s", data.order_number, e)
        return {"ok": False, "error": str(e)}


@router.post("/check-can-release")
async def check_can_release_endpoint(
    data: OrderActionRequest,
    trader: Trader = Depends(get_current_trader),
):
    """EP-12: read-only probe — confirm Binance allows release before calling EP-20."""
    from app.services.binance.sapi_client import check_if_can_release, relay_trader
    api_key, api_secret = _sapi_creds(trader)
    relay_trader.set(trader.id)
    try:
        resp = await check_if_can_release(api_key, api_secret, data.order_number)
        ok_code = resp.get("code") == "000000" or resp.get("success") is True
        can_release = ok_code and bool(resp.get("data") if resp.get("data") is not None else True)
        return {"ok": True, "can_release": can_release, "raw": resp}
    except Exception as e:
        logger.warning("check-can-release failed for %s: %s", data.order_number, e)
        # Don't block release on EP-12 failure — let EP-20 be the final arbiter
        return {"ok": False, "can_release": True, "error": str(e)}


# ─── I&M Bank withdrawal job queue ───────────────────────────────────────────

def _current_sweep_window_start() -> datetime:
    """Return the start of the current 15-minute sweep window (UTC).
    Windows are fixed at :00, :15, :30, :45 past every hour.
    Only withdrawals created BEFORE this timestamp are released to the bot.
    """
    now = datetime.now(timezone.utc)
    boundary_minute = (now.minute // 15) * 15
    return now.replace(minute=boundary_minute, second=0, microsecond=0)


@router.get("/pending-bank-withdrawals")
async def get_pending_bank_withdrawals(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app polls this to get pending I&M bank withdrawals queued for execution.

    Batch sweep model: only releases withdrawals from the PREVIOUS 15-minute window.
    Withdrawals created in the current window accumulate until the next sweep fires.
    """
    if not trader.is_admin and trader.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    # Only process withdrawals created before the current 15-min window started.
    # This batches all requests that arrived in the same window into one sweep run.
    window_start = _current_sweep_window_start()

    # Also skip traders where the M-PESA sweep is still pending (money not in I&M yet).
    traders_with_pending_sweep = select(ImSweep.trader_id).where(ImSweep.status == "pending")

    result = await db.execute(
        select(WalletTransaction, Trader).join(
            Trader, Trader.id == WalletTransaction.trader_id
        ).where(
            WalletTransaction.settlement_method.in_(["bank", "bank_paybill"]),
            WalletTransaction.status == "pending",
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.created_at < window_start,
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

    # Auto-fire next withdrawal for any balance accumulated since this one was queued.
    # This implements the "one pending at a time → auto-fire for full balance on completion" rule.
    # batch_settle() will block if another pending already exists (race-safe).
    try:
        from app.services.settlement.engine import SettlementEngine, BANK_MIN_WITHDRAWAL
        settlement = SettlementEngine(db)
        fresh_wallet = await settlement._get_wallet(tx.trader_id)
        if fresh_wallet and fresh_wallet.balance >= BANK_MIN_WITHDRAWAL:
            logger.info(
                f"[BankWithdrawal] Auto-firing next withdrawal for trader {tx.trader_id}: "
                f"KES {fresh_wallet.balance:,.0f} accumulated"
            )
            await settlement.batch_settle(tx.trader_id, bypass_threshold=True)
    except Exception as e:
        logger.warning(f"[BankWithdrawal] Auto-fire next withdrawal failed for trader {tx.trader_id}: {e}")

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


# ── Counterparty due diligence: log raw order detail ─────────────

class OrderDetailReport(BaseModel):
    order_number: str
    trade_type: str = ""
    raw: dict


@router.post("/report-order-detail")
async def report_order_detail(
    data: OrderDetailReport,
    trader: Trader = Depends(get_current_trader),
):
    """
    Receive full Binance order detail from the bot.
    Logs all counterparty fields for due diligence analysis.
    """
    raw = data.raw
    # Extract counterparty fields Binance returns
    counterparty_fields = {k: v for k, v in raw.items() if any(kw in k.lower() for kw in [
        'buyer', 'seller', 'user', 'nick', 'rate', 'count', 'trade', 'complete',
        'feedback', 'kyc', 'verify', 'month', 'total', 'finish', 'register', 'first',
    ])}
    logger.info(
        f"[OrderDetail] Order {data.order_number} | Trader {trader.id} | "
        f"Type:{data.trade_type} | CounterpartyFields: {counterparty_fields}"
    )
    logger.info(f"[OrderDetail] FULL RAW for {data.order_number}: {raw}")
    return {"status": "logged"}


# ── Trader notifications from bot ─────────────────────────────────

class NotifyTraderRequest(BaseModel):
    message: str


@router.post("/notify-trader")
async def notify_trader(
    data: NotifyTraderRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Bot calls this to send an in-app notification to the trader."""
    from app.api.routes.traders import add_notification
    add_notification(trader.id, "Bot Alert", data.message, "warning")
    logger.info(f"[NotifyTrader] Trader {trader.id}: {data.message[:100]}")
    return {"status": "notified"}


class ScreenshotRequest(BaseModel):
    screenshot: str  # base64
    reason: str = ""
    url: str = ""
    timestamp: str = ""


@router.post("/screenshot")
async def receive_screenshot(
    data: ScreenshotRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Receive screenshot from bot for monitoring. Logs metadata only."""
    size_kb = round(len(data.screenshot) * 3 / 4 / 1024)
    logger.info(f"[Screenshot] Trader {trader.id} | Reason:{data.reason} | Size:{size_kb}KB | URL:{data.url[:60]}")
    return {"status": "received"}


# ── Choice Bank payment status check ─────────────────────────────────────────

@router.get("/choice-payment-received")
async def choice_payment_received(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Check whether a SELL order has been fully paid via Choice Bank (PesaLink or M-Pesa).
    The bot calls this as Step 0.4, before attempting M-Pesa OCR/callback verification.
    Returns received=True when all accumulated CHOICE_INBOUND payments cover the order total.
    """
    order_result = await db.execute(
        select(Order).where(
            Order.binance_order_number == order_number,
            Order.trader_id == trader.id,
            Order.side == OrderSide.SELL,
        )
    )
    order = order_result.scalar_one_or_none()
    if not order:
        return {"received": False, "reason": "order_not_found"}

    if order.status == OrderStatus.PAYMENT_RECEIVED:
        return {"received": True, "reason": "status_payment_received", "total_paid": order.fiat_amount}

    # Fetch all confirmed Choice Bank inbound payments for this order (rows, not just sum)
    # so the desktop can run the payer name-match anti-fraud check.
    pay_rows = await db.execute(
        select(Payment).where(
            Payment.order_id == order.id,
            Payment.direction == PaymentDirection.INBOUND,
            Payment.status == PaymentStatus.COMPLETED,
            Payment.transaction_type == "CHOICE_INBOUND",
        ).order_by(Payment.created_at)
    )
    payments = pay_rows.scalars().all()
    total_paid = float(sum(p.amount for p in payments))
    # Whole-figure match: ignore cents only, NO underpayment slack (was amount - 5 KES).
    received = int(total_paid) >= int(order.fiat_amount)
    # Distinct payer names (for mixed-sender / payer-vs-legal-name checks)
    senders = []
    for p in payments:
        nm = (p.sender_name or "").strip()
        if nm and nm not in senders:
            senders.append(nm)
    return {
        "received": received,
        "total_paid": total_paid,
        "order_amount": order.fiat_amount,
        "buyer_real_name": order.counterparty_real_name or "",
        "senders": senders,
        "payments": [{"amount": p.amount, "sender_name": p.sender_name or ""} for p in payments],
        # Release-gating for the desktop bot: the backend owns the payer name-check + release.
        "held": order.status == OrderStatus.DISPUTED,           # payer name mismatch — do NOT release
        "released": order.status in (OrderStatus.RELEASED, OrderStatus.COMPLETED),
        "reason": "paid_in_full" if received else f"partial_{total_paid:.0f}_of_{order.fiat_amount:.0f}",
    }


class AlertMerchantRequest(BaseModel):
    message: str


@router.post("/alert-merchant")
async def alert_merchant(
    data: AlertMerchantRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Desktop bot fires urgent merchant alerts (payer name mismatch, deficit).
    In-app notification always; Telegram in real time; SMS fallback if Telegram fails."""
    try:
        from app.api.routes.traders import add_notification
        add_notification(trader.id, "Bot Alert", data.message, "warning")
    except Exception:
        pass
    sent = False
    try:
        from app.api.routes.telegram import notify_trader as _tg_notify
        sent = await _tg_notify(trader, f"\U0001f916 SparkP2P\n\n{data.message}")
    except Exception as e:
        logger.warning("alert-merchant telegram failed for trader %s: %s", trader.id, e)
    if not sent:
        try:
            from app.services.sms import send_sms
            send_sms(trader.phone, f"SparkP2P: {data.message[:140]}")
        except Exception:
            pass
    return {"ok": True}


# ── SMS-OTP relay: the phone's SmsReceiver posts incoming OTP texts here ───────

import re as _re
import time as _time

# trader_id -> {otp, sender, ts}. Latest OTP the phone relayed; a pending payout reads it to confirm.
_received_sms_otp: dict[int, dict] = {}

# account_last_4 -> {event: asyncio.Event, otp: str | None}. Event-based waiter for choice-pay-confirm-sms.
_pending_sms_otps: dict[str, dict] = {}


class SmsOtpData(BaseModel):
    sender: str = ""
    body: str = ""


@router.post("/sms-otp")
async def receive_sms_otp(data: SmsOtpData, trader: Trader = Depends(get_current_trader)):
    """The sideloaded app's SMS reader forwards incoming code-bearing SMS here. We log sender+body (to
    learn the exact Choice OTP format) and stash the extracted 6-digit code so a pending Choice payout
    can confirm the operation with it (the channel that actually works — email can't be verified)."""
    body = data.body or ""
    # Choice format: "Verification code 2402. This code expires in 10 minutes." (4-digit code).
    m = _re.search(r"[Vv]erification code[:\s]*(\d{3,8})", body) or _re.search(r"(?<!\d)(\d{4,8})(?!\d)", body)
    otp = m.group(1) if m else None
    logger.warning(f"[SMS-OTP] trader={trader.id} sender={data.sender!r} body={body[:120]!r} -> otp={otp}")
    if otp:
        _received_sms_otp[trader.id] = {"otp": otp, "sender": data.sender, "ts": _time.time()}
    return {"ok": True, "otp_seen": bool(otp)}


# ── Buy order pre-payment Telegram notification ───────────────────────────────

async def _choice_balance(trader) -> float | None:
    """Live Choice Bank balance (KES) for the trader's sub-account, or None if unavailable.
    Used to block BUY-order payouts the trader can't actually fund."""
    acct = getattr(trader, "choice_account_id", None)
    if not acct:
        return None
    try:
        from app.services.choice_bank import client as choice_client
        result = await choice_client.get_account_details(acct)
        data = result.get("data") or {}
        bal = data.get("balance")
        return float(bal) if bal is not None else None
    except Exception:
        return None


class NotifyBuyPaymentRequest(BaseModel):
    order_number: str
    seller_name: str = ""
    amount: float
    method: str = "mpesa"    # "mpesa" | "im_bank" | "other_bank"
    phone: str = ""
    account_number: str = ""
    bank_name: str = ""
    verified_name: str = ""  # Hakikisha-verified name if available


@router.post("/notify-buy-payment")
async def notify_buy_payment(
    data: NotifyBuyPaymentRequest,
    trader: Trader = Depends(get_current_trader),
):
    """
    Called by the desktop bot immediately before executing a BUY order payment.
    Sends a Telegram alert to the trader with who is being paid and how.
    Fire-and-forget — bot does not wait for a response.
    """
    from app.api.routes.telegram import notify_trader

    amt_str = f"KES {int(data.amount):,}"
    name = data.verified_name or data.seller_name or "Unknown"
    verified_tag = " ✅" if data.verified_name else ""

    # Balance pre-check — never announce/attempt a payout the trader can't fund.
    bal = await _choice_balance(trader)
    if bal is not None and bal < data.amount:
        shortfall = data.amount - bal
        await notify_trader(trader, (
            f"⚠️ SparkP2P — Insufficient Choice balance\n\n"
            f"Cannot pay {amt_str} for order ...{data.order_number[-12:]}.\n"
            f"💰 Choice balance: KES {bal:,.0f}\n"
            f"➕ Top up at least KES {shortfall:,.0f} more.\n\n"
            f"Order was NOT processed and the seller was NOT told you paid. "
            f"Top up your Choice account so future orders go through."
        ))
        return {"ok": False, "insufficient": True, "balance": bal, "needed": data.amount}

    if data.method in ("im_bank", "other_bank"):
        bank = data.bank_name or "Bank"
        dest = f"{bank} a/c {data.account_number or '?'}"
    else:
        dest = f"M-Pesa {data.phone or '?'}"

    msg = (
        f"🤖 SparkBot — Payment Alert\n\n"
        f"Sending {amt_str} to:\n"
        f"👤 {name}{verified_tag}\n"
        f"📍 {dest}\n"
        f"📋 Order: ...{data.order_number[-12:]}\n\n"
        f"Payment is being processed now."
    )

    await notify_trader(trader, msg)
    return {"ok": True}


# ── Choice Bank outbound payment (BUY order payments to sellers) ──────────────

class ChoicePayRequest(BaseModel):
    order_number: str
    payee_account_id: str   # M-Pesa phone (9 digits) or bank account number
    amount: float
    payee_name: str = ""
    bank_code: str = ""     # Empty for M-Pesa mobile; PesaLink bank code for bank transfers
    remark: str = ""


@router.post("/choice-pay")
async def choice_pay(
    data: ChoicePayRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Execute a Choice Bank outbound transfer on behalf of the trader.
    Called by the desktop bot for BUY order payments to sellers.
    Deducts from the trader's own Choice Bank sub-account (not SparkP2P wallet).
    """
    if not trader.choice_account_id:
        raise HTTPException(
            status_code=400,
            detail="No Choice Bank account linked. Complete KYC in the Bank Account tab first.",
        )

    from app.services.choice_bank.client import transfer

    # Hard balance gate — never move money the trader doesn't have (prevents a failed transfer that
    # leaves the seller falsely told "paid" and the order auto-cancelling).
    bal = await _choice_balance(trader)
    if bal is not None and bal < data.amount:
        raise HTTPException(
            status_code=400,
            detail=(f"Insufficient Choice balance: KES {bal:,.0f} available, "
                    f"KES {data.amount:,.0f} needed. Top up your Choice account."),
        )

    from app.services.choice_bank.client import send_otp

    remark = data.remark or f"Spark BUY {data.order_number[-12:]}"

    # M-Pesa B2C requires payeeBankCode="M-PESA". PesaLink requires the bank's CBK code.
    # Without the correct bank code Choice Bank treats the call as an internal transfer
    # and returns success without actually routing the money.
    is_mpesa = not data.bank_code and data.payee_account_id.isdigit() and len(data.payee_account_id) == 9
    effective_bank_code = data.bank_code if data.bank_code else ("M-PESA" if is_mpesa else "")
    logger.info(f"[ChoiceBank] BUY payment: KES {data.amount} → {data.payee_account_id} (bankCode={effective_bank_code or 'internal'})")

    result = await transfer(
        payer_account_id=trader.choice_account_id,
        payee_account_id=data.payee_account_id,
        amount=data.amount,
        payee_bank_code=effective_bank_code,
        payee_name=data.payee_name,
        remark=remark,
    )

    code = result.get("code", "")
    if code != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Choice Bank transfer failed"))

    tx_data = result.get("data") or {}
    tx_id = tx_data.get("txId") or tx_data.get("externalTxId") or ""
    application_id = tx_data.get("applicationId") or ""

    # All external transfers (M-Pesa, PesaLink, Airtel) require OTP before money moves.
    # - M-Pesa / Airtel: Choice Bank returns txId — we must call send_otp(txId) to trigger the OTP.
    # - PesaLink / large interbank: Choice Bank returns applicationId — OTP is auto-sent; we call
    #   send_otp as well (no-op if already sent) and use applicationId as the confirmation handle.
    # In both cases we return otp_required so the desktop waits for the SMS OTP via MacroDroid relay.
    business_id = tx_id or application_id
    if not business_id:
        raise HTTPException(status_code=502, detail="Choice Bank returned no transaction ID — transfer may not have been created")

    try:
        otp_res = await send_otp(business_id, otp_type="SMS")
        if otp_res.get("code") != "00000":
            logger.warning(f"[ChoiceBank] send_otp returned {otp_res.get('code')}: {otp_res.get('msg')} — OTP may be auto-sent by Choice Bank")
        else:
            logger.info(f"[ChoiceBank] OTP triggered via SMS for businessId={business_id}")
    except Exception as exc:
        logger.warning(f"[ChoiceBank] send_otp call failed: {exc} — continuing, OTP may be auto-sent")

    return {
        "status": "otp_required",
        "application_id": business_id,   # txId or applicationId — both work with confirm_otp
        "order_number": data.order_number,
        "amount": data.amount,
        "payee": data.payee_account_id,
        "payee_name": data.payee_name,
        "remark": remark,
    }


class ChoiceConfirmOtpRequest(BaseModel):
    application_id: str
    otp: str
    order_number: str
    amount: float
    payee_account_id: str
    payee_name: str = ""
    bank_code: str = ""
    remark: str = ""


@router.post("/choice-confirm-otp")
async def choice_confirm_otp(
    data: ChoiceConfirmOtpRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Confirm a Choice Bank transfer OTP read from Gmail. Called by desktop after readChoiceOTPviaIMAP."""
    from app.services.choice_bank.client import confirm_otp
    result = await confirm_otp(data.application_id, data.otp)
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "OTP confirmation failed"))
    tx_data = result.get("data") or {}
    tx_id = tx_data.get("txId") or tx_data.get("externalTxId") or data.application_id
    return await _finalise_choice_payment(
        trader=trader, db=db, tx_id=tx_id, amount=data.amount,
        payee_account_id=data.payee_account_id, payee_name=data.payee_name,
        order_number=data.order_number, remark=data.remark, bank_code=data.bank_code,
    )


class ChoicePayConfirmSmsRequest(BaseModel):
    application_id: str
    order_number: str
    amount: float
    payee_account_id: str
    payee_name: str = ""
    bank_code: str = ""
    remark: str = ""


@router.post("/choice-pay-confirm-sms")
async def choice_pay_confirm_sms(
    data: ChoicePayConfirmSmsRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Wait for Choice Bank SMS OTP forwarded via /api/webhooks/sms-otp, then confirm the transfer."""
    import asyncio
    from app.services.choice_bank.client import confirm_otp

    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account configured")

    account_last_4 = str(trader.choice_account_id)[-4:]

    # Fast path: OTP may have arrived before this endpoint was called (race condition in webhooks).
    # webhooks.py caches the OTP in _pending_sms_otps even when no waiter exists yet.
    cached = _pending_sms_otps.get(account_last_4)
    if cached and cached.get("otp") and cached.get("event") is None and _time.time() - cached.get("ts", 0) < 300:
        otp = cached["otp"]
        _pending_sms_otps.pop(account_last_4, None)
        logger.info(f"[ChoiceBank] Using cached SMS OTP for ****{account_last_4} (arrived before waiter)")
    else:
        # Register event waiter and block until OTP arrives
        event = asyncio.Event()
        _pending_sms_otps[account_last_4] = {"event": event, "otp": None}
        logger.info(f"[ChoiceBank] Waiting for SMS OTP for account ****{account_last_4} (applicationId={data.application_id})")
        otp = None
        try:
            try:
                await asyncio.wait_for(event.wait(), timeout=60.0)
            except asyncio.TimeoutError:
                logger.warning(f"[ChoiceBank] 60s OTP timeout for ****{account_last_4} — resending")
                try:
                    from app.services.choice_bank.client import resend_otp
                    await resend_otp(data.application_id, otp_type="SMS")
                except Exception as _re:
                    logger.warning(f"[ChoiceBank] resend_otp failed: {_re}")
                event.clear()
                _pending_sms_otps[account_last_4]["otp"] = None
                try:
                    await asyncio.wait_for(event.wait(), timeout=60.0)
                except asyncio.TimeoutError:
                    raise HTTPException(
                        status_code=408,
                        detail="Choice Bank OTP not received after resend — check MacroDroid SMS relay is running",
                    )
            otp = (_pending_sms_otps.get(account_last_4) or {}).get("otp")
            if not otp:
                raise HTTPException(status_code=502, detail="OTP event fired but no code was extracted from SMS")
        finally:
            _pending_sms_otps.pop(account_last_4, None)

    logger.info(f"[ChoiceBank] SMS OTP received for ****{account_last_4} — confirming with Choice Bank")
    result = await confirm_otp(data.application_id, otp)
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "OTP confirmation failed"))

    tx_data = result.get("data") or {}
    tx_id = tx_data.get("txId") or tx_data.get("externalTxId") or data.application_id
    return await _finalise_choice_payment(
        trader=trader, db=db, tx_id=tx_id, amount=data.amount,
        payee_account_id=data.payee_account_id, payee_name=data.payee_name,
        order_number=data.order_number, remark=data.remark, bank_code=data.bank_code,
    )


async def _finalise_choice_payment(*, trader, db, tx_id, amount, payee_account_id,
                                    payee_name, order_number, remark, bank_code):
    """Record the payment in DB and generate a receipt image after OTP is confirmed."""
    _dest_type = "Bank Transfer" if bank_code else "M-Pesa"
    payment = Payment(
        trader_id=trader.id,
        direction=PaymentDirection.OUTBOUND,
        status=PaymentStatus.COMPLETED,
        amount=amount,
        transaction_type="CHOICE_OUTBOUND",
        phone=payee_account_id,
        destination=payee_account_id,
        destination_type=_dest_type,
        sender_name=payee_name,
        mpesa_transaction_id=tx_id or None,
        remarks=f"BUY {order_number[-12:]}: {payee_name}",
    )
    db.add(payment)
    await db.commit()

    receipt_b64 = ""
    try:
        from app.services.payment_receipt import generate_receipt
        receipt_b64 = generate_receipt(
            amount=amount, payee_name=payee_name, payee_account=payee_account_id,
            ref=tx_id or remark, method="Bank Transfer" if bank_code else "M-Pesa",
        )
    except Exception as e:
        logger.warning(f"choice-pay receipt generation failed: {e}")

    # Notify trader that payment has been sent
    try:
        from app.api.routes.telegram import notify_trader as _tg_notify
        _method_label = "Bank/PesaLink" if bank_code else "M-Pesa"
        _short = order_number[-8:] if order_number else "?"
        await _tg_notify(
            trader,
            f"💸 <b>Payment sent!</b>\n\n"
            f"KES {int(amount):,} → {payee_name or payee_account_id} ({_method_label})\n"
            f"Order ref: <code>...{_short}</code>\n"
            f"<i>Waiting for seller to release crypto...</i>",
        )
    except Exception as _ne:
        logger.warning(f"choice-pay sent-notification failed: {_ne}")

    return {
        "success": True,
        "transaction_id": tx_id,
        "amount": amount,
        "payee": payee_account_id,
        "remark": remark,
        "receipt_image": receipt_b64,
    }
