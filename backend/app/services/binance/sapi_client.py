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
import contextvars

import httpx

logger = logging.getLogger(__name__)

SAPI_BASE = "https://api.binance.com"

# Load relay config — prefer app settings (avoids pydantic extra-field errors),
# fall back to raw env vars for standalone scripts.
try:
    from app.core.config import settings as _cfg
    _RELAY_URL    = (_cfg.BINANCE_RELAY_URL or "").rstrip("/")
    _RELAY_SECRET = _cfg.BINANCE_RELAY_SECRET or ""
    _RELAY_MODE   = (_cfg.RELAY_MODE or "shared").lower()
except Exception:
    _RELAY_URL    = os.environ.get("BINANCE_RELAY_URL", "").rstrip("/")
    _RELAY_SECRET = os.environ.get("BINANCE_RELAY_SECRET", "")
    _RELAY_MODE   = os.environ.get("RELAY_MODE", "shared").lower()

# Set per-request so _post knows which trader's desktop to route through (per_trader mode).
# Callers wrap their Binance work with relay_trader.set(trader.id); awaited calls inherit it.
relay_trader: "contextvars.ContextVar[int | None]" = contextvars.ContextVar("relay_trader_id", default=None)


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
    """POST to Binance — via the trader's own desktop (per_trader mode), the shared residential
    relay, or directly. In per_trader mode the desktop pins the host to Binance and only forwards
    these params/body/headers, so api keys stay on the VPS and egress uses the trader's IP."""
    headers = _build_headers(api_key)

    # Per-trader egress: route through this trader's desktop (must be running).
    if _RELAY_MODE == "per_trader":
        tid = relay_trader.get()
        if tid is not None:
            from app.services.binance import relay_router
            return await relay_router.execute(tid, path, params, body, headers)

    base = _RELAY_URL if _RELAY_URL else SAPI_BASE
    url  = f"{base}{path}"
    if _RELAY_URL:
        logger.debug("Routing via shared relay: %s", url)

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, params=params, json=body, headers=headers)

    return r.json()


async def _get(path: str, api_key: str, params: dict) -> dict:
    """GET from Binance — same egress routing as _post (per-trader desktop, shared relay, or
    direct). Without this, GET endpoints silently bypass the relay and hit the geo-blocked VPS IP."""
    headers = _build_headers(api_key)

    # Per-trader egress: route through this trader's desktop (must be running).
    if _RELAY_MODE == "per_trader":
        tid = relay_trader.get()
        if tid is not None:
            from app.services.binance import relay_router
            return await relay_router.execute(tid, path, params, None, headers, method="GET")

    base = _RELAY_URL if _RELAY_URL else SAPI_BASE
    url  = f"{base}{path}"
    if _RELAY_URL:
        logger.debug("Routing GET via shared relay: %s", url)

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url, params=params, headers=headers)

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


async def update_ad_price(api_key: str, api_secret: str, adv_no: str, price) -> dict:
    """Update a single ad's price via /sapi/v1/c2c/ads/update. Send ONLY advNo + price —
    including surplusAmount/other fields triggers error 187049."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    body = {"advNo": adv_no, "price": str(price)}
    data = await _post("/sapi/v1/c2c/ads/update", api_key, params, body)
    success = data.get("success") or data.get("code") == "000000"
    if not success:
        code = data.get("code", "?"); msg = data.get("msg", "unknown error")
        logger.error("ads/update price failed: code=%s msg=%s adv_no=%s", code, msg, adv_no)
        raise ValueError(f"Binance ads/update error {code}: {msg}")
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


# Binance c2c success code is the string "000000"; anything else (e.g. -1022, -2008) is an error.
_BINANCE_OK_CODES = (None, "000000", "00000", "0", 0, 200, "200")

_BINANCE_ERR_FRIENDLY = {
    "-1022": "Your API secret doesn't match the key. Re-copy BOTH the API Key and Secret from Binance and try again.",
    "-2008": "This API key is invalid or was deleted on Binance. Create a new key and reconnect.",
    "-2014": "The API key format is invalid. Re-copy it exactly from Binance.",
    "-2015": "Invalid API key, IP, or permissions. Make sure the key has Reading enabled and isn't restricted to other IPs.",
    "-1021": "The clock on the relay machine is out of sync. Fix its date/time and reconnect.",
}


class BinanceApiError(Exception):
    """Binance returned an error envelope (e.g. -1022 bad signature). Carries code + message so the
    connect/test flow can show a clear, actionable reason instead of silently 'succeeding'."""
    def __init__(self, code, msg):
        self.code = code
        self.msg = msg
        super().__init__(f"Binance error {code}: {msg}")


def friendly_binance_error(code, msg) -> str:
    return _BINANCE_ERR_FRIENDLY.get(str(code), f"Binance rejected the request (code {code}): {msg}")


def _binance_envelope_error(data):
    """Return (code, msg) if the response is a Binance error envelope, else None."""
    if not isinstance(data, dict):
        return None
    code = data.get("code")
    if code in _BINANCE_OK_CODES:
        return None
    return code, (data.get("msg") or data.get("message") or "unknown error")


async def verify_api_credentials(api_key: str, api_secret: str) -> list:
    """EP-4 ad fetch that RAISES BinanceApiError on a Binance error envelope (bad signature/key/etc).
    Used by the connect/test-connection flow so a mismatched secret fails loudly with a clear
    message — unlike get_merchant_ads(), which returns [] on error (kept that way for the background
    pollers that must not crash). Returns the ads list on success (may be empty if no active ads)."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    data = await _post("/sapi/v1/c2c/ads/listWithPagination", api_key, params, {"page": 1, "rows": 50})
    err = _binance_envelope_error(data)
    if err:
        logger.warning(f"[Binance verify] error {err[0]}: {err[1]}")
        raise BinanceApiError(err[0], err[1])
    raw = data.get("data", [])
    return raw.get("content", []) if isinstance(raw, dict) else raw


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
    data = await _get("/sapi/v1/c2c/orderMatch/listUserOrderHistory", api_key, params)
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
        "taker_user_no": d.get("takerUserNo"),
    }


