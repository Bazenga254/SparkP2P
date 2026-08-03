"""Hourly Binance-tier → subscription-plan sync.

Plans are LOCKED to the merchant's live Binance P2P medal. This poller re-reads each connected
merchant's current tier (gold/silver/bronze) from their live ads and, when it changed, moves their
plan to match via apply_tier_plan (from next renewal, BOTH directions — promote and demote).

Safety:
  * Relay-gated. Reading the tier needs the merchant's relay/desktop online. If it's offline or the
    API errors, we SKIP that merchant — never demote/change a plan on a missing/failed read.
  * The relay call is made WITHOUT holding a DB connection (the connection is released first), so a
    slow relay can't exhaust the pool.
  * Throttled per trader so we don't hammer the relay.
"""
import asyncio
import logging
import time

from sqlalchemy import select

from app.core.database import async_session
from app.models.trader import Trader

logger = logging.getLogger(__name__)

INTERVAL = 3600            # re-check every hour
_PER_TRADER_GAP = 3000     # don't re-read the same trader more often than ~50 min
_last_checked: dict[int, float] = {}


async def _check_one(trader_id: int):
    from app.services.binance.sapi_client import get_merchant_ads, relay_trader
    from app.services.price_tracker import detect_nickname_from_ads
    from app.core.security import decrypt_data
    from app.services.plans import apply_tier_plan

    # 1. Short session: grab the encrypted creds, then RELEASE the connection.
    async with async_session() as db:
        trader = await db.get(Trader, trader_id)
        if not trader or not trader.binance_api_key or not trader.binance_api_secret:
            return
        if getattr(trader, "billing_exempt", False):
            return
        _ak, _as = trader.binance_api_key, trader.binance_api_secret

    # 2. Relay read — NO DB connection held across it.
    relay_trader.set(trader_id)
    try:
        ads = await get_merchant_ads(decrypt_data(_ak), decrypt_data(_as))
        nick, p2p_tier = await detect_nickname_from_ads(ads)
    except Exception:
        return   # relay offline / API error — SKIP (never change on a failed read)
    from app.core.tiers import DETECTABLE_TIERS, merchant_tier_for
    if not p2p_tier or p2p_tier not in DETECTABLE_TIERS:
        return   # couldn't read a clear tier — SKIP

    # 3. Fresh short session: persist the tier + move the plan to match if it changed.
    async with async_session() as db:
        trader = await db.get(Trader, trader_id)
        if not trader:
            return
        if nick and not trader.binance_nickname:
            trader.binance_nickname = nick
        # 'block' is the display tier (binance_p2p_tier); binance_merchant_tier maps
        # to 'gold' so a block merchant keeps every Gold-gated capability.
        _mt = merchant_tier_for(p2p_tier)
        if trader.binance_p2p_tier != p2p_tier or (_mt and trader.binance_merchant_tier != _mt):
            trader.binance_p2p_tier = p2p_tier
            if _mt:
                trader.binance_merchant_tier = _mt
            await db.commit()
        changed = await apply_tier_plan(trader, db)
        if changed:
            logger.info("[TierPoller] trader %s now Binance %s — plan synced", trader_id, p2p_tier)


async def tier_poller():
    logger.info("[TierPoller] started — hourly Binance-tier → plan sync (every %ss)", INTERVAL)
    while True:
        try:
            async with async_session() as db:
                ids = (await db.execute(
                    select(Trader.id).where(Trader.binance_api_key.isnot(None))
                )).scalars().all()
            now = time.time()
            for tid in ids:
                if now - _last_checked.get(tid, 0) < _PER_TRADER_GAP:
                    continue
                _last_checked[tid] = now
                try:
                    await _check_one(tid)
                except Exception as e:
                    logger.warning("[TierPoller] trader %s check failed: %s", tid, e)
                await asyncio.sleep(2)   # gentle pacing across traders/relay
        except Exception as e:
            logger.warning("[TierPoller] cycle failed: %s", e)
        await asyncio.sleep(INTERVAL)
