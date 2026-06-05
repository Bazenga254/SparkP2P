"""Single source of truth for the trading-day boundary.

The trading day resets at 00:00 UTC (= 03:00 EAT), matching Binance's daily reset. Change
TRADING_DAY_OFFSET_HOURS here and EVERY "today" figure across the whole platform — merchant
dashboard, profit pages, daily limits AND the admin dashboard — shifts together. Nothing else
in the codebase should compute a day boundary on its own; everything routes through here so the
reset time can never drift between pages again.

Examples:
    TRADING_DAY_OFFSET_HOURS = 0  -> day starts 00:00 UTC (03:00 EAT)  [current, matches Binance]
    TRADING_DAY_OFFSET_HOURS = 3  -> day starts 00:00 EAT (21:00 UTC)
"""
from datetime import datetime, timezone, timedelta

# Hours added to UTC before taking midnight. 0 => 00:00 UTC. Keep this the ONLY knob.
TRADING_DAY_OFFSET_HOURS = 0


def now_utc():
    """Timezone-aware current time in UTC."""
    return datetime.now(timezone.utc)


def _as_utc(dt):
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def trading_day_start(now=None):
    """UTC datetime marking the start of the trading day that `now` falls in."""
    now = _as_utc(now) if now is not None else now_utc()
    off = timedelta(hours=TRADING_DAY_OFFSET_HOURS)
    return (now + off).replace(hour=0, minute=0, second=0, microsecond=0) - off


def trading_month_start(now=None):
    """UTC datetime marking the start of the trading month that `now` falls in."""
    now = _as_utc(now) if now is not None else now_utc()
    off = timedelta(hours=TRADING_DAY_OFFSET_HOURS)
    return (now + off).replace(day=1, hour=0, minute=0, second=0, microsecond=0) - off


def trading_day_key(dt):
    """'YYYY-MM-DD' label of the trading day that `dt` belongs to."""
    return (_as_utc(dt) + timedelta(hours=TRADING_DAY_OFFSET_HOURS)).strftime("%Y-%m-%d")


def trading_day_date(now=None):
    """date() of the current trading day."""
    return trading_day_key(now if now is not None else now_utc())
