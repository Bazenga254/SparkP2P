"""Live auto-pricing engine + poller (Phase 2 — Floating).

For traders with pm_autoprice='live', this re-prices their Binance P2P ad(s) to hold their target
rank, clamped to their KES margin band, and pushes the new price via the signed ads/update endpoint
(through the trader's relay). It is the only money-moving piece, so it runs with hard safety rails:

  • Margin floor      — price clamped to [margin band]; never below the min profit.
  • Outlier guard     — competitor prices far from the robust median (spoofs/spikes) are ignored.
  • Step cap          — price never moves more than MAX_STEP KES per update.
  • Push throttle      — at most one push per trader per MIN_PUSH_GAP seconds.
  • Relay-gated        — only runs while the trader's relay is online; never errors out.
  • Kill switch        — env AUTOPRICE_DISABLED=1 stops all live pushing globally.
"""
import asyncio
import logging
import os
import time

from sqlalchemy import select

logger = logging.getLogger(__name__)

TICK = 0.01                 # KES — finest Binance price step
OUTLIER_PCT = 0.015         # ignore competitors >1.5% from the robust median
MAX_STEP = 1.00             # KES — max price move per single update
CHECK_INTERVAL = 120        # seconds between sweeps
MIN_PUSH_GAP = 300          # seconds between pushes per trader (<= ~12/hr)
KILL = os.environ.get("AUTOPRICE_DISABLED", "").lower() in ("1", "true", "yes")

_last_push: dict[int, float] = {}


def _median(vals: list) -> float:
    s = sorted(v for v in vals if v and v > 0)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else 0.0


def compute_target(board_side, is_sell, ref, mmin, mmax, target_rank, my_nick, my_tier, scope):
    """Target price for one ad side, or None. is_sell=True => SELL ad on the Buy-USDT board
    (cheapest first, ref=cost to acquire). is_sell=False => BUY ad on the Sell-USDT board
    (highest first, ref=sale revenue)."""
    if not (mmax and mmax > 0) or not ref:
        return None
    nl = (my_nick or "").strip().lower()
    comps = [r for r in (board_side or []) if (r.get("nick") or "").strip().lower() != nl]
    if scope == "tier" and my_tier:
        comps = [r for r in comps if r.get("tier") == my_tier]
    if not comps:
        return None
    # Outlier guard: drop competitor prices abnormally far from the robust top-15 median.
    med = _median([r.get("price") for r in comps[:15]])
    if med:
        comps = [r for r in comps if abs(r.get("price", 0) - med) / med <= OUTLIER_PCT] or comps
    comps = sorted(comps, key=lambda r: r.get("rank", 10**9))
    tgt = comps[min(int(target_rank or 1), len(comps)) - 1]
    peg = tgt.get("price") - TICK if is_sell else tgt.get("price") + TICK
    lo = ref + mmin if is_sell else ref - mmax
    hi = ref + mmax if is_sell else ref - mmin
    return round(min(max(peg, lo), hi), 2)


async def _run_once():
    if KILL:
        return
    from app.core.database import async_session
    from app.models import Trader
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import get_merchant_ads, update_ad_price, relay_trader
    from app.services.binance import relay_router
    from app.services.price_tracker import get_board

    async with async_session() as db:
        traders = (await db.execute(
            select(Trader).where(
                Trader.pm_autoprice == "live",
                Trader.price_tracker_enabled.is_(True),
                Trader.binance_api_key.isnot(None),
            )
        )).scalars().all()
    if not traders:
        return

    try:
        board = await get_board("USDT", "KES")
    except Exception as e:
        logger.warning("[AutoPrice] board fetch failed: %s", e)
        return
    cost = _median([r["price"] for r in board.get("buy", [])[:5]])      # cost to acquire USDT
    revenue = _median([r["price"] for r in board.get("sell", [])[:5]])  # revenue when selling USDT

    from app.api.routes.telegram import notify_trader

    for t in traders:
        try:
            if not relay_router.is_connected(t.id):
                continue
            if time.time() - _last_push.get(t.id, 0) < MIN_PUSH_GAP:
                continue
            relay_trader.set(t.id)
            try:
                ads = await get_merchant_ads(decrypt_data(t.binance_api_key), decrypt_data(t.binance_api_secret))
            except Exception as e:
                logger.warning("[AutoPrice] EP-4 failed for trader %s: %s", t.id, e)
                continue

            for ad in (ads or []):
                if not isinstance(ad, dict) or ad.get("asset") != "USDT" or ad.get("fiatUnit") != "KES":
                    continue
                tt = (ad.get("tradeType") or "").upper()
                if tt not in ("BUY", "SELL"):
                    continue
                current = float(ad.get("price") or 0)
                adv_no = ad.get("advNo")
                if not adv_no or current <= 0:
                    continue
                is_sell = (tt == "SELL")
                board_side = board.get("buy", []) if is_sell else board.get("sell", [])
                ref = cost if is_sell else revenue
                target = compute_target(
                    board_side, is_sell, ref, t.pm_margin_min, t.pm_margin_max,
                    t.pm_target_rank, t.binance_nickname, t.binance_p2p_tier, t.pm_scope,
                )
                if target is None:
                    continue
                # Step cap, then skip no-op moves.
                target = round(min(max(target, current - MAX_STEP), current + MAX_STEP), 2)
                if abs(target - current) < TICK:
                    continue

                relay_trader.set(t.id)
                try:
                    await update_ad_price(decrypt_data(t.binance_api_key), decrypt_data(t.binance_api_secret), adv_no, target)
                except Exception as e:
                    logger.warning("[AutoPrice] update failed trader %s adv %s: %s", t.id, adv_no, e)
                    continue
                _last_push[t.id] = time.time()
                logger.warning("[AutoPrice] trader %s %s ad %s -> %s (was %s)", t.id, tt, adv_no, target, current)
                try:
                    await notify_trader(t, f"🤖 SparkP2P auto-price: your {tt.lower()} ad moved {current} → {target} KES (holding top {t.pm_target_rank}).")
                except Exception:
                    pass
        except Exception as e:
            logger.warning("[AutoPrice] trader %s error: %s", t.id, e)


async def start():
    logger.info("[AutoPrice] started — every %ss (kill=%s)", CHECK_INTERVAL, KILL)
    while True:
        try:
            await _run_once()
        except Exception as e:
            logger.error("[AutoPrice] sweep error: %s", e)
        await asyncio.sleep(CHECK_INTERVAL)
