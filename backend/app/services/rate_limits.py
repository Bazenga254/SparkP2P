"""Per-tier daily rate limits — trades and Telegram alerts.

Caps come from the trader's ACTIVE subscription tier (app.services.plans) and reset at the
trading-day boundary (00:00 UTC = 03:00 EAT, app.core.trading_day). A cap of 0 (UNLIMITED) = no cap.

Safety: traders with NO active subscription are NOT newly blocked here — trades fall back to their
existing trader.daily_trade_limit and Telegram is uncapped — so this rollout never locks out current
users. Requiring a subscription for ALL traders is a separate business decision.
"""
from datetime import timedelta
from sqlalchemy import select, func

from app.core.database import async_session
from app.core.trading_day import trading_day_start, trading_day_key, now_utc
from app.models.order import Order, OrderStatus
from app.models.trader import Trader
from app.services.plans import active_plan, plan_daily_trades, plan_daily_tg, UNLIMITED


def _next_reset():
    return trading_day_start() + timedelta(days=1)


async def trade_rate_status(db, trader) -> dict:
    """Daily completed-trade cap status: {used, limit, unlimited, allowed, reset_at, plan}."""
    plan = await active_plan(db, trader.id)
    if plan is not None:
        limit = plan_daily_trades(plan)
    else:
        limit = int(trader.daily_trade_limit or 0)   # non-subscriber: keep existing behavior
    used = (await db.execute(
        select(func.count(Order.id)).where(
            Order.trader_id == trader.id,
            Order.created_at >= trading_day_start(),
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )).scalar() or 0
    unlimited = (limit == UNLIMITED)
    return {
        "used": int(used),
        "limit": int(limit),
        "unlimited": unlimited,
        "allowed": bool(unlimited or used < limit),
        "reset_at": _next_reset().isoformat(),
        "plan": plan.value if plan else None,
    }


def tg_rate_status(plan, trader) -> dict:
    """Daily Telegram-alert cap status (pure; plan already resolved)."""
    limit = plan_daily_tg(plan) if plan is not None else UNLIMITED   # non-subscriber: uncapped
    today = trading_day_key(now_utc())
    used = (trader.tg_alerts_count or 0) if (trader.tg_alerts_day or "") == today else 0
    unlimited = (limit == UNLIMITED)
    return {
        "used": int(used),
        "limit": int(limit),
        "unlimited": unlimited,
        "allowed": bool(unlimited or used < limit),
        "reset_at": _next_reset().isoformat(),
        "plan": plan.value if plan else None,
    }


async def consume_tg_alert(trader_id: int) -> bool:
    """Reserve one Telegram alert against today's cap. Returns True if allowed (and increments the
    counter), False if the trader has hit their daily cap. Opens its own session — safe to call
    from notification code that doesn't hold a db session."""
    async with async_session() as db:
        trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
        if not trader:
            return True   # don't drop alerts for unknown traders
        plan = await active_plan(db, trader_id)
        limit = plan_daily_tg(plan) if plan is not None else UNLIMITED
        today = trading_day_key(now_utc())
        if (trader.tg_alerts_day or "") != today:
            trader.tg_alerts_day = today
            trader.tg_alerts_count = 0
        if limit != UNLIMITED and (trader.tg_alerts_count or 0) >= limit:
            await db.commit()
            return False
        trader.tg_alerts_count = (trader.tg_alerts_count or 0) + 1
        await db.commit()
        return True
