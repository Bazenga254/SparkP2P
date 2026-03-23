import re
import random
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token
from app.models import Trader, TraderStatus
from app.models.wallet import Wallet

logger = logging.getLogger(__name__)

router = APIRouter()

# In-memory store for email verification codes (use Redis in production)
_verification_codes: dict[str, str] = {}


class RegisterRequest(BaseModel):
    first_name: str
    last_name: str
    email: EmailStr
    phone: str
    password: str
    email_code: str  # Verification code

    @field_validator("first_name", "last_name")
    @classmethod
    def validate_name(cls, v):
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters")
        if not v.replace(" ", "").replace("-", "").isalpha():
            raise ValueError("Name must contain only letters")
        return v

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


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    trader_id: int
    full_name: str


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

    # TODO: Send email via SMTP/Zoho/SendGrid
    # For now, log it (in production, send actual email)
    logger.info(f"Verification code for {data.email}: {code}")

    # For development/testing, also return the code
    # Remove this in production!
    return {"message": f"Verification code sent to {data.email}", "dev_code": code}


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

    full_name = f"{data.first_name.strip()} {data.last_name.strip()}"

    trader = Trader(
        email=data.email,
        phone=data.phone,
        full_name=full_name,
        password_hash=hash_password(data.password),
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
    )


@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login and get access token."""
    result = await db.execute(
        select(Trader).where(Trader.email == data.email)
    )
    trader = result.scalar_one_or_none()

    if not trader or not verify_password(data.password, trader.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if trader.status == TraderStatus.SUSPENDED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account suspended",
        )

    token = create_access_token({"sub": str(trader.id), "email": trader.email})

    return TokenResponse(
        access_token=token,
        trader_id=trader.id,
        full_name=trader.full_name,
    )
