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
    SubscriptionPlan.ADVANCED: "advanced",   # hidden B2C plan
}


# ── Schemas ───────────────────────────────────────────────────────

class InitiateSubscriptionRequest(BaseModel):
    plan: str  # "starter" or "pro"
    phone: str


class BuyCreditsRequest(BaseModel):
    phone: str
    amount: float


class SubscriptionStatusResponse(BaseModel):
    has_subscription: bool
    plan: str | None = None
    status: str | None = None
    expires_at: str | None = None
    days_remaining: int | None = None
    amount: float | None = None


# ── Routes ────────────────────────────────────────────────────────

@router.get("/plans")
async def list_plans():
    """Public plan catalogue — label + price straight from plans.py PLAN_CONFIG.

    Every UI (landing page, subscribe page, dashboard cards, admin tier picker) must read
    prices from here rather than hardcoding a copy. Hardcoded copies drifted before: the
    cards advertised KES 3,000 while the backend charged KES 10,000.
    """
    from app.services.plans import PLAN_ORDER, UNLIMITED
    return {"plans": [
        {
            "key": p.value,
            "label": PLAN_CONFIG[p]["label"],
            "price": PLAN_CONFIG[p]["price"],
            "daily_trades": PLAN_CONFIG[p]["daily_trades"] or None,   # None = unlimited
            "daily_tg": PLAN_CONFIG[p]["daily_tg"] or None,
        }
        for p in PLAN_ORDER
    ]}


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

    # B2C own-paybill clients are locked to the hidden B2C plan (no downgrade); everyone else
    # is blocked from selecting it.
    if getattr(trader, "b2c_own_paybill_enabled", False):
        plan = SubscriptionPlan.ADVANCED
    elif plan == SubscriptionPlan.ADVANCED:
        raise HTTPException(status_code=403, detail="That plan isn't available on your account.")

    # Charge only the difference after the prepaid subscription balance.
    from app.services.billing import account_number as _acct, credit_subscription_payment
    price = PLAN_PRICES[plan]
    balance = float(trader.subscription_balance or 0)
    due = max(0, price - balance)
    if due <= 0:
        # Balance already covers the plan — activate straight away, no STK needed.
        await credit_subscription_payment(db, trader.id, 0.0, source="balance", target_plan=plan)
        return {"status": "activated", "message": f"{plan.value.replace('_', ' ').title()} activated from your balance."}

    # Create pending subscription (amount = the charged difference)
    subscription = Subscription(
        trader_id=trader.id,
        plan=plan,
        status=SubscriptionStatus.PENDING,
        amount=due,
    )
    db.add(subscription)
    await db.commit()
    await db.refresh(subscription)

    # Send STK Push for the difference
    account_ref = _acct(trader.id)   # SPK<id> — unified across STK / manual / Choice Bank
    try:
        result = await mpesa_client.stk_push(
            phone=data.phone,
            amount=due,
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
            "amount_charged": due,
            "message": f"STK Push of KES {due:,.0f} sent to {data.phone}. Enter your M-Pesa PIN to complete payment.",
        }
    except Exception as e:
        logger.error(f"STK Push failed for subscription {subscription.id}: {e}")
        subscription.status = SubscriptionStatus.EXPIRED
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send STK Push: {str(e)}")


