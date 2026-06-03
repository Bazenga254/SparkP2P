"""
Binance SAPI client — signed requests for P2P merchant operations.
Requires a Binance API key + secret from a verified Merchant account.
Used for: counterparty filter updates (EP-7), ad listing (EP-4).

Geo-block workaround: if BINANCE_RELAY_URL is set, all Binance calls are
forwarded to a local relay service running on a residential IP (your computer),
which is not geo-blocked by Binance.
"""

import hmac
import hashlib
import os
import time
import logging

import httpx

logger = logging.getLogger(__name__)

SAPI_BASE = "https://api.binance.com"

# Load relay config — prefer app settings (avoids pydantic extra-field errors),
# fall back to raw env vars for standalone scripts.
try:
    from app.core.config import settings as _cfg
    _RELAY_URL    = (_cfg.BINANCE_RELAY_URL or "").rstrip("/")
    _RELAY_SECRET = _cfg.BINANCE_RELAY_SECRET or ""
except Exception:
    _RELAY_URL    = os.environ.get("BINANCE_RELAY_URL", "").rstrip("/")
    _RELAY_SECRET = os.environ.get("BINANCE_RELAY_SECRET", "")


def _sign(secret: str, params: dict) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def _base_params() -> dict:
    return {"timestamp": int(time.time() * 1000), "recvWindow": 60000}


def _build_headers(api_key: str) -> dict:
    headers = {
        "X-MBX-APIKEY": api_key,
        "clientType":   "web",
        "Content-Type": "application/json",
    }
    if _RELAY_URL and _RELAY_SECRET:
        headers["X-Relay-Secret"] = _RELAY_SECRET
    return headers


async def _post(path: str, api_key: str, params: dict, body: dict) -> dict:
    """POST to Binance directly, or via the residential relay if configured."""
    headers = _build_headers(api_key)
    base    = _RELAY_URL if _RELAY_URL else SAPI_BASE
    url     = f"{base}{path}"

    if _RELAY_URL:
        logger.debug("Routing via relay: %s", url)

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, params=params, json=body, headers=headers)

    return r.json()


async def push_counterparty_filters(
    api_key: str,
    api_secret: str,
    adv_no: str,
    completion_rate_min: float,
    completion_rate_window: int,
    all_trades_min: int,
    trade_count_window: int,
    completed_trades_min: int,
    buy_trades_min: int = 0,
    sell_trades_min: int = 0,
    volume_min: float = 0.0,
    volume_asset: str = "USDT",
    volume_window: int = 2,
    reg_days_min: int = 0,
) -> dict:
    """Push counterparty filter settings to a Binance P2P ad via EP-7."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)

    body = {
        "advNo":                           adv_no,
        "userTradeCompleteRateMin":        completion_rate_min,
        "userTradeCompleteRateFilterTime": completion_rate_window,
        "userAllTradeCountMin":            all_trades_min,
        "userTradeCountFilterTime":        trade_count_window,
        "userTradeCompleteCountMin":       completed_trades_min,
        "userBuyTradeCountMin":            buy_trades_min,
        "userSellTradeCountMin":           sell_trades_min,
        "userTradeVolumeMin":              volume_min,
        "userTradeVolumeAsset":            volume_asset,
        "userTradeVolumeFilterTime":       volume_window,
        "buyerRegDaysLimit":               reg_days_min,
    }

    data = await _post("/sapi/v1/c2c/ads/update", api_key, params, body)
    success = data.get("success") or data.get("code") == "000000"

    if not success:
        code = data.get("code", "?")
        msg  = data.get("msg", "unknown error")
        logger.error("EP-7 failed: code=%s msg=%s adv_no=%s via=%s", code, msg, adv_no, "relay" if _RELAY_URL else "direct")
        raise ValueError(f"Binance EP-7 error {code}: {msg}")

    logger.info("EP-7 filters pushed: adv_no=%s via=%s", adv_no, "relay" if _RELAY_URL else "direct")
    return {"success": True}


async def get_merchant_ads(api_key: str, api_secret: str) -> list:
    """Fetch the merchant's active ads via EP-4."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)

    data = await _post(
        "/sapi/v1/c2c/ads/listWithPagination",
        api_key, params, {"page": 1, "rows": 50}
    )

    raw = data.get("data", [])
    ads = raw.get("content", []) if isinstance(raw, dict) else raw
    return ads


