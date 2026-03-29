import json
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.security import encrypt_data, decode_access_token
from app.models import Trader, SettlementMethod
from app.models.wallet import Wallet, WalletTransaction, TransactionType
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
    settlement_cooldown_until: Optional[str] = None  # ISO datetime when cooldown ends


# In-memory store for phone verification results
_phone_verifications: dict[str, dict] = {}


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

    # Compute onboarding status — Binance + settlement is enough
    # Subscription is optional (shown as banner on dashboard)
    onboarding_complete = (
        trader.binance_connected
        and trader.settlement_method is not None
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
        settlement_cooldown_until=(
            (trader.settlement_changed_at + timedelta(hours=48)).isoformat()
            if trader.settlement_changed_at and
               (trader.settlement_changed_at + timedelta(hours=48)) > datetime.now(timezone.utc)
            else None
        ),
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

    return WalletResponse(
        balance=wallet.balance,
        reserved=wallet.reserved,
        total_earned=wallet.total_earned,
        total_withdrawn=wallet.total_withdrawn,
        total_fees_paid=wallet.total_fees_paid,
        daily_volume=wallet.daily_volume,
        daily_trades=wallet.daily_trades,
    )


@router.post("/wallet/withdraw")
async def request_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Request withdrawal of wallet balance.
    Checks 48-hour cooldown on new payment methods.
    """
    from app.services.settlement.engine import SettlementEngine
    from datetime import datetime, timezone

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

    # Calculate fees
    from app.services.settlement.engine import get_total_settlement_fee
    safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, wallet.balance)
    net_amount = wallet.balance - total_fee

    if net_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Balance too low to cover fees (KES {total_fee})",
        )

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
        "message": f"KES {net_amount:,.0f} sent to your M-Pesa",
        "amount_sent": net_amount,
        "transaction_fee": total_fee,
        "wallet_deducted": wallet.balance + total_fee,
    }


@router.get("/wallet/withdraw/preview")
async def preview_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Preview withdrawal fees before confirming."""
    from app.services.settlement.engine import get_total_settlement_fee

    result = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        return {"can_withdraw": False, "reason": "No funds available"}

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
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get wallet transaction history."""
    result = await db.execute(
        select(WalletTransaction)
        .where(WalletTransaction.trader_id == trader.id)
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
