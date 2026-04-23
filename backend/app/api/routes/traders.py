import json
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select, update as sql_update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.security import encrypt_data, decode_access_token, create_access_token
from app.models import Trader, SettlementMethod
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.order import Order, OrderStatus
from app.services.binance.client import BinanceP2PClient
from app.services.mpesa.client import mpesa_client
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────

class BinanceConnectRequest(BaseModel):
    cookies: dict  # Browser cookies as {name: value} (legacy)
    cookies_full: Optional[list] = None  # Full cookie objects [{name, value, domain, path, secure, httpOnly, sameSite}, ...]
    csrf_token: str
    bnc_uuid: Optional[str] = None
    totp_secret: Optional[str] = None
    gmail_cookies: Optional[list] = None  # Gmail cookies from desktop app's Chrome browser


class CompleteProfileRequest(BaseModel):
    full_name: str
    phone: str


class VerificationConfigRequest(BaseModel):
    verify_method: str  # totp, fund_password, manual, none
    totp_secret: Optional[str] = None
    fund_password: Optional[str] = None


class SettlementConfigRequest(BaseModel):
    method: SettlementMethod
    phone: Optional[str] = None          # For M-Pesa
    paybill: Optional[str] = None        # For bank/paybill/till
    account: Optional[str] = None        # Account number
    bank_name: Optional[str] = None
    otp_code: Optional[str] = None       # Required for security verification
    security_answer: Optional[str] = None  # Required for security verification


class RequestSettlementOTP(BaseModel):
    """Request OTP before changing settlement method."""
    pass


class TradingConfigRequest(BaseModel):
    auto_release_enabled: Optional[bool] = None
    auto_pay_enabled: Optional[bool] = None
    daily_trade_limit: Optional[int] = None
    max_single_trade: Optional[int] = None
    batch_settlement_enabled: Optional[bool] = None
    batch_threshold: Optional[int] = None


class DepositRequest(BaseModel):
    amount: float
    phone: str


class WalletResponse(BaseModel):
    balance: float
    reserved: float
    total_earned: float
    total_withdrawn: float
    total_fees_paid: float
    daily_volume: float
    daily_trades: int
    pending_withdrawal: bool = False
    pending_withdrawal_amount: float = 0.0


class TraderProfileResponse(BaseModel):
    id: int
    email: str
    phone: str
    full_name: str
    binance_connected: bool
    binance_username: Optional[str]
    settlement_method: Optional[str]
    settlement_destination: Optional[str]
    auto_release_enabled: bool
    auto_pay_enabled: bool
    daily_trade_limit: int
    max_single_trade: int
    tier: str
    total_trades: int
    total_volume: float
    status: str
    is_admin: bool = False
    role: str = "trader"
    subscription_plan: Optional[str] = None
    subscription_status: Optional[str] = None
    subscription_expires: Optional[str] = None
    onboarding_complete: bool = False
    security_question: Optional[str] = None
    last_extension_sync: Optional[str] = None
    settlement_cooldown_until: Optional[str] = None  # ISO datetime when cooldown ends
    password_change_cooldown_until: Optional[str] = None  # ISO datetime, 48hr after last pw change
    binance_verify_method: Optional[str] = None
    im_connected: bool = False
    gmail_connected: bool = False
    mpesa_portal_connected: bool = False
    has_totp: bool = False
    batch_settlement_enabled: bool = True
    batch_threshold: int = 50000


# In-memory store for phone verification results
_phone_verifications: dict[str, dict] = {}

# In-memory notification store (per trader)
_notifications: dict[int, list] = {}


def add_notification(trader_id: int, title: str, message: str, notif_type: str = "info"):
    """Add a notification for a trader. Called from anywhere in the app."""
    if trader_id not in _notifications:
        _notifications[trader_id] = []
    from datetime import datetime
    _notifications[trader_id].insert(0, {
        "title": title,
        "message": message,
        "type": notif_type,  # payment, release, order, settlement, info
        "time": datetime.now().strftime("%I:%M %p, %b %d"),
        "read": False,
    })
    # Keep only last 50
    _notifications[trader_id] = _notifications[trader_id][:50]


class VerifyPhoneRequest(BaseModel):
    phone: str


# ── Routes ────────────────────────────────────────────────────────

