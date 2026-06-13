"""Price Monitor poller (Phase 2 — Monitor mode).

For each trader who has enabled rank alerts (and has an admin-granted price tracker + a known
Binance nickname), this checks where their ad ranks on the live public board and fires configurable
Telegram alerts. It is RELAY-FREE: rank comes from the public adv/search feed + the cached nickname,
so it works even when the trader's desktop relay is offline.

Alerts (edge-triggered, so no spam): drop-out-of-target, overtaken, new #1, periodic summary.
"""
import asyncio
import logging
import time

from sqlalchemy import select

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 180          # seconds between sweeps
SUMMARY_EVERY = 6 * 3600      # periodic summary cadence
NOTIFY_THROTTLE = 600         # min seconds between event notifications per trader

# In-memory per-trader state (resets on restart — acceptable):
#   {trader_id: {"sell": {rank, top1}, "buy": {rank, top1}, "last_notify": ts, "summary_at": ts}}
_state: dict[int, dict] = {}


def _median(vals: list) -> float:
    s = sorted(v for v in vals if v and v > 0)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else 0.0


def _spike(rows: list):
    """Detect an abnormal #1 price (>1.5% from the top-10 median). Returns (nick, price, median) or None."""
    if len(rows or []) < 3:
        return None
    med = _median([r.get("price") for r in rows[:10]])
    if not med:
        return None
    top = rows[0].get("price") or 0
    if abs(top - med) / med > 0.015:
        return (rows[0].get("nick"), top, round(med, 2))
    return None


def _position(rows: list, nick: str, scope: str) -> dict | None:
    """Find the merchant in one board side and compute rank (overall or within their tier)."""
    nl = (nick or "").strip().lower()
    if not nl:
        return None
    mine = [r for r in rows if (r.get("nick") or "").strip().lower() == nl]
    if not mine:
        return None
    m = min(mine, key=lambda r: r.get("rank", 10**9))
    if scope == "tier":
        rank = sum(1 for r in rows if r.get("tier") == m.get("tier") and r.get("rank", 10**9) < m.get("rank", 10**9)) + 1
    else:
        rank = m.get("rank")
    return {"rank": rank, "price": m.get("price"), "tier": m.get("tier")}


