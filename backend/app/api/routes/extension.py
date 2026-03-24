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
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models import Order, OrderSide, OrderStatus, Trader
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.services.settlement.engine import SettlementEngine
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────

class BinanceOrderData(BaseModel):
    orderNumber: str
    advNo: Optional[str] = None
    tradeType: str  # "SELL" or "BUY"
    totalPrice: float  # fiat amount
    amount: float  # crypto amount
    price: float  # exchange rate
    asset: str = "USDT"
    buyerNickname: Optional[str] = None
    sellerNickname: Optional[str] = None
    orderStatus: Optional[int] = None  # 1=pending, 2=buyer paid, 3=releasing


class ReportOrdersRequest(BaseModel):
    sell_orders: list[BinanceOrderData] = []
    buy_orders: list[BinanceOrderData] = []


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
    # Check subscription
    from app.models.subscription import Subscription, SubscriptionStatus
    sub_result = await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.expires_at.desc())
    )
    sub = sub_result.scalar_one_or_none()
    if not sub or not sub.is_active:
        return {"actions": [], "message": "No active subscription"}

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

    # Buy side: pending orders that need auto-pay (pro tier only)
    if trader.auto_pay_enabled and trader.tier == "pro":
        result = await db.execute(
            select(Order).where(
                Order.trader_id == trader.id,
                Order.side == OrderSide.BUY,
                Order.status == OrderStatus.PENDING,
            )
        )
        for order in result.scalars().all():
            if order.fiat_amount <= trader.max_single_trade:
                actions.append({
                    "action": "pay",
                    "order_number": order.binance_order_number,
                })

    return {"actions": actions}


@router.post("/heartbeat")
async def heartbeat(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension sends heartbeat every 30 seconds.
    Updates binance_connected and last_seen.
    """
    trader.binance_connected = True
    trader.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok", "trader_id": trader.id}


# ── Internal helpers ──────────────────────────────────────────────

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

    # Check if we already track this order
    result = await db.execute(
        select(Order).where(Order.binance_order_number == order_number)
    )
    existing = result.scalar_one_or_none()

    if existing:
        # Already tracked — check if payment was received and needs release
        if existing.status == OrderStatus.PAYMENT_RECEIVED and trader.auto_release_enabled:
            existing.status = OrderStatus.RELEASING
            await db.commit()
            return {"action": "release", "order_number": order_number}
        return None

    # Create new order
    amount = order_data.totalPrice
    crypto_amount = order_data.amount
    rate = order_data.price
    currency = order_data.asset

    prefix = f"T{trader.id:04d}"
    account_ref = f"P2P-{prefix}-{order_number}"

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
        f"Hello! Please pay KES {amount:,.0f} to:\n"
        f"Paybill: {paybill}\n"
        f"Account: {account_ref}\n\n"
        f"Your crypto will be released automatically after payment confirmation."
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
    If auto-pay is enabled (pro tier), triggers M-Pesa payment from VPS
    and tells extension to mark as paid.
    """
    order_number = order_data.orderNumber

    # Check if we already track this order
    result = await db.execute(
        select(Order).where(Order.binance_order_number == order_number)
    )
    existing = result.scalar_one_or_none()

    if existing:
        # If we already sent payment but haven't told extension to mark as paid
        if existing.status == OrderStatus.PAYMENT_SENT:
            return {"action": "pay", "order_number": order_number}
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
    )
    db.add(order)
    await db.commit()

    logger.info(f"New buy order tracked: {order_number} for trader {trader.full_name}")

    # Auto-pay if enabled, within limits, AND trader is on Pro tier
    if trader.auto_pay_enabled and amount <= trader.max_single_trade and trader.tier == "pro":
        # NOTE: For buy-side, we need order detail (seller payment info)
        # which the extension will need to fetch separately.
        # For now, just tell extension to get order detail.
        # The VPS handles M-Pesa payment via _trigger_auto_release flow.
        pass

    return None