@router.post("/verify-phone")
async def verify_phone(
    data: VerifyPhoneRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send KES 1 to the phone number via B2C to retrieve the M-Pesa registered name."""
    phone = data.phone.strip().replace(" ", "")
    if phone.startswith("07") or phone.startswith("01"):
        phone = "254" + phone[1:]
    if not phone.startswith("254") or len(phone) != 12:
        raise HTTPException(status_code=400, detail="Invalid phone number")

    try:
        from app.services.mpesa.client import mpesa_client
        result = await mpesa_client.send_b2c(
            phone=phone,
            amount=10,
            occasion="SparkP2P phone verification",
            remarks="Phone name verification",
        )
        conv_id = result.get("ConversationID", "")
        logger.info(f"Phone verification B2C sent to {phone}, ConversationID: {conv_id}")

        # Store pending verification
        _phone_verifications[phone] = {
            "conversation_id": conv_id,
            "trader_id": trader.id,
            "status": "pending",
            "mpesa_name": None,
        }

        return {
            "status": "sent",
            "message": f"KES 1 sent to {phone}. Waiting for M-Pesa confirmation...",
            "conversation_id": conv_id,
        }
    except Exception as e:
        logger.error(f"Phone verification B2C failed: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send verification: {str(e)}")


@router.get("/verify-phone/result")
async def verify_phone_result(
    phone: str,
    trader: Trader = Depends(get_current_trader),
):
    """Check the result of a phone verification — returns M-Pesa name if available."""
    phone = phone.strip().replace(" ", "")
    if phone.startswith("07") or phone.startswith("01"):
        phone = "254" + phone[1:]

    logger.info(f"Checking verification for {phone}, known keys: {list(_phone_verifications.keys())}")

    verification = _phone_verifications.get(phone)
    if not verification:
        return {"status": "not_found", "message": "No verification found for this number"}

    if verification["status"] == "pending":
        return {"status": "pending", "message": "Waiting for M-Pesa response..."}

    mpesa_name = verification.get("mpesa_name", "")
    registered_name = trader.full_name.upper().strip()

    # Compare names — at least 2 name parts must match
    if mpesa_name:
        mpesa_parts = mpesa_name.upper().split()
        reg_parts = registered_name.split()
        match_count = sum(1 for p in reg_parts if p in mpesa_parts)
        name_match = match_count >= 2 or mpesa_name.upper() == registered_name

        return {
            "status": "verified",
            "mpesa_name": mpesa_name,
            "registered_name": registered_name,
            "name_match": name_match,
            "match_count": match_count,
        }

    return {"status": "failed", "message": "Could not retrieve M-Pesa name"}


def update_phone_verification(phone: str, mpesa_name: str, status: str = "verified"):
    """Called by B2C callback to update the verification result."""
    if phone in _phone_verifications:
        _phone_verifications[phone]["mpesa_name"] = mpesa_name
        _phone_verifications[phone]["status"] = status


@router.post("/suspend-self")
async def suspend_self(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Suspend account after 3 failed settlement verifications."""
    trader.status = TraderStatus.SUSPENDED
    await db.commit()
    logger.warning(f"Trader {trader.id} ({trader.full_name}) self-suspended: 3 failed settlement verifications")
    return {"status": "suspended"}


@router.post("/complete-profile")
async def complete_profile(
    data: CompleteProfileRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Google OAuth users must complete their profile with phone + KYC name."""
    if not data.full_name or len(data.full_name) < 3:
        raise HTTPException(status_code=400, detail="Full name is required (minimum 3 characters)")
    if not data.phone or len(data.phone) < 10:
        raise HTTPException(status_code=400, detail="Valid phone number is required")

    # Normalize phone
    phone = data.phone.strip().replace(" ", "")
    if phone.startswith("07") or phone.startswith("01"):
        phone = "254" + phone[1:]

    trader.full_name = data.full_name.upper()
    trader.phone = phone
    await db.commit()

    logger.info(f"Profile completed for trader {trader.id}: {trader.full_name}, {trader.phone}")
    return {"status": "ok", "full_name": trader.full_name, "phone": trader.phone}


@router.get("/notifications")
async def get_notifications(trader: Trader = Depends(get_current_trader)):
    """Get trader's notifications."""
    return _notifications.get(trader.id, [])


@router.post("/notifications/mark-read")
async def mark_notifications_read(trader: Trader = Depends(get_current_trader)):
    """Mark all notifications as read."""
    for n in _notifications.get(trader.id, []):
        n["read"] = True
    return {"status": "ok"}


@router.get("/me", response_model=TraderProfileResponse)
async def get_profile(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get current trader's profile."""
    from app.models.subscription import Subscription, SubscriptionStatus

    destination = trader.settlement_phone or trader.settlement_paybill or ""
    if trader.settlement_account:
        destination = f"{destination} Acc: {trader.settlement_account}"

    # Get active subscription info
    sub_plan = None
    sub_status = None
    sub_expires = None
    result = await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.expires_at.desc())
    )
    sub = result.scalar_one_or_none()
    if sub and sub.is_active:
        sub_plan = sub.plan.value
        sub_status = sub.status.value
        sub_expires = sub.expires_at.isoformat() if sub.expires_at else None

    # Compute onboarding status — Binance + settlement + security question + TOTP required
    onboarding_complete = (
        trader.binance_connected
        and trader.settlement_method is not None
        and bool(trader.security_question)
        and bool(trader.totp_secret)
    )

    return TraderProfileResponse(
        id=trader.id,
        email=trader.email,
        phone=trader.phone,
        full_name=trader.full_name,
        binance_connected=trader.binance_connected,
        binance_username=trader.binance_username,
        settlement_method=trader.settlement_method.value if trader.settlement_method else None,
        settlement_destination=destination,
        auto_release_enabled=trader.auto_release_enabled,
        auto_pay_enabled=trader.auto_pay_enabled,
        daily_trade_limit=trader.daily_trade_limit,
        max_single_trade=trader.max_single_trade,
        tier=trader.tier,
        total_trades=trader.total_trades,
        total_volume=trader.total_volume,
        status=trader.status.value,
        is_admin=trader.is_admin,
        role=trader.role or "trader",
        subscription_plan=sub_plan,
        subscription_status=sub_status,
        subscription_expires=sub_expires,
        onboarding_complete=bool(onboarding_complete),
        security_question=trader.security_question,
        last_extension_sync=trader.last_extension_sync.isoformat() if trader.last_extension_sync else None,
        settlement_cooldown_until=(
            (trader.settlement_changed_at + timedelta(hours=48)).isoformat()
            if trader.settlement_changed_at and
               (trader.settlement_changed_at + timedelta(hours=48)) > datetime.now(timezone.utc)
            else None
        ),
        password_change_cooldown_until=(
            (trader.password_changed_at + timedelta(hours=48)).isoformat()
            if trader.password_changed_at and
               (trader.password_changed_at + timedelta(hours=48)) > datetime.now(timezone.utc)
            else None
        ),
        binance_verify_method=trader.binance_verify_method or "none",
        im_connected=bool(trader.im_connected),
        gmail_connected=bool(trader.gmail_cookies),
        mpesa_portal_connected=bool(trader.mpesa_portal_connected),
        has_totp=bool(trader.totp_secret),
        batch_settlement_enabled=bool(trader.batch_settlement_enabled),
        batch_threshold=trader.batch_threshold or 50000,
    )


@router.post("/connect-binance")
async def connect_binance(
    data: BinanceConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Connect Binance account by providing session cookies.
    Fetches user profile from Binance and verifies name match.
    """
    # Test the session
    client = BinanceP2PClient.from_raw(
        cookies=data.cookies,
        csrf_token=data.csrf_token,
        bnc_uuid=data.bnc_uuid or "",
        totp_secret=data.totp_secret,
    )
    is_valid = await client.check_session()

    # If validation fails, still save but warn
    # Some Binance sessions need specific headers that our check doesn't include
    if not is_valid:
        logger.warning(f"Binance session validation failed for trader {trader.id}, saving cookies anyway")

    # Fetch Binance profile to get verified name
    binance_profile = {}
    try:
        binance_profile = await client.get_user_profile()
    except Exception as e:
        logger.warning(f"Could not fetch Binance profile: {e}")

    binance_name = binance_profile.get("verified_name", "")

    # Check if name matches
    name_match = False
    if binance_name:
        # Compare case-insensitive
        name_match = trader.full_name.strip().upper() == binance_name.strip().upper()

    # Encrypt and store credentials
    trader.binance_cookies = encrypt_data(json.dumps(data.cookies))
    trader.binance_csrf_token = encrypt_data(data.csrf_token)
    if data.bnc_uuid:
        trader.binance_bnc_uuid = encrypt_data(data.bnc_uuid)
    if data.totp_secret:
        trader.binance_2fa_secret = encrypt_data(data.totp_secret)

    # Store full cookie objects for Playwright (with domain, path, secure, httpOnly, sameSite)
    if data.cookies_full:
        trader.binance_cookies_full = encrypt_data(json.dumps(data.cookies_full))
        logger.info(f"Stored {len(data.cookies_full)} full cookies for trader {trader.id}")

    # Save Gmail cookies when desktop app captures them (Gmail tab open alongside Binance)
    if data.gmail_cookies and len(data.gmail_cookies) > 0:
        trader.gmail_cookies = encrypt_data(json.dumps(data.gmail_cookies))
        logger.info(f"Gmail session synced: {len(data.gmail_cookies)} cookies for trader {trader.id}")

    # Mark as connected if full cookies provided (verified login from desktop app)
    if data.cookies_full and len(data.cookies_full) > 10:
        trader.binance_connected = True
    if binance_name:
        trader.binance_username = binance_name

    await db.commit()

    cookie_count = len(data.cookies_full) if data.cookies_full else len(data.cookies)
    return {
        "status": "cookies_stored",
        "message": "Cookies stored. Use Connect Binance to verify login.",
        "binance_name": binance_name,
        "registered_name": trader.full_name,
        "name_match": name_match,
        "cookies_received": cookie_count,
    }


@router.post("/update-name")
async def update_name_from_binance(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trader's name to match their Binance verified name."""
    if not trader.binance_username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No Binance name found. Connect Binance first.",
        )

    trader.full_name = trader.binance_username
    await db.commit()

    return {
        "status": "updated",
        "full_name": trader.full_name,
    }


@router.put("/verification")
async def update_verification(
    data: VerificationConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Configure how releases are verified on Binance."""
    if data.verify_method not in ("totp", "fund_password", "manual", "none"):
        raise HTTPException(status_code=400, detail="Invalid verification method")

    trader.binance_verify_method = data.verify_method

    if data.verify_method == "totp" and data.totp_secret:
        trader.binance_2fa_secret = encrypt_data(data.totp_secret)
    elif data.verify_method == "fund_password" and data.fund_password:
        trader.binance_fund_password = encrypt_data(data.fund_password)

    await db.commit()

    return {"status": "updated", "verify_method": data.verify_method}


@router.post("/settlement/request-otp")
async def request_settlement_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone before allowing settlement change."""
    import random
    from app.api.routes.auth import _login_otp_codes

    # Block if still in 48hr cooldown
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            hours_left = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)
            raise HTTPException(
                status_code=400,
                detail=f"You cannot change your payment method again for {hours_left} hours.",
            )

    otp_code = str(random.randint(100000, 999999))
    _login_otp_codes[f"settle_{trader.email}"] = otp_code

    # Send via SMS only (not email)
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception:
        pass

    return {
        "message": f"OTP sent to ***{trader.phone[-4:]}",
        "security_question": trader.security_question or "What is your mother's maiden name?",
    }


@router.put("/settlement")
async def update_settlement(
    data: SettlementConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update settlement configuration.
    Requires OTP + security answer for verification.
    New method has 48-hour cooldown before it can be used.
    """
    from app.api.routes.auth import _login_otp_codes
    from app.core.security import verify_password
    from datetime import datetime, timezone

    # Verify OTP
    if not data.otp_code:
        raise HTTPException(status_code=400, detail="OTP code is required to change payment method")

    stored_otp = _login_otp_codes.get(f"settle_{trader.email}")
    if not stored_otp or stored_otp != data.otp_code:
        raise HTTPException(status_code=401, detail="Invalid or expired OTP code")

    # Verify security answer
    if not data.security_answer:
        raise HTTPException(status_code=400, detail="Security answer is required")

    if trader.security_answer_hash:
        if not verify_password(data.security_answer.strip().lower(), trader.security_answer_hash):
            raise HTTPException(status_code=401, detail="Incorrect security answer")

    # Clear OTP
    _login_otp_codes.pop(f"settle_{trader.email}", None)

    # Save as PENDING — don't replace the active method yet
    # Active method continues to work during 48hr cooldown
    trader.pending_settlement_method = data.method.value
    trader.pending_settlement_phone = data.phone
    trader.pending_settlement_paybill = data.paybill
    trader.pending_settlement_account = data.account
    trader.pending_settlement_bank_name = data.bank_name
    trader.settlement_changed_at = datetime.now(timezone.utc)

    # If this is the FIRST time setting settlement (no active method), activate immediately
    if not trader.settlement_phone and not trader.settlement_paybill:
        trader.settlement_method = data.method
        trader.settlement_phone = data.phone
        trader.settlement_paybill = data.paybill
        trader.settlement_account = data.account
        trader.settlement_bank_name = data.bank_name
        trader.pending_settlement_method = None
        trader.settlement_changed_at = None

    await db.commit()

    # Send email notification
    from app.services.email import send_payment_method_added
    method_display = {
        "mpesa": "M-Pesa",
        "bank_paybill": f"Bank ({data.bank_name or 'Paybill'})",
        "till": "Till Number",
        "paybill": "Paybill",
    }.get(data.method.value, data.method.value)
    destination = data.phone or data.paybill or ""
    if data.account:
        destination = f"{destination} Acc: {data.account}"
    send_payment_method_added(trader.email, trader.full_name, method_display, destination)

    if trader.pending_settlement_method:
        return {
            "status": "pending",
            "method": data.method.value,
            "cooldown_until": (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
            "message": "New payment method saved. Your current method will remain active for 48 hours. You'll receive an email when the new method is ready.",
        }
    else:
        return {
            "status": "updated",
            "method": data.method.value,
            "message": "Payment method set successfully.",
        }


@router.put("/trading-config")
async def update_trading_config(
    data: TradingConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trading configuration."""
    if data.auto_release_enabled is not None:
        trader.auto_release_enabled = data.auto_release_enabled
    if data.auto_pay_enabled is not None:
        trader.auto_pay_enabled = data.auto_pay_enabled
    if data.daily_trade_limit is not None:
        trader.daily_trade_limit = data.daily_trade_limit
    if data.max_single_trade is not None:
        trader.max_single_trade = data.max_single_trade
    if data.batch_settlement_enabled is not None:
        trader.batch_settlement_enabled = data.batch_settlement_enabled
    if data.batch_threshold is not None:
        trader.batch_threshold = data.batch_threshold

    await db.commit()

    return {"status": "updated"}


# ── Profile, Security Question, Change Password ───────────────────

_change_pw_otp_codes: dict[str, str] = {}  # email -> OTP for in-app password change
_withdraw_otp_codes: dict[str, str] = {}  # email -> OTP for withdrawal confirmation


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = None


class SetSecurityQuestionRequest(BaseModel):
    security_question: str
    security_answer: str


class ChangePasswordRequest(BaseModel):
    otp_code: str
    new_password: str


@router.put("/profile")
async def update_profile(
    data: UpdateProfileRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update editable profile fields (full_name)."""
    if data.full_name is not None:
        name = data.full_name.strip().upper()
        if len(name) < 3:
            raise HTTPException(status_code=400, detail="Full name must be at least 3 characters")
        await db.execute(sql_update(Trader).where(Trader.id == trader.id).values(full_name=name))
        await db.commit()
        return {"message": "Profile updated", "full_name": name}
    return {"message": "Nothing to update", "full_name": trader.full_name}


@router.post("/security-question")
async def set_security_question(
    data: SetSecurityQuestionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Set security question — only allowed if not already set (permanent)."""
    if trader.security_question:
        raise HTTPException(
            status_code=400,
            detail="Security question is already set and cannot be changed",
        )
    from app.core.security import hash_password
    await db.execute(
        sql_update(Trader).where(Trader.id == trader.id).values(
            security_question=data.security_question.strip(),
            security_answer_hash=hash_password(data.security_answer.strip().lower()),
            security_answer_plain=data.security_answer.strip().lower(),
        )
    )
    await db.commit()
    return {"message": "Security question saved successfully"}


@router.post("/change-password/request")
async def request_change_password_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone to authorize a password change."""
    if trader.password_changed_at:
        cooldown_end = trader.password_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds())
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "password_change_cooldown",
                    "message": "Password can only be changed once every 48 hours.",
                    "cooldown_until": cooldown_end.isoformat(),
                    "remaining_seconds": remaining,
                },
            )
    import random
    otp_code = str(random.randint(100000, 999999))
    _change_pw_otp_codes[trader.email] = otp_code
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception as e:
        logger.warning(f"Change-password OTP SMS failed for {trader.email}: {e}")
    masked = f"***{trader.phone[-4:]}"
    return {"message": f"OTP sent to {masked}", "phone_hint": masked}


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify OTP and update password (must differ from current). 48hr cooldown enforced."""
    import re
    # Enforce 48-hour cooldown
    if trader.password_changed_at:
        cooldown_end = trader.password_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds())
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "password_change_cooldown",
                    "message": "Password can only be changed once every 48 hours.",
                    "cooldown_until": cooldown_end.isoformat(),
                    "remaining_seconds": remaining,
                },
            )

    stored = _change_pw_otp_codes.get(trader.email)
    if not stored or stored != data.otp_code:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code")

    # Validate password strength
    from app.core.security import hash_password, verify_password
    pw = data.new_password
    errors = []
    if len(pw) < 8: errors.append("at least 8 characters")
    if len(re.findall(r"[A-Z]", pw)) < 2: errors.append("2 uppercase letters")
    if len(re.findall(r"[a-z]", pw)) < 2: errors.append("2 lowercase letters")
    if len(re.findall(r"[0-9]", pw)) < 2: errors.append("2 numbers")
    if len(re.findall(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?]", pw)) < 2: errors.append("2 special characters")
    if errors:
        raise HTTPException(status_code=400, detail=f"Password must contain: {', '.join(errors)}")

    if verify_password(data.new_password, trader.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different from your current password")

    now = datetime.now(timezone.utc)
    await db.execute(
        sql_update(Trader).where(Trader.id == trader.id).values(
            password_hash=hash_password(data.new_password),
            failed_login_attempts=0,
            locked_until=None,
            password_changed_at=now,
        )
    )
    _change_pw_otp_codes.pop(trader.email, None)
    await db.commit()
    cooldown_until = (now + timedelta(hours=48)).isoformat()
    return {"message": "Password changed successfully", "cooldown_until": cooldown_until}


@router.get("/session-health")
async def get_session_health(
    trader: Trader = Depends(get_current_trader),
):
    """Get current session health status from the background monitor."""
    from app.services.binance.health import session_monitor
    health = session_monitor.get_health(trader.id)
    return {
        "score": health.get("score", 0),
        "status": health.get("status", "unknown"),
        "last_success": health.get("last_success"),
        "last_check": health.get("last_check"),
        "consecutive_failures": health.get("consecutive_failures", 0),
    }


@router.get("/desktop-credentials")
async def get_desktop_credentials(
    trader: Trader = Depends(get_current_trader),
):
    """
    Returns the trader's decrypted Binance verification credentials to the desktop app.
    Called once on startup so the bot can auto-enter PIN / TOTP when Binance asks.
    Only returns to the authenticated owner — never exposed to other users.
    """
    from app.core.security import decrypt_data
    fund_password = None
    totp_secret = None
    try:
        if trader.binance_fund_password:
            fund_password = decrypt_data(trader.binance_fund_password)
    except Exception:
        pass
    try:
        if trader.binance_2fa_secret:
            totp_secret = decrypt_data(trader.binance_2fa_secret)
    except Exception:
        pass
    # Also check trader.totp_secret — set by the TOTP setup/verify flow
    if not totp_secret:
        try:
            if trader.totp_secret:
                totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            pass
    account_number = f"P2PT{trader.id:04d}"
    return {
        "verify_method": trader.binance_verify_method or "none",
        "fund_password": fund_password,
        "totp_secret": totp_secret,
        "anthropic_api_key": settings.ANTHROPIC_API_KEY,
        "account_number": account_number,
        "phone_number": trader.phone or "",
        "im_account": trader.settlement_account or "",
    }


@router.post("/refresh-token")
async def refresh_token(
    trader: Trader = Depends(get_current_trader),
):
    """
    Exchange a valid (non-expired) JWT for a fresh 30-day token.
    Desktop app calls this every 20 minutes to keep the session alive.
    No OTP required — the existing valid token is proof of identity.
    """
    from app.models import TraderStatus
    if trader.status != TraderStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="Account is not active")
    new_token = create_access_token({"sub": str(trader.id), "email": trader.email})
    return {
        "access_token": new_token,
        "token_type": "bearer",
        "trader_id": trader.id,
        "full_name": trader.full_name,
        "role": trader.role or "trader",
    }


class InternalTransferRequest(BaseModel):
    recipient: str  # Phone number or email of the recipient
    amount: float


@router.post("/wallet/transfer")
async def internal_transfer(
    data: InternalTransferRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send money to another SparkP2P user. FREE - no transaction fees."""
    from app.services.internal_transfer import find_trader_by_phone, transfer_between_wallets

    if data.amount < 10:
        raise HTTPException(status_code=400, detail="Minimum transfer amount is KES 10")
    if data.amount > 500_000:
        raise HTTPException(status_code=400, detail="Maximum transfer amount is KES 500,000")

    recipient = data.recipient.strip()
    if not recipient:
        raise HTTPException(status_code=400, detail="Recipient phone or email is required")

    # Look up recipient by email or phone
    recipient_trader = None
    if "@" in recipient:
        result = await db.execute(
            select(Trader).where(Trader.email == recipient)
        )
        recipient_trader = result.scalar_one_or_none()
    else:
        recipient_trader = await find_trader_by_phone(db, recipient)

    if not recipient_trader:
        raise HTTPException(status_code=404, detail="Recipient not found on SparkP2P")

    if recipient_trader.id == trader.id:
        raise HTTPException(status_code=400, detail="You cannot send money to yourself")

    try:
        await transfer_between_wallets(
            db=db,
            from_trader_id=trader.id,
            to_trader_id=recipient_trader.id,
            amount=data.amount,
            description=f"Manual transfer to {recipient_trader.full_name}",
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Get updated sender wallet
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    updated_wallet = result.scalar_one_or_none()

    return {
        "status": "success",
        "message": f"KES {data.amount:,.0f} sent to {recipient_trader.full_name}",
        "amount": data.amount,
        "recipient_name": recipient_trader.full_name,
        "fee": 0,
        "new_balance": updated_wallet.balance if updated_wallet else 0,
    }


@router.get("/wallet", response_model=WalletResponse)
async def get_wallet(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get trader's wallet balance and stats."""
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet:
        return WalletResponse(
            balance=0, reserved=0, total_earned=0,
            total_withdrawn=0, total_fees_paid=0,
            daily_volume=0, daily_trades=0,
        )

    # Check for any pending bank withdrawal
    from app.models.wallet import WalletTransaction, TransactionType
    pending_r = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.status == "pending",
        ).limit(1)
    )
    pending_txn = pending_r.scalar_one_or_none()

    return WalletResponse(
        balance=wallet.balance,
        reserved=wallet.reserved,
        total_earned=wallet.total_earned,
        total_withdrawn=wallet.total_withdrawn,
        total_fees_paid=wallet.total_fees_paid,
        daily_volume=wallet.daily_volume,
        daily_trades=wallet.daily_trades,
        pending_withdrawal=pending_txn is not None,
        pending_withdrawal_amount=abs(pending_txn.amount) if pending_txn else 0.0,
    )


