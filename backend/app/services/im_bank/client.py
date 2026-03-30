"""
I&M Bank Payment Gateway Client

Integrates with I&M Bank's Host-to-Host API for:
- WithinBankAccountTransfer (I&M to I&M) — FREE
- MpesaPayment (I&M to M-Pesa B2C/B2B) — KES 60
- PesalinkPayment (I&M to other banks) — KES 40-150
- QueryBalance (verify account name + balance)
- AccountStatement (reconciliation)

Security: OAuth 2.0 + RSA 2048 Checksum
Docs: I&M Payment Gateway Integration API Document v2
"""

import hashlib
import base64
import time
import logging
from typing import Optional
from datetime import datetime

import httpx
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend

from app.core.config import settings

logger = logging.getLogger(__name__)


class IMBankClient:
    """I&M Bank Payment Gateway API Client."""

    def __init__(self):
        # These will be set from environment/config once I&M provides them
        self.base_url = getattr(settings, 'IM_BANK_API_URL', '')  # e.g., https://api.imbank.com/KEPaymentGatewayService/1.0
        self.token_url = getattr(settings, 'IM_BANK_TOKEN_URL', '')  # e.g., https://api.imbank.com/KEOAuthTokenService/1.0/GetToken
        self.channel_id = getattr(settings, 'IM_BANK_CHANNEL_ID', '')
        self.client_id = getattr(settings, 'IM_BANK_CLIENT_ID', '')
        self.client_secret = getattr(settings, 'IM_BANK_CLIENT_SECRET', '')
        self.sender_account = getattr(settings, 'IM_BANK_SENDER_ACCOUNT', '')  # SparkP2P's I&M account
        self.sender_name = getattr(settings, 'IM_BANK_SENDER_NAME', 'SparkP2P')
        self.rsa_public_key = getattr(settings, 'IM_BANK_RSA_PUBLIC_KEY', '')  # Base64 RSA 2048 public key
        self.country_code = 'KE'

        self._access_token = None
        self._token_expires_at = 0

    # ═══════════════════════════════════════════════════════════
    # AUTHENTICATION
    # ═══════════════════════════════════════════════════════════

    async def _get_token(self) -> str:
        """Get OAuth 2.0 access token, refreshing if expired."""
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        async with httpx.AsyncClient(verify=False) as client:
            resp = await client.post(
                self.token_url,
                data={'grant_type': 'client_credentials'},
                auth=(self.client_id, self.client_secret),
            )
            resp.raise_for_status()
            data = resp.json()
            self._access_token = data['access_token']
            self._token_expires_at = time.time() + int(data.get('expires_in', 3600)) - 60
            logger.info('[I&M] OAuth token refreshed')
            return self._access_token

    # ═══════════════════════════════════════════════════════════
    # CHECKSUM
    # ═══════════════════════════════════════════════════════════

    def _generate_checksum(self, service_name: str, request_ref: str,
                           sender_account: str, amount: str, currency: str) -> str:
        """
        Generate RSA checksum for payment requests.
        Steps: concat fields → RSA encrypt → base64 encode → SHA-256 hex hash
        """
        if not self.rsa_public_key:
            return ''

        plain_text = f"{service_name}{self.channel_id}{request_ref}{sender_account}{amount}{currency}"

        try:
            # Decode the base64 public key
            pub_key_bytes = base64.b64decode(self.rsa_public_key)
            public_key = serialization.load_der_public_key(pub_key_bytes, backend=default_backend())

            # Encrypt with RSA/ECB/NoPadding
            encrypted = public_key.encrypt(
                plain_text.encode('utf-8'),
                padding.PKCS1v15()  # NoPadding equivalent in Python
            )

            # Base64 encode
            b64_encrypted = base64.b64encode(encrypted).decode('utf-8')

            # SHA-256 hex hash
            checksum = hashlib.sha256(b64_encrypted.encode('utf-8')).hexdigest()
            return checksum

        except Exception as e:
            logger.error(f'[I&M] Checksum generation failed: {e}')
            return ''

    def _generate_ref(self) -> str:
        """Generate 12-digit unique request reference number."""
        return datetime.now().strftime('%y%m%d%H%M%S')

    # ═══════════════════════════════════════════════════════════
    # API CALLS
    # ═══════════════════════════════════════════════════════════

    async def _make_payment(self, service_name: str, payload: dict,
                            amount: str, currency: str = 'KES') -> dict:
        """Generic payment request to I&M Payment Gateway."""
        token = await self._get_token()
        request_ref = self._generate_ref()
        checksum = self._generate_checksum(
            service_name, request_ref, self.sender_account, amount, currency
        )

        headers = {
            'serviceName': service_name,
            'initChannelID': self.channel_id,
            'requestRefNum': request_ref,
            'checksum': checksum,
            'countryCode': self.country_code,
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        }

        async with httpx.AsyncClient(verify=False, timeout=30) as client:
            resp = await client.post(
                f'{self.base_url}/MakePayment',
                headers=headers,
                json=payload,
            )

        result = resp.json()
        logger.info(f'[I&M] {service_name}: ref={request_ref}, code={result.get("responseCode")}, msg={result.get("responseMessage", "")[:80]}')
        return result

    async def _make_query(self, service_name: str, payload: dict) -> dict:
        """Generic query request to I&M Payment Gateway."""
        token = await self._get_token()
        request_ref = self._generate_ref()

        headers = {
            'serviceName': service_name,
            'initChannelID': self.channel_id,
            'requestRefNum': request_ref,
            'countryCode': self.country_code,
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        }

        async with httpx.AsyncClient(verify=False, timeout=30) as client:
            resp = await client.post(
                f'{self.base_url}/QueryService',
                headers=headers,
                json=payload,
            )

        return resp.json()

    # ═══════════════════════════════════════════════════════════
    # PAYMENT METHODS
    # ═══════════════════════════════════════════════════════════

    async def transfer_within_im(self, receiver_account: str, receiver_name: str,
                                  amount: float, narration: str = '') -> dict:
        """
        Transfer within I&M Bank accounts — FREE.
        Use for: Settling to trader's I&M account.
        """
        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'receiver': {
                'receiverAccountNo': receiver_account,
                'receiverAccountFullName': receiver_name,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P settlement',
                'eventID': 'FUND_TRF_WIB',
            },
        }
        return await self._make_payment('WithinBankAccountTransfer', payload, str(amount))

    async def send_to_mpesa(self, phone: str, amount: float,
                            narration: str = '') -> dict:
        """
        Send money to M-Pesa mobile wallet — KES 60.
        Use for: Buy-side (pay seller) or settlement to M-Pesa.
        """
        # Normalize phone
        if phone.startswith('07') or phone.startswith('01'):
            phone = '254' + phone[1:]

        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'MPESA_B2C',
            },
            'mobilemoneypayment': {
                'commandID': 'TransferFromBankToCustomer',
                'receiverPartyIdentifierType': '1',
                'receiverPartyIdentifier': phone,
            },
        }
        return await self._make_payment('MpesaPayment', payload, str(amount))

    async def send_to_paybill(self, paybill: str, account_ref: str,
                               amount: float, narration: str = '') -> dict:
        """
        Send money to M-Pesa Paybill — KES 60.
        Use for: Pay to paybill numbers.
        """
        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'MPESA_B2B_PAYBILL',
            },
            'mobilemoneypayment': {
                'commandID': 'FSItoPayBill',
                'receiverPartyIdentifierType': '4',
                'receiverPartyIdentifier': paybill,
                'receiverPartyAccountReference': account_ref,
            },
        }
        return await self._make_payment('MpesaPayment', payload, str(amount))

    async def send_to_till(self, till_number: str, amount: float,
                           narration: str = '') -> dict:
        """Send money to M-Pesa Till Number — KES 60."""
        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'MPESA_B2B_TILL',
            },
            'mobilemoneypayment': {
                'commandID': 'FSItoMerchant',
                'receiverPartyIdentifierType': '2',
                'receiverPartyIdentifier': till_number,
            },
        }
        return await self._make_payment('MpesaPayment', payload, str(amount))

    async def send_via_pesalink(self, receiver_account: str, receiver_name: str,
                                 bank_code: str, amount: float,
                                 narration: str = '', pay_to: str = 'ACCOUNT') -> dict:
        """
        Send via PesaLink to other banks — KES 40-150.
        pay_to: ACCOUNT, PHONE, or CARD
        """
        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'receiver': {
                'receiverAccountNo': receiver_account,
                'receiverAccountFullName': receiver_name,
                'receiverBankCode': bank_code,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'KITS_P2P_A2A',
            },
            'pesalinkpayment': {
                'payTo': pay_to,
            },
        }
        return await self._make_payment('PesalinkPayment', payload, str(amount))

    async def send_via_pesalink_phone(self, phone: str, receiver_name: str,
                                       bank_code: str, amount: float,
                                       narration: str = '') -> dict:
        """Send via PesaLink to phone number at another bank."""
        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'receiver': {
                'receiverAccountFullName': receiver_name,
                'receiverPhoneNo': phone,
                'receiverBankCode': bank_code,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'KITS_P2P_A2P',
            },
            'pesalinkpayment': {
                'payTo': 'PHONE',
            },
        }
        return await self._make_payment('PesalinkPayment', payload, str(amount))

    async def send_to_airtel(self, phone: str, amount: float,
                             narration: str = '') -> dict:
        """Send money to Airtel Money wallet."""
        if phone.startswith('07') or phone.startswith('01'):
            phone = '254' + phone[1:]

        payload = {
            'sender': {
                'senderAccountNo': self.sender_account,
                'senderName': self.sender_name,
            },
            'trandetails': {
                'transAmount': str(amount),
                'tranCCY': 'KES',
                'narration': narration or f'SparkP2P payment',
                'eventID': 'AIRTEL_B2C',
            },
            'mobilemoneypayment': {
                'commandID': 'TransferFromBankToCustomer',
                'receiverPartyIdentifierType': '1',
                'receiverPartyIdentifier': phone,
            },
        }
        return await self._make_payment('AirtelPayment', payload, str(amount))

    # ═══════════════════════════════════════════════════════════
    # QUERY METHODS
    # ═══════════════════════════════════════════════════════════

    async def query_balance(self, account_number: str = None) -> dict:
        """
        Query I&M account balance.
        Returns: accountName, availableBalance, ledgerBalance, etc.
        Use for: Verifying I&M account names during onboarding.
        """
        payload = {
            'accountNumber': account_number or self.sender_account,
        }
        return await self._make_query('QueryBalance', payload)

    async def verify_im_account(self, account_number: str) -> dict:
        """
        Verify an I&M Bank account — returns the account holder's name.
        Use for: Settlement verification (compare with Binance KYC name).
        """
        result = await self.query_balance(account_number)

        if result.get('responseCode') == 'SUCCESS':
            target = result.get('targetResponse', {})
            return {
                'valid': True,
                'account_name': target.get('accountName', ''),
                'account_number': target.get('accountNumber', ''),
                'status': target.get('accountStatus', ''),
                'currency': target.get('accountCurrencyCode', 'KES'),
                'available_balance': float(target.get('availableBalance', 0)),
            }
        else:
            return {
                'valid': False,
                'error': result.get('responseMessage', 'Invalid account'),
            }

    async def get_account_statement(self, account_number: str = None,
                                     from_date: str = None, to_date: str = None) -> dict:
        """
        Get account statement for reconciliation.
        Dates format: 2024-03-01T00:00:00.000
        """
        if not from_date:
            from datetime import timedelta
            today = datetime.now()
            from_date = (today - timedelta(days=30)).strftime('%Y-%m-%dT00:00:00.000')
        if not to_date:
            to_date = datetime.now().strftime('%Y-%m-%dT23:59:59.000')

        payload = {
            'accountNumber': account_number or self.sender_account,
            'fromDate': from_date,
            'uptoDate': to_date,
            'orderBy': 'D',
        }
        return await self._make_query('AccountStatement', payload)

    async def validate_mpesa_paybill(self, paybill: str) -> dict:
        """Validate M-Pesa Paybill or Till number."""
        payload = {
            'requestType': '4',  # 4=Paybill, 2=Till
            'referenceNumber': paybill,
        }
        return await self._make_query('MpesaQryOrganization', payload)

    async def pesalink_lookup(self, phone: str) -> dict:
        """Look up PesaLink registered banks for a phone number."""
        if phone.startswith('07') or phone.startswith('01'):
            phone = '254' + phone[1:]
        payload = {'mobileNumber': phone}
        return await self._make_query('PesalinkLookup', payload)

    # ═══════════════════════════════════════════════════════════
    # HIGH-LEVEL SETTLEMENT
    # ═══════════════════════════════════════════════════════════

    async def settle_to_trader(self, trader_settlement_method: str,
                                trader_account: str, trader_name: str,
                                amount: float, narration: str = '') -> dict:
        """
        Smart settlement — chooses the best payment method based on trader's config.

        Settlement fees (SparkP2P charges):
          KES 10,000 - 49,999 → KES 10
          KES 50,000 - 99,999 → KES 25
          KES 100,000+        → KES 50

        I&M costs:
          I&M to I&M → FREE
          I&M to M-Pesa → KES 60
          I&M to PesaLink → KES 40-150
        """
        narration = narration or f'SparkP2P settlement to {trader_name}'

        if trader_settlement_method == 'bank_paybill':
            # I&M to I&M transfer — FREE
            result = await self.transfer_within_im(
                receiver_account=trader_account,
                receiver_name=trader_name,
                amount=amount,
                narration=narration,
            )
        elif trader_settlement_method == 'mpesa':
            # I&M to M-Pesa — KES 60
            result = await self.send_to_mpesa(
                phone=trader_account,
                amount=amount,
                narration=narration,
            )
        else:
            logger.error(f'[I&M] Unknown settlement method: {trader_settlement_method}')
            return {'responseCode': 'FAILED', 'responseMessage': 'Unknown settlement method'}

        return result


# Singleton instance
im_bank_client = IMBankClient()
