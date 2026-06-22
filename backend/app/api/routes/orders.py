import io
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.trading_day import trading_day_start
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
    cancelled_at: Optional[str]


@router.post("/", response_model=OrderResponse)
async def create_order(
    data: CreateOrderRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Create a new P2P order for tracking."""
    # Daily trade rate limit — per active subscription tier (Starter 30 / Starter Pro 80 /
    # Starter Pro Max unlimited), resets at 03:00 EAT. Non-subscribers keep existing behavior.
    from app.services.rate_limits import trade_rate_status
    _rl = await trade_rate_status(db, trader)
    if not _rl["allowed"]:
        raise HTTPException(status_code=429, detail={
            "error": "daily_trade_limit_reached",
            "message": f"Daily trade limit reached ({_rl['used']}/{_rl['limit']}). Trading resets at 3:00 AM.",
            "used": _rl["used"], "limit": _rl["limit"], "reset_at": _rl["reset_at"],
        })

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


# Time ranges for the export. "24h" = the current trading day (since 03:00 EAT = 00:00 UTC); the
# larger ranges count back that many days from the same 03:00 boundary, so every range honours the
# 3 AM account-day reset the rest of the app uses.
_EXPORT_RANGES = {"24h": 0, "7d": 7, "30d": 30, "1y": 365}
_EAT = timezone(timedelta(hours=3))


@router.get("/export")
async def export_orders(
    period: str = Query("all", alias="range"),   # 24h | 7d | 30d | 1y | all
    kind: str = Query("all", alias="type"),      # all | incoming | outgoing
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Export the trader's orders (incoming + outgoing) to an .xlsx file, filtered by time range and
    type. 24h respects the 3 AM EAT trading-day boundary. (Param names avoid shadowing range()/type().)"""
    start = None
    if period != "all":
        if period not in _EXPORT_RANGES:
            raise HTTPException(status_code=400, detail="Invalid range")
        start = trading_day_start() - timedelta(days=_EXPORT_RANGES[period])

    q = select(Order).where(Order.trader_id == trader.id)
    if start is not None:
        q = q.where(Order.created_at >= start)
    if kind == "incoming":
        q = q.where(Order.side == OrderSide.SELL)
    elif kind == "outgoing":
        q = q.where(Order.side == OrderSide.BUY)
    q = q.order_by(Order.created_at.desc())
    orders = (await db.execute(q)).scalars().all()

    import xlsxwriter
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})
    ws = wb.add_worksheet("Orders")

    f_hdr = wb.add_format({"bold": True, "bg_color": "#0E1117", "font_color": "#FFFFFF", "border": 1, "align": "center", "valign": "vcenter"})
    f_txt = wb.add_format({"border": 1})
    f_in = wb.add_format({"border": 1, "font_color": "#059669", "bold": True})
    f_out = wb.add_format({"border": 1, "font_color": "#D97706", "bold": True})
    f_num = wb.add_format({"border": 1, "num_format": "#,##0.00"})
    f_kes = wb.add_format({"border": 1, "num_format": "#,##0.00"})
    f_tot = wb.add_format({"bold": True, "border": 1, "num_format": "#,##0.00", "bg_color": "#F3F4F6"})
    f_totlbl = wb.add_format({"bold": True, "border": 1, "bg_color": "#F3F4F6"})

    headers = ["Type", "Amount (KES)", "Crypto", "Currency", "Rate", "Status", "Reference", "Counterparty", "Time (EAT)"]
    widths = [11, 16, 12, 9, 10, 14, 24, 22, 21]
    for c, h in enumerate(headers):
        ws.write(0, c, h, f_hdr)
        ws.set_column(c, c, widths[c])
    ws.freeze_panes(1, 0)

    total_kes = 0.0
    total_crypto = 0.0
    r = 1
    for o in orders:
        is_in = (o.side == OrderSide.SELL)
        kes = float(o.fiat_amount or 0)
        crypto = float(o.crypto_amount or 0)
        total_kes += kes
        total_crypto += crypto
        ws.write_string(r, 0, "Incoming" if is_in else "Outgoing", f_in if is_in else f_out)
        ws.write_number(r, 1, kes, f_kes)
        ws.write_number(r, 2, crypto, f_num)
        ws.write_string(r, 3, o.crypto_currency or "USDT", f_txt)
        ws.write_number(r, 4, float(o.exchange_rate or 0), f_num)
        ws.write_string(r, 5, (o.status.value if o.status else ""), f_txt)
        # reference written as text so Excel doesn't mangle the long order number into 2.28E+19
        ws.write_string(r, 6, str(o.binance_order_number or o.account_reference or ""), f_txt)
        ws.write_string(r, 7, o.counterparty_name or "", f_txt)
        ws.write_string(r, 8, o.created_at.astimezone(_EAT).strftime("%Y-%m-%d %H:%M:%S") if o.created_at else "", f_txt)
        r += 1

    # Totals row
    ws.write_string(r, 0, f"TOTAL ({len(orders)})", f_totlbl)
    ws.write_number(r, 1, total_kes, f_tot)
    ws.write_number(r, 2, total_crypto, f_tot)
    for c in range(3, len(headers)):
        ws.write_string(r, c, "", f_totlbl)

    wb.close()
    buf.seek(0)
    stamp = datetime.now(_EAT).strftime("%Y%m%d-%H%M")
    fname = f"sparkp2p-orders-{period}-{kind}-{stamp}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/stats")