class WithdrawRequest(BaseModel):
    otp_code: str


@router.post("/wallet/withdraw")
async def request_withdrawal(
    data: WithdrawRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Request withdrawal of wallet balance.
    Requires OTP verification. Checks 48-hour cooldown on new payment methods.
    """
    from app.services.settlement.engine import SettlementEngine
    from datetime import datetime, timezone

    # Verify OTP
    stored_otp = _withdraw_otp_codes.get(trader.email)
    if not stored_otp or stored_otp != data.otp_code.strip():
        raise HTTPException(status_code=401, detail="Invalid or expired OTP code")
    del _withdraw_otp_codes[trader.email]

    # Block if pending withdrawal already exists
    from app.models.wallet import WalletTransaction, TransactionType
    pending_r = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.status == "pending",
        ).limit(1)
    )
    if pending_r.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You have a pending withdrawal being processed. Please wait for it to complete before requesting another.",
        )

    # Check 48-hour cooldown
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            hours_left = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)
            raise HTTPException(
                status_code=400,
                detail=f"Your payment method was recently changed. For security, withdrawals are available in {hours_left} hours.",
            )

    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No funds available for withdrawal",
        )

    from app.services.settlement.engine import get_total_settlement_fee, MIN_WITHDRAWAL, BANK_MIN_WITHDRAWAL, get_bank_withdrawal_eligibility
    if wallet.balance < MIN_WITHDRAWAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Minimum withdrawal is KES {MIN_WITHDRAWAL:,}. Your balance is KES {wallet.balance:,.0f}.",
        )

    # For bank withdrawals, check tier eligibility
    if trader.settlement_method.value != "mpesa":
        eligibility = get_bank_withdrawal_eligibility(wallet.balance)
        if not eligibility["eligible"]:
            min_req = eligibility.get("min_required", 0)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{eligibility['reason']}. Keep trading to reach KES {min_req:,}.",
            )

    # Calculate fees
    safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, wallet.balance)
    net_amount = wallet.balance - total_fee

    if net_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Balance too low to cover fees (KES {total_fee})",
        )

    # ── Auto-Sweep: paybill 4041355 → I&M Bank ───────────────────────────────
    # Fire BEFORE settlement so the I&M account has the funds ready.
    # Sweep is for the GROSS amount (wallet.balance) — Daraja B2B is async so
    # the result arrives via callback; settlement proceeds regardless.
    from app.services.sweep_service import trigger_im_sweep
    sweep_ref = f"WD-{trader.email[:20]}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    sweep_result = await trigger_im_sweep(
        amount=wallet.balance,       # gross amount (before fees)
        trader_id=trader.id,
        withdrawal_tx_id=None,       # linked after settlement commits
        reference=sweep_ref,
        db=db,
    )
    if sweep_result.get("success"):
        logger.info(f"[Sweep] Initiated for KES {wallet.balance:,.0f} — sweep_id={sweep_result.get('sweep_id')}")
    elif not sweep_result.get("skipped"):
        # Log the failure but don't block the trader's withdrawal
        logger.error(f"[Sweep] Failed for trader {trader.id}: {sweep_result.get('error')}")
    # ─────────────────────────────────────────────────────────────────────────

    engine = SettlementEngine(db)
    # Force withdraw — bypass batch threshold for manual withdrawals
    original_threshold = trader.batch_threshold
    trader.batch_threshold = 0  # Temporarily disable threshold
    success = await engine.batch_settle(trader.id)
    trader.batch_threshold = original_threshold  # Restore

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Withdrawal failed. Please try again.",
        )

    return {
        "status": "success",
        "message": f"KES {net_amount:,.0f} sent to your account",
        "amount_sent": net_amount,
        "transaction_fee": total_fee,
        "wallet_deducted": wallet.balance + total_fee,
        "sweep": {
            "initiated": sweep_result.get("success", False),
            "sweep_id": sweep_result.get("sweep_id"),
            "skipped": sweep_result.get("skipped", False),
        },
    }


@router.get("/wallet/withdraw/preview")
async def preview_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Preview withdrawal fees before confirming."""
    from app.services.settlement.engine import get_total_settlement_fee, MIN_WITHDRAWAL, BANK_MIN_WITHDRAWAL, get_bank_withdrawal_eligibility

    result = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        return {"can_withdraw": False, "reason": "No funds available"}

    if wallet.balance < MIN_WITHDRAWAL:
        return {"can_withdraw": False, "reason": f"Minimum withdrawal is KES {MIN_WITHDRAWAL:,}"}

    if trader.settlement_method.value != "mpesa":
        eligibility = get_bank_withdrawal_eligibility(wallet.balance)
        if not eligibility["eligible"]:
            min_req = eligibility.get("min_required", 0)
            return {
                "can_withdraw": False,
                "reason": eligibility["reason"],
                "min_required": min_req,
                "balance": wallet.balance,
            }

    safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, wallet.balance)
    net_amount = wallet.balance - total_fee

    # Check cooldown
    cooldown_active = False
    cooldown_hours = 0
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            cooldown_active = True
            cooldown_hours = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)

    return {
        "can_withdraw": net_amount > 0 and not cooldown_active,
        "balance": wallet.balance,
        "transaction_fee": total_fee,
        "you_receive": max(net_amount, 0),
        "cooldown_active": cooldown_active,
        "cooldown_hours": cooldown_hours,
    }