async def _check_trader(trader, board, market, notify):
    st = _state.setdefault(trader.id, {})
    target = int(trader.pm_target_rank or 1)
    scope = trader.pm_scope or "all"
    # Their SELL ad sits on the Buy-USDT board; their BUY ad sits on the Sell-USDT board.
    sides = {"sell": board.get("buy", []), "buy": board.get("sell", [])}
    msgs = []

    for label, rows in sides.items():
        pos = _position(rows, trader.binance_nickname, scope)
        if not pos:
            continue
        prev = st.get(label) or {}
        prev_rank = prev.get("rank")
        scope_txt = "your tier" if scope == "tier" else "the table"

        if trader.pm_alert_drop and prev_rank is not None:
            if prev_rank <= target and pos["rank"] > target:
                msgs.append(f"⚠️ Your {label} ad slipped to #{pos['rank']} on {scope_txt} (target: top {target}).")

        if trader.pm_alert_reached and prev_rank is not None:
            if prev_rank > target and pos["rank"] <= target:
                msgs.append(f"✅ In target — your {label} ad is now #{pos['rank']} on {scope_txt} (target: top {target}).")

        if trader.pm_alert_overtaken and prev_rank is not None and pos["rank"] > prev_rank:
            msgs.append(f"↧ Overtaken — your {label} ad moved from #{prev_rank} to #{pos['rank']} on {scope_txt}.")

        top1 = (rows[0].get("nick") if rows else None)
        if trader.pm_alert_top1 and prev.get("top1") and top1 and top1 != prev.get("top1"):
            msgs.append(f"🏁 New #1 on {label}: {top1} at KES {rows[0].get('price')}.")

        st[label] = {"rank": pos["rank"], "top1": top1}

    # Competitor watchlist — alert when a tracked merchant's board rank moves (edge-triggered).
    wl = [w for w in (getattr(trader, "pm_watchlist", None) or []) if w]
    if getattr(trader, "pm_alert_watchlist", True) and wl:
        wstate = st.setdefault("watch", {})
        # Board labels as shown on the Price Tracker page.
        board_sides = [("Buy-USDT", board.get("buy", [])), ("Sell-USDT", board.get("sell", []))]
        for nick in wl:
            ws = wstate.setdefault(nick.strip().lower(), {})
            seen = ws.get("_seen", False)
            for bname, rows in board_sides:
                pos = _position(rows, nick, "all")
                now = pos["rank"] if pos else None
                prev = ws.get(bname)
                if not seen:
                    pass  # first observation — record silently, no alert burst
                elif prev is None and now is not None:
                    # They had no ad on this side before and just posted one.
                    tag = " — top of the board 🏁" if now == 1 else ""
                    msgs.append(f"🆕 {nick} posted a new ad ({bname}) at position #{now} — price KES {pos['price']}{tag}.")
                elif prev is not None and now is None:
                    msgs.append(f"👋 {nick} removed their {bname} ad.")
                elif prev is not None and now is not None and now != prev:
                    arrow = "📈" if now < prev else "📉"
                    tag = " — now top of the board 🏁" if now == 1 else ""
                    msgs.append(f"{arrow} {nick} was position #{prev}, now #{now} ({bname} ad) — price KES {pos['price']}{tag}.")
                ws[bname] = now
            ws["_seen"] = True

    # Aggressive-market advisory (edge-triggered): spread squeeze or an abnormal price spike.
    if getattr(trader, "pm_alert_anomaly", False):
        mmin = float(trader.pm_margin_min or 0)
        spread = market.get("spread")
        cond_spread = spread is not None and mmin > 0 and spread < mmin
        spike = market.get("spike_sell") or market.get("spike_buy")
        cond = bool(cond_spread or spike)
        if cond and not st.get("anomaly", False):
            if cond_spread:
                msgs.append(f"⚠️ Aggressive market — the round-trip spread is only KES {spread} (below your {mmin} min margin). Chasing rank now would eat your profit; hold your price.")
            else:
                nk, pr, med = spike
                msgs.append(f"⚠️ Abnormal pricing — {nk} is pricing at KES {pr} vs the pack ~{med}. Likely a spike/manipulation — don't chase it.")
        st["anomaly"] = cond

    # Periodic summary (independent of throttle)
    if trader.pm_alert_summary and time.time() - st.get("summary_at", 0) > SUMMARY_EVERY:
        parts = []
        for label in ("sell", "buy"):
            p = st.get(label)
            if p and p.get("rank"):
                parts.append(f"{label} #{p['rank']}")
        if parts:
            await notify(trader, f"📊 SparkP2P rank summary — {' · '.join(parts)} ({'your tier' if scope == 'tier' else 'whole table'}).")
            st["summary_at"] = time.time()

    if msgs and time.time() - st.get("last_notify", 0) >= NOTIFY_THROTTLE:
        await notify(trader, "SparkP2P Price Alert:\n" + "\n".join(msgs))
        st["last_notify"] = time.time()


async def _run_once():
    from app.core.database import async_session
    from app.models import Trader
    from app.services.price_tracker import get_board
    from app.api.routes.telegram import notify_trader

    async with async_session() as db:
        # Own-rank alerts need a nickname; watchlist alerts don't — load anyone with alerts on.
        # _check_trader skips own-rank checks gracefully when binance_nickname is unset.
        traders = (await db.execute(
            select(Trader).where(
                Trader.pm_enabled.is_(True),
                Trader.price_tracker_enabled.is_(True),
            )
        )).scalars().all()

    if not traders:
        return
    try:
        board = await get_board("USDT", "KES")
    except Exception as e:
        logger.warning("[PriceMonitor] board fetch failed: %s", e)
        return

    # Market state for the aggressive-market advisory.
    buy, sell = board.get("buy", []), board.get("sell", [])
    cost = _median([r["price"] for r in buy[:5]])
    revenue = _median([r["price"] for r in sell[:5]])
    spread = round(revenue - cost, 2) if (revenue and cost) else None
    market = {
        "spread": spread,
        "spike_sell": _spike(sell),   # abnormally high bid
        "spike_buy": _spike(buy),     # abnormally low ask
    }

    async def notify(trader, msg):
        try:
            await notify_trader(trader, msg)
        except Exception as e:
            logger.warning("[PriceMonitor] notify failed for %s: %s", trader.id, e)

    for t in traders:
        try:
            await _check_trader(t, board, market, notify)
        except Exception as e:
            logger.warning("[PriceMonitor] check failed for trader %s: %s", t.id, e)


async def start():
    logger.info("[PriceMonitor] started — every %ss", CHECK_INTERVAL)
    while True:
        try:
            await _run_once()
        except Exception as e:
            logger.error("[PriceMonitor] sweep error: %s", e)
        await asyncio.sleep(CHECK_INTERVAL)
