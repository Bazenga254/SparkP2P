"""Subscription plans — single source of truth for pricing + daily rate limits.

Three tiers. Daily limits reset at the trading-day boundary
(00:00 UTC = 03:00 EAT, see app.core.trading_day). A limit of 0 means UNLIMITED.

    Bronze  KES 5,000/mo    unlimited trades   unlimited Telegram alerts
    Silver  KES 7,500/mo    unlimited trades   unlimited Telegram alerts
    Gold    KES 10,000/mo   unlimited trades   unlimited Telegram alerts

All tiers now have unlimited trades + Telegram alerts; the tiers differ by price,
price-tracker data visibility (Bronze: bronze only; Silver: +silver; Gold: all)
and Gold's priority support. The plan is auto-assigned from the merchant's live
Binance P2P tier (see traders.apply_tier_plan), not chosen manually.
"""
from datetime import datetime, timezone
from sqlalchemy import select

from app.models.subscription import SubscriptionPlan, Subscription, SubscriptionStatus

import logging
logger = logging.getLogger(__name__)

UNLIMITED = 0

# Binance P2P medal tier -> the SparkP2P plan it maps to. Plans are AUTO-ASSIGNED from the
# merchant's live Binance tier (locked — merchants don't pick manually).
TIER_TO_PLAN = {
    "gold":   SubscriptionPlan.PRO_MAX,
    "silver": SubscriptionPlan.PRO,
    "bronze": SubscriptionPlan.STARTER,
}


def plan_for_tier(tier):
    return TIER_TO_PLAN.get((tier or "").lower())


async def apply_tier_plan(trader, db) -> bool:
    """Move the trader's ACTIVE subscription to the plan matching their Binance P2P tier
    (trader.binance_merchant_tier). BILLING = from next renewal: keep the paid period + expiry, just
    switch the plan so features/price-tracker visibility follow immediately and the NEXT renewal
    charges the new plan's price.

    Safety rails: unknown/missing tier -> no change (never demote on a bad/offline read); billing-
    exempt traders and the admin-only B2C/ADVANCED plan are left alone; no active subscription ->
    nothing to move (a new merchant simply pays for the plan their tier maps to). Returns True if
    the plan actually changed."""
    target = plan_for_tier(getattr(trader, "binance_merchant_tier", None))
    if not target or getattr(trader, "billing_exempt", False):
        return False
    r = await db.execute(select(Subscription).where(
        Subscription.trader_id == trader.id,
        Subscription.status == SubscriptionStatus.ACTIVE,
    ).order_by(Subscription.expires_at.desc()))
    # A trader can have MORE THAN ONE active row (stacked payments); take the newest by
    # expiry. scalar_one_or_none() would raise MultipleResultsFound and silently break the
    # hourly tier sync for that trader.
    sub = r.scalars().first()
    if not sub or not sub.is_active or sub.plan == SubscriptionPlan.ADVANCED or sub.plan == target:
        return False
    old = sub.plan.value
    sub.plan = target
    await db.commit()
    logger.info("apply_tier_plan: trader %s plan %s -> %s (Binance tier=%s)",
                trader.id, old, target.value, trader.binance_merchant_tier)
    return True


PLAN_CONFIG = {
    SubscriptionPlan.STARTER: {"label": "Bronze", "price": 5000, "daily_trades": UNLIMITED, "daily_tg": UNLIMITED},
    SubscriptionPlan.PRO:     {"label": "Silver", "price": 7500, "daily_trades": UNLIMITED, "daily_tg": UNLIMITED},
    SubscriptionPlan.PRO_MAX: {"label": "Gold",   "price": 10000, "daily_trades": UNLIMITED, "daily_tg": UNLIMITED},
    # B2C-via-own-paybill plan — NOT public. Only offered to admin-flagged clients
    # (trader.b2c_own_paybill_enabled). Kept out of PLAN_ORDER so it never shows on the
    # public/Landing pricing; surfaced only on the flagged trader's own Subscriptions tab.
    SubscriptionPlan.ADVANCED: {"label": "B2C",   "price": 15000, "daily_trades": UNLIMITED, "daily_tg": UNLIMITED},
}
# Order shown in PUBLIC UIs (Landing, plan catalogue). ADVANCED/B2C is intentionally excluded.
PLAN_ORDER = [SubscriptionPlan.STARTER, SubscriptionPlan.PRO, SubscriptionPlan.PRO_MAX]
# The hidden, admin-gated B2C plan key (for code that needs to reference it explicitly).
B2C_PLAN = SubscriptionPlan.ADVANCED


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