@router.post("/wallet/withdraw/request-otp")
async def request_withdrawal_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone to authorize a withdrawal."""
    import random
    otp_code = str(random.randint(100000, 999999))
    _withdraw_otp_codes[trader.email] = otp_code
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception as e:
        logger.warning(f"Withdrawal OTP SMS failed for {trader.email}: {e}")
    masked = trader.phone[-4:] if trader.phone else "****"
    return {"status": "sent", "message": f"OTP sent to number ending {masked}"}


@router.post("/wallet/withdraw/simulate")
async def simulate_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Simulate withdrawal (for testing without real M-Pesa)."""
    from app.services.settlement.engine import SettlementEngine

    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No funds available for withdrawal",
        )

    balance_before = wallet.balance
    engine = SettlementEngine(db)
    success = await engine.batch_settle(trader.id, simulate=True)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Withdrawal simulation failed",
        )

    return {
        "status": "success",
        "simulated": True,
        "amount_settled": balance_before,
        "settlement_method": trader.settlement_method.value,
        "destination": trader.settlement_phone or trader.settlement_paybill,
    }


@router.get("/wallet/transactions")
async def get_wallet_transactions(
    limit: int = 50,
    offset: int = 0,
    direction: str = None,   # "positive" | "negative" | None (all)
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get wallet transaction history."""
    filters = [
        WalletTransaction.trader_id == trader.id,
        ~WalletTransaction.description.contains("[CANCELLED"),
    ]
    if direction == "negative":
        filters.append(WalletTransaction.amount < 0)
    elif direction == "positive":
        filters.append(WalletTransaction.amount > 0)

    result = await db.execute(
        select(WalletTransaction)
        .where(*filters)
        .order_by(WalletTransaction.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    transactions = result.scalars().all()

    return [
        {
            "id": t.id,
            "type": t.transaction_type.value,
            "amount": t.amount,
            "balance_after": t.balance_after,
            "description": t.description,
            "status": t.status or "completed",
            "settlement_method": t.settlement_method or "",
            "destination": t.destination or "",
            "created_at": t.created_at.isoformat(),
        }
        for t in transactions
    ]


# ── Deposit Endpoints ─────────────────────────────────────────────

@router.post("/deposit")
async def initiate_deposit(
    data: DepositRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Initiate a deposit via M-Pesa STK Push."""
    # Validate amount
    if data.amount < 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Minimum deposit is KES 100",
        )
    if data.amount > 500_000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Maximum deposit is KES 500,000",
        )

    # Ensure wallet exists
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()
    if not wallet:
        wallet = Wallet(trader_id=trader.id)
        db.add(wallet)
        await db.flush()

    # Send STK Push
    account_ref = f"SparkP2P-Dep-{trader.id}"
    deposit_callback_url = f"{settings.MPESA_CALLBACK_BASE_URL}/api/traders/deposit/callback"
    try:
        stk_result = await mpesa_client.stk_push(
            phone=data.phone,
            amount=data.amount,
            account_reference=account_ref,
            description="Deposit to SparkP2P",
            callback_url=deposit_callback_url,
        )
    except Exception as e:
        logger.error(f"STK Push failed for deposit: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to initiate M-Pesa payment. Please try again.",
        )

    checkout_id = stk_result.get("CheckoutRequestID", "")

    # Create pending wallet transaction
    txn = WalletTransaction(
        trader_id=trader.id,
        wallet_id=wallet.id,
        transaction_type=TransactionType.DEPOSIT,
        amount=data.amount,
        balance_after=wallet.balance,  # Not yet credited
        description=f"M-Pesa deposit (pending) - {account_ref}",
        mpesa_checkout_id=checkout_id,
        status="pending",
    )
    db.add(txn)
    await db.commit()

    logger.info(f"Deposit STK Push sent to {data.phone} for KES {data.amount}, checkout={checkout_id}")

    return {
        "status": "pending",
        "checkout_request_id": checkout_id,
        "message": "STK Push sent to your phone. Please enter your M-Pesa PIN.",
    }


