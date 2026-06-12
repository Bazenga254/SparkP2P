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


def _tier_from_vip(vip: int) -> str:
    # In the P2P adv/search feed, vipLevel IS the Binance P2P Merchant tier (verified against the
    # web-UI medal badges): 3 -> Gold, 2 -> Silver, 1/0 -> Bronze. (This is the P2P Merchant VIP
    # Program, NOT the separate spot-trading VIP level on the fee page.)
    if vip >= 3:
        return "gold"
    if vip == 2:
        return "silver"
    return "bronze"


def _parse(items: list, start: int = 0) -> list[dict]:
    out = []
    for i, item in enumerate(items or []):
        adv = item.get("adv", {}) or {}
        a = item.get("advertiser", {}) or {}
        vip = int(a.get("vipLevel") or 0)
        out.append({
            "rank": start + i + 1,
            "advNo": adv.get("advNo"),
            "price": float(adv.get("price") or 0),
            "nick": a.get("nickName"),
            "userNo": a.get("userNo"),
            "identity": a.get("userIdentity"),         # MASS_MERCHANT / BLOCK_MERCHANT / ...
            "vip": vip,
            "tier": _tier_from_vip(vip),
            "orders30d": int(a.get("monthOrderCount") or 0),
            "finishRate": round((a.get("monthFinishRate") or 0) * 100, 1),
            "available": float(adv.get("tradableQuantity") or adv.get("surplusAmount") or 0),
            "minAmount": float(adv.get("minSingleTransAmount") or 0),
            "maxAmount": float(adv.get("maxSingleTransAmount") or 0),
            "methods": [m.get("tradeMethodShortName") or m.get("identifier") for m in (adv.get("tradeMethods") or [])],
            "floating": bool(adv.get("priceType")),     # auto-floating-price ad vs fixed
        })
    return out


async def _fetch(asset: str, fiat: str, trade_type: str, pages: int = 3, rows: int = 20) -> list[dict]:
    """Fetch several pages of the order book so the tier filters have enough merchants to show."""
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=15) as client:
        for page in range(1, pages + 1):
            payload = {
                "asset": asset, "fiat": fiat, "tradeType": trade_type,
                "page": page, "rows": rows, "publisherType": "merchant",
            }
            r = await client.post(SEARCH_URL, json=payload, headers=_HEADERS)
            data = (r.json() or {}).get("data", []) or []
            if not data:
                break
            out.extend(_parse(data, start=len(out)))
            if page < pages and len(data) >= rows:
                await asyncio.sleep(0.12)   # be gentle on the soft rate limit
            else:
                break
    return out


async def get_board(asset: str = "USDT", fiat: str = "KES", pages: int = 5) -> dict:
    """Both sides of the order book, ranked, with up to `pages`*20 merchants. Cached briefly.
    A deeper pool (pages*20) lets the client-side merchant search find names beyond the top 20."""
    key = f"{asset}:{fiat}:{pages}"
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]

    buy_ads, sell_ads = await asyncio.gather(
        _fetch(asset, fiat, "BUY", pages),    # where I can BUY (sellers' asks)
        _fetch(asset, fiat, "SELL", pages),   # where I can SELL (buyers' bids)
    )
    result = {
        "asset": asset, "fiat": fiat,
        "updated_at": now,
        "buy": buy_ads,    # ranked cheapest-first (best to buy from)
        "sell": sell_ads,  # ranked highest-first (best to sell to)
    }
    _cache[key] = (now, result)
    return result
