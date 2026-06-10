from app.core.config import settings
import secrets
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.models.trader import Trader
from app.services.choice_bank import client as choice

router = APIRouter()

_token_store: dict = {}
TOKEN_TTL = 1800  # 30 minutes


def _make_token(trader_id: int) -> str:
    now = time.time()
    expired = [k for k, v in list(_token_store.items()) if v["exp"] < now]
    for k in expired:
        _token_store.pop(k, None)
    token = secrets.token_urlsafe(8)
    _token_store[token] = {"tid": trader_id, "exp": now + TOKEN_TTL}
    return token


def _decode_token(token: str) -> int:
    entry = _token_store.get(token)
    if not entry:
        raise HTTPException(400, "This link has expired or is invalid. Please request a new one from the SparkP2P app.")
    if time.time() > entry["exp"]:
        _token_store.pop(token, None)
        raise HTTPException(400, "This link expired (30-minute limit). Please open SparkP2P and click Set Up again.")
    return entry["tid"]


@router.post("/kyc/session")
async def create_kyc_session(trader: Trader = Depends(get_current_trader)):
    return {"token": _make_token(trader.id)}


@router.get("/kyc/validate/{token}")
async def validate_kyc_token(token: str, db: AsyncSession = Depends(get_db)):
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404, "Trader not found.")
    kyc_status = trader.choice_kyc_status or ""
    pending_onboarding_id = ""
    if kyc_status.startswith("pending:"):
        pending_onboarding_id = kyc_status.split(":", 1)[1]
    return {
        "verified": bool(trader.choice_account_id),
        "trader_id": trader.id,
        "full_name": trader.full_name,
        "phone": getattr(trader, "phone", "") or "",
        "account_number": trader.choice_account_number,
        "kyc_status": kyc_status,
        "pending_onboarding_id": pending_onboarding_id,
    }


class MobileKycBody(BaseModel):
    first_name: str
    last_name: str
    middle_name: str = ""
    mobile: str
    id_number: str
    birthday: str
    gender: int = 1
    email: str = ""
    address: str
    kra_pin: str
    employment_status: str
    monthly_income: str
    front_photo_b64: str
    back_photo_b64: str
    selfie_b64: str
    kra_cert_b64: str
    kra_cert_content_type: str = "image"  # "image" or "pdf"


@router.post("/kyc/submit/{token}")
async def submit_mobile_kyc(token: str, body: MobileKycBody, db: AsyncSession = Depends(get_db)):
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404, "Trader not found.")
    if trader.choice_account_id:
        return {"status": "already_verified", "account_number": trader.choice_account_number}

    result = await choice.create_current_account(
        user_id=str(tid),
        first_name=body.first_name,
        last_name=body.last_name,
        middle_name=body.middle_name,
        mobile=body.mobile,
        id_number=body.id_number,
        birthday=body.birthday,
        gender=body.gender,
        email=body.email,
        address=body.address,
        kra_pin=body.kra_pin,
        employment_status=body.employment_status,
        monthly_income=body.monthly_income,
    )
    if result.get("code") == "13203":
        raise HTTPException(400, "This ID is already registered with Choice Bank. Please contact SparkP2P support to resolve this.")
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "Onboarding request failed"))

    onboarding_id = (
        result.get("onboardingRequestId")
        or (result.get("data") or {}).get("onboardingRequestId")
        or ""
    )
    if not onboarding_id:
        raise HTTPException(500, "Choice Bank did not return an onboarding ID")

    # Persist the onboarding link IMMEDIATELY — BEFORE the media uploads — so a hiccup in any
    # upload can never lose it. (This was the bug: the save ran only AFTER all 4 uploads, so a
    # single failed upload left choice_kyc_status NULL while the onboarding already existed at
    # Choice — exactly why an approved KYC never reflected back.) The KYC poller relies on this
    # "pending:<id>" link to reconcile the approval later.
    trader.choice_kyc_status = "pending:" + onboarding_id
    await db.commit()

    for upload_args in [
        ("KYCF00001", body.front_photo_b64, "image"),
        ("KYCF00002", body.back_photo_b64, "image"),
        ("KYCF00006", body.selfie_b64, "image"),
        ("KYCF00009", body.kra_cert_b64, body.kra_cert_content_type),
    ]:
        media_type, b64, ct = upload_args
        upload_res = await choice.upload_kyc_media(onboarding_id, media_type, b64, ct)
        if upload_res.get("code") != "00000":
            raise HTTPException(400, "Failed to upload " + media_type + ": " + upload_res.get("msg", "Upload error"))

    otp_res = await choice.send_otp(onboarding_id)
    if otp_res.get("code") != "00000":
        raise HTTPException(400, "Documents submitted but OTP failed: " + otp_res.get("msg", "OTP error"))

    return {"onboardingRequestId": onboarding_id}


