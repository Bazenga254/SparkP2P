"""Subscription entitlement enforcement — the single gate for paid automation.

A trader may use the bot's paid features (auto buy/sell/release, Telegram/any notifications,
profit stats, price tracker, margin calculator, counterparty filters) only when they are
**billing_active**: billing-exempt (admins / test / grandfathered) OR holding an active,
non-expired subscription plan.

Two enforcement modes:
  * Subscription expired  -> billing_active() is False -> everything paid is locked, and the
    subscription_enforcer wipes the trader's bot config to zero (destructive, by product
    decision). Choice Bank banking is intentionally NOT gated here — it's the user's own money.
  * Daily trade cap hit (while still subscribed) -> can_auto_trade() returns False with
    reason 'daily_limit' until the 03:00 EAT reset; the rest of the app stays usable.
"""
from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.models.trader import Trader
from app.services.plans import active_plan
from app.services.rate_limits import trade_rate_status


async def billing_active(db, trader) -> bool:
    """True if the trader is entitled to paid automation (billing-exempt or active plan).

    When the global ENFORCEMENT_ENABLED switch is off, EVERYONE is treated as active — so
    nothing is locked and the feature ships as a no-op until the switch is flipped on."""
    if not settings.ENFORCEMENT_ENABLED:
        return True
    if getattr(trader, "billing_exempt", False):
        return True
    return (await active_plan(db, trader.id)) is not None


def account_frozen(trader) -> bool:
    """A SUSPENDED trader is FROZEN: every paid/automation feature is off, and only
    Choice Bank (their own money) stays usable. This is an ADMIN action, independent
    of the billing / ENFORCEMENT_ENABLED switch — a suspended account is frozen even
    when subscription enforcement is turned off. Choice Bank routes never call this,
    so a frozen trader can still bank; everything else is locked. The dashboard mirrors
    this: all tabs except Overview / Transactions / My Paybill are blurred + unclickable."""
    from app.models.trader import TraderStatus
    return getattr(trader, "status", None) == TraderStatus.SUSPENDED


async def subscription_locked(db, trader) -> bool:
    """Convenience for endpoints that lock when not entitled. Locked when the trader is
    account-frozen (admin suspension — always, regardless of the enforcement switch) OR
    not billing_active (subscription expired). Choice Bank is deliberately never gated."""
    if account_frozen(trader):
        return True
    return not await billing_active(db, trader)


async def can_auto_trade(db, trader):
    """Whether the bot may auto-process a trade for this trader right now.

    Returns (allowed: bool, reason: str|None) where reason is one of:
      None                 -> allowed
      'suspended'          -> account frozen by an admin (only Choice Bank stays usable)
      'subscription_expired' -> no active plan (and not exempt)
      'daily_limit'        -> active plan but daily trade cap reached (resets 03:00 EAT)
    """
    if account_frozen(trader):
        return False, "suspended"
    if not settings.ENFORCEMENT_ENABLED:
        return True, None
    if not await billing_active(db, trader):
        return False, "subscription_expired"
    rl = await trade_rate_status(db, trader)
    if not rl.get("allowed", True):
        return False, "daily_limit"
    return True, None


async def notifications_allowed(trader_id) -> bool:
    """Whether notifications (Telegram/SMS/email alerts) may be sent. Opens its own session so it
    is safe to call from notification code that doesn't hold a db session."""
    async with async_session() as db:
        trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
        if not trader:
            return True   # don't drop alerts for unknown traders
        if account_frozen(trader):
            return False  # a suspended account gets no bot notifications
        return await billing_active(db, trader)


def wipe_bot_config(trader) -> None:
    """Zero out ALL bot-automation config so nothing keeps running once a subscription lapses.

    DESTRUCTIVE by product decision ("reset itself to zero") — the trader must reconfigure after
    renewing. Does NOT touch Choice Bank, identity, or billing fields. Caller commits.
    """
    # Automation toggles off
    trader.auto_release_enabled = False
    trader.auto_pay_enabled = False
    trader.dd_enabled = False
    trader.pm_enabled = False
    trader.price_tracker_enabled = False
    trader.cb_enabled = False
    trader.telegram_approval_enabled = False
    # Due-diligence thresholds -> 0
    trader.dd_min_30d_trades = 0
    trader.dd_min_all_trades = 0
    # Price-matching margins -> 0
    trader.pm_margin_min = 0.0
    trader.pm_margin_max = 0.0
    # Binance counterparty filters -> off + all thresholds 0 (min trades, total trades,
    # max avg pay time, max avg release time, etc.)
    trader.cf_filters_enabled = False
    trader.cf_completion_rate_min = 0.0
    trader.cf_all_trades_min = 0
    trader.cf_completed_trades_min = 0
    trader.cf_buy_trades_min = 0
    trader.cf_sell_trades_min = 0
    trader.cf_volume_min = 0.0
    trader.cf_all_trades_min_all = 0
    trader.cf_reg_days_min = 0
    trader.cf_max_pay_mins = 0
    trader.cf_max_release_mins = 0
