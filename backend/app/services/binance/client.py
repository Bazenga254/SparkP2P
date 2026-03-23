import json
import logging
from typing import Optional

import httpx
import pyotp

from app.core.config import settings
from app.core.security import decrypt_data

logger = logging.getLogger(__name__)


class BinanceP2PClient:
    """Binance P2P client using authenticated cookie session.

    Endpoints verified from real Binance P2P network traffic (March 2026).
    Host: c2c.binance.com
    Base path: /bapi/c2c/v2/private/c2c/order-match/
    """

    BASE_URL = "https://c2c.binance.com/bapi/c2c/v2/private"

    def __init__(
        self,
        cookies: dict,
        csrf_token: str,
        bnc_uuid: str = "",
        totp_secret: Optional[str] = None,
    ):
        self.cookies = cookies
        self.csrf_token = csrf_token
        self.bnc_uuid = bnc_uuid
        self.totp_secret = totp_secret
        self.headers = {
            "Csrftoken": csrf_token,
            "Clienttype": "web",
            "C2ctype": "c2c_web",
            "Bnc-Location": "KE",
            "Bnc-Time-Zone": "Africa/Nairobi",
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
            "User-Agent": settings.BINANCE_DEFAULT_USER_AGENT,
        }
        if bnc_uuid:
            self.headers["Bnc-Uuid"] = bnc_uuid

    @classmethod
    def from_trader(cls, trader) -> "BinanceP2PClient":
        """Create client from a Trader model instance."""
        cookies = json.loads(decrypt_data(trader.binance_cookies))
        csrf_token = decrypt_data(trader.binance_csrf_token)
        bnc_uuid = ""
        if trader.binance_bnc_uuid:
            bnc_uuid = decrypt_data(trader.binance_bnc_uuid)
        totp_secret = None
        if trader.binance_2fa_secret:
            totp_secret = decrypt_data(trader.binance_2fa_secret)
        return cls(cookies, csrf_token, bnc_uuid, totp_secret)

    @classmethod
    def from_raw(cls, cookies: dict, csrf_token: str, bnc_uuid: str = "", totp_secret: str = None):
        """Create client from raw credentials (for testing)."""
        return cls(cookies, csrf_token, bnc_uuid, totp_secret)

    def _get_2fa_code(self) -> Optional[str]:
        """Generate current TOTP 2FA code."""
        if not self.totp_secret:
            return None
        return pyotp.TOTP(self.totp_secret).now()

    async def _request(self, endpoint: str, payload: dict = None) -> dict:
        """Make authenticated POST request to Binance C2C API."""
        url = f"{self.BASE_URL}{endpoint}"
        async with httpx.AsyncClient(cookies=self.cookies, timeout=30.0) as client:
            response = await client.post(
                url,
                json=payload or {},
                headers=self.headers,
            )

            logger.debug(f"Binance API {endpoint}: status={response.status_code}")

            if response.status_code == 401 or response.status_code == 403:
                logger.error(f"Binance session expired/forbidden: {response.status_code}")
                raise BinanceSessionExpired("Session cookies expired or forbidden")

            data = response.json()

            # Binance returns {"code": "000000", "data": {...}} on success
            if data.get("code") and data["code"] != "000000":
                logger.error(f"Binance API error: {data}")
                raise BinanceAPIError(
                    f"Binance error {data.get('code')}: {data.get('message', 'Unknown error')}"
                )

            return data

    # ── Order Management ──────────────────────────────────────────

    async def get_pending_orders(self, trade_type: str = "SELL") -> list:
        """
        Get pending P2P orders.
        trade_type: SELL (we're selling, buyer pays us) or BUY (we're buying, we pay seller)
        """
        payload = {
            "page": 1,
            "rows": 20,
            "tradeType": trade_type,
            "orderStatusList": [1, 2, 3],  # 1=pending, 2=buyer paid, 3=releasing
        }
        result = await self._request("/c2c/order-match/order-list", payload)
        return result.get("data", [])

    async def get_order_detail(self, order_number: str) -> dict:
        """Get detailed info about a specific order."""
        payload = {"orderNumber": order_number}
        result = await self._request("/c2c/order-match/order-detail", payload)
        return result.get("data", {})

    async def release_order(self, order_number: str) -> dict:
        """
        Release crypto to buyer (sell side).
        This is the core auto-release function.
        Endpoint: /bapi/c2c/v2/private/c2c/order-match/confirm-order
        """
        payload = {"orderNumber": order_number}

        # Add 2FA if required
        code = self._get_2fa_code()
        if code:
            payload["emailVerifyCode"] = ""
            payload["mobileVerifyCode"] = ""
            payload["googleVerifyCode"] = code

        result = await self._request("/c2c/order-match/confirm-order", payload)
        logger.info(f"Released order {order_number}: code={result.get('code')}")
        return result

    async def mark_as_paid(self, order_number: str) -> dict:
        """Mark order as paid (buy side - after we send KES to seller)."""
        payload = {"orderNumber": order_number}
        result = await self._request("/c2c/order-match/buyer-confirm-pay", payload)
        logger.info(f"Marked order {order_number} as paid: code={result.get('code')}")
        return result

    # ── Chat ──────────────────────────────────────────────────────

    async def send_chat_message(self, order_number: str, message: str) -> dict:
        """Send a message in the P2P order chat."""
        payload = {
            "orderNumber": order_number,
            "message": message,
            "msgType": 1,  # Text message
        }
        result = await self._request("/c2c/chat/send-message", payload)
        return result

    async def get_chat_messages(self, order_number: str) -> list:
        """Get chat messages for an order."""
        payload = {"orderNumber": order_number}
        result = await self._request("/c2c/chat/retrieve-message", payload)
        return result.get("data", [])

    # ── User Profile ──────────────────────────────────────────────

    async def get_user_profile(self) -> dict:
        """Fetch user's verified name and details from payment methods.
        Returns: {name, nickname, uid, payment_methods}
        """
        result = await self._request(
            "/c2c/pay-method/user-paymethods", {}
        )
        payment_methods = result.get("data", [])

        # Extract verified name from payment method fields
        verified_name = None
        phone = None
        for pm in payment_methods:
            fields = pm.get("fields", [])
            for f in fields:
                field_name = (f.get("fieldName") or "").lower()
                field_value = f.get("fieldValue", "")
                if field_name in ("account name", "full name", "name") and field_value:
                    if not verified_name:
                        verified_name = field_value
                if field_name in ("phone number", "mobile number") and field_value:
                    if not phone:
                        phone = field_value

        return {
            "verified_name": verified_name,
            "phone": phone,
            "payment_methods_count": len(payment_methods),
        }

    # ── Ad Management ─────────────────────────────────────────────

    async def get_my_ads(self) -> list:
        """Get trader's active ads."""
        payload = {"page": 1, "rows": 20}
        result = await self._request("/c2c/adv/search", payload)
        return result.get("data", [])

    async def update_ad_price(self, ad_number: str, price: float) -> dict:
        """Update ad price."""
        payload = {"advNo": ad_number, "price": str(price)}
        result = await self._request("/c2c/adv/update", payload)
        logger.info(f"Updated ad {ad_number} price to {price}")
        return result

    async def toggle_ad(self, ad_number: str, enable: bool) -> dict:
        """Enable or disable an ad."""
        payload = {
            "advNo": ad_number,
            "advStatus": 1 if enable else 2,
        }
        result = await self._request("/c2c/adv/update-status", payload)
        return result

    # ── Order Review (for buy side) ───────────────────────────────

    async def get_order_review(self, order_number: str) -> dict:
        """Get order review status."""
        payload = {"orderNumber": order_number}
        result = await self._request("/c2c/order-match/order-review", payload)
        return result.get("data", {})

    # ── Session Validation ────────────────────────────────────────

    async def check_session(self) -> bool:
        """Check if the current session is still valid."""
        try:
            result = await self._request("/c2c/order-match/order-list", {
                "page": 1, "rows": 1, "tradeType": "SELL", "orderStatusList": [1]
            })
            return result.get("code") == "000000"
        except (BinanceSessionExpired, BinanceAPIError, Exception) as e:
            logger.warning(f"Session check failed: {e}")
            return False


class BinanceSessionExpired(Exception):
    """Raised when Binance session cookies have expired."""
    pass


class BinanceAPIError(Exception):
    """Raised when Binance returns an API error."""
    pass
