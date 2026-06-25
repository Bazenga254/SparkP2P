"""Cookie-session health monitor.

Proactively checks each trader's stored Binance session (cookies) via their relay and, when it has
expired, Telegrams + in-app-notifies the merchant to reconnect — so the cookie chat-send never
silently fails mid-trade. Re-reminds every few hours while it stays expired; resets once healthy.
"""

import asyncio
import logging
import time

from sqlalchemy import select

from app.core.database import async_session
from app.models.trader import Trader

logger = logging.getLogger(__name__)

_CHECK_EVERY = 60             # 1 min between sweeps — catch expiry fast so no order falls in a gap
_RENOTIFY_AFTER = 3 * 3600    # re-remind every 3h while still expired (the sweep is 1 min; the nudge is rate-limited)
_last_notified: dict[int, float] = {}   # trader_id -> last re-login nudge time

RELOGIN_MSG = (
    "🔐 Action needed — reconnect your Binance session" + chr(10) +
    "Your Binance session has expired, so the bot can no longer send payment details or messages to "
    "your buyers and sellers. Please open the SparkP2P app and reconnect your Binance account "
    "(Settings → Binance → Re-connect) — it takes under a minute." + chr(10) +
    "Until you reconnect, new sell orders will pause. Reconnecting keeps your clients receiving their "
    "payment instructions on time. Thank you for keeping your account secure. — SparkP2P"
)


async def cookie_health_poller():
    """Every 30 min, check each trader's cookie session and nudge them to reconnect if expired."""
    logger.info("[CookieHealth] started (%d-min sweep)", _CHECK_EVERY // 60)
    from app.services.binance import relay_router
    from app.services.binance.sapi_client import check_cookie_session
    while True:
        try:
            async with async_session() as db:
                traders = (await db.execute(
                    select(Trader).where(Trader.binance_cookies.isnot(None))
                )).scalars().all()
            for t in traders:
                if not relay_router.is_connected(t.id):
                    continue   # relay offline — can't check; skip this round
                try:
                    valid = await check_cookie_session(t)
                except Exception:
                    continue   # relay timeout/error — skip, try next sweep
                now = time.time()
                # Persist the flag so the dashboard "Reconnect" banner appears/disappears.
                if bool(t.binance_session_expired) == (not valid):
                    pass  # already in the right state
                else:
                    async with async_session() as db2:
                        tt = (await db2.execute(select(Trader).where(Trader.id == t.id))).scalar_one_or_none()
                        if tt:
                            tt.binance_session_expired = not valid
                            await db2.commit()
                if valid:
                    _last_notified.pop(t.id, None)   # healthy again — reset
                    continue
                # Expired — nudge once, then re-nudge at most every _RENOTIFY_AFTER.
                if now - _last_notified.get(t.id, 0) < _RENOTIFY_AFTER:
                    continue
                try:
                    from app.api.routes.telegram import notify_trader
                    await notify_trader(t, RELOGIN_MSG)
                except Exception as e:
                    logger.warning("[CookieHealth] telegram notify failed for %s: %s", t.id, e)
                try:
                    from app.api.routes.traders import add_notification
                    add_notification(
                        t.id, "🔐 Reconnect Binance",
                        "Your Binance session expired — reconnect in Settings → Binance so the bot can keep sending chat messages.",
                        "warning",
                    )
                except Exception:
                    pass
                _last_notified[t.id] = now
                logger.info("[CookieHealth] trader %s session EXPIRED — re-login nudge sent", t.id)
        except Exception as e:
            logger.warning("[CookieHealth] loop error: %s", e)
        await asyncio.sleep(_CHECK_EVERY)
