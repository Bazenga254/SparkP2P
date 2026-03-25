import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Order, OrderSide, OrderStatus, Trader
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


class CreateOrderRequest(BaseModel):
    binance_order_number: str
    side: OrderSide
    crypto_amount: float
    crypto_currency: str = "USDT"
    fiat_amount: float
    exchange_rate: float
    # Buy side fields
    seller_payment_method: Optional[str] = None
    seller_payment_destination: Optional[str] = None
    seller_payment_name: Optional[str] = None


class OrderResponse(BaseModel):
    id: int
    binance_order_number: str
    side: str
    crypto_amount: float
    crypto_currency: str
    fiat_amount: float
    exchange_rate: float
    status: str
    account_reference: Optional[str]
    counterparty_name: Optional[str]
    platform_fee: float
    created_at: str
    payment_confirmed_at: Optional[str]
    released_at: Optional[str]
    settled_at: Optional[str]


@router.post("/", response_model=OrderResponse)
async def create_order(
    data: CreateOrderRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Create a new P2P order for tracking."""
    # Check daily limits
    today = func.current_date()
    result = await db.execute(
        select(func.count(Order.id)).where(
            Order.trader_id == trader.id,
            func.date(Order.created_at) == today,
        )
    )
    daily_count = result.scalar() or 0

    if daily_count >= trader.daily_trade_limit:
        raise HTTPException(status_code=400, detail="Daily trade limit reached")

    if data.fiat_amount > trader.max_single_trade:
        raise HTTPException(status_code=400, detail="Amount exceeds max single trade limit")

    # Generate account reference for sell side
    account_ref = None
    if data.side == OrderSide.SELL:
        prefix = f"T{trader.id:04d}"
        account_ref = f"P2P-{prefix}-{data.binance_order_number}"

    order = Order(
        trader_id=trader.id,
        binance_order_number=data.binance_order_number,
        side=data.side,
        crypto_amount=data.crypto_amount,
        crypto_currency=data.crypto_currency,
        fiat_amount=data.fiat_amount,
        exchange_rate=data.exchange_rate,
        account_reference=account_ref,
        seller_payment_method=data.seller_payment_method,
        seller_payment_destination=data.seller_payment_destination,
        seller_payment_name=data.seller_payment_name,
        platform_fee=0,
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)

    return _order_to_response(order)


@router.get("/", response_model=list[OrderResponse])
async def list_orders(
    side: Optional[OrderSide] = None,
    status: Optional[OrderStatus] = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """List trader's orders with optional filters."""
    query = select(Order).where(Order.trader_id == trader.id)

    if side:
        query = query.where(Order.side == side)
    if status:
        query = query.where(Order.status == status)

    query = query.order_by(Order.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    orders = result.scalars().all()

    return [_order_to_response(o) for o in orders]


@router.get("/stats")
async def get_order_stats(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get trading statistics."""
    today = func.current_date()

    # Today's stats
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.platform_fee), 0),
        ).where(
            Order.trader_id == trader.id,
            func.date(Order.created_at) == today,
        )
    )
    today_count, today_volume, today_fees = result.one()

    # Sell side stats today
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.crypto_amount), 0),
        ).where(
            Order.trader_id == trader.id,
            func.date(Order.created_at) == today,
            Order.side == OrderSide.SELL,
        )
    )
    sell_count, sell_volume, sell_crypto = result.one()

    # Buy side stats today
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.crypto_amount), 0),
        ).where(
            Order.trader_id == trader.id,
            func.date(Order.created_at) == today,
            Order.side == OrderSide.BUY,
        )
    )
    buy_count, buy_volume, buy_crypto = result.one()

    # Average rates today
    avg_buy_rate = float(buy_volume) / float(buy_crypto) if float(buy_crypto) > 0 else 0
    avg_sell_rate = float(sell_volume) / float(sell_crypto) if float(sell_crypto) > 0 else 0
    spread = avg_sell_rate - avg_buy_rate if avg_buy_rate > 0 and avg_sell_rate > 0 else 0
    spread_pct = (spread / avg_buy_rate * 100) if avg_buy_rate > 0 else 0

    # Gross profit = sell revenue - buy cost
    # Only count matched crypto (min of buy/sell crypto traded)
    matched_crypto = min(float(sell_crypto), float(buy_crypto))
    gross_profit = matched_crypto * spread if spread > 0 else 0

    # Net profit = gross - platform fees - settlement fees
    net_profit = gross_profit - float(today_fees)

    # Settlement fees from wallet transactions today
    from app.models.wallet import WalletTransaction, TransactionType
    result = await db.execute(
        select(
            func.coalesce(func.sum(func.abs(WalletTransaction.amount)), 0),
        ).where(
            WalletTransaction.trader_id == trader.id,
            func.date(WalletTransaction.created_at) == today,
            WalletTransaction.transaction_type.in_([
                TransactionType.SETTLEMENT_FEE,
                TransactionType.PLATFORM_FEE,
            ]),
        )
    )
    total_fees_today = float(result.scalar() or 0)
    net_profit = gross_profit - total_fees_today

    # Calculate estimated daily volume fee (0.05% of today's volume)
    today_volume_fee = round(float(today_volume) * 0.0005, 2)

    return {
        "today": {
            "total_trades": today_count,
            "sell_trades": sell_count,
            "buy_trades": today_count - sell_count,
            "volume": float(today_volume),
            "fees_paid": float(today_fees),
            "sell_volume": float(sell_volume),
            "buy_volume": float(buy_volume),
            "sell_crypto": float(sell_crypto),
            "buy_crypto": float(buy_crypto),
            "avg_buy_rate": round(avg_buy_rate, 2),
            "avg_sell_rate": round(avg_sell_rate, 2),
            "spread": round(spread, 2),
            "spread_pct": round(spread_pct, 2),
            "gross_profit": round(gross_profit, 2),
            "total_fees": round(total_fees_today, 2),
            "net_profit": round(net_profit, 2),
            "today_volume_fee": today_volume_fee,
        },
        "all_time": {
            "total_trades": trader.total_trades,
            "total_volume": trader.total_volume,
        },
        "limits": {
            "daily_limit": trader.daily_trade_limit,
            "remaining_today": trader.daily_trade_limit - today_count,
            "max_single_trade": trader.max_single_trade,
        },
    }


@router.get("/{order_id}", response_model=OrderResponse)
async def get_order(
    order_id: int,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific order."""
    result = await db.execute(
        select(Order).where(Order.id == order_id, Order.trader_id == trader.id)
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    return _order_to_response(order)


def _order_to_response(order: Order) -> OrderResponse:
    return OrderResponse(
        id=order.id,
        binance_order_number=order.binance_order_number,
        side=order.side.value,
        crypto_amount=order.crypto_amount,
        crypto_currency=order.crypto_currency,
        fiat_amount=order.fiat_amount,
        exchange_rate=order.exchange_rate,
        status=order.status.value,
        account_reference=order.account_reference,
        counterparty_name=order.counterparty_name,
        platform_fee=order.platform_fee,
        created_at=order.created_at.isoformat() if order.created_at else "",
        payment_confirmed_at=order.payment_confirmed_at.isoformat() if order.payment_confirmed_at else None,
        released_at=order.released_at.isoformat() if order.released_at else None,
        settled_at=order.settled_at.isoformat() if order.settled_at else None,
    )
