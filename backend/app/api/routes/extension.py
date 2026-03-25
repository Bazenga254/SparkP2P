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
    sellerPaymentMethod: Optional[str] = None  # mpesa, bank
    sellerPaymentPhone: Optional[str] = None  # seller's M-Pesa number
    sellerPaymentAccount: Optional[str] = None  # seller's account number


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
    Updates binance_connected and last_seen.
    """
    trader.binance_connected = True
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

    # For orders >= KES 50,000, SparkP2P covers the B2C fee (platform absorbs it)
    # For orders < KES 50,000, deduct Safaricom B2C fee from buyer's wallet
    b2c_fee_covered_by_platform = amount >= 50_000
    if not b2c_fee_covered_by_platform:
        # Estimate Safaricom B2C fee (tiered):
        # KES 0-999: ~KES 11, KES 1000-1499: ~KES 15, KES 1500-2499: ~KES 22,
        # KES 2500-3499: ~KES 33, KES 3500-4999: ~KES 55, KES 5000-9999: ~KES 77,
        # KES 10000-14999: ~KES 112, KES 15000-19999: ~KES 197,
        # KES 20000-34999: ~KES 220, KES 35000-49999: ~KES 250
        if amount < 1000: b2c_fee = 11
        elif amount < 1500: b2c_fee = 15
        elif amount < 2500: b2c_fee = 22
        elif amount < 3500: b2c_fee = 33
        elif amount < 5000: b2c_fee = 55
        elif amount < 10000: b2c_fee = 77
        elif amount < 15000: b2c_fee = 112
        elif amount < 20000: b2c_fee = 197
        elif amount < 35000: b2c_fee = 220
        else: b2c_fee = 250

        # Deduct fee from buyer wallet
        if wallet.balance >= b2c_fee:
            wallet.balance -= b2c_fee
            fee_txn = WalletTransaction(
                trader_id=trader.id,
                wallet_id=wallet.id,
                order_id=order.id,
                transaction_type=TransactionType.SETTLEMENT_FEE,
                amount=-b2c_fee,
                balance_after=wallet.balance,
                description=f"Safaricom B2C fee for order {order_number}",
            )
            db.add(fee_txn)
            await db.flush()
            logger.info(f"B2C fee KES {b2c_fee} deducted from buyer wallet for order {order_number}")
        else:
            logger.warning(f"Buyer wallet cannot cover B2C fee KES {b2c_fee} for order {order_number}, proceeding anyway")
    else:
        logger.info(f"Order {order_number} >= KES 50K: SparkP2P covers B2C fee")

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