async def get_counterparty_statistic(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-19: query counterparty trade statistics for a given order.

    Returns the buyer's trade history and our relationship with them, e.g.:
      completedOrderNumOfLatest30day            -> buyer 30D completed trades
      completedOrderNum                         -> buyer all-time completed trades
      finishRateLatest30Day / finishRate        -> completion rate (ratio 0-1)
      registerDays                              -> account age in days
      avgPayTime / avgPayTimeOfLatest30day      -> avg pay time (seconds)
      avgReleaseTime / avgReleaseTimeOfLatest30day
      numberOfTradesWithCounterpartyCompleted30day -> trades with us in last 30d
    """
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    data = await _post(
        "/sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic",
        api_key, params, {"orderNumber": order_number},
    )
    if not (data.get("success") or data.get("code") == "000000"):
        raise ValueError(f"EP-19 error {data.get('code','?')}: {data.get('msg') or data.get('message','unknown')}")
    return data.get("data") or {}


async def get_user_order_history(api_key: str, api_secret: str, page: int = 1, rows: int = 100) -> list:
    """EP-16: GET /sapi/v1/c2c/orderMatch/listUserOrderHistory.
    Returns completed/cancelled C2C orders (newest first) with rate, amount, fees."""
    params = _base_params()
    params["page"] = page
    params["rows"] = rows
    params["signature"] = _sign(api_secret, params)
    base = _RELAY_URL if _RELAY_URL else SAPI_BASE
    headers = _build_headers(api_key)
    url = f"{base}/sapi/v1/c2c/orderMatch/listUserOrderHistory"
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url, params=params, headers=headers)
    data = r.json()
    # Surface Binance auth errors so callers can flag a dead/invalid key
    code = str(data.get("code")) if isinstance(data, dict) else None
    if code in ("-2008", "-2014", "-2015"):
        raise ValueError("INVALID_API_KEY:" + str(data.get("msg") or code))
    return data.get("data") or []


async def get_order_payment_details(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-13: getUserOrderDetail -> extract the counterparty's payment account details.
    Returns {method, name, account, fields:[{label,value}], pay_account, raw_pay_type}.
    On a BUY order this is the SELLER's account (where we send money)."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    data = await _post(
        "/sapi/v1/c2c/orderMatch/getUserOrderDetail",
        api_key, params, {"adOrderNo": order_number},
    )
    d = data.get("data") or {}
    pay_methods = d.get("payMethods") or []
    # Prefer the method matching payType (the one actually selected), else first with values.
    pay_type = d.get("payType")
    chosen = None
    for m in pay_methods:
        if (m.get("identifier") == pay_type) or (m.get("tradeMethodName") == pay_type):
            chosen = m
            break
    if not chosen:
        # pick the method that has at least one non-empty field value
        for m in pay_methods:
            if any((f.get("fieldValue") or "").strip() for f in (m.get("fields") or [])):
                chosen = m
                break
    if not chosen and pay_methods:
        chosen = pay_methods[0]
    fields = []
    name = None
    pay_account = None
    if chosen:
        for f in (chosen.get("fields") or []):
            val = (f.get("fieldValue") or "").strip()
            if not val:
                continue
            label = f.get("fieldName") or ""
            fields.append({"label": label, "value": val})
            ctype = (f.get("fieldContentType") or "").lower()
            if ctype == "payee" or "name" in label.lower():
                name = name or val
            if ctype == "pay_account" or any(w in label.lower() for w in ["account number", "phone", "card"]):
                pay_account = pay_account or val
    # Full (unmasked) counterparty nickname — depends on our side of the trade.
    trade_type = (d.get("tradeType") or "").upper()
    if trade_type == "BUY":
        cp_nick = d.get("sellerNickname")   # we buy -> counterparty is the seller
    else:
        cp_nick = d.get("buyerNickname")    # we sell -> counterparty is the buyer
    return {
        "method": (chosen or {}).get("tradeMethodName") or pay_type,
        "name": name,
        "pay_account": pay_account,
        "fields": fields,
        "raw_pay_type": pay_type,
        "counterparty_nickname": cp_nick,
    }
