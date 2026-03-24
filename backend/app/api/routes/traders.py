import json
import logging

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
    cookies: dict  # Browser cookies as JSON
    csrf_token: str
    bnc_uuid: Optional[str] = None
    totp_secret: Optional[str] = None


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


# ── Routes ────────────────────────────────────────────────────────

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
    trader.binance_connected = True
    if binance_name:
        trader.binance_username = binance_name

    await db.commit()

    return {
        "status": "connected",
        "message": "Binance account connected successfully",
        "binance_name": binance_name,
        "registered_name": trader.full_name,
        "name_match": name_match,
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


@router.put("/settlement")
async def update_settlement(
    data: SettlementConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update settlement configuration."""
    trader.settlement_method = data.method
    trader.settlement_phone = data.phone
    trader.settlement_paybill = data.paybill
    trader.settlement_account = data.account
    trader.settlement_bank_name = data.bank_name

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

    return {"status": "updated", "method": data.method.value}


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
    """Request withdrawal of wallet balance."""
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

    engine = SettlementEngine(db)
    success = await engine.batch_settle(trader.id)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Withdrawal failed. Please try again.",
        )

    return {"status": "success", "message": f"KES {wallet.balance} sent to your account"}


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
