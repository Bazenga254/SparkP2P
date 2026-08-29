"""Subscription plans — single source of truth for pricing + daily rate limits.

Three tiers. Daily limits reset at the trading-day boundary
(00:00 UTC = 03:00 EAT, see app.core.trading_day). A limit of 0 means UNLIMITED.

    Bronze  KES 5,000/mo    unlimited trades   unlimited Telegram alerts
    Silver  KES 7,500/mo    unlimited trades   unlimited Telegram alerts
    Gold    KES 10,000/mo   unlimited trades   unlimited Telegram alerts

All tiers now have unlimited trades + Telegram alerts; the tiers differ by price,
price-tracker data visibility (Bronze: bronze only; Silver: +silver; Gold: all)
and Gold's priority support.

The subscription plan reflects what the merchant PAID / was granted — it is NOT
auto-assigned from their Binance medal (apply_tier_plan is now a no-op; see it for why).
The Gold/Silver/Bronze CAPABILITIES still follow the live Binance medal via
binance_merchant_tier (price-tracker visibility, the 0.25 fee, counterparty filters),
so a Block merchant keeps every Gold power even on a Silver plan.
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
    """DISABLED (Aug 20 2026) — a no-op that never changes the plan.

    The subscription plan now reflects what the merchant PAID / was granted, NOT their
    live Binance medal. Auto-upgrading the plan off the medal (Block/Gold → PRO_MAX)
    silently put Silver-paying merchants on a Gold plan: their subscription card read
    "Gold" while their tier, badge, I&M plan and billing all said Silver — a persistent
    confusion (three Block merchants ended up PRO_MAX on the 7,500 Silver price).

    Nothing is left for it to do: billing already follows the paid amount
    (im_pricing.rate_for_trader → plan_for_price), and the Gold/Silver/Bronze CAPABILITIES
    (price-tracker data visibility, the 0.25 KES fee, counterparty filters) key off
    binance_merchant_tier, never the plan — so a Block merchant keeps every Gold power
    with a Silver plan. Kept as a no-op so its callers (tier_poller, connect-Binance) need
    no change; the tier poller still records binance_p2p_tier / binance_merchant_tier for
    the badges and those capabilities. Returns False (the plan is never touched here)."""
    return False


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


async def active_subscription(db, trader_id):
    """The trader's current active, unexpired Subscription ROW (or None).

    Same selection as active_plan(), but returns the row so callers can read the
    PAID AMOUNT — I&M/credit billing charges by what the merchant actually paid,
    not by a plan the hourly tier-poller may have auto-upgraded from their Binance
    medal (see plan_for_price + im_pricing.rate_for_trader)."""
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
    return sub


async def active_plan(db, trader_id):
    """Return the trader's current active SubscriptionPlan, or None (free / no subscription)."""
    sub = await active_subscription(db, trader_id)
    return sub.plan if sub else None


def plan_for_price(amount):
    """Reverse-map a PAID subscription amount to the plan whose CURRENT price equals it.

    Returns None when the amount matches no current plan price (a subscription bought
    under old pricing, or a nominal admin grant) — callers then fall back to the stored
    plan. Prices are all distinct (5000/7500/10000/15000), so the map is unambiguous."""
    try:
        amt = int(amount)
    except (TypeError, ValueError):
        return None
    for plan, cfg in PLAN_CONFIG.items():
        if cfg.get("price") == amt:
            return plan
    return None
