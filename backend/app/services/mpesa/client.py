import base64
import logging
from datetime import datetime

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class MpesaClient:
    """Daraja API client for M-Pesa C2B, B2C, and B2B transactions."""

    def __init__(self):
        self.base_url = settings.mpesa_base_url
        self.consumer_key = settings.MPESA_CONSUMER_KEY
        self.consumer_secret = settings.MPESA_CONSUMER_SECRET
        self.shortcode = settings.MPESA_SHORTCODE
        self.passkey = settings.MPESA_PASSKEY
        self.initiator_name = settings.MPESA_INITIATOR_NAME
        self.security_credential = settings.MPESA_SECURITY_CREDENTIAL
        self.callback_base = settings.MPESA_CALLBACK_BASE_URL
        self._access_token = None
        self._token_expiry = None

    async def _get_access_token(self) -> str:
        """Get OAuth access token from Daraja."""
        if self._access_token and self._token_expiry and datetime.now() < self._token_expiry:
            return self._access_token

        credentials = base64.b64encode(
            f"{self.consumer_key}:{self.consumer_secret}".encode()
        ).decode()

        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/oauth/v1/generate?grant_type=client_credentials",
                headers={"Authorization": f"Basic {credentials}"},
            )
            response.raise_for_status()
            data = response.json()
            self._access_token = data["access_token"]
            # Token expires in ~3600s, refresh at 3000s
            from datetime import timedelta
            self._token_expiry = datetime.now() + timedelta(seconds=3000)
            return self._access_token

    async def _make_request(self, endpoint: str, payload: dict) -> dict:
        """Make authenticated request to Daraja API."""
        token = await self._get_access_token()
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}{endpoint}",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
            data = response.json()
            if response.status_code >= 400:
                logger.error(f"Daraja API error: {response.status_code} - {data}")
                raise Exception(f"Daraja {response.status_code}: {data}")
            return data

    # ── C2B Registration ──────────────────────────────────────────

    async def register_c2b_urls(self):
        """Register C2B confirmation and validation URLs."""
        payload = {
            "ShortCode": self.shortcode,
            "ResponseType": "Completed",
            "ConfirmationURL": f"{self.callback_base}/api/payment/c2b/confirm",
            "ValidationURL": f"{self.callback_base}/api/payment/c2b/validate",
        }
        result = await self._make_request(
            "/mpesa/c2b/v1/registerurl", payload
        )
        logger.info(f"C2B URLs registered: {result}")
        return result

    # ── C2B Simulation (Sandbox only) ──────────────────────────────

    async def simulate_c2b(
        self,
        amount: float,
        account_reference: str,
        phone: str = "254708374149",
    ) -> dict:
        """Simulate a C2B payment in sandbox environment."""
        payload = {
            "ShortCode": self.shortcode,
            "CommandID": "CustomerPayBillOnline",
            "Amount": str(int(amount)),
            "Msisdn": phone,
            "BillRefNumber": account_reference,
        }
        result = await self._make_request("/mpesa/c2b/v1/simulate", payload)
        logger.info(f"C2B Simulation: {result}")
        return result

    # ── B2C (Paybill → M-Pesa) ────────────────────────────────────

    async def send_b2c(
        self,
        phone: str,
        amount: float,
        remarks: str = "",
        occasion: str = "",
    ) -> dict:
        """Send money from Paybill to M-Pesa number (B2C)."""
        payload = {
            "InitiatorName": self.initiator_name,
            "SecurityCredential": self.security_credential,
            "CommandID": "BusinessPayment",
            "Amount": str(int(amount)),
            "PartyA": self.shortcode,
            "PartyB": self._format_phone(phone),
            "Remarks": remarks[:100],  # Max 100 chars
            "QueueTimeOutURL": f"{self.callback_base}/api/payment/b2c/timeout",
            "ResultURL": f"{self.callback_base}/api/payment/b2c/result",
            "Occasion": occasion[:100],
        }
        result = await self._make_request("/mpesa/b2c/v3/paymentrequest", payload)
        logger.info(f"B2C sent: {amount} to {phone} - {result}")
        return result

    # ── B2B (Paybill → Paybill/Till) ──────────────────────────────

    async def send_b2b(
        self,
        receiver_shortcode: str,
        amount: float,
        account_number: str = "",
        remarks: str = "",
        command_id: str = "BusinessPayBill",  # or "BusinessBuyGoods"
    ) -> dict:
        """Send money from Paybill to another Paybill/Till (B2B)."""
        payload = {
            "Initiator": self.initiator_name,
            "SecurityCredential": self.security_credential,
            "CommandID": command_id,
            "SenderIdentifierType": "4",  # Paybill
            "RecieverIdentifierType": "4",  # Paybill (use "2" for Till)
            "Amount": str(int(amount)),
            "PartyA": self.shortcode,
            "PartyB": receiver_shortcode,
            "AccountReference": account_number,
            "Remarks": remarks[:100],
            "QueueTimeOutURL": f"{self.callback_base}/api/payment/b2b/timeout",
            "ResultURL": f"{self.callback_base}/api/payment/b2b/result",
        }

        # If sending to a Till (Buy Goods), adjust identifiers
        if command_id == "BusinessBuyGoods":
            payload["RecieverIdentifierType"] = "2"

        result = await self._make_request("/mpesa/b2b/v1/paymentrequest", payload)
        logger.info(f"B2B sent: {amount} to {receiver_shortcode} acc:{account_number} - {result}")
        return result

    # ── STK Push (for future use) ─────────────────────────────────

    async def stk_push(
        self,
        phone: str,
        amount: float,
        account_reference: str,
        description: str = "Payment",
    ) -> dict:
        """Initiate STK push to customer's phone."""
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        password = base64.b64encode(
            f"{self.shortcode}{self.passkey}{timestamp}".encode()
        ).decode()

        payload = {
            "BusinessShortCode": self.shortcode,
            "Password": password,
            "Timestamp": timestamp,
            "TransactionType": "CustomerPayBillOnline",
            "Amount": str(int(amount)),
            "PartyA": self._format_phone(phone),
            "PartyB": self.shortcode,
            "PhoneNumber": self._format_phone(phone),
            "CallBackURL": f"{self.callback_base}/api/payment/stkpush/callback",
            "AccountReference": account_reference,
            "TransactionDesc": description[:20],
        }
        result = await self._make_request(
            "/mpesa/stkpush/v1/processrequest", payload
        )
        logger.info(f"STK Push sent to {phone}: {result}")
        return result

    # ── Transaction Status Query ──────────────────────────────────

    async def query_transaction(self, transaction_id: str) -> dict:
        """Query the status of an M-Pesa transaction."""
        payload = {
            "Initiator": self.initiator_name,
            "SecurityCredential": self.security_credential,
            "CommandID": "TransactionStatusQuery",
            "TransactionID": transaction_id,
            "PartyA": self.shortcode,
            "IdentifierType": "4",
            "ResultURL": f"{self.callback_base}/api/payment/status/result",
            "QueueTimeOutURL": f"{self.callback_base}/api/payment/status/timeout",
            "Remarks": "Status check",
        }
        return await self._make_request(
            "/mpesa/transactionstatus/v1/query", payload
        )

    @staticmethod
    def _format_phone(phone: str) -> str:
        """Format phone number to 254XXXXXXXXX format."""
        phone = phone.strip().replace(" ", "").replace("+", "")
        if phone.startswith("0"):
            phone = "254" + phone[1:]
        elif not phone.startswith("254"):
            phone = "254" + phone
        return phone


# Singleton
mpesa_client = MpesaClient()
