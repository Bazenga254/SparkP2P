import hashlib
import logging
import secrets
import string
import time
import uuid

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


def _generate_salt(length: int = 11) -> str:
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def _flatten(obj, path="", pairs=None):
    """Recursively flatten a nested dict/list into (key, value) pairs for SHA-256 signing."""
    if pairs is None:
        pairs = []
    if isinstance(obj, dict):
        if not obj and path:
            pairs.append((path, "{}"))
            return pairs
        for k, v in obj.items():
            child = f"{path}.{k}" if path else k
            _flatten(v, child, pairs)
    elif isinstance(obj, list):
        if not obj and path:
            pairs.append((path, "[]"))
            return pairs
        for i, v in enumerate(obj):
            _flatten(v, f"{path}[{i}]", pairs)
    else:
        pairs.append((path, "" if obj is None else str(obj)))
    return pairs


def _sign(payload: dict) -> dict:
    """Inject salt + signature into a Choice Bank request payload (plain SHA-256)."""
    payload["salt"] = _generate_salt()
    payload["senderKey"] = settings.CHOICE_BANK_SENDER_KEY
    pairs = _flatten(payload)
    pairs.sort(key=lambda x: x[0])  # ASCII byte-value sort
    flat = "&".join(f"{k}={v}" for k, v in pairs)
    payload["signature"] = hashlib.sha256(flat.encode()).hexdigest()
    del payload["senderKey"]
    return payload


def _build_request(params: dict) -> dict:
    payload = {
        "requestId": uuid.uuid4().hex[:22],
        "sender": settings.CHOICE_BANK_SENDER_ID,
        "locale": "en_KE",
        "timestamp": int(time.time() * 1000),
        "params": params,
    }
    return _sign(payload)


async def _post(endpoint: str, params: dict) -> dict:
    url = f"{settings.CHOICE_BANK_BASE_URL}{endpoint}"
    body = _build_request(params)
    logger.info(f"[ChoiceBank] POST {endpoint} | requestId={body['requestId']}")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
        code = data.get("code", "")
        if code != "00000":
            logger.error(f"[ChoiceBank] Error {code}: {data.get('msg')} — {endpoint}")
        else:
            logger.info(f"[ChoiceBank] Success {endpoint}")
        return data


# ── Bank / Provider Codes ─────────────────────────────────────────────────────

async def get_bank_codes() -> dict:
    """Fetch all supported payment channel codes (run once to identify M-Pesa code)."""
    return await _post("/staticData/getBankCodes", {})


# ── OTP ───────────────────────────────────────────────────────────────────────

async def send_otp(mobile: str, onboarding_request_id: str = "") -> dict:
    """Send OTP to mobile. Provide onboardingRequestId when resending during onboarding."""
    params: dict = {"mobile": mobile}
    if onboarding_request_id:
        params["onboardingRequestId"] = onboarding_request_id
    return await _post("/common/sendOtp", params)


async def confirm_otp(onboarding_request_id: str, otp: str) -> dict:
    """Confirm OTP to proceed. Must be done within 30 minutes."""
    return await _post("/common/confirmOperation", {
        "onboardingRequestId": onboarding_request_id,
        "otp": otp,
    })


# ── Wallet Account Onboarding ─────────────────────────────────────────────────
# Limits: KES 20,000/day, KES 300,000 max holding.
# KYC: National ID front + back + selfie (base64).

async def create_wallet_account(
    user_id: str,
    first_name: str,
    last_name: str,
    mobile: str,
    id_number: str,
    birthday: str,          # yyyy-mm-dd
    gender: int,            # 0=female, 1=male
    front_photo_b64: str,   # National ID front, base64
    back_photo_b64: str,    # National ID back, base64
    selfie_b64: str,        # Selfie photo, base64
    middle_name: str = "",
    email: str = "",
    address: str = "",
    id_type: str = "101",   # 101=National ID, 102=Alien ID, 103=Passport
) -> dict:
    """
    Step 1 of wallet onboarding. Returns onboardingRequestId on success.
    Follow with send_otp() → confirm_otp() → poll get_onboarding_status().
    """
    return await _post("/onboarding/v3/submitEasyOnboardingRequest", {
        "userId":         user_id,
        "firstName":      first_name,
        "middleName":     middle_name,
        "lastName":       last_name,
        "birthday":       birthday,
        "gender":         gender,
        "countryCode":    "KE",
        "mobile":         mobile,
        "idType":         id_type,
        "idNumber":       id_number,
        "address":        address,
        "email":          email,
        "frontSidePhoto": front_photo_b64,
        "backSidePhoto":  back_photo_b64,
        "selfiePhoto":    selfie_b64,
    })