@router.post("/deposit/callback")
async def deposit_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """M-Pesa STK Push callback for deposits."""
    data = await request.json()
    logger.info(f"Deposit STK Callback: {data}")

    body = data.get("Body", {}).get("stkCallback", {})
    result_code = body.get("ResultCode")
    checkout_id = body.get("CheckoutRequestID", "")

    if not checkout_id:
        logger.warning("Deposit callback missing CheckoutRequestID")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    # Find the pending transaction
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.mpesa_checkout_id == checkout_id,
            WalletTransaction.transaction_type == TransactionType.DEPOSIT,
            WalletTransaction.status == "pending",
        )
    )
    txn = result.scalar_one_or_none()

    if not txn:
        logger.warning(f"No pending deposit found for checkout {checkout_id}")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    if result_code == 0:
        # Success - credit the wallet
        # Extract receipt number from metadata
        metadata = body.get("CallbackMetadata", {}).get("Item", [])
        receipt = ""
        for item in metadata:
            if item.get("Name") == "MpesaReceiptNumber":
                receipt = item.get("Value", "")
                break

        # Get the wallet
        wallet_result = await db.execute(
            select(Wallet).where(Wallet.trader_id == txn.trader_id)
        )
        wallet = wallet_result.scalar_one_or_none()

        if wallet:
            wallet.balance += txn.amount
            wallet.total_earned += txn.amount
            txn.balance_after = wallet.balance
            txn.status = "completed"
            txn.mpesa_receipt = receipt
            txn.description = f"M-Pesa deposit - {receipt}"

            await db.commit()

            logger.info(
                f"Deposit credited: KES {txn.amount} to trader {txn.trader_id}, "
                f"new balance: {wallet.balance}, receipt: {receipt}"
            )

            # Send email notification
            trader_result = await db.execute(
                select(Trader).where(Trader.id == txn.trader_id)
            )
            trader = trader_result.scalar_one_or_none()
            if trader:
                from app.services.email import send_deposit_received
                send_deposit_received(
                    trader.email, trader.full_name, txn.amount, wallet.balance
                )
        else:
            logger.error(f"Wallet not found for trader {txn.trader_id} during deposit callback")
    else:
        # Failed
        txn.status = "failed"
        txn.description = f"M-Pesa deposit failed (code: {result_code})"
        await db.commit()
        logger.warning(f"Deposit failed for checkout {checkout_id}: code={result_code}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.get("/deposit/history")
async def get_deposit_history(
    limit: int = 50,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get deposit history for the trader."""
    result = await db.execute(
        select(WalletTransaction)
        .where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.DEPOSIT,
        )
        .order_by(WalletTransaction.created_at.desc())
        .limit(limit)
    )
    deposits = result.scalars().all()

    return [
        {
            "id": d.id,
            "amount": d.amount,
            "status": d.status or "completed",
            "mpesa_receipt": d.mpesa_receipt,
            "balance_after": d.balance_after,
            "description": d.description,
            "created_at": d.created_at.isoformat(),
        }
        for d in deposits
    ]


@router.get("/deposit/status/{checkout_id}")
async def check_deposit_status(
    checkout_id: str,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Poll the status of a deposit by checkout request ID."""
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.mpesa_checkout_id == checkout_id,
            WalletTransaction.trader_id == trader.id,
        )
    )
    txn = result.scalar_one_or_none()

    if not txn:
        raise HTTPException(status_code=404, detail="Deposit not found")

    return {
        "status": txn.status or "pending",
        "amount": txn.amount,
        "balance_after": txn.balance_after,
        "mpesa_receipt": txn.mpesa_receipt,
    }


