import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Trader
from app.models.subscription import Subscription, SubscriptionPlan, SubscriptionStatus
from app.api.deps import get_current_trader, get_admin_trader
from app.services.mpesa.client import mpesa_client

logger = logging.getLogger(__name__)

router = APIRouter()

# Prices come from the central plan config (app/services/plans.py) — single source of truth.
from app.services.plans import PLAN_CONFIG, plan_price as _plan_price

PLAN_PRICES = {plan: cfg["price"] for plan, cfg in PLAN_CONFIG.items()}

PLAN_TIERS = {
    SubscriptionPlan.STARTER: "standard",
    SubscriptionPlan.PRO: "pro",
    SubscriptionPlan.PRO_MAX: "pro_max",
}


# ── Schemas ───────────────────────────────────────────────────────

class InitiateSubscriptionRequest(BaseModel):
    plan: str  # "starter" or "pro"
    phone: str


class SubscriptionStatusResponse(BaseModel):
    has_subscription: bool
    plan: str | None = None
    status: str | None = None
    expires_at: str | None = None
    days_remaining: int | None = None
    amount: float | None = None


# ── Routes ────────────────────────────────────────────────────────

@router.post("/initiate")
async def initiate_subscription(
    data: InitiateSubscriptionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Initiate subscription payment via M-Pesa STK Push."""
    # Validate plan
    try:
        plan = SubscriptionPlan(data.plan.lower())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid plan. Use 'starter', 'pro', or 'pro_max'.")
    if plan not in PLAN_PRICES:
        raise HTTPException(status_code=400, detail="That plan is not available. Use 'starter', 'pro', or 'pro_max'.")

    amount = PLAN_PRICES[plan]

    # Create pending subscription
    subscription = Subscription(
        trader_id=trader.id,
        plan=plan,
        status=SubscriptionStatus.PENDING,
        amount=amount,
    )
    db.add(subscription)
    await db.commit()
    await db.refresh(subscription)

    # Send STK Push
    from app.services.billing import account_number as _acct
    account_ref = _acct(trader.id)   # SPK<id> — unified across STK / manual / Choice Bank
    try:
        result = await mpesa_client.stk_push(
            phone=data.phone,
            amount=amount,
            account_reference=account_ref,
            description=f"{plan.value.title()} Plan",
        )

        # Store checkout request ID
        checkout_id = result.get("CheckoutRequestID")
        subscription.mpesa_checkout_id = checkout_id
        await db.commit()

        return {
            "status": "pending",
            "subscription_id": subscription.id,
            "checkout_request_id": checkout_id,
            "message": f"STK Push sent to {data.phone}. Enter your M-Pesa PIN to complete payment.",
        }
    except Exception as e:
        logger.error(f"STK Push failed for subscription {subscription.id}: {e}")
        subscription.status = SubscriptionStatus.EXPIRED
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send STK Push: {str(e)}")


@router.post("/callback")
async def subscription_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """M-Pesa STK Push callback for subscription payments."""
    data = await request.json()
    logger.info(f"Subscription STK Callback: {data}")

    # Parse callback
    body = data.get("Body", {}).get("stkCallback", {})
    result_code = body.get("ResultCode")
    checkout_id = body.get("CheckoutRequestID")

    if not checkout_id:
        logger.warning("Subscription callback missing CheckoutRequestID")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    # Find subscription by checkout ID
    result = await db.execute(
        select(Subscription).where(Subscription.mpesa_checkout_id == checkout_id)
    )
    subscription = result.scalar_one_or_none()

    if not subscription:
        logger.warning(f"No subscription found for checkout {checkout_id}")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    if result_code == 0:
        # Payment successful
        now = datetime.now(timezone.utc)
        subscription.status = SubscriptionStatus.ACTIVE
        subscription.started_at = now
        subscription.expires_at = now + timedelta(days=30)

        # Extract M-Pesa receipt number from callback metadata
        metadata = body.get("CallbackMetadata", {}).get("Item", [])
        for item in metadata:
            if item.get("Name") == "MpesaReceiptNumber":
                subscription.mpesa_transaction_id = item.get("Value")
                break

        # Update trader tier based on plan
        trader_result = await db.execute(
            select(Trader).where(Trader.id == subscription.trader_id)
        )
        trader = trader_result.scalar_one_or_none()
        if trader:
            trader.tier = PLAN_TIERS.get(subscription.plan, "standard")

        await db.commit()
        logger.info(f"Subscription {subscription.id} activated for trader {subscription.trader_id}")
    else:
        # Payment failed
        subscription.status = SubscriptionStatus.EXPIRED
        await db.commit()
        logger.warning(f"Subscription {subscription.id} payment failed: code={result_code}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.get("/status", response_model=SubscriptionStatusResponse)
async def get_subscription_status(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Check current subscription status for logged-in trader."""
    result = await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.expires_at.desc())
    )
    sub = result.scalar_one_or_none()

    if sub and sub.is_active:
        days_remaining = (sub.expires_at - datetime.now(timezone.utc)).days if sub.expires_at else 0
        return SubscriptionStatusResponse(
            has_subscription=True,
            plan=sub.plan.value,
            status=sub.status.value,
            expires_at=sub.expires_at.isoformat() if sub.expires_at else None,
            days_remaining=max(0, days_remaining),
            amount=sub.amount,
        )

    return SubscriptionStatusResponse(has_subscription=False)


