"""Squad Mode — Phase B: live coordinated pricing (see docs/squad-mode.md).

For each squad in mode='live', compute the team plan (squad_engine.simulate) and push each
member's target price through THEIR OWN relay/IP. Money-moving, so it runs with the same rails
as the solo auto-pricer:

  • Per-member relay   — each push routes via that member's desktop (relay_trader contextvar).
  • Pushable set       — only verified merchants with API + relay online + a known nickname; the
                         block resizes to whoever is live, and the squad pauses if < 2 are pushable.
  • Margin floor       — enforced inside the engine (band clamp); never below min margin.
  • Step cap / throttle — max move per push + min seconds between pushes per ad.
  • Kill switch        — env SQUAD_DISABLED (or AUTOPRICE_DISABLED) halts all live pushing.
"""
import asyncio
import logging
import os
import time

from sqlalchemy import select

logger = logging.getLogger(__name__)

TICK = 0.01
MAX_STEP = 1.00            # KES — max move per single update
MIN_PUSH_GAP = 300        # seconds between pushes per ad
CHECK_INTERVAL = 90       # seconds between sweeps
KILL = os.environ.get("SQUAD_DISABLED", os.environ.get("AUTOPRICE_DISABLED", "")).lower() in ("1", "true", "yes")

_last_push: dict[tuple, float] = {}   # (trader_id, adv_no) -> ts


def _verified(t) -> bool:
    return getattr(t, "binance_p2p_tier", None) in ("gold", "silver", "bronze")


async def _run_once():
    if KILL:
        return
    from app.core.database import async_session
    from app.models import Trader, Squad, SquadMember
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import update_ad_price, relay_trader
    from app.services.binance import relay_router
    from app.services.price_tracker import get_board
    from app.services.squad_engine import simulate
    from app.api.routes.telegram import notify_trader

    async with async_session() as db:
        squads = (await db.execute(select(Squad).where(Squad.mode == "live"))).scalars().all()
        if not squads:
            return
        try:
            board = await get_board("USDT", "KES")
        except Exception as e:
            logger.warning("[Squad] board fetch failed: %s", e)
            return

        for squad in squads:
            mem_rows = (await db.execute(
                select(SquadMember).where(SquadMember.squad_id == squad.id, SquadMember.status == "active")
            )).scalars().all()
            ids = [m.trader_id for m in mem_rows]
            traders = {t.id: t for t in (await db.execute(select(Trader).where(Trader.id.in_(ids)))).scalars().all()} if ids else {}
            # Pushable = verified merchant + API + relay online + known nickname.
            pushable = [t for t in traders.values()
                        if relay_router.is_connected(t.id) and _verified(t) and t.binance_api_key and t.binance_nickname]
            if len(pushable) < 2:
                continue

            members = [{"trader_id": t.id, "nick": t.binance_nickname, "name": t.full_name} for t in pushable]
            try:
                plan = simulate(squad, members, board)
            except Exception as e:
                logger.warning("[Squad] plan failed squad %s: %s", squad.id, e)
                continue

            for side in ("sell", "buy"):
                sp = plan.get(side)
                if not sp:
                    continue
                for mp in sp.get("members", []):
                    if not (mp.get("online") and mp.get("adv_no") and mp.get("target_price")):
                        continue
                    t = traders.get(mp["trader_id"])
                    if not t:
                        continue
                    current = float(mp.get("current_price") or 0)
                    if current <= 0:
                        continue
                    target = round(min(max(float(mp["target_price"]), current - MAX_STEP), current + MAX_STEP), 2)
                    if abs(target - current) < TICK:
                        continue
                    key = (t.id, mp["adv_no"])
                    if time.time() - _last_push.get(key, 0) < MIN_PUSH_GAP:
                        continue
                    relay_trader.set(t.id)   # route through THIS member's relay/IP
                    try:
                        await update_ad_price(decrypt_data(t.binance_api_key), decrypt_data(t.binance_api_secret),
                                              mp["adv_no"], target)
                    except Exception as e:
                        emsg = str(e)
                        logger.warning("[Squad] push failed squad %s trader %s adv %s: %s", squad.id, t.id, mp["adv_no"], emsg)
                        if "-1002" in emsg or "not authorized" in emsg.lower():
                            try:
                                await notify_trader(t, "⚠ SparkP2P Squad couldn't change your price — Binance says this account "
                                                       "isn't authorized to manage ads via API (verified-merchant only).")
                            except Exception:
                                pass
                        continue
                    _last_push[key] = time.time()
                    logger.warning("[Squad] squad %s trader %s %s ad %s %s -> %s (slot #%s)",
                                   squad.id, t.id, side, mp["adv_no"], current, target, mp.get("target_slot"))


async def start():
    logger.info("[Squad] live pricing started — every %ss (kill=%s)", CHECK_INTERVAL, KILL)
    while True:
        try:
            await _run_once()
        except Exception as e:
            logger.error("[Squad] sweep error: %s", e)
        await asyncio.sleep(CHECK_INTERVAL)
