import secrets
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.core.config import settings
from app.models.trader import Trader
from app.services.choice_bank import client as choice

router = APIRouter()

# In-memory token store — survives 10 min, lost on restart (acceptable for short-lived links)
_token_store: dict = {}
TOKEN_TTL = 600  # 10 minutes


def _make_token(trader_id: int) -> str:
    now = time.time()
    # Purge expired tokens
    expired = [k for k, v in list(_token_store.items()) if v["exp"] < now]
    for k in expired:
        _token_store.pop(k, None)
    token = secrets.token_urlsafe(8)   # ~11 chars, e.g. "aB3xKp7mN2Q"
    _token_store[token] = {"tid": trader_id, "exp": now + TOKEN_TTL}
    return token


def _decode_token(token: str) -> int:
    entry = _token_store.get(token)
    if not entry:
        raise HTTPException(400, "This link has expired or is invalid. Please request a new one from the SparkP2P app.")
    if time.time() > entry["exp"]:
        _token_store.pop(token, None)
        raise HTTPException(400, "This link expired (10-minute limit). Please open SparkP2P and click 'Set Up' again.")
    return entry["tid"]


@router.post("/kyc/session")
async def create_kyc_session(trader: Trader = Depends(get_current_trader)):
    """Authenticated — creates a 10-minute short token for the mobile KYC flow."""
    return {"token": _make_token(trader.id)}


@router.get("/kyc/validate/{token}")
async def validate_kyc_token(token: str, db: AsyncSession = Depends(get_db)):
    """Public — validates token and returns trader info for the QR page and mobile form."""
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404, "Trader not found.")
    return {
        "verified": bool(trader.choice_account_id),
        "trader_id": trader.id,
        "full_name": trader.full_name,
        "phone": getattr(trader, "phone", "") or "",
        "account_number": trader.choice_account_number,
        "kyc_status": trader.choice_kyc_status,
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
    address: str = ""
    front_photo_b64: str
    back_photo_b64: str
    selfie_b64: str


@router.post("/kyc/submit/{token}")
async def submit_mobile_kyc(token: str, body: MobileKycBody, db: AsyncSession = Depends(get_db)):
    """Public — submit KYC from mobile. Token gates the request."""
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404, "Trader not found.")
    if trader.choice_account_id:
        return {"status": "already_verified", "account_number": trader.choice_account_number}

    result = await choice.create_wallet_account(
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
        front_photo_b64=body.front_photo_b64,
        back_photo_b64=body.back_photo_b64,
        selfie_b64=body.selfie_b64,
    )
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "Onboarding failed"))

    onboarding_id = (result.get("data") or {}).get("onboardingRequestId") or ""
    trader.choice_kyc_status = f"pending:{onboarding_id}"
    await db.commit()
    return {"onboardingRequestId": onboarding_id}


class OtpBody(BaseModel):
    onboarding_request_id: str
    otp: str


@router.post("/kyc/otp/{token}")
async def confirm_mobile_otp(token: str, body: OtpBody, db: AsyncSession = Depends(get_db)):
    _decode_token(token)
    result = await choice.confirm_otp(body.onboarding_request_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "OTP failed"))
    return {"status": "confirmed"}


@router.get("/kyc/poll/{token}/{onboarding_id}")
async def poll_mobile_kyc(token: str, onboarding_id: str, db: AsyncSession = Depends(get_db)):
    tid = _decode_token(token)
    trader = await db.get(Trader, tid)
    if not trader:
        raise HTTPException(404)
    result = await choice.get_onboarding_status(onboarding_id)
    data = result.get("data") or {}
    status = data.get("status")
    if status in (3, 7, "3", "7"):
        aid = data.get("accountId") or ""
        anum = data.get("accountNumber") or ""
        if aid:
            trader.choice_account_id = aid
            trader.choice_account_number = anum
            trader.choice_kyc_status = "approved"
            await db.commit()
    return {"status": status, "accountId": data.get("accountId"), "accountNumber": data.get("accountNumber")}