class GmailCredentials(BaseModel):
    gmail_email: str
    gmail_password: str


@router.post("/gmail-credentials")
async def save_gmail_credentials(
    data: GmailCredentials,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Save Gmail credentials for automated OTP scanning during order release."""
    trader.gmail_email = data.gmail_email
    trader.gmail_password = encrypt_data(data.gmail_password)
    await db.commit()
    return {"message": "Gmail credentials saved successfully"}


@router.get("/gmail-credentials")
async def get_gmail_credentials(
    trader: Trader = Depends(get_current_trader),
):
    """Check if Gmail session is active (synced from desktop app)."""
    return {
        "configured": bool(trader.gmail_cookies),
    }


class ImConnectRequest(BaseModel):
    cookies: list  # Full cookie objects from desktop app Chrome session


@router.post("/connect-im")
async def connect_im(
    data: ImConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Store I&M Bank session cookies captured by desktop app after manual login."""
    if not data.cookies or len(data.cookies) < 3:
        raise HTTPException(status_code=400, detail="Not enough cookies — make sure you are fully logged in to I&M.")
    trader.im_cookies = encrypt_data(json.dumps(data.cookies))
    trader.im_connected = True
    trader.last_extension_sync = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok", "message": "I&M session saved.", "cookies_received": len(data.cookies)}


@router.post("/pause-bot/request-otp")
async def request_pause_otp(trader: Trader = Depends(get_current_trader)):
    """Send OTP to trader's phone before allowing bot pause."""
    import random
    from app.api.routes.auth import _login_otp_codes
    otp_code = str(random.randint(100000, 999999))
    _login_otp_codes[f"pause_{trader.email}"] = otp_code
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception:
        pass
    return {
        "message": f"OTP sent to ***{trader.phone[-4:]}",
        "security_question": trader.security_question or "What is your mother's maiden name?",
    }


class SetupTotpVerifyRequest(BaseModel):
    secret: str   # The generated secret to confirm
    code: str     # 6-digit code user entered from Google Authenticator


@router.get("/setup-totp")
async def get_totp_setup(trader: Trader = Depends(get_current_trader)):
    """Generate a new TOTP secret and return the otpauth URI for QR code display."""
    import pyotp
    secret = pyotp.random_base32()
    app_name = "SparkP2P"
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=trader.email, issuer_name=app_name)
    return {"secret": secret, "uri": uri}