async def get_order_stats(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get trading statistics."""
    # Trading day boundary from the central source of truth (00:00 UTC = 03:00 EAT).
    today_start = trading_day_start()
    # Daily trade limit comes from the active subscription tier (Starter 30 / Pro 80 / Pro Max ∞).
    from app.services.rate_limits import trade_rate_status
    _rl = await trade_rate_status(db, trader)
    # Only count orders that actually completed — not pending/cancelled/expired
    completed_statuses = [OrderStatus.RELEASED, OrderStatus.COMPLETED]

    # Today's stats
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.platform_fee), 0),
        ).where(
            Order.trader_id == trader.id,
            Order.created_at >= today_start,
            Order.status.in_(completed_statuses),
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
            Order.created_at >= today_start,
            Order.side == OrderSide.SELL,
            Order.status.in_(completed_statuses),
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
            Order.created_at >= today_start,
            Order.side == OrderSide.BUY,
            Order.status.in_(completed_statuses),
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
            WalletTransaction.created_at >= today_start,
            WalletTransaction.transaction_type.in_([
                TransactionType.SETTLEMENT_FEE,
                TransactionType.PLATFORM_FEE,
            ]),
            WalletTransaction.status == "completed",
        )
    )
    total_fees_today = float(result.scalar() or 0)

    # Binance merchant fee per completed trade (deducted by Binance, not SparkP2P)
    _binance_fee_map = {"gold": 0.25, "silver": 0.35, "bronze": 0.40}
    binance_fee_per_trade = _binance_fee_map.get(trader.binance_merchant_tier or "bronze", 0.40)
    binance_fees_today = round(today_count * binance_fee_per_trade, 2)

    net_profit = gross_profit - total_fees_today - binance_fees_today

    # Dominant currency today (most-traded coin)
    dom_result = await db.execute(
        select(Order.crypto_currency, func.count(Order.id).label("cnt")).where(
            Order.trader_id == trader.id,
            Order.created_at >= today_start,
            Order.status.in_(completed_statuses),
        ).group_by(Order.crypto_currency).order_by(func.count(Order.id).desc()).limit(1)
    )
    dom_row = dom_result.first()
    dominant_currency = dom_row[0] if dom_row else "USDT"

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
            "binance_fees": binance_fees_today,
            "binance_fee_per_trade": binance_fee_per_trade,
            "net_profit": round(net_profit, 2),
            "dominant_currency": dominant_currency,
        },
        "all_time": {
            "total_trades": trader.total_trades,
            "total_volume": trader.total_volume,
        },
        "limits": {
            "daily_limit": _rl["limit"],
            "remaining_today": (None if _rl["unlimited"] else max(0, _rl["limit"] - _rl["used"])),
            "used_today": _rl["used"],
            "unlimited": _rl["unlimited"],
            "reset_at": _rl["reset_at"],
            "plan": _rl["plan"],
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
        cancelled_at=order.cancelled_at.isoformat() if order.cancelled_at else None,
    )
