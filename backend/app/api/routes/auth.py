import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token
from app.models import Trader, TraderStatus
from app.models.wallet import Wallet

logger = logging.getLogger(__name__)

router = APIRouter()


class RegisterRequest(BaseModel):
    email: EmailStr
    phone: str
    full_name: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    trader_id: int
    full_name: str


@router.post("/register", response_model=TokenResponse)
async def register(data: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new trader."""
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

    trader = Trader(
        email=data.email,
        phone=data.phone,
        full_name=data.full_name,
        password_hash=hash_password(data.password),
        status=TraderStatus.PENDING,
    )
    db.add(trader)
    await db.flush()

    # Create wallet for trader
    wallet = Wallet(trader_id=trader.id)
    db.add(wallet)
    await db.commit()

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
