"""I&M weekly payout plan — the flat-fee, unlimited-payouts alternative to
on-demand credits.

ONE source of truth for: the weekly price per tier, whether a merchant is on an
ACTIVE week, and the money logic (a payment accumulates in im_plan_balance;
when it covers the tier price a 7-day week is activated and the price deducted;
the excess rolls over toward the next week; a partial payment is HELD).

A merchant on an active week gets UNLIMITED payouts — the poller never pauses
them and record_charge does not consume a credit. When the week expires they are
auto-renewed from any rolled-over balance that covers a full week; otherwise the
bot pauses until they top up.
"""
import logging
from datetime import datetime, timezone, timedelta

from app.core.tiers import display_tier

logger = logging.getLogger(__name__)

# KES per week for UNLIMITED I&M payouts, by the merchant's display tier.
WEEKLY_PLAN_PRICE = {
    "block":  5000,
    "gold":   4500,
    "silver": 3000,
    "bronze": 2000,
}
# Merchants with NO detected Binance tier (unranked / normal) still get a plan.
DEFAULT_WEEKLY_PRICE = 8000

WEEK = timedelta(days=7)
SAVING_NOTE = "You are saving 15% credit costs on this plan"


def _now():
    return datetime.now(timezone.utc)


def weekly_price(trader):
    """The weekly price for this trader — their tier price, or KES 8000 for an
    unranked/untiered (normal) merchant. Always returns a usable price."""
    return WEEKLY_PLAN_PRICE.get(display_tier(trader), DEFAULT_WEEKLY_PRICE)


def on_weekly_mode(trader) -> bool:
    """Admin has put this merchant on the weekly package (vs on-demand credits)."""
    return getattr(trader, "im_billing_mode", "on_demand") == "weekly"


def _active_until(trader):
    dt = getattr(trader, "im_weekly_active_until", None)
    if dt is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def on_active_weekly_plan(trader) -> bool:
    """True only when weekly mode AND the current week has not expired — i.e. the
    merchant currently has UNLIMITED payouts."""
    if not on_weekly_mode(trader):
        return False
    until = _active_until(trader)
    return bool(until and until > _now())


def _try_activate(trader) -> bool:
    """If the held balance covers the tier price, consume it to (re)start a 7-day
    week. Stacks: paying two weeks up front extends the expiry by two weeks.
    Returns True if a week was (re)activated. Caller commits."""
    price = weekly_price(trader)
    if not price:
        return False
    activated = False
    bal = float(getattr(trader, "im_plan_balance", 0) or 0)
    # Each full price buys one more week. Loop so a big prepay stacks weeks.
    while bal >= price:
        base = _active_until(trader)
        start = base if (base and base > _now()) else _now()
        trader.im_weekly_active_until = start + WEEK
        bal -= price
        activated = True
    trader.im_plan_balance = round(bal, 2)
    return activated


def apply_payment(trader, amount_kes: float) -> dict:
    """A merchant on weekly mode paid `amount_kes` toward their plan. Add it to the
    held balance and activate/extend as many full weeks as it covers; the remainder
    stays as their rollover balance. Caller commits. Returns a small summary."""
    trader.im_plan_balance = round(float(getattr(trader, "im_plan_balance", 0) or 0) + float(amount_kes or 0), 2)
    activated = _try_activate(trader)
    return {
        "activated": activated,
        "active_until": _active_until(trader),
        "balance": float(getattr(trader, "im_plan_balance", 0) or 0),
        "price": weekly_price(trader),
    }


def renew_if_due(trader) -> bool:
    """Called by the expiry poller. If the week has lapsed, try to auto-renew from
    the rolled-over balance. Returns True if a renewal happened. If it can't renew
    (not enough balance) the plan simply stays expired and the bot pauses."""
    if not on_weekly_mode(trader):
        return False
    if on_active_weekly_plan(trader):
        return False  # still inside the current week — nothing to do
    return _try_activate(trader)


def status(trader) -> dict:
    """Everything the /credits endpoint and the UIs need to render the plan."""
    price = weekly_price(trader)
    active = on_active_weekly_plan(trader)
    until = _active_until(trader)
    return {
        "mode": "weekly" if on_weekly_mode(trader) else "on_demand",
        "weekly_price": price,
        "active": active,
        "active_until": until.isoformat() if until else None,
        "plan_balance": round(float(getattr(trader, "im_plan_balance", 0) or 0), 2),
        "saving_note": SAVING_NOTE,
    }
