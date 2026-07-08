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
    async with httpx.AsyncClient(timeout=30, verify=False) as client:
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

async def send_otp(business_id: str, otp_type: str = "SMS") -> dict:
    """Trigger an OTP for an operation (txId / onboardingRequestId). otpType ("SMS"|"EMAIL") selects
    the channel AND verifies it — sending EMAIL during onboarding is what marks the registered email
    as verified, which a later transaction's sendOtp(EMAIL) requires."""
    return await _post("/common/sendOtp", {
        "businessId": business_id,
        "otpType": otp_type,
    })


async def resend_otp(business_id: str, otp_type: str = "SMS") -> dict:
    """Re-send an OTP if the first didn't arrive (onboarding / account / transaction operations)."""
    return await _post("/common/resendOtp", {
        "businessId": business_id,
        "otpType": otp_type,
    })


async def confirm_otp(business_id: str, otp: str) -> dict:
    """Confirm an OTP. businessId is the txId / onboardingRequestId / applicationId the OTP was for."""
    return await _post("/common/confirmOperation", {
        "businessId": business_id,
        "otpCode": otp,
    })


async def close_individual_account(account_id: str, closure_reason="9", otp_type: str = "sms") -> dict:
    """Close a BaaS Wallet/Current account. An OTP validates the request; then Choice staff manually
    review/approve (result via callback). Returns { applicationId } — confirm the OTP against it.
    Closing the customer's LAST account sets onboarding to ACCOUNT_CLOSED, enabling a fresh KYC reopen.
    NOTE: closureReason must be an ARRAY of reason CODES ('1'..'10', e.g. 9 = 'similar account /
    opening a similar account'), and otpType must be lowercase ('sms'/'email')."""
    reasons = closure_reason if isinstance(closure_reason, list) else [str(closure_reason)]
    return await _post("/account/closeIndividualAccount", {
        "accountId":     account_id,
        "closureReason": reasons,
        "otpType":       (otp_type or "sms").lower(),
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
        "countryCode":    "254",
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
        "countryCode":      "254",
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
    Returns onboardingStatus (string) + accountId on approval.
    Does NOT contain a numeric status field — use get_user_kyc() for numeric status.
    """
    return await _post("/onboarding/getOnboardingStatus", {
        "onboardingRequestId": onboarding_request_id,
    })


async def get_user_kyc(onboarding_request_id: str) -> dict:
    """
    Returns numeric status: 1-Submitted, 2-Processing, 3-Passed, 4-Rejected,
    5-Account Closed, 9-Manual Reviewing.
    Does NOT return accountId — call get_onboarding_status() separately for that.
    """
    return await _post("/onboarding/getUserKyc", {
        "onboardingRequestId": onboarding_request_id,
    })


# ── Account Queries ───────────────────────────────────────────────────────────

async def validate_account(account_id: str, bank_code: str) -> dict:
    """Verify a Pesalink beneficiary and return their registered account name.
    accountType=4 (int) -> Pesalink external bank. bankCode is the CBK 2-digit code.
    Response data.accountName contains the verified name on success.
    Retries up to 2 times on transient 10001 busy errors.
    """
    import asyncio as _asyncio
    params = {"accountId": account_id, "accountType": 4, "bankCode": bank_code}
    for attempt in range(2):
        result = await _post("/account/validateAccount", params)
        if result.get("code") != "10001":
            return result
        if attempt < 1:
            await _asyncio.sleep(0.8)
    return result


async def get_account_details(account_id: str) -> dict:
    """Get balance, status, short code and details for a sub-account."""
    return await _post("/query/getAccountDetails", {
        "accountId": account_id,
    })


async def get_transaction_list(
    account_id: str,
    tx_types: list = None,
    tx_status: list = None,
    start_ms: int = None,
    end_ms: int = None,
    page_no: int = 1,
    page_size: int = 30,
    order_by_desc: int = 1,
) -> dict:
    """/query/getTransList — list transactions for a sub-account (active polling of
    incoming payments, independent of the push webhook). Each row includes
    oppoAccountName (sender name), amount, txType, txStatus (8=success), createTime.
    Defaults: last 2 hours, success only, newest first."""
    import time as _time
    now_ms = int(_time.time() * 1000)
    return await _post("/query/getTransList", {
        "accountId": account_id,
        "txType": tx_types if tx_types is not None else [],
        "txStatus": tx_status if tx_status is not None else [8],
        "startTime": start_ms if start_ms is not None else (now_ms - 2 * 60 * 60 * 1000),
        "endTime": end_ms if end_ms is not None else now_ms,
        "pageNo": page_no,
        "pageSize": page_size,
        "orderByDesc": order_by_desc,
    })


async def verify_email_address(
    document_number: str,
    personal_id_type: str = "101",  # 101=National ID, 102=Alien ID, 103=Passport
    onboard_type: str = "personal",
) -> dict:
    """Send an OTP to the email linked to this account for verification.
    Uses /account/verifyEmailOrMobile (not /account/verifyEmailAddress which returns 500
    for existing accounts). Returns { applicationId } — confirm via confirm_otp()."""
    params = {
        "onboardType": onboard_type,
        "documentNumber": document_number,
        "verifyType": "email",
    }
    if onboard_type == "personal":
        params["personalIdType"] = personal_id_type
    return await _post("/account/verifyEmailOrMobile", params)


async def verify_mobile_number(
    document_number: str,
    personal_id_type: str = "101",
    onboard_type: str = "personal",
) -> dict:
    """Send an OTP to the mobile linked to this account for verification.
    Returns { applicationId } — confirm via confirm_contact_verify()."""
    params = {
        "onboardType": onboard_type,
        "documentNumber": document_number,
        "verifyType": "mobile",
    }
    if onboard_type == "personal":
        params["personalIdType"] = personal_id_type
    return await _post("/account/verifyEmailOrMobile", params)


async def confirm_contact_verify(application_id: str, otp: str) -> dict:
    """Confirm the OTP sent by verifyEmailOrMobile / verifyEmailAddress."""
    return await _post("/common/confirmOtp", {
        "businessId": application_id,
        "otpCode": otp,
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
        "amount":         f"{float(amount):.2f}",
        "remark":         remark or "Spark payment",
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


async def mpesa_business_transfer(
    payer_account_id: str,
    business_number: str,         # M-Pesa Paybill or Till/BuyGoods number (payeeShortCode)
    amount: float,
    account_number: str = "",     # payeeReferenceNumber — required for Paybill, omitted for Till
    is_paybill: bool = True,      # payType: True->0 (Paybill), False->1 (Till / Buy Goods)
    remark: str = "",
) -> dict:
    """M-Pesa Paybill / Till (B2B) — TTID0005 via /trans/v2/applyForMpesaBusinessTransfer.
    Follow with send_otp(txId) -> confirm_otp(txId, otp), then poll getTransResult.
    Fields per Choice Bank API Details: payerAccountId, payeeShortCode, payType (0=Paybill,
    1=Till/BuyGoods), payeeReferenceNumber (account number when payType=0), amount (KES),
    description (message to beneficiary, ≤100 chars). Returns { txId } on code 00000."""
    params: dict = {
        "payerAccountId": payer_account_id,
        "payeeShortCode": business_number,
        "payType":        0 if is_paybill else 1,
        "amount":         round(float(amount), 2),
    }
    if is_paybill and account_number:
        params["payeeReferenceNumber"] = account_number
    if remark:
        params["description"] = remark[:100]
    return await _post("/trans/v2/applyForMpesaBusinessTransfer", params)


async def large_domestic_interbank_transfer(
    payer_account_id:    str,
    beneficiary_bank_code: str,
    beneficiary_bank_name: str,
    beneficiary_account_id: str,
    beneficiary_name:    str,
    amount:              float,
    payment_channel:     str = "RTGS",   # "RTGS" (instant) or "EFT" (T+1 batch)
    payment_purpose_id:  str = "OTHR",
    payment_purpose:     str = "Spark withdrawal",
    sender_address:      str = "Nairobi, Kenya",
    message_to_beneficiary: str = "",
    beneficiary_email:   str = "",
) -> dict:
    """Initiate a domestic interbank transfer via RTGS or EFT.
    RTGS is real-time and has no upper-limit. EFT is T+1 batch.
    Returns { applicationId } on success — use get_interbank_transfer_status() to poll.
    """
    params: dict = {
        "accountId":            payer_account_id,
        "beneficiaryBankCode":  beneficiary_bank_code,
        "beneficiaryBankName":  beneficiary_bank_name,
        "beneficiaryAccountId": beneficiary_account_id,
        "beneficiaryAccountCcy": "KES",
        "beneficiaryName":      beneficiary_name,
        "amount":               round(amount, 2),
        "amountType":           0,
        "paymentChannel":       payment_channel,
        "paymentPurposeId":     payment_purpose_id,
        "senderAddress":        sender_address,
    }
    if payment_purpose_id == "OTHR" and payment_purpose:
        params["paymentPurpose"] = payment_purpose[:35]
    if message_to_beneficiary:
        params["messageToBeneficiary"] = message_to_beneficiary[:100]
    if beneficiary_email:
        params["beneficiaryEmail"] = beneficiary_email
    return await _post("/trans/largeDomesticInterBankTransfer", params)


async def get_interbank_transfer_status(application_id: str) -> dict:
    """Poll the status of a large domestic interbank transfer by applicationId."""
    return await _post("/trans/getInterBankTransferDetails", {
        "applicationId": application_id,
    })


async def deposit_from_mpesa(account_id: str, mobile: str, amount: int) -> dict:
    """Trigger an M-Pesa STK push to deposit into a Choice Bank account."""
    return await _post("/trans/depositFromMpesa", {
        "accountId": account_id,
        "mobile": mobile,
        "amount": amount,
    })

async def batch_disburse(
    payer_account_id: str,
    payee_account_id: str,
    payee_account_name: str,
    payee_bank_code: str,
    amount: float,
    remark: str = "",
    org_tx_id: str = "",
    payment_purpose: str = "",
    notify_mobile: str = "",
) -> dict:
    """
    Merchant Bulk Transfer — no OTP required (payer must be whitelisted merchant account).
    Sends funds from a Choice Bank merchant account to any external bank via Pesalink.
    Result delivered via webhook callback 0004.
    payeeBankCode: from Choice BaaS Bank Code List (CBK codes used for Pesalink).
    """
    beneficiary: dict = {
        "payeeAccountName": payee_account_name,
        "payeeAccountId":   payee_account_id,
        "payeeBankCode":    str(payee_bank_code),
        "currency":         "KES",
        "amount":           f"{float(amount):.2f}",
        "remark":           remark or "Spark payment",
    }
    if org_tx_id:
        beneficiary["orgTxId"] = org_tx_id
    if payment_purpose:
        beneficiary["paymentPurpose"] = payment_purpose
    if notify_mobile:
        beneficiary["payeeMobileForNotification"] = notify_mobile

    params = {
        "payerAccountId":   payer_account_id,
        "beneficiaryArray": [beneficiary],
    }
    return await _post("/trans/batchTransitionalFundsDisbursement", params)


async def query_batch_transfer(order_id: str) -> dict:
    """Query the result of a merchant bulk transfer by the orderId returned from batch_disburse."""
    return await _post("/trans/getInternalBatchTransactionResult", {"orderId": order_id})

