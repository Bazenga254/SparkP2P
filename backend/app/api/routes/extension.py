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


@router.post("/heartbeat")
async def heartbeat(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Extension sends heartbeat every 30 seconds.
    Updates last_seen timestamp.
    """
    trader.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok", "trader_id": trader.id}


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
        f"Account Number: {account_ref}\n"
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

    # Enforce buy order minimum: KES 100,000
    if order_data.totalPrice < 100000:
        logger.warning(
            f"Buy order {order_number} below minimum (KES {order_data.totalPrice:,.0f} < KES 100,000). Skipping."
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

    # Auto-pay if enabled, within limits, AND trader is on Pro tier
    if not (trader.auto_pay_enabled and amount <= trader.max_single_trade and trader.tier == "pro"):
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
        return {"action": "get_order_details", "order_number": order_number}

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