async def check_if_can_release(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-12: checkIfCanReleaseCoin — READ-ONLY eligibility probe (moves no crypto). Used to test
    whether the official release endpoints are alive for this account: a normal Binance envelope
    means the family works; a 'deprecated'/forbidden/404 means we must use the cookie path instead.
    Returns the RAW Binance response so the caller can inspect code/msg."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    return await _post(
        "/sapi/v1/c2c/orderMatch/checkIfCanReleaseCoin",
        api_key, params, {"orderNumber": order_number},
    )


async def release_coin(api_key: str, api_secret: str, order_number: str,
                       auth_type: str = None, code: str = None) -> dict:
    """EP-20: releaseCoin — release crypto to the buyer on a paid SELL order. May require a 2FA
    code (authType + code) depending on the account; we pass them through only when provided so we
    can discover the requirement from Binance's error. Returns the RAW response."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    body = {"orderNumber": order_number}
    if auth_type:
        body["authType"] = auth_type
    if code:
        # Binance expects the Google Authenticator code under googleVerifyCode (error -9000 otherwise)
        body["googleVerifyCode"] = code
    return await _post("/sapi/v1/c2c/orderMatch/releaseCoin", api_key, params, body)


def _cookie_str_for_host(trader, host: str) -> str:
    """Build the Cookie header for a specific Binance host using the FULL captured cookie set,
    selecting only cookies whose domain applies to that host (just like the browser does). The flat
    name->value dict can't do this — the P2P session token p20t exists per-domain (www/p2p), so a
    c2c.binance.com call must NOT borrow the wrong-domain token. Falls back to the flat dict."""
    import json
    from app.core.security import decrypt_data
    full = getattr(trader, "binance_cookies_full", None)
    if full:
        try:
            cookies = json.loads(decrypt_data(full))
            if isinstance(cookies, list):
                parts = []
                for c in cookies:
                    name, val = c.get("name"), c.get("value")
                    dom = (c.get("domain") or "").lstrip(".")
                    if not name or not dom:
                        continue
                    if host == dom or host.endswith("." + dom):   # cookie applies to this host
                        parts.append(f"{name}={val}")
                if parts:
                    return "; ".join(parts)
        except Exception:
            pass
    d = json.loads(decrypt_data(trader.binance_cookies))
    return "; ".join(f"{k}={v}" for k, v in d.items())


def _cookie_headers(trader, host: str = "p2p.binance.com") -> dict:
    """Full Binance web-API header set (matching the logged-in browser) for cookie-authed calls.
    Missing any of these (esp. C2ctype / Bnc-Uuid / Clienttype) or sending wrong-domain cookies
    makes Binance reply 100002002 'check if you are logged in' even with fresh cookies."""
    from app.core.security import decrypt_data
    csrf = decrypt_data(trader.binance_csrf_token) if getattr(trader, "binance_csrf_token", None) else ""
    bnc_uuid = decrypt_data(trader.binance_bnc_uuid) if getattr(trader, "binance_bnc_uuid", None) else ""
    h = {
        "Cookie": _cookie_str_for_host(trader, host),
        "Csrftoken": csrf,
        "Clienttype": "web",
        "C2ctype": "c2c_web",
        "Bnc-Location": "KE",
        "Bnc-Time-Zone": "Africa/Nairobi",
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
        "User-Agent": getattr(_cfg, "BINANCE_DEFAULT_USER_AGENT", None) or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }
    if bnc_uuid:
        h["Bnc-Uuid"] = bnc_uuid
    return h


async def check_cookie_session(trader) -> bool:
    """Proactive cookie health: True if the trader's stored Binance session is still valid, False if
    expired. Lightweight cookie-auth call (user/profile) routed through their relay. Raises
    RelayOffline if the device isn't reachable (caller should skip, not alarm)."""
    from app.services.binance import relay_router
    if not getattr(trader, "binance_cookies", None):
        return False
    headers = _cookie_headers(trader)
    body = {"userNo": trader.binance_uid or ""}
    result = await relay_router.execute(
        trader.id, "/bapi/c2c/v2/friendly/c2c/user/profile",
        {}, body, headers, method="POST", host="https://p2p.binance.com",
    )
    if isinstance(result, dict):
        code = str(result.get("code") or "")
        msg = str(result.get("message") or "").lower()
        if code == "100002001" or "login status expired" in msg or "log in again" in msg:
            return False
    return True   # any non-expiry response means the session authenticated fine


