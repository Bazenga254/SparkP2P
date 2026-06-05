"""Subscription plans — single source of truth for pricing + daily rate limits.

Three tiers (display names keep "Starter"). Daily limits reset at the trading-day boundary
(00:00 UTC = 03:00 EAT, see app.core.trading_day). A limit of 0 means UNLIMITED.

    Starter         KES 3,000/mo   30 trades/day    100 Telegram alerts/day
    Starter Pro     KES 5,000/mo   80 trades/day    200 Telegram alerts/day
    Starter Pro Max KES 10,000/mo  unlimited        unlimited
"""
from datetime import datetime, timezone
from sqlalchemy import select

from app.models.subscription import SubscriptionPlan, Subscription, SubscriptionStatus

UNLIMITED = 0

PLAN_CONFIG = {
    SubscriptionPlan.STARTER: {"label": "Starter",         "price": 3000,  "daily_trades": 30,        "daily_tg": 100},
    SubscriptionPlan.PRO:     {"label": "Starter Pro",     "price": 5000,  "daily_trades": 80,        "daily_tg": 200},
    SubscriptionPlan.PRO_MAX: {"label": "Starter Pro Max", "price": 10000, "daily_trades": UNLIMITED, "daily_tg": UNLIMITED},
}
# Order shown in UIs. ADVANCED is retired (not offered).
PLAN_ORDER = [SubscriptionPlan.STARTER, SubscriptionPlan.PRO, SubscriptionPlan.PRO_MAX]


def plan_price(plan) -> int:
    return PLAN_CONFIG.get(plan, {}).get("price", 0)


def plan_label(plan) -> str:
    if plan is None:
        return "Free"
    return PLAN_CONFIG.get(plan, {}).get("label", str(getattr(plan, "value", plan)).title())


def plan_daily_trades(plan):
    """Trades/day for a plan (0 = unlimited). None if the trader has no active plan."""
    if plan is None:
        return None
    return PLAN_CONFIG.get(plan, {}).get("daily_trades", UNLIMITED)


def plan_daily_tg(plan):
    """Telegram alerts/day for a plan (0 = unlimited). None if no active plan."""
    if plan is None:
        return None
    return PLAN_CONFIG.get(plan, {}).get("daily_tg", UNLIMITED)


async def active_plan(db, trader_id):
    """Return the trader's current active SubscriptionPlan, or None (free / no subscription)."""
    sub = (await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader_id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.started_at.desc())
    )).scalars().first()
    if not sub:
        return None
    if sub.expires_at and datetime.now(timezone.utc) > sub.expires_at:
        return None
    return sub.plan