@router.post("/renew")
async def renew_subscription(
    data: InitiateSubscriptionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Renew an expiring or expired subscription."""
    # Validate plan
    try:
        plan = SubscriptionPlan(data.plan.lower())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid plan. Use 'starter', 'pro', or 'pro_max'.")
    if plan not in PLAN_PRICES:
        raise HTTPException(status_code=400, detail="That plan is not available. Use 'starter', 'pro', or 'pro_max'.")

    amount = PLAN_PRICES[plan]

    # Create new subscription record for renewal
    subscription = Subscription(
        trader_id=trader.id,
        plan=plan,
        status=SubscriptionStatus.PENDING,
        amount=amount,
    )
    db.add(subscription)
    await db.commit()
    await db.refresh(subscription)

    # Send STK Push
    from app.services.billing import account_number as _acct
    account_ref = _acct(trader.id)   # SPK<id> — unified across STK / manual / Choice Bank
    try:
        result = await mpesa_client.stk_push(
            phone=data.phone,
            amount=amount,
            account_reference=account_ref,
            description=f"{plan.value.title()} Renewal",
        )

        checkout_id = result.get("CheckoutRequestID")
        subscription.mpesa_checkout_id = checkout_id
        await db.commit()

        return {
            "status": "pending",
            "subscription_id": subscription.id,
            "checkout_request_id": checkout_id,
            "message": f"STK Push sent to {data.phone}. Enter your M-Pesa PIN to renew.",
        }
    except Exception as e:
        logger.error(f"STK Push failed for renewal {subscription.id}: {e}")
        subscription.status = SubscriptionStatus.EXPIRED
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send STK Push: {str(e)}")


class ChoicePayRequest(BaseModel):
    plan: str


class OtpConfirmRequest(BaseModel):
    otp: str


_pending_choice_sub: dict[int, dict] = {}


@router.get("/payment-info")
async def payment_info(trader: Trader = Depends(get_current_trader)):
    """Manual-payment details for the Subscribe page: Paybill + the trader's unique account number,
    the plan price list, and whether they have a Choice Bank wallet to pay from."""
    from app.core.config import settings
    from app.services.billing import account_number
    return {
        "paybill": settings.SUBSCRIPTION_PAYBILL,
        "account_number": account_number(trader.id),
        "plans": [{"key": p.value, "label": cfg["label"], "price": cfg["price"]} for p, cfg in PLAN_CONFIG.items()],
        "has_choice_account": bool(trader.choice_account_id),
    }


@router.post("/pay-choice/initiate")
async def pay_choice_initiate(
    data: ChoicePayRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Pay a plan straight from the trader's Choice Bank wallet — a Choice->Paybill B2B transfer to
    SUBSCRIPTION_PAYBILL with their SPK account number. Activation happens via the C2B confirmation
    when the money lands on the Paybill (same path as manual/STK)."""
    from app.core.config import settings
    from app.services.billing import account_number
    from app.services.choice_bank import client as choice
    try:
        plan = SubscriptionPlan(data.plan.lower())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid plan.")
    if plan not in PLAN_PRICES:
        raise HTTPException(status_code=400, detail="That plan is not available.")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked. Verify Choice Bank first.")
    amount = PLAN_PRICES[plan]
    acct = account_number(trader.id)
    try:
        result = await choice.mpesa_business_transfer(
            payer_account_id=trader.choice_account_id,
            business_number=settings.SUBSCRIPTION_PAYBILL,
            amount=amount,
            account_number=acct,
            is_paybill=True,
            remark=f"SparkP2P {plan.value} subscription",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not start the payment: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Payment rejected by Choice Bank"))
    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")
    try:
        await choice.send_otp(tx_id)
    except Exception as exc:
        logger.warning(f"[Sub] Choice pay sendOtp failed: {exc}")
    _pending_choice_sub[trader.id] = {"tx_id": tx_id, "plan": plan.value, "amount": amount}
    return {"status": "otp_sent", "message": "Enter the OTP sent to your phone to confirm payment from your Choice Bank wallet."}


@router.post("/pay-choice/confirm")
async def pay_choice_confirm(
    body: OtpConfirmRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Confirm the OTP to release the Choice Bank payment. The subscription then activates when the
    Paybill C2B confirmation arrives."""
    from app.services.choice_bank import client as choice
    pending = _pending_choice_sub.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending payment. Please start again.")
    try:
        result = await choice.confirm_otp(pending["tx_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))
    _pending_choice_sub.pop(trader.id, None)
    return {"status": "success", "message": "Payment sent from your Choice Bank wallet. Your subscription will activate shortly."}


@router.get("/admin/all")
async def admin_list_subscriptions(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Admin endpoint to see all subscriptions."""
    result = await db.execute(
        select(Subscription, Trader.full_name, Trader.email)
        .join(Trader, Subscription.trader_id == Trader.id)
        .order_by(Subscription.created_at.desc())
    )
    rows = result.all()

    return [
        {
            "id": sub.id,
            "trader_id": sub.trader_id,
            "trader_name": name,
            "trader_email": email,
            "plan": sub.plan.value,
            "status": sub.status.value,
            "amount": sub.amount,
            "started_at": sub.started_at.isoformat() if sub.started_at else None,
            "expires_at": sub.expires_at.isoformat() if sub.expires_at else None,
            "mpesa_transaction_id": sub.mpesa_transaction_id,
            "created_at": sub.created_at.isoformat() if sub.created_at else None,
        }
        for sub, name, email in rows
    ]
