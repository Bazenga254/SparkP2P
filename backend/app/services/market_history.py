"""Market history recorder for the Price Tracker.

Takes periodic snapshots of the public Binance P2P board (best ask/bid, medians, liquidity,
merchant count) so the cockpit can draw trend sparklines (spread tightening/widening, price
drift, liquidity over time). File-backed rolling buffer — no DB migration, survives restarts
and deploys (the JSON file isn't touched by scp/git).
"""
import asyncio
import json
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

INTERVAL = 60                 # snapshot cadence (seconds)
MAX_AGE = 48 * 3600           # keep the last 48h of points
HIST_FILE = Path(__file__).resolve().parents[2] / "market_history.json"

_hist: list[dict] = []


def _median(vals) -> float:
    s = sorted(v for v in vals if v and v > 0)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else 0.0


def _load():
    global _hist
    try:
        if HIST_FILE.exists():
            _hist = json.loads(HIST_FILE.read_text("utf-8")) or []
            logger.info("[MarketHistory] restored %d points", len(_hist))
    except Exception as e:
        logger.warning("[MarketHistory] load failed: %s", e)


def _save():
    try:
        tmp = HIST_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_hist), "utf-8")
        tmp.replace(HIST_FILE)
    except Exception as e:
        logger.warning("[MarketHistory] save failed: %s", e)


def get_history(hours: float = 6.0) -> list[dict]:
    """Recent snapshots within the window (oldest-first)."""
    cut = time.time() - hours * 3600
    return [p for p in _hist if p.get("ts", 0) >= cut]


async def _snap_once():
    from app.services.price_tracker import get_board
    board = await get_board("USDT", "KES")
    buy, sell = board.get("buy", []), board.get("sell", [])
    if not buy and not sell:
        return
    point = {
        "ts": round(time.time()),
        "ask": round(buy[0]["price"], 2) if buy else None,       # cheapest USDT to buy
        "bid": round(sell[0]["price"], 2) if sell else None,     # highest to sell USDT
        "ask_med": round(_median([r["price"] for r in buy[:10]]), 2),
        "bid_med": round(_median([r["price"] for r in sell[:10]]), 2),
        "buy_liq": round(sum((r.get("available") or 0) for r in buy)),
        "sell_liq": round(sum((r.get("available") or 0) for r in sell)),
        "n_buy": len(buy),
        "n_sell": len(sell),
    }
    _hist.append(point)
    cut = time.time() - MAX_AGE
    _hist[:] = [p for p in _hist if p.get("ts", 0) >= cut]
    _save()


async def start():
    _load()
    logger.info("[MarketHistory] started — every %ss", INTERVAL)
    while True:
        try:
            await _snap_once()
        except Exception as e:
            logger.warning("[MarketHistory] snap error: %s", e)
        await asyncio.sleep(INTERVAL)
