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
    if b is None:
        b = _buckets[hk] = {"buy": 0.0, "sell": 0.0, "m": {}, "start_avail": dict(_avail_now), "ts": now}

    cur: dict[str, tuple] = {}
    nick_avail: dict[str, float] = {}
    for side, rows in (("buy", buy), ("sell", sell)):
        for r in rows:
            adv = str(r.get("advNo") or "")
            if not adv:
                continue
            av = float(r.get("available") or 0)
            nick = r.get("nick") or ""
            cur[adv] = (nick, side, av)
            if nick:
                # "Avail now" = USDT the merchant actually has FOR SALE (sell ads only). The 'buy'
                # board side IS the sell ads (merchants selling USDT). Buy-ad amounts are inflated
                # monthly buy-limits, so they're excluded from availability.
                if side == "buy":
                    nick_avail[nick] = nick_avail.get(nick, 0.0) + av
                _nick_first.setdefault(nick, now)

    for adv, (nick, side, av) in cur.items():
        if adv in _prev:
            delta = _prev[adv] - av
            if delta > 0:
                filled = min(delta, MAX_FILL_PER_MIN)
                b[side] += filled
                m = b["m"].setdefault(nick, {"buy": 0.0, "sell": 0.0})
                m[side] += filled

    _prev.clear()
    _prev.update({adv: av for adv, (n, s, av) in cur.items()})
    _avail_now.clear()
    _avail_now.update(nick_avail)
    _prune(now)
    _save()


def get_summary() -> dict:
    now = time.time()
    cut = now - WINDOW
    buy = sell = 0.0
    merch: dict[str, dict] = {}
    live = [b for b in _buckets.values() if b.get("ts", 0) >= cut]
    oldest = min(live, key=lambda x: x["ts"]) if live else None
    base_avail = (oldest or {}).get("start_avail", {})
    for b in live:
        buy += b.get("buy", 0.0)
        sell += b.get("sell", 0.0)
        for nick, v in b.get("m", {}).items():
            mm = merch.setdefault(nick, {"buy": 0.0, "sell": 0.0})
            mm["buy"] += v.get("buy", 0.0)
            mm["sell"] += v.get("sell", 0.0)

    rows = []
    for nick, v in merch.items():
        sold = v["buy"] + v["sell"]
        availn = _avail_now.get(nick, 0.0)
        base = base_avail.get(nick)
        dpct = round((availn - base) / base * 100, 1) if base else None
        rows.append({
            "nick": nick, "sold": round(sold), "buy": round(v["buy"]), "sell": round(v["sell"]),
            "avail": round(availn), "delta_pct": dpct,
        })
    rows.sort(key=lambda r: r["sold"], reverse=True)

    age = now - (_started or now)
    new_m = sum(1 for t in _nick_first.values() if t >= cut) if age >= WINDOW else None
    return {
        "buy_vol": round(buy),
        "sell_vol": round(sell),
        "total_vol": round(buy + sell),
        "active_merchants": len(_avail_now),
        "new_merchants": new_m,
        "merchants": rows[:40],
        "tracked_hours": round(age / 3600, 1),
        "window_hours": 24,
    }


async def start():
    _load()
    logger.info("[MarketFlow] started — every %ss", INTERVAL)
    while True:
        try:
            await _flow_once()
        except Exception as e:
            logger.warning("[MarketFlow] sweep error: %s", e)
        await asyncio.sleep(INTERVAL)
