"""Market flow tracker — estimates 24h USDT/KES trading activity from order-book depletion.

Binance does NOT expose other merchants' wallet balances or executed trades. The honest proxy:
snapshot every ad's *advertised available* quantity each minute; when an ad's available DROPS
between snapshots, that quantity was almost certainly filled (traded). Summing those decreases
across all merchants gives an estimate of volume traded, per side and per merchant.

Guards: spoof/outlier-priced ads are ignored; a per-ad per-minute fill cap rejects relist/edit
phantoms; top-ups (available going UP) are ignored. File-backed + hourly-bucketed so the 24h
window rolls cheaply and survives restarts. Everything here is an ESTIMATE by construction.
"""
import asyncio
import json
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

INTERVAL = 60                       # snapshot cadence (s)
WINDOW = 24 * 3600                  # rolling window
OUT_PCT = 0.03                      # ignore ads >3% off the top-15 median (spoofs)
MAX_FILL_PER_MIN = 50000.0         # cap a single ad's counted depletion/min (relist/edit guard)
FLOW_FILE = Path(__file__).resolve().parents[2] / "market_flow.json"

_prev: dict[str, float] = {}        # advNo -> available (previous snapshot)
_buckets: dict[str, dict] = {}      # str(hour_epoch) -> {buy, sell, m:{nick:{buy,sell}}, start_avail:{nick:av}, ts}
_nick_first: dict[str, float] = {}  # nick -> first-seen ts
_avail_now: dict[str, float] = {}   # nick -> current total advertised available
_started: float = 0.0


def _median(vals) -> float:
    s = sorted(v for v in vals if v and v > 0)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else 0.0


def _clean(rows: list) -> list:
    arr = [r for r in (rows or []) if (r.get("price") or 0) > 0]
    m = _median([r["price"] for r in arr[:15]])
    if not m:
        return arr
    f = [r for r in arr if abs(r["price"] - m) / m <= OUT_PCT]
    return f or arr


def _hour(ts: float) -> str:
    return str(int(ts // 3600 * 3600))


def _load():
    global _prev, _buckets, _nick_first, _avail_now, _started
    try:
        if FLOW_FILE.exists():
            d = json.loads(FLOW_FILE.read_text("utf-8")) or {}
            _prev = d.get("prev", {})
            _buckets = d.get("buckets", {})
            _nick_first = d.get("nick_first", {})
            _avail_now = d.get("avail_now", {})
            _started = d.get("started", 0.0) or time.time()
            # Migrate legacy buckets (buy/sell keys) -> corrected bought/sold. The old 'buy' key
            # held sell-ad drops (= the merchant SOLD); 'sell' held buy-ad drops (= BOUGHT).
            for b in _buckets.values():
                if "bought" not in b:
                    b["sold"] = b.pop("buy", 0.0)
                    b["bought"] = b.pop("sell", 0.0)
                    for mm in b.get("m", {}).values():
                        mm["sold"] = mm.pop("buy", 0.0)
                        mm["bought"] = mm.pop("sell", 0.0)
            logger.info("[MarketFlow] restored %d buckets, %d merchants", len(_buckets), len(_avail_now))
    except Exception as e:
        logger.warning("[MarketFlow] load failed: %s", e)
    if not _started:
        _started = time.time()


def _save():
    try:
        tmp = FLOW_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "prev": _prev, "buckets": _buckets, "nick_first": _nick_first,
            "avail_now": _avail_now, "started": _started,
        }), "utf-8")
        tmp.replace(FLOW_FILE)
    except Exception as e:
        logger.warning("[MarketFlow] save failed: %s", e)


def _prune(now: float):
    cut = now - WINDOW - 3600
    for k in list(_buckets):
        if _buckets[k].get("ts", 0) < cut:
            del _buckets[k]
    # forget merchants neither active nor seen in the last 72h
    old = now - 72 * 3600
    for n in list(_nick_first):
        if n not in _avail_now and _nick_first[n] < old:
            del _nick_first[n]


async def _flow_once():
    from app.services.price_tracker import get_board
    board = await get_board("USDT", "KES")
    buy, sell = _clean(board.get("buy", [])), _clean(board.get("sell", []))
    if not buy and not sell:
        return
    now = time.time()
    hk = _hour(now)
    b = _buckets.get(hk)
    if b is None or "bought" not in b:        # missing or legacy-shaped bucket -> start clean
        b = _buckets[hk] = {"bought": 0.0, "sold": 0.0, "m": {}, "start_avail": dict(_avail_now), "ts": now}

    cur: dict[str, tuple] = {}
    nick_avail: dict[str, float] = {}
    # board["buy"] = SELL ads (merchants SELLING USDT); board["sell"] = BUY ads (merchants BUYING).
    for board_side, rows in (("buy", buy), ("sell", sell)):
        for r in rows:
            adv = str(r.get("advNo") or "")
            if not adv:
                continue
            av = float(r.get("available") or 0)
            nick = r.get("nick") or ""
            cur[adv] = (nick, board_side, av)
            if nick:
                # "Avail now" = USDT the merchant actually has FOR SALE (their sell ads = board["buy"]).
                # Buy-ad amounts are inflated monthly buy-limits, so they're excluded from availability.
                if board_side == "buy":
                    nick_avail[nick] = nick_avail.get(nick, 0.0) + av
                _nick_first.setdefault(nick, now)

    for adv, (nick, board_side, av) in cur.items():
        if adv in _prev:
            delta = _prev[adv] - av
            if delta > 0:
                filled = min(delta, MAX_FILL_PER_MIN)
                # A drop on a SELL ad (board["buy"]) means the merchant SOLD USDT; a drop on a
                # BUY ad (board["sell"]) means they BOUGHT. (Earlier this was mislabeled, which
                # made net buyers like our own merchants show up as sellers.)
                action = "sold" if board_side == "buy" else "bought"
                b[action] += filled
                m = b["m"].setdefault(nick, {"bought": 0.0, "sold": 0.0})
                m[action] += filled

    _prev.clear()
    _prev.update({adv: av for adv, (n, s, av) in cur.items()})
    _avail_now.clear()
    _avail_now.update(nick_avail)
    _prune(now)
    _save()


