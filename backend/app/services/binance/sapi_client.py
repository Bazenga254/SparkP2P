"""
Binance SAPI client — signed requests for P2P merchant operations.
Requires a Binance API key + secret from a verified Merchant account.
Used for: counterparty filter updates (EP-7), ad status (EP-8).
"""

import hmac
import hashlib
import time
import logging

import httpx

logger = logging.getLogger(__name__)

SAPI_BASE = "https://api.binance.com"


def _sign(secret: str, params: dict) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def _base_params() -> dict:
    return {"timestamp": int(time.time() * 1000), "recvWindow": 60000}


async def push_counterparty_filters(
    api_key: str,
    api_secret: str,
    adv_no: str,
    completion_rate_min: float,      # ratio 0.0–1.0
    completion_rate_window: int,     # 1=Last 30D, 2=All-time
    all_trades_min: int,
    trade_count_window: int,         # 1=Last 30D, 2=All-time
    completed_trades_min: int,
    buy_trades_min: int = 0,
    sell_trades_min: int = 0,
    volume_min: float = 0.0,
    volume_asset: str = "USDT",
    volume_window: int = 2,
) -> dict:
    """
    Push counterparty filter settings to a Binance P2P ad via EP-7.
    Returns {"success": True} or raises on failure.
    """
    headers = {
        "X-MBX-APIKEY": api_key,
        "clientType": "web",
        "Content-Type": "application/json",
    }

    params = _base_params()
    params["signature"] = _sign(api_secret, params)

    body = {
        "advNo": adv_no,
        "userTradeCompleteRateMin":    completion_rate_min,
        "userTradeCompleteRateFilterTime": completion_rate_window,
        "userAllTradeCountMin":        all_trades_min,
        "userTradeCountFilterTime":    trade_count_window,
        "userTradeCompleteCountMin":   completed_trades_min,
        "userBuyTradeCountMin":        buy_trades_min,
        "userSellTradeCountMin":       sell_trades_min,
        "userTradeVolumeMin":          volume_min,
        "userTradeVolumeAsset":        volume_asset,
        "userTradeVolumeFilterTime":   volume_window,
    }

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{SAPI_BASE}/sapi/v1/c2c/ads/update",
            params=params,
            json=body,
            headers=headers,
        )

    data = r.json()
    success = data.get("success") or data.get("code") == "000000"

    if not success:
        code = data.get("code", r.status_code)
        msg  = data.get("msg", "unknown error")
        logger.error("EP-7 filter push failed: code=%s msg=%s adv_no=%s", code, msg, adv_no)
        raise ValueError(f"Binance EP-7 error {code}: {msg}")

    logger.info("EP-7 filters pushed successfully: adv_no=%s", adv_no)
    return {"success": True}


async def get_merchant_ads(api_key: str, api_secret: str) -> list:
    """Fetch the merchant's active ads (EP-4) to get advNo values."""
    headers = {
        "X-MBX-APIKEY": api_key,
        "clientType": "web",
        "Content-Type": "application/json",
    }

    params = _base_params()
    params["signature"] = _sign(api_secret, params)

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{SAPI_BASE}/sapi/v1/c2c/ads/listWithPagination",
            params=params,
            json={"page": 1, "rows": 50},
            headers=headers,
        )

    data = r.json()
    raw = data.get("data", [])
    ads = raw.get("content", []) if isinstance(raw, dict) else raw
    return ads
