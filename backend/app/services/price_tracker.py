"""Binance P2P public price tracker.

Pulls the public C2C advertisement order book (no auth required) so a merchant can see where
competitors are priced and how they rank. The VPS can reach this endpoint directly (unlike the
signed SAPI), so no relay is needed.

adv/search semantics:
  tradeType=BUY  -> "I want to BUY" -> returns SELL ads (merchants selling to me), cheapest first
  tradeType=SELL -> "I want to SELL" -> returns BUY ads (merchants buying from me), highest first
Binance already returns each list in competitive order, so the list index is the rank.
"""
import asyncio
import logging
import time

import httpx

logger = logging.getLogger(__name__)

SEARCH_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search"
_HEADERS = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}

# Short in-memory cache so many merchants viewing the tracker don't hammer Binance.
_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 20  # seconds


def _parse(items: list) -> list[dict]:
    out = []
    for i, item in enumerate(items or []):
        adv = item.get("adv", {}) or {}
        a = item.get("advertiser", {}) or {}
        out.append({
            "rank": i + 1,
            "advNo": adv.get("advNo"),
            "price": float(adv.get("price") or 0),
            "nick": a.get("nickName"),
            "userNo": a.get("userNo"),
            "identity": a.get("userIdentity"),         # MASS_MERCHANT / BLOCK_MERCHANT / ...
            "grade": a.get("userGrade"),
            "orders30d": int(a.get("monthOrderCount") or 0),
            "finishRate": round((a.get("monthFinishRate") or 0) * 100, 1),
            "available": float(adv.get("tradableQuantity") or adv.get("surplusAmount") or 0),
            "minAmount": float(adv.get("minSingleTransAmount") or 0),
            "maxAmount": float(adv.get("maxSingleTransAmount") or 0),
            "methods": [m.get("tradeMethodShortName") or m.get("identifier") for m in (adv.get("tradeMethods") or [])],
            "floating": bool(adv.get("priceType")),     # auto-floating-price ad vs fixed
        })
    return out


async def _fetch(asset: str, fiat: str, trade_type: str, rows: int) -> list[dict]:
    payload = {
        "asset": asset, "fiat": fiat, "tradeType": trade_type,
        "page": 1, "rows": rows, "publisherType": "merchant",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(SEARCH_URL, json=payload, headers=_HEADERS)
        data = (r.json() or {}).get("data", []) or []
    return _parse(data)


async def get_board(asset: str = "USDT", fiat: str = "KES", rows: int = 15) -> dict:
    """Both sides of the order book, ranked. Cached briefly per asset/fiat."""
    key = f"{asset}:{fiat}:{rows}"
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]

    buy_ads, sell_ads = await asyncio.gather(
        _fetch(asset, fiat, "BUY", rows),    # where I can BUY (sellers' asks)
        _fetch(asset, fiat, "SELL", rows),   # where I can SELL (buyers' bids)
    )
    result = {
        "asset": asset, "fiat": fiat,
        "updated_at": now,
        "buy": buy_ads,    # ranked cheapest-first (best to buy from)
        "sell": sell_ads,  # ranked highest-first (best to sell to)
    }
    _cache[key] = (now, result)
    return result