def _day_start(now: float) -> float:
    # Binance trading day resets at 00:00 UTC == 03:00 EAT. Volume is counted
    # from this boundary (not a rolling 24h) so the morning shows "since 3am".
    return now - (now % 86400)


def get_summary() -> dict:
    now = time.time()
    cut = _day_start(now)
    bought = sold = 0.0
    merch: dict[str, dict] = {}
    live = [b for b in _buckets.values() if b.get("ts", 0) >= cut]
    oldest = min(live, key=lambda x: x["ts"]) if live else None
    base_avail = (oldest or {}).get("start_avail", {})
    for b in live:
        bought += b.get("bought", 0.0)
        sold += b.get("sold", 0.0)
        for nick, v in b.get("m", {}).items():
            mm = merch.setdefault(nick, {"bought": 0.0, "sold": 0.0})
            mm["bought"] += v.get("bought", 0.0)
            mm["sold"] += v.get("sold", 0.0)

    rows = []
    for nick, v in merch.items():
        traded = v["bought"] + v["sold"]
        availn = _avail_now.get(nick, 0.0)
        base = base_avail.get(nick)
        dpct = round((availn - base) / base * 100, 1) if base else None
        rows.append({
            "nick": nick, "traded": round(traded), "bought": round(v["bought"]), "sold": round(v["sold"]),
            "avail": round(availn), "delta_pct": dpct,
        })
    rows.sort(key=lambda r: r["traded"], reverse=True)

    since_hours = round((now - cut) / 3600, 1)           # hours since 3am reset
    started = _started or now
    # We only have complete "since 3am" data if the tracker was already running
    # before today's reset. If it started after 3am, today's total is partial.
    incomplete = started > cut + 120
    coverage_hours = round((now - max(cut, started)) / 3600, 1)
    new_m = sum(1 for t in _nick_first.values() if t >= cut) if not incomplete else None
    return {
        "bought_vol": round(bought),
        "sold_vol": round(sold),
        "total_vol": round(bought + sold),
        "active_merchants": len(_avail_now),
        "new_merchants": new_m,
        "merchants": rows[:40],
        "tracked_hours": coverage_hours,
        "since_hours": since_hours,
        "incomplete_day": incomplete,
        "window_hours": 24,
    }


def get_tier_breakdown(nick_tier: dict) -> dict:
    """Per merchant-tier aggregates for today. `nick_tier` maps nick -> tier
    (gold/silver/bronze/normal) from the live board, so 'online' reflects who is
    currently advertising. Returns {tier: {traded, bought, sold, avail, online}}."""
    now = time.time()
    cut = _day_start(now)
    tiers = ("gold", "silver", "bronze", "normal")
    agg = {t: {"traded": 0.0, "bought": 0.0, "sold": 0.0, "avail": 0.0, "online": 0} for t in tiers}
    # Online-now + advertised inventory, grouped by the tier on the current board.
    for nick, t in nick_tier.items():
        tt = t if t in agg else "normal"
        agg[tt]["online"] += 1
        agg[tt]["avail"] += _avail_now.get(nick, 0.0)
    # Today's estimated traded volume, grouped by tier.
    for b in _buckets.values():
        if b.get("ts", 0) < cut:
            continue
        for nick, v in b.get("m", {}).items():
            tt = nick_tier.get(nick, "normal")
            if tt not in agg:
                tt = "normal"
            agg[tt]["bought"] += v.get("bought", 0.0)
            agg[tt]["sold"] += v.get("sold", 0.0)
    for d in agg.values():
        d["bought"] = round(d["bought"]); d["sold"] = round(d["sold"])
        d["traded"] = d["bought"] + d["sold"]; d["avail"] = round(d["avail"])
    return agg


async def start():
    _load()
    logger.info("[MarketFlow] started — every %ss", INTERVAL)
    while True:
        try:
            await _flow_once()
        except Exception as e:
            logger.warning("[MarketFlow] sweep error: %s", e)
        await asyncio.sleep(INTERVAL)