@router.post("/setup-totp/verify")
async def verify_and_save_totp(
    data: SetupTotpVerifyRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify the 6-digit code then save the TOTP secret to the trader's account."""
    import pyotp
    totp = pyotp.TOTP(data.secret)
    if not totp.verify(data.code.strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code. Make sure your phone's time is synced and try again.")
    # Save encrypted secret
    from app.core.security import encrypt_data
    trader.totp_secret = encrypt_data(data.secret)
    await db.commit()
    return {"success": True, "message": "Google Authenticator linked successfully."}


@router.delete("/setup-totp")
async def remove_totp(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Remove Google Authenticator from this account."""
    trader.totp_secret = None
    await db.commit()
    return {"success": True}


class VerifyTotpRequest(BaseModel):
    code: str

@router.post("/verify-totp")
async def verify_totp_code(
    data: VerifyTotpRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify a TOTP code for the current trader (used to unlock sensitive dashboard data)."""
    if not trader.totp_secret:
        raise HTTPException(status_code=400, detail="Google Authenticator not configured on this account.")
    from app.core.security import decrypt_data as decrypt_value
    try:
        secret = decrypt_value(trader.totp_secret)
    except Exception:
        secret = trader.totp_secret
    if not _verify_totp(secret, data.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid code. Please try again.")
    return {"success": True}


class PauseBotRequest(BaseModel):
    otp_code: str
    security_answer: str
    totp_code: Optional[str] = None  # Google Authenticator 6-digit code (required for admin)


def _verify_totp(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code against a base32 secret (same algorithm as the desktop app)."""
    import hmac, hashlib, struct, time, base64
    try:
        secret_clean = secret.upper().replace(' ', '').replace('=', '')
        # Pad to multiple of 8
        pad = (8 - len(secret_clean) % 8) % 8
        key = base64.b32decode(secret_clean + '=' * pad)
        counter = int(time.time()) // 30
        # Check current window and ±1 for clock skew
        for offset in [-1, 0, 1]:
            msg = struct.pack('>Q', counter + offset)
            h = hmac.new(key, msg, hashlib.sha1).digest()
            o = h[19] & 0x0f
            otp = ((h[o] & 0x7f) << 24 | h[o+1] << 16 | h[o+2] << 8 | h[o+3]) % 1_000_000
            if str(otp).zfill(6) == code.strip():
                return True
        return False
    except Exception:
        return False


@router.post("/pause-bot/confirm")
async def confirm_pause_bot(data: PauseBotRequest, trader: Trader = Depends(get_current_trader)):
    """Verify OTP + security answer + (for admin) Google Authenticator TOTP."""
    from app.api.routes.auth import _login_otp_codes
    from app.core.security import verify_password

    stored = _login_otp_codes.get(f"pause_{trader.email}")
    if not stored or stored != data.otp_code:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code.")

    if not trader.security_answer_hash or not verify_password(data.security_answer.strip().lower(), trader.security_answer_hash):
        raise HTTPException(status_code=400, detail="Incorrect security answer.")

    # Admin must also verify Google Authenticator — but only if TOTP is configured
    if trader.is_admin and trader.totp_secret:
        if not data.totp_code:
            raise HTTPException(status_code=400, detail="Google Authenticator code is required.")
        totp_secret = None
        from app.core.security import decrypt_data
        try:
            totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            totp_secret = trader.totp_secret
        if not totp_secret or not _verify_totp(totp_secret, data.totp_code):
            raise HTTPException(status_code=400, detail="Invalid Google Authenticator code.")

    del _login_otp_codes[f"pause_{trader.email}"]
    return {"authorized": True}


@router.post("/disconnect-im")
async def disconnect_im(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Clear I&M Bank session."""
    trader.im_cookies = None
    trader.im_connected = False
    await db.commit()
    return {"status": "ok"}


class MpesaPortalConnectRequest(BaseModel):
    connected: bool = True


@router.post("/connect-mpesa-portal")
async def connect_mpesa_portal(
    data: MpesaPortalConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this once M-PESA org portal login is confirmed."""
    trader.mpesa_portal_connected = data.connected
    await db.commit()
    return {"status": "ok", "mpesa_portal_connected": data.connected}


@router.post("/disconnect-mpesa-portal")
async def disconnect_mpesa_portal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Clear M-PESA org portal connection status."""
    trader.mpesa_portal_connected = False
    await db.commit()
    return {"status": "ok"}


@router.get("/stats/today")
async def get_today_stats(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Return 24-hour trading statistics that reset at midnight Kenyan time (EAT = UTC+3).
    """
    # Midnight today in EAT (UTC+3)
    eat_offset = timedelta(hours=3)
    now_eat = datetime.now(timezone.utc) + eat_offset
    midnight_eat = now_eat.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight_utc = midnight_eat - eat_offset  # convert back to UTC for DB query

    # Completed orders since midnight EAT
    orders_q = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status == OrderStatus.COMPLETED,
            Order.created_at >= midnight_utc,
        )
    )
    orders_today = orders_q.scalars().all()

    trades_count = len(orders_today)
    usdt_traded = sum(o.crypto_amount for o in orders_today)
    kes_volume = sum(o.fiat_amount for o in orders_today)

    # Gross profit = KES received (sell credits) - KES paid (buy debits) since midnight EAT
    txn_q = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type.in_([
                TransactionType.SELL_CREDIT,
                TransactionType.BUY_DEBIT,
            ]),
            WalletTransaction.created_at >= midnight_utc,
        )
    )
    txns_today = txn_q.scalars().all()

    sell_credits = sum(t.amount for t in txns_today if t.transaction_type == TransactionType.SELL_CREDIT)
    buy_debits = sum(t.amount for t in txns_today if t.transaction_type == TransactionType.BUY_DEBIT)
    # buy_debit amounts are negative; gross profit = net KES flow from trading
    gross_profit = sell_credits + buy_debits

    return {
        "trades_count": trades_count,
        "usdt_traded": round(usdt_traded, 4),
        "kes_volume": round(kes_volume, 2),
        "gross_profit": round(gross_profit, 2),
        "reset_at": midnight_utc.isoformat(),
    }


class PinChangeVerifyRequest(BaseModel):
    otp_code: str
    totp_code: str = None


@router.post("/verify-pin-change")
async def verify_pin_change(data: PinChangeVerifyRequest, trader: Trader = Depends(get_current_trader)):
    """Verify OTP + TOTP (no security answer) before allowing I&M PIN change."""
    from app.api.routes.auth import _login_otp_codes

    stored = _login_otp_codes.get(f"pause_{trader.email}")
    if not stored or stored != data.otp_code:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code.")

    if trader.totp_secret:
        if not data.totp_code:
            raise HTTPException(status_code=400, detail="Google Authenticator code is required.")
        from app.core.security import decrypt_data
        try:
            totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            totp_secret = trader.totp_secret
        if not totp_secret or not _verify_totp(totp_secret, data.totp_code):
            raise HTTPException(status_code=400, detail="Invalid Google Authenticator code.")

    del _login_otp_codes[f"pause_{trader.email}"]
    return {"authorized": True}
