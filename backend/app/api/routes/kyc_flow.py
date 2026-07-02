from app.core.config import settings
import secrets
import time
import logging

logger = logging.getLogger(__name__)
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.models.trader import Trader
from app.models.kyc_submission import KycSubmission
from app.services.choice_bank import client as choice

router = APIRouter()

_token_store: dict = {}
TOKEN_TTL = 1800  # 30 minutes


def _pdf_to_jpeg_b64(pdf_b64: str) -> str:
    """Render the first page of a base64 PDF to a base64 JPEG. Choice Bank production onboarding
    rejects PDF media, so KRA certs uploaded as PDF are flattened to an image here."""
    import base64
    import fitz  # PyMuPDF
    raw = base64.b64decode(pdf_b64)
    doc = fitz.open(stream=raw, filetype="pdf")
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2))
    return base64.b64encode(pix.tobytes("jpeg")).decode()


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

    # Staging flow: submission is in our DB, pending/rejected by admin
    if kyc_status.startswith("staging:") or kyc_status.startswith("rejected_admin:"):
        result = await db.execute(
            select(KycSubmission)
            .where(KycSubmission.trader_id == tid)
            .order_by(KycSubmission.created_at.desc())
            .limit(1)
        )
        sub = result.scalar_one_or_none()
        sub_status = sub.status if sub else "pending_review"
        onboarding_id = (sub.choice_onboarding_id or "") if sub else ""
        admin_notes = (sub.admin_notes or "") if sub else ""
        if kyc_status.startswith("rejected_admin:"):
            sub_status = "rejected"
        return {
            "verified": False,
            "trader_id": tid,
            "full_name": trader.full_name,
            "phone": getattr(trader, "phone", "") or "",
            "account_number": trader.choice_account_number,
            "kyc_status": kyc_status,
            "pending_onboarding_id": onboarding_id,
            "submission_status": sub_status,
            "admin_notes": admin_notes,
        }

    # Original flow: pending:ONBRD... = submitted to Choice Bank
    pending_onboarding_id = ""
    if kyc_status.startswith("pending:"):
        pending_onboarding_id = kyc_status.split(":", 1)[1]
    return {
        "verified": bool(trader.choice_account_id),
        "trader_id": tid,
        "full_name": trader.full_name,
        "phone": getattr(trader, "phone", "") or "",
        "account_number": trader.choice_account_number,
        "kyc_status": kyc_status,
        "pending_onboarding_id": pending_onboarding_id,
        "submission_status": "",
        "admin_notes": "",
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
    front_photo_b64: str = ""
    back_photo_b64: str = ""
    selfie_b64: str = ""
    kra_cert_b64: str = ""
    kra_cert_content_type: str = "image"


@router.post("/kyc/submit/{token}")
async def submit_mobile_kyc(token: str, body: MobileKycBody, db: AsyncSession = Depends(get_db)):
    """Save KYC data + images to our staging DB for admin review.
    Nothing is sent to Choice Bank until an admin explicitly approves."""
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404, "Trader not found.")
    if trader.choice_account_id:
        return {"status": "already_verified", "account_number": trader.choice_account_number}

    _email = (body.email or "").strip()
    if not _email or "@" not in _email or "." not in _email.split("@")[-1]:
        raise HTTPException(400, "A valid email address is required — use the same email as your Binance account.")

    sub = KycSubmission(
        trader_id=tid,
        status="pending_review",
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
        front_photo_b64=body.front_photo_b64 or None,
        back_photo_b64=body.back_photo_b64 or None,
        selfie_b64=body.selfie_b64 or None,
        kra_cert_b64=body.kra_cert_b64 or None,
        kra_cert_content_type=body.kra_cert_content_type,
    )
    db.add(sub)
    trader.choice_kyc_status = "staging:pending_review"
    await db.commit()
    await db.refresh(sub)
    logger.warning(f"[KYC] Staging submission created: trader={tid} ({trader.full_name}) sub_id={sub.id}")

    try:
        from app.api.routes.telegram import notify_admin
        await notify_admin(
            f"\U0001f4cb New KYC submission from {trader.full_name} (trader #{tid}) — review in Admin → KYC tab."
        )
    except Exception as _e:
        logger.warning(f"[KYC] Admin Telegram notify failed: {_e}")

    return {"status": "pending_review", "submission_id": sub.id}


class OtpBody(BaseModel):
    onboarding_request_id: str
    otp: str


