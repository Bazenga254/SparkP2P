"""Background counterparty-filter sync + Gold-tier self-heal.

A trader's ad-level counterparty filter (EP-7 `userAllTradeCountMin`) is applied to their Binance
SELL ads via their desktop relay. It can be dropped after the initial push for several reasons —
the relay was down at save (never synced), a price/ad edit or re-list reset the ad's fields, or
Binance cleared it — and there was previously nothing to restore it (this poller used to skip any
trader once `cf_last_pushed_at` was set, so a dropped filter stayed dropped forever).

This poller now RE-ASSERTS each filter-enabled trader's configured filter whenever the LIVE ad has
drifted from their setting — not just on first-time sync. For each such trader, while their relay is
connected and at most once per 30 min: read their SELL ads, and if any ad's `userAllTradeCountMin`
!= their configured value, re-push it, then verify the re-push actually landed. A verified push both
records `cf_last_pushed_at` (does NOT infer tier — EP-7 push also succeeds for non-Gold
Merchants; if it doesn't stick, that's logged instead of silently looping). Never holds a DB session
across the slow relay/Binance calls.
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
ATTEMPT_BACKOFF = 1800       # re-check a given trader at most once per 30 min

_attempt_at: dict = {}       # trader_id -> last attempt time


async def _sync_for_trader(tid: int):
    """Read the trader's SELL ads and re-push their configured counterparty filter if the live ad
    has drifted. Returns (pushed_count, verified_ok). Holds NO DB session across relay calls."""
    from app.services.binance.sapi_client import get_merchant_ads, push_counterparty_filters, relay_trader

    async with async_session() as db:   # short read, released before the slow relay calls
        t = await db.get(Trader, tid)
        if not t or not t.binance_api_key or t.binance_api_key_invalid:
            return 0, None
        ak = decrypt_data(t.binance_api_key)
        sec = decrypt_data(t.binance_api_secret)
        min_all = int((t.cf_all_trades_min_all or 0) if getattr(t, "cf_filters_enabled", True) else 0)

    relay_trader.set(tid)
    try:
        ads = await get_merchant_ads(ak, sec)
    except Exception as e:
        logger.info("[FilterSync] trader %s ads fetch failed (relay?): %s", tid, e)
        return 0, None

    sell = [a for a in (ads or []) if (a.get("tradeType") or "").upper() == "SELL"]
    if not sell:
        return 0, True   # no live sell ads -> nothing to enforce
    # Already matches the configured value on every ad -> nothing to do.
    if all(int(a.get("userAllTradeCountMin") or 0) == min_all for a in sell):
        return 0, True

    pushed = 0
    for ad in sell:
        adv = ad.get("advNo") or ad.get("adsNo")
        if not adv:
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

    # Verify the re-push actually landed — EP-7 can return success yet not apply the filter if the
    # account is not a Gold Merchant. Surface that instead of silently re-pushing every 30 min.
    verified_ok = None
    if pushed:
        try:
            sell2 = [a for a in (await get_merchant_ads(ak, sec) or [])
                     if (a.get("tradeType") or "").upper() == "SELL"]
            verified_ok = bool(sell2) and all(int(a.get("userAllTradeCountMin") or 0) == min_all for a in sell2)
            if not verified_ok:
                logger.warning(
                    "[FilterSync] trader %s: pushed %d ad(s) but Binance still shows %s (expected %s) "
                    "— account may not be a Gold Merchant, so ad-level filters can't apply",
                    tid, pushed, [a.get("userAllTradeCountMin") for a in sell2], min_all,
                )
        except Exception:
            pass
    return pushed, verified_ok


async def filter_sync_poller():
    await asyncio.sleep(40)
    logger.info("[FilterSync] started (re-asserts drifted counterparty filters every %ds)", FILTER_SYNC_INTERVAL)
    from app.services.binance import relay_router
    while True:
        try:
            async with async_session() as db:
                rows = (await db.execute(
                    select(Trader.id).where(and_(
                        Trader.binance_api_key.isnot(None),
                        Trader.binance_api_key_invalid.is_(False),
                        Trader.cf_filters_enabled.is_(True),
                        # NOTE: intentionally NOT restricted to cf_last_pushed_at IS NULL — we
                        # re-verify already-synced traders so a later-dropped filter self-heals.
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

                pushed, verified = await _sync_for_trader(tid)
                # Only claim success (record sync) when the re-push actually landed. Do NOT
                # tag Gold from an EP-7 push — it succeeds for Silver/Bronze merchants too and
                # was mislabeling them Gold. Tier comes only from the public P2P medal.
                if pushed and verified:
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t:
                            t.cf_last_pushed_at = datetime.now(timezone.utc)
                            await db.commit()
                    logger.info("[FilterSync] trader %s: re-asserted counterparty filter on %d ad(s)", tid, pushed)
        except Exception as e:
            logger.error("[FilterSync] loop error: %s", e)
        await asyncio.sleep(FILTER_SYNC_INTERVAL)
