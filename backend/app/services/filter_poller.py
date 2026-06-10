"""Background counterparty-filter sync + Gold-tier self-heal.

A trader's counterparty filters — and the Gold Merchant detection — are applied to Binance via
EP-7, which requires their desktop relay to be online. If the relay was down when they saved
(common for fresh connections, or a flaky relay), the push silently failed: the filters never
reached Binance AND the Gold badge was never tagged (`cf_last_pushed_at` stays NULL).

This poller finds traders with filters configured but never synced and — ONLY while their relay
is currently connected — re-pushes their OWN configured filters. On success it records
`cf_last_pushed_at` and tags `binance_merchant_tier='gold'` (a successful EP-7 push only works
for Gold Merchants). It is:
  - non-destructive — pushes the trader's real cf_* config, never zeros that would clear filters;
  - connection-safe — never holds a DB session across the (slow) relay/Binance calls;
  - throttled — at most one attempt per trader per 30 min, and only when the relay is connected,
    so a flaky/offline trader (or a non-Gold trader who enabled filters) is not hammered.
Once a trader is synced (`cf_last_pushed_at` set) they drop out of the candidate set.
"""
import asyncio
import logging
from datetime import datetime, timezone
from sqlalchemy import select, and_

from app.core.database import async_session
from app.core.security import decrypt_data
from app.models import Trader

logger = logging.getLogger(__name__)

FILTER_SYNC_INTERVAL = 300   # seconds between sweeps (5 min)
ATTEMPT_BACKOFF = 1800       # don't retry the same trader more than once per 30 min

_attempt_at: dict = {}       # trader_id -> last attempt time


async def _push_for_trader(tid: int):
    """Re-push the trader's configured filters via EP-7. Returns pushed count (>0 = Gold).
    Does relay/Binance calls — holds NO DB session while doing so."""
    from app.services.binance.sapi_client import get_merchant_ads, push_counterparty_filters, relay_trader

    async with async_session() as db:   # short read, released before the slow calls
        t = await db.get(Trader, tid)
        if not t or not t.binance_api_key or t.binance_api_key_invalid:
            return 0
        ak = decrypt_data(t.binance_api_key)
        sec = decrypt_data(t.binance_api_secret)
        min_all = (t.cf_all_trades_min_all or 0) if getattr(t, "cf_filters_enabled", True) else 0

    relay_trader.set(tid)
    pushed = 0
    try:
        ads = await get_merchant_ads(ak, sec)
    except Exception as e:
        logger.info("[FilterSync] trader %s ads fetch failed (relay?): %s", tid, e)
        return 0
    for ad in (ads or []):
        adv = ad.get("advNo") or ad.get("adsNo")
        if not adv or (ad.get("tradeType") or "").upper() != "SELL":
            continue
        try:
            await push_counterparty_filters(
                api_key=ak, api_secret=sec, adv_no=adv,
                completion_rate_min=0.0, completion_rate_window=2,
                all_trades_min=min_all, trade_count_window=2, completed_trades_min=0,
                buy_trades_min=0, sell_trades_min=0,
                volume_min=0.0, volume_asset="USDT", volume_window=2, reg_days_min=0,
            )
            pushed += 1
        except Exception as e:
            logger.info("[FilterSync] trader %s push failed ad %s: %s", tid, adv, e)
    return pushed


async def filter_sync_poller():
    await asyncio.sleep(40)
    logger.info("[FilterSync] started (re-pushes unsynced counterparty filters every %ds)", FILTER_SYNC_INTERVAL)
    from app.services.binance import relay_router
    while True:
        try:
            async with async_session() as db:
                rows = (await db.execute(
                    select(Trader.id).where(and_(
                        Trader.binance_api_key.isnot(None),
                        Trader.binance_api_key_invalid.is_(False),
                        Trader.cf_filters_enabled.is_(True),
                        Trader.cf_last_pushed_at.is_(None),   # configured but never synced
                    ))
                )).all()
            candidates = [r[0] for r in rows]

            for tid in candidates:
                if not relay_router.is_connected(tid):
                    continue   # relay not up — skip (avoids a 25s timeout)
                now = datetime.now(timezone.utc)
                last = _attempt_at.get(tid)
                if last and (now - last).total_seconds() < ATTEMPT_BACKOFF:
                    continue
                _attempt_at[tid] = now

                pushed = await _push_for_trader(tid)
                if pushed and pushed > 0:
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t:
                            t.cf_last_pushed_at = datetime.now(timezone.utc)
                            if (t.binance_merchant_tier or "").lower() != "gold":
                                t.binance_merchant_tier = "gold"
                            await db.commit()
                    logger.info("[FilterSync] trader %s: filters synced + Gold tagged (%d ad(s))", tid, pushed)
        except Exception as e:
            logger.error("[FilterSync] loop error: %s", e)
        await asyncio.sleep(FILTER_SYNC_INTERVAL)