@router.get("/credits")
async def get_credits(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """The merchant's credit balance for the SparkP2P dashboard card. Only
    meaningful on the prepaid rails (I&M Bot / Own-Paybill) — a Choice Bank trader
    gets credits_enabled=false and no card is shown."""
    from app.services.credits import trader_credits_enabled, trader_balance, credit_rate_for_trader, MIN_DEPOSIT_KES
    from app.core.config import settings
    from app.models.subscription import CreditPurchase
    enabled = trader_credits_enabled(trader)
    balance = trader_balance(trader)
    rate = await credit_rate_for_trader(db, trader.id) if enabled else None
    recent = (await db.execute(
        select(CreditPurchase).where(CreditPurchase.trader_id == trader.id,
                                     CreditPurchase.status == "completed")
        .order_by(CreditPurchase.created_at.desc()).limit(10)
    )).scalars().all()
    return {
        "credits_enabled": enabled,
        "credits": balance,
        "credit_rate": rate,
        "paused_no_credits": bool(enabled and balance <= 0),
        "min_deposit": MIN_DEPOSIT_KES,
        "paybill": settings.SUBSCRIPTION_PAYBILL,
        "history": [
            {"amount": int(c.amount or 0), "credits": int(c.credits or 0),
             "receipt": c.mpesa_receipt, "at": c.created_at.isoformat() if c.created_at else None}
            for c in recent
        ],
    }


@router.post("/buy-credits")
async def buy_credits(
    data: BuyCreditsRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Buy prepaid payout credits via STK Push to paybill 4041355. 1 credit = 1
    payout, priced at the trader's plan rate (round(amount / rate)); min KES 1,000.
    Only for the prepaid rails (I&M Bot or Own-Paybill/B2C) — a Choice Bank trader
    has no credit balance. Reference CR<id> so the callbacks grant credits."""
    from app.services.credits import trader_credits_enabled, credit_rate_for_trader, credits_for, MIN_DEPOSIT_KES
    if not trader_credits_enabled(trader):
        raise HTTPException(status_code=403, detail="Credits are only for the I&M Bot or Own-Paybill payout rails.")
    amount = int(float(data.amount or 0))
    if amount < MIN_DEPOSIT_KES:
        raise HTTPException(status_code=400, detail=f"Minimum credit purchase is KES {MIN_DEPOSIT_KES:,}.")
    rate = await credit_rate_for_trader(db, trader.id)
    credits = credits_for(amount, rate)
    from app.models.subscription import CreditPurchase
    try:
        result = await mpesa_client.stk_push(
            phone=data.phone, amount=amount,
            account_reference=f"CR{trader.id}", description="B2C Credits",
        )
        checkout_id = result.get("CheckoutRequestID")
    except Exception as e:
        logger.error(f"Buy-credits STK failed for trader {trader.id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send STK Push: {e}")
    cp = CreditPurchase(trader_id=trader.id, amount=amount, credits=credits,
                        mpesa_checkout_id=checkout_id, status="pending")
    db.add(cp)
    await db.commit()
    return {
        "status": "pending", "checkout_request_id": checkout_id, "credits": credits,
        "message": f"STK Push of KES {amount:,} sent to {data.phone}. You'll receive {credits:,} credits once paid.",
    }


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
        # Maybe a Buy-Credits top-up (B2C own-paybill clients) — granted separately, idempotently.
        from app.models.subscription import CreditPurchase
        cp = (await db.execute(
            select(CreditPurchase).where(CreditPurchase.mpesa_checkout_id == checkout_id)
        )).scalars().first()
        if cp:
            if result_code == 0:
                meta = body.get("CallbackMetadata", {}).get("Item", [])
                receipt = ""
                amt = float(cp.amount or 0)
                for item in meta:
                    if item.get("Name") == "MpesaReceiptNumber":
                        receipt = item.get("Value")
                    elif item.get("Name") == "Amount":
                        try:
                            amt = float(item.get("Value") or amt)
                        except (TypeError, ValueError):
                            pass
                # Route to the right population: a trader purchase (trader_id) or
                # a bot-only one (bot_account_id). Both idempotent per receipt.
                if cp.bot_account_id is not None:
                    from app.services.credits import grant_bot_credits
                    await grant_bot_credits(db, cp.bot_account_id, amt, receipt=receipt)
                else:
                    from app.services.billing import grant_b2c_credits
                    await grant_b2c_credits(db, cp.trader_id, amt, receipt=receipt, checkout_id=checkout_id)
            else:
                cp.status = "failed"
                await db.commit()
                logger.warning(f"Credit purchase {cp.id} failed: code={result_code}")
            return {"ResultCode": 0, "ResultDesc": "Accepted"}
        logger.warning(f"No subscription/credit-purchase found for checkout {checkout_id}")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    if result_code == 0:
        # Payment successful — credit the paid amount to the balance, then activate the chosen plan
        # if it's now covered (handles the prepaid-balance / pay-the-difference flow).
        metadata = body.get("CallbackMetadata", {}).get("Item", [])
        receipt = ""
        amount_paid = float(subscription.amount or 0)
        for item in metadata:
            if item.get("Name") == "MpesaReceiptNumber":
                receipt = item.get("Value")
            elif item.get("Name") == "Amount":
                try:
                    amount_paid = float(item.get("Value") or amount_paid)
                except (TypeError, ValueError):
                    pass
        # A plain top-up deposit (marker "DEPOSIT") has no target plan — it just accumulates;
        # a plan purchase targets that plan. Capture the marker before we overwrite the field.
        is_deposit = (subscription.mpesa_transaction_id == "DEPOSIT")
        target = None if is_deposit else subscription.plan
        # This pending row was just the payment intent — the unified credit creates/extends the
        # real active subscription and deducts the plan price from the balance.
        subscription.status = SubscriptionStatus.CANCELLED
        subscription.mpesa_transaction_id = receipt or (None if is_deposit else subscription.mpesa_transaction_id)
        from app.services.billing import credit_subscription_payment
        await credit_subscription_payment(db, subscription.trader_id, amount_paid, txn_id=receipt,
                                          source="stk", target_plan=target)
        logger.info(f"STK payment for trader {subscription.trader_id}: credited {amount_paid}, deposit={is_deposit}")
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


class DepositRequest(BaseModel):
    phone: str
    amount: float


@router.post("/deposit/initiate")
async def initiate_deposit(
    data: DepositRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """STK-push a CUSTOM amount toward the subscription balance ('pay slowly'). No plan is chosen —
    the money accumulates in the balance and a plan activates once it's covered."""
    amt = float(data.amount or 0)
    if amt < 10:
        raise HTTPException(status_code=400, detail="Minimum deposit is KES 10")
    if amt > 250000:
        raise HTTPException(status_code=400, detail="M-Pesa payments are limited to KES 250,000")

    from app.services.billing import account_number as _acct
    # Pending row marked "DEPOSIT" so the STK callback credits the balance with no target plan.
    sub = Subscription(
        trader_id=trader.id, plan=SubscriptionPlan.STARTER, status=SubscriptionStatus.PENDING,
        amount=amt, mpesa_transaction_id="DEPOSIT",
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    try:
        result = await mpesa_client.stk_push(
            phone=data.phone, amount=amt, account_reference=_acct(trader.id),
            description="Subscription deposit",
        )
        sub.mpesa_checkout_id = result.get("CheckoutRequestID")
        await db.commit()
        return {
            "status": "pending",
            "checkout_request_id": result.get("CheckoutRequestID"),
            "amount": amt,
            "message": f"STK Push of KES {amt:,.0f} sent to {data.phone}. Enter your M-Pesa PIN — it'll be added to your balance.",
        }
    except Exception as e:
        logger.error(f"Deposit STK Push failed for trader {trader.id}: {e}")
        sub.status = SubscriptionStatus.EXPIRED
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send STK Push: {str(e)}")


class ChoicePayRequest(BaseModel):
    plan: str


class OtpConfirmRequest(BaseModel):
    otp: str


_pending_choice_sub: dict[int, dict] = {}


@router.get("/payment-info")
async def payment_info(trader: Trader = Depends(get_current_trader),
                       db: AsyncSession = Depends(get_db)):
    """Manual-payment details for the Subscribe page: Paybill + the trader's unique account number,
    the plan price list, current-plan expiry, and whether they have a Choice Bank wallet to pay."""
    from app.core.config import settings
    from app.services.billing import account_number
    from app.services.plans import plan_label
    balance = float(trader.subscription_balance or 0)
    # Latest active subscription — for the expiry + days-remaining display.
    sub = (await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.started_at.desc())
    )).scalars().first()
    expires_at = sub.expires_at.isoformat() if (sub and sub.expires_at) else None
    cur_label = plan_label(sub.plan) if sub else None
    return {
        "paybill": settings.SUBSCRIPTION_PAYBILL,
        "account_number": account_number(trader.id),
        "balance": balance,
        "plans": [{
            "key": p.value, "label": cfg["label"], "price": cfg["price"],
            "due": max(0, cfg["price"] - balance),   # what's left to pay after the balance
        } for p, cfg in PLAN_CONFIG.items()],
        "has_choice_account": bool(trader.choice_account_id),
        "current_plan_label": cur_label,
        "expires_at": expires_at,
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
    from app.services.billing import credit_subscription_payment
    price = PLAN_PRICES[plan]
    balance = float(trader.subscription_balance or 0)
    due = max(0, price - balance)
    if due <= 0:
        # Balance already covers it — activate from balance, no Choice payment needed.
        await credit_subscription_payment(db, trader.id, 0.0, source="balance", target_plan=plan)
        return {"status": "activated", "message": f"{plan.value.replace('_', ' ').title()} activated from your balance."}
    acct = account_number(trader.id)
    try:
        result = await choice.mpesa_business_transfer(
            payer_account_id=trader.choice_account_id,
            business_number=settings.SUBSCRIPTION_PAYBILL,
            amount=due,
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
    _pending_choice_sub[trader.id] = {"tx_id": tx_id, "plan": plan.value, "amount": due}
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
