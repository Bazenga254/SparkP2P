import re
import random
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlencode
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token
from app.models import Trader, TraderStatus
from app.models.wallet import Wallet

logger = logging.getLogger(__name__)

router = APIRouter()

# In-memory store for email verification codes (use Redis in production)
_verification_codes: dict[str, str] = {}
_login_otp_codes: dict[str, str] = {}  # email -> OTP for login 2FA


class RegisterRequest(BaseModel):
    full_name: str = ""
    first_name: str = ""  # Legacy — kept for backward compat
    last_name: str = ""   # Legacy — kept for backward compat
    email: EmailStr
    phone: str
    password: str
    email_code: str  # Verification code
    security_question: str  # Cannot be changed after registration
    security_answer: str  # Hashed before storing

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, v):
        v = v.strip()
        if v and len(v) < 3:
            raise ValueError("Full name must be at least 3 characters")
        return v.upper()

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v):
        v = v.strip().replace(" ", "").replace("+", "")
        if v.startswith("0"):
            v = "254" + v[1:]
        if not v.startswith("254") or len(v) != 12:
            raise ValueError("Invalid phone number. Use format 0712345678 or 254712345678")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(re.findall(r"[A-Z]", v)) < 2:
            raise ValueError("Password must contain at least 2 uppercase letters")
        if len(re.findall(r"[a-z]", v)) < 2:
            raise ValueError("Password must contain at least 2 lowercase letters")
        if len(re.findall(r"[0-9]", v)) < 2:
            raise ValueError("Password must contain at least 2 numbers")
        if len(re.findall(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?]", v)) < 2:
            raise ValueError("Password must contain at least 2 special characters")
        return v


class SendVerificationRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: str
    password: str
    otp_code: Optional[str] = None  # Step 2: OTP verification


class EmployeeLoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    trader_id: int
    full_name: str
    role: str = "trader"


@router.post("/send-verification")
async def send_verification_code(data: SendVerificationRequest, db: AsyncSession = Depends(get_db)):
    """Send email verification code."""
    # Check if email already registered
    result = await db.execute(
        select(Trader).where(Trader.email == data.email)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    # Generate 6-digit code
    code = str(random.randint(100000, 999999))
    _verification_codes[data.email] = code

    # Send via Brevo
    from app.services.email import send_verification_code
    sent = send_verification_code(data.email, code)

    if not sent:
        logger.warning(f"Email send failed for {data.email}, code: {code}")

    return {"message": f"Verification code sent to {data.email}"}


@router.post("/register", response_model=TokenResponse)
async def register(data: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new trader."""
    # Verify email code
    stored_code = _verification_codes.get(data.email)
    if not stored_code or stored_code != data.email_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired verification code",
        )

    # Check if email or phone already exists
    result = await db.execute(
        select(Trader).where(
            (Trader.email == data.email) | (Trader.phone == data.phone)
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email or phone already registered",
        )

    # Use full_name if provided, otherwise combine first + last (legacy)
    full_name = data.full_name.strip() if data.full_name else f"{data.first_name.strip()} {data.last_name.strip()}"
    full_name = full_name.upper()

    trader = Trader(
        email=data.email,
        phone=data.phone,
        full_name=full_name,
        password_hash=hash_password(data.password),
        security_question=data.security_question.strip(),
        security_answer_hash=hash_password(data.security_answer.strip().lower()),
        status=TraderStatus.PENDING,
    )
    db.add(trader)
    await db.flush()

    # Create wallet for trader
    wallet = Wallet(trader_id=trader.id)
    db.add(wallet)
    await db.commit()

    # Clean up verification code
    _verification_codes.pop(data.email, None)

    token = create_access_token({"sub": str(trader.id), "email": trader.email})

    return TokenResponse(
        access_token=token,
        trader_id=trader.id,
        full_name=trader.full_name,
        role=trader.role or "trader",
    )


MAX_LOGIN_ATTEMPTS = 3
LOCKOUT_HOURS = 24


@router.post("/login")
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Two-step login with SMS OTP.
    Step 1: Send email + password → returns otp_required=true, sends SMS OTP
    Step 2: Send email + password + otp_code → returns access_token
    Lockout: 3 failed attempts locks account for 24 hours.
    """
    result = await db.execute(
        select(Trader).where(Trader.email == data.email)
    )
    trader = result.scalar_one_or_none()

    # Check lockout first (even if email not found — don't reveal that)
    if trader and trader.locked_until:
        now = datetime.now(timezone.utc)
        if trader.locked_until > now:
            remaining_seconds = int((trader.locked_until - now).total_seconds())
            raise HTTPException(
                status_code=423,
                detail={
                    "code": "account_locked",
                    "message": "Account locked due to too many failed attempts.",
                    "locked_until": trader.locked_until.isoformat(),
                    "remaining_seconds": remaining_seconds,
                },
            )
        else:
            # Lockout expired — reset
            trader.failed_login_attempts = 0
            trader.locked_until = None
            await db.commit()

    if not trader or not verify_password(data.password, trader.password_hash):
        # Increment failed attempts if trader exists
        if trader:
            trader.failed_login_attempts = (trader.failed_login_attempts or 0) + 1
            attempts_remaining = MAX_LOGIN_ATTEMPTS - trader.failed_login_attempts
            if trader.failed_login_attempts >= MAX_LOGIN_ATTEMPTS:
                trader.locked_until = datetime.now(timezone.utc) + timedelta(hours=LOCKOUT_HOURS)
                trader.failed_login_attempts = MAX_LOGIN_ATTEMPTS
                await db.commit()
                raise HTTPException(
                    status_code=423,
                    detail={
                        "code": "account_locked",
                        "message": "Account locked for 24 hours after too many failed attempts.",
                        "locked_until": trader.locked_until.isoformat(),
                        "remaining_seconds": LOCKOUT_HOURS * 3600,
                    },
                )
            await db.commit()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "invalid_credentials",
                    "message": "Invalid email or password",
                    "attempts_remaining": max(0, attempts_remaining),
                    "show_reset": trader.failed_login_attempts >= 1,
                },
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Invalid email or password", "attempts_remaining": MAX_LOGIN_ATTEMPTS, "show_reset": False},
        )

    if trader.status == TraderStatus.SUSPENDED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account suspended",
        )

    # Step 2: Verify OTP
    if data.otp_code:
        stored_otp = _login_otp_codes.get(data.email)
        if not stored_otp or stored_otp != data.otp_code:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired OTP code",
            )

        # OTP valid — issue token, reset lockout counters
        _login_otp_codes.pop(data.email, None)
        trader.failed_login_attempts = 0
        trader.locked_until = None
        trader.last_login = datetime.now(timezone.utc)
        await db.commit()
        token = create_access_token({"sub": str(trader.id), "email": trader.email})

        return {
            "access_token": token,
            "token_type": "bearer",
            "trader_id": trader.id,
            "full_name": trader.full_name,
            "role": trader.role or "trader",
            "otp_required": False,
        }

    # Step 1: Password valid → send OTP to phone
    otp_code = str(random.randint(100000, 999999))
    _login_otp_codes[data.email] = otp_code

    # Send OTP via SMS
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception as e:
        logger.warning(f"SMS OTP send failed for {trader.email}: {e}")

    # OTP sent to phone only — no email fallback

    return {
        "otp_required": True,
        "message": f"OTP sent to {trader.phone[-4:].rjust(len(trader.phone), '*')}",
        "phone_hint": f"***{trader.phone[-4:]}",
    }