@router.post("/kyc/otp/{token}")
async def confirm_mobile_otp(token: str, body: OtpBody, db: AsyncSession = Depends(get_db)):
    """Confirm Choice Bank email OTP. For staged submissions, also uploads images from our DB
    so the trader goes straight to polling without a separate upload step."""
    tid = _decode_token(token)
    result = await choice.confirm_otp(body.onboarding_request_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "OTP verification failed"))

    # Look for a staged submission that has the images
    sub_result = await db.execute(
        select(KycSubmission)
        .where(KycSubmission.trader_id == tid)
        .where(KycSubmission.choice_onboarding_id == body.onboarding_request_id)
        .limit(1)
    )
    sub = sub_result.scalar_one_or_none()

    if sub and sub.front_photo_b64:
        logger.warning(f"[KYC] uploading from staging sub={sub.id} oid={body.onboarding_request_id}")
        for media_type, b64 in [
            ("KYCF00001", sub.front_photo_b64),
            ("KYCF00002", sub.back_photo_b64),
            ("KYCF00006", sub.selfie_b64),
        ]:
            if not b64:
                continue
            upload_res = await choice.upload_kyc_media(body.onboarding_request_id, media_type, b64, "image")
            logger.warning(f"[KYC] staging upload {media_type} -> code={upload_res.get('code')} msg={upload_res.get('msg') or upload_res.get('message')}")
            if upload_res.get("code") != "00000":
                raise HTTPException(400, f"Failed to upload {media_type}: " + upload_res.get("msg", "Upload error"))

        sub.status = "submitted"
        trader = await db.get(Trader, tid)
        if trader:
            trader.choice_kyc_status = "pending:" + body.onboarding_request_id
        await db.commit()
        return {"status": "submitted", "onboarding_id": body.onboarding_request_id}

    # Legacy path: no staged submission — frontend will call upload-docs separately
    return {"status": "confirmed"}


class ResendOtpBody(BaseModel):
    onboarding_request_id: str


@router.post("/kyc/resend-otp/{token}")
async def resend_kyc_otp(token: str, body: ResendOtpBody):
    _decode_token(token)
    email_res = await choice.resend_otp(body.onboarding_request_id, "EMAIL")
    sms_res = await choice.resend_otp(body.onboarding_request_id, "SMS")
    if email_res.get("code") != "00000" and sms_res.get("code") != "00000":
        raise HTTPException(400, email_res.get("msg") or sms_res.get("msg", "Could not resend OTP"))
    return {"status": "sent", "channel": "both"}


class UploadDocsBody(BaseModel):
    onboarding_request_id: str
    front_photo_b64: str
    back_photo_b64: str
    selfie_b64: str


@router.post("/kyc/upload-docs/{token}")
async def upload_kyc_docs(token: str, body: UploadDocsBody, db: AsyncSession = Depends(get_db)):
    """Legacy path: upload ID photos after OTP confirm. Staged submissions skip this — images are
    uploaded in confirm_mobile_otp from the DB. This endpoint stays for the legacy non-staged path."""
    _decode_token(token)
    oid = body.onboarding_request_id
    sizes = {
        "KYCF00001": len(body.front_photo_b64),
        "KYCF00002": len(body.back_photo_b64),
        "KYCF00006": len(body.selfie_b64),
    }
    logger.warning(f"[KYC] upload-docs {oid} b64_sizes={sizes}")
    for media_type, b64 in [
        ("KYCF00001", body.front_photo_b64),
        ("KYCF00002", body.back_photo_b64),
        ("KYCF00006", body.selfie_b64),
    ]:
        upload_res = await choice.upload_kyc_media(oid, media_type, b64, "image")
        logger.warning(f"[KYC] upload-docs {oid} {media_type} -> code={upload_res.get('code')} msg={upload_res.get('msg') or upload_res.get('message')}")
        if upload_res.get("code") != "00000":
            raise HTTPException(400, "Failed to upload " + media_type + ": " + upload_res.get("msg", "Upload error"))
    return {"status": "uploaded"}


@router.get("/kyc/poll/{token}/{onboarding_id}")
async def poll_mobile_kyc(token: str, onboarding_id: str, db: AsyncSession = Depends(get_db)):
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404)

    kyc_result = await choice.get_user_kyc(onboarding_id)
    kyc_data = kyc_result.get("data") or kyc_result
    status = kyc_data.get("status")
    rejection_msg = kyc_data.get("rejectionReasonMsg") or kyc_data.get("rejectionReasonCode") or ""

    try:
        status_int = int(status) if status is not None else 0
    except (ValueError, TypeError):
        status_int = 0

    if status_int == 3:
        status_result = await choice.get_onboarding_status(onboarding_id)
        status_data = status_result.get("data") or status_result
        aid = status_data.get("accountId") or ""
        trader.choice_account_id = aid or onboarding_id
        trader.choice_account_number = aid
        trader.choice_kyc_status = "approved"
        await db.commit()
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
        if not (trader.choice_kyc_status or "").startswith("pending:"):
            trader.choice_kyc_status = "pending:" + onboarding_id
            await db.commit()

    return {
        "status": status,
        "accountId": None,
        "accountNumber": None,
        "rejectionReasonMsg": rejection_msg,
    }