class OtpBody(BaseModel):
    onboarding_request_id: str
    otp: str


@router.post("/kyc/otp/{token}")
async def confirm_mobile_otp(token: str, body: OtpBody, db: AsyncSession = Depends(get_db)):
    _decode_token(token)
    result = await choice.confirm_otp(body.onboarding_request_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "OTP verification failed"))
    return {"status": "confirmed"}


@router.get("/kyc/poll/{token}/{onboarding_id}")
async def poll_mobile_kyc(token: str, onboarding_id: str, db: AsyncSession = Depends(get_db)):
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404)

    # getUserKyc returns numeric status codes (1-9); getOnboardingStatus does not
    kyc_result = await choice.get_user_kyc(onboarding_id)
    kyc_data = kyc_result.get("data") or kyc_result
    status = kyc_data.get("status")
    rejection_msg = kyc_data.get("rejectionReasonMsg") or kyc_data.get("rejectionReasonCode") or ""

    try:
        status_int = int(status) if status is not None else 0
    except (ValueError, TypeError):
        status_int = 0

    if status_int == 3:
        # Passed — fetch accountId from getOnboardingStatus (getUserKyc doesn't return it)
        status_result = await choice.get_onboarding_status(onboarding_id)
        status_data = status_result.get("data") or status_result
        aid = status_data.get("accountId") or ""
        # accountId is the account identifier used for transfers and is also the account number
        trader.choice_account_id = aid or onboarding_id  # fallback so we mark as approved
        trader.choice_account_number = aid
        trader.choice_kyc_status = "approved"
        await db.commit()
        # Notify trader via Telegram, email, and SMS
        try:
            from app.api.routes.telegram import notify_trader
            _tg = (
                "\U0001f389 Your Choice Bank account is approved!" + chr(10) +
                "Account ID: " + (aid or "—") + chr(10) +
                "Paybill: " + settings.CHOICE_BANK_PAYBILL + " | Account No: " + (aid or "—") + chr(10) +
                "You can now receive payments directly to your Choice Bank account."
            )
            await notify_trader(trader, _tg)
        except Exception as _e:
            logger.warning(f"[KYC] Approval Telegram notify failed: {_e}")
        try:
            from app.services.email import send_email
            _html = (
                "<h2>\U0001f389 Choice Bank Account Approved!</h2>"
                "<p>Hi " + (trader.full_name or "Trader") + ",</p>"
                "<p>Great news! Your <strong>Choice Bank account</strong> has been approved on SparkP2P.</p>"
                "<table style='border-collapse:collapse'>"
                "<tr><td style='padding:6px 12px;color:#6b7280'>Account ID</td>"
                "<td style='padding:6px 12px;font-weight:700'>" + (aid or "—") + "</td></tr>"
                "<tr><td style='padding:6px 12px;color:#6b7280'>Paybill</td>"
                "<td style='padding:6px 12px;font-weight:700'>" + settings.CHOICE_BANK_PAYBILL + "</td></tr>"
                "<tr><td style='padding:6px 12px;color:#6b7280'>Account No</td>"
                "<td style='padding:6px 12px;font-weight:700'>" + (aid or "—") + "</td></tr>"
                "</table>"
                "<p>You can now receive M-Pesa payments directly to your Choice Bank account.</p>"
                "<p>Log in to SparkP2P to view your account details.</p>"
            )
            await send_email(trader.email, "Choice Bank Account Approved — SparkP2P", _html)
        except Exception as _e:
            logger.warning(f"[KYC] Approval email failed: {_e}")
        try:
            from app.services.sms import send_otp_sms
            _sms = "SparkP2P: Choice Bank account approved! Acct: " + (aid or "N/A") + ". Paybill " + settings.CHOICE_BANK_PAYBILL + "."
            await send_otp_sms(trader.phone, _sms)
        except Exception as _e:
            logger.warning(f"[KYC] Approval SMS failed: {_e}")
        return {"status": status, "accountId": aid, "accountNumber": aid, "rejectionReasonMsg": ""}
    elif status_int == 4:
        rejection_msg = rejection_msg or kyc_data.get("profileCheckResultText") or "Application not approved."
        trader.choice_kyc_status = "rejected"
        await db.commit()
    elif status_int == 9:
        # Manual review — keep pending: prefix so user can resume polling after returning to page
        if not (trader.choice_kyc_status or "").startswith("pending:"):
            trader.choice_kyc_status = "pending:" + onboarding_id
            await db.commit()

    return {
        "status": status,
        "accountId": None,
        "accountNumber": None,
        "rejectionReasonMsg": rejection_msg,
    }