# ── Current Account Onboarding ────────────────────────────────────────────────
# No transaction limits (standard channel limits apply).
# KYC: same as wallet + KRA PIN certificate + Smile ID-verified selfie.

async def create_current_account(
    user_id: str,
    first_name: str,
    last_name: str,
    mobile: str,
    id_number: str,
    birthday: str,
    gender: int,
    kra_pin: str,
    employment_status: str,
    monthly_income: str,
    middle_name: str = "",
    email: str = "",
    address: str = "",
    id_type: str = "101",
) -> dict:
    """
    Step 1 of current account onboarding. Returns onboardingRequestId.
    Follow with upload_kyc_media() for each document, then send_otp() → confirm_otp()
    → poll get_onboarding_status().
    Note: selfie must be captured via Smile ID SDK on the frontend before calling this.
    """
    return await _post("/onboarding/submitOnboardingRequest", {
        "userId":           user_id,
        "firstName":        first_name,
        "middleName":       middle_name,
        "lastName":         last_name,
        "birthday":         birthday,
        "gender":           gender,
        "countryCode":      "KE",
        "mobile":           mobile,
        "idType":           id_type,
        "idNumber":         id_number,
        "address":          address,
        "email":            email,
        "kraPin":           kra_pin,
        "employmentStatus": employment_status,
        "monthlyIncome":    monthly_income,
    })


async def upload_kyc_media(
    onboarding_request_id: str,
    media_type: str,        # e.g. KYCF00001=ID front, KYCF00002=ID back, KYCF00006=selfie
    media_b64: str,
    content_type: str = "image",
) -> dict:
    """Upload a KYC document for current account onboarding."""
    return await _post("/onboarding/uploadMedia", {
        "onboardingRequestId": onboarding_request_id,
        "mediaType":           media_type,
        "mediaBase64":         media_b64,
        "contentType":         content_type,
    })


async def get_onboarding_status(onboarding_request_id: str) -> dict:
    """
    Poll until status=3 (active) or status=7.
    Response data includes accountId and accountNumber once approved.
    Typically 1-2 minutes; worst case 24 hours for KYC-flagged cases.
    """
    return await _post("/onboarding/getOnboardingStatus", {
        "onboardingRequestId": onboarding_request_id,
    })


# ── Account Queries ───────────────────────────────────────────────────────────

async def get_account_details(account_id: str) -> dict:
    """Get balance, status, short code and details for a sub-account."""
    return await _post("/query/getAccountDetails", {
        "accountId": account_id,
    })


# ── Transfers ─────────────────────────────────────────────────────────────────


async def transfer(
    payer_account_id: str,
    payee_account_id: str,      # Phone number for B2C, account number for internal
    amount: float,
    payee_bank_code: str = "",  # Leave empty for internal Choice-to-Choice transfers
    payee_name: str = "",
    payment_purpose: str = "",
    remark: str = "",
    notify_mobile: str = "",    # Send SMS receipt to payee at this number
) -> dict:
    """
    Universal transfer — covers M-Pesa B2C, Airtel Money, internal, and PesaLink.
    payee_bank_code: fetch valid codes from get_bank_codes().
    For M-Pesa B2C, payeeAccountId = 9-digit phone number (no 254/0 prefix).
    """
    params: dict = {
        "payerAccountId": payer_account_id,
        "payeeAccountId": payee_account_id,
        "currency":       "KES",
        "amount":         str(round(amount, 2)),
        "remark":         remark or "SparkP2P payment",
    }
    if payee_bank_code:
        params["payeeBankCode"] = payee_bank_code
    if payee_name:
        params["payeeAccountName"] = payee_name
    if payment_purpose:
        params["paymentPurpose"] = payment_purpose
    if notify_mobile:
        params["payeeMobileForNotification"] = notify_mobile
    return await _post("/trans/v2/applyForTransfer", params)