@router.post("/extension/login")
async def extension_login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login from Chrome extension — skips OTP.
    The extension already has Binance cookies which is stronger auth.
    """
    result = await db.execute(
        select(Trader).where(Trader.email == data.email)
    )
    trader = result.scalar_one_or_none()

    if not trader or not verify_password(data.password, trader.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if trader.status == TraderStatus.SUSPENDED:
        raise HTTPException(status_code=403, detail="Account suspended")

    token = create_access_token({"sub": str(trader.id), "email": trader.email})

    return {
        "access_token": token,
        "token_type": "bearer",
        "trader_id": trader.id,
        "full_name": trader.full_name,
        "role": trader.role or "trader",
        "otp_required": False,
    }


@router.post("/employee/login")
async def employee_login(data: EmployeeLoginRequest, db: AsyncSession = Depends(get_db)):
    """Login as an employee (support staff)."""
    result = await db.execute(
        select(Trader).where(Trader.email == data.email)
    )
    employee = result.scalar_one_or_none()

    if not employee or not verify_password(data.password, employee.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if employee.role not in ("employee", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized as employee",
        )

    if employee.status == TraderStatus.SUSPENDED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account suspended",
        )

    token = create_access_token({
        "sub": str(employee.id),
        "email": employee.email,
        "role": employee.role,
    })

    return {
        "access_token": token,
        "token_type": "bearer",
        "trader_id": employee.id,
        "full_name": employee.full_name,
        "role": employee.role,
    }


# ═══════════════════════════════════════════════════════════
# GOOGLE OAUTH
# ═══════════════════════════════════════════════════════════

import os
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = "https://sparkp2p.com/api/auth/google/callback"

_google_states: dict[str, bool] = {}


@router.get("/google")
async def google_login():
    """Redirect user to Google OAuth consent screen."""
    state = secrets.token_urlsafe(32)
    _google_states[state] = True

    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "state": state,
        "prompt": "select_account",
    })
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{params}")


@router.get("/google/callback")
async def google_callback(code: str = None, state: str = None, error: str = None, db: AsyncSession = Depends(get_db)):
    """Google redirects here after login. Exchange code for user info, login or register."""
    if error:
        return RedirectResponse(f"/login?error={error}")

    if not code or not state or state not in _google_states:
        return RedirectResponse("/login?error=invalid_state")

    _google_states.pop(state, None)

    # Exchange code for tokens
    async with httpx.AsyncClient() as client:
        token_resp = await client.post("https://oauth2.googleapis.com/token", data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        })

    if token_resp.status_code != 200:
        logger.error(f"Google token exchange failed: {token_resp.text}")
        return RedirectResponse("/login?error=token_exchange_failed")

    tokens = token_resp.json()
    access_token = tokens.get("access_token")

    # Get user info from Google
    async with httpx.AsyncClient() as client:
        user_resp = await client.get("https://www.googleapis.com/oauth2/v2/userinfo", headers={
            "Authorization": f"Bearer {access_token}",
        })

    if user_resp.status_code != 200:
        return RedirectResponse("/login?error=user_info_failed")

    google_user = user_resp.json()
    email = google_user.get("email", "").lower()
    name = google_user.get("name", "")

    if not email:
        return RedirectResponse("/login?error=no_email")

    # Check if user exists
    result = await db.execute(select(Trader).where(Trader.email == email))
    trader = result.scalar_one_or_none()

    if not trader:
        # Auto-register with Google account
        trader = Trader(
            email=email,
            full_name=name.upper(),
            phone="",
            password_hash=hash_password(secrets.token_urlsafe(32)),  # random password
            status=TraderStatus.ACTIVE,
            google_id=google_user.get("id", ""),
        )
        db.add(trader)
        await db.flush()

        # Create wallet
        wallet = Wallet(trader_id=trader.id, balance=0.0)
        db.add(wallet)
        await db.commit()
        await db.refresh(trader)
        logger.info(f"New Google user registered: {email} as {name}")
    else:
        # Update google_id if not set
        if not trader.google_id:
            trader.google_id = google_user.get("id", "")
            await db.commit()

    # Create JWT token
    token = create_access_token({"sub": str(trader.id), "email": trader.email})

    # Check if profile is incomplete (Google users need phone + KYC name)
    needs_profile = not trader.phone or trader.phone == ""

    # Redirect with token — frontend handles profile completion
    return RedirectResponse(f"/login?google_token={token}&name={trader.full_name}&id={trader.id}&role={trader.role or 'trader'}&needs_profile={'1' if needs_profile else '0'}")