async def send_chat_via_relay(trader, order_number: str, message: str) -> dict:
    """Cookie-hybrid chat-send: send a Binance P2P chat message using the trader's STORED browser
    cookies, routed through their device's relay (cookie auth + residential IP). This is the one
    thing the official API can't do — the API key handles everything else. Returns the raw response.
    Raises ValueError('NO_BINANCE_SESSION') if cookies are missing/expired (trader must re-login)."""
    from app.services.binance import relay_router
    if not getattr(trader, "binance_cookies", None) or not getattr(trader, "binance_csrf_token", None):
        raise ValueError("NO_BINANCE_SESSION")
    headers = _cookie_headers(trader, host="p2p.binance.com")
    body = {"orderNumber": str(order_number), "message": message, "msgType": 1}
    result = await relay_router.execute(
        trader.id, "/bapi/c2c/v2/private/c2c/chat/send-message",
        {}, body, headers, method="POST", host="https://p2p.binance.com",
    )
    # Expired cookies -> surface as NO_BINANCE_SESSION so the caller fires the re-login nudge.
    if isinstance(result, dict):
        _code = str(result.get("code") or "")
        _msg = str(result.get("message") or "").lower()
        if _code == "100002001" or "login status expired" in _msg or "log in again" in _msg:
            raise ValueError("NO_BINANCE_SESSION")
    return result


async def mark_order_as_paid(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-17: markOrderAsPaid — on a BUY order, tell the seller we've paid. Returns RAW response."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    return await _post("/sapi/v1/c2c/orderMatch/markOrderAsPaid", api_key, params, {"orderNumber": order_number})


async def cancel_order(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-9: cancelOrder. Returns RAW response."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    return await _post("/sapi/v1/c2c/orderMatch/cancelOrder", api_key, params, {"orderNumber": order_number})


async def get_order_identity(api_key: str, api_secret: str, order_number: str) -> dict:
    """EP-13 (lean): just the counterparty identity + headline order facts, used to
    match a counterparty across past orders (history nicknames are masked, so we key
    on the stable takerUserNo). Returns {taker_user_no, counterparty_nickname,
    trade_type, total_price, status}."""
    params = _base_params()
    params["signature"] = _sign(api_secret, params)
    data = await _post(
        "/sapi/v1/c2c/orderMatch/getUserOrderDetail",
        api_key, params, {"adOrderNo": order_number},
    )
    d = data.get("data") or {}
    trade_type = (d.get("tradeType") or "").upper()
    cp_nick = d.get("sellerNickname") if trade_type == "BUY" else d.get("buyerNickname")
    try:
        total_price = float(d.get("totalPrice") or 0)
    except Exception:
        total_price = 0.0
    return {
        "taker_user_no": d.get("takerUserNo"),
        "counterparty_nickname": cp_nick,
        "trade_type": trade_type,
        "total_price": total_price,
        "status": str(d.get("orderStatus") or "").upper(),
    }
