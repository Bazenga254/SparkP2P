"""Subscription billing — per-trader Paybill account numbers + payment activation.

Every trader pays the production Paybill (settings.SUBSCRIPTION_PAYBILL = 4041355) using a unique
account number **SPK<6-digit id>** (e.g. trader #9 -> SPK000009). All three payment paths land on
that Paybill and flow through the M-Pesa C2B confirmation callback, which calls
activate_subscription_payment() here:
  * STK push from the Subscribe page
  * Manual Paybill payment (customer types the account number)
  * "Pay with Choice Bank" (a Choice->Paybill B2B transfer with the same account number)
"""
import logging
import re
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, text

from app.core.config import settings
from app.models.subscription import Subscription, SubscriptionStatus
from app.models.trader import Trader
from app.services.plans import PLAN_CONFIG, plan_label, active_plan

logger = logging.getLogger(__name__)


def account_number(trader_id: int) -> str:
    """The trader's unique Paybill account number, e.g. 9 -> 'SPK000009'."""
    return f"SPK{int(trader_id):06d}"


def parse_account_number(ref: str):
    """Reverse: 'SPK000009' / 'spk9' -> 9, or None if not a SparkP2P account ref."""
    m = re.match(r"^SPK0*(\d+)$", (ref or "").strip().upper())
    return int(m.group(1)) if m else None


def plan_for_amount(amount):
    """Map a paid amount to a plan by exact price (3000/5000/10000). None if no match."""
    for plan, cfg in PLAN_CONFIG.items():
        if abs(float(amount) - float(cfg["price"])) < 1:
            return plan
    return None


def _highest_affordable(balance: float):
    """The most expensive plan whose price the balance can cover, or None."""
    best = None
    best_price = -1
    for plan, cfg in PLAN_CONFIG.items():
        price = float(cfg["price"])
        if balance + 0.01 >= price and price > best_price:
            best, best_price = plan, price
    return best


async def credit_subscription_payment(db, trader_id: int, amount: float, txn_id: str = "",
                                      source: str = "mpesa", target_plan=None):
    """Credit a payment to the trader's prepaid subscription balance, then activate a plan if the
    balance covers it.

    target_plan set (STK / Choice / activate-from-balance): activate exactly that plan when the
    balance covers its price. target_plan None (manual Paybill): activate the highest plan the
    balance can now afford. When nothing is activated yet, the money sits in the balance ("pay
    slowly") and a deposit SMS is sent. Returns the activated SubscriptionPlan, or None.
    """
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        logger.error(f"[Billing] payment for unknown trader {trader_id} (amount {amount})")
        return None

    # Idempotency: an STK-to-Paybill payment fires BOTH the STK callback and the C2B confirmation
    # with the same M-Pesa receipt. Process it once — skip if we already recorded this receipt.
    if txn_id:
        from app.models.wallet import WalletTransaction
        # Serialize concurrent processing of the SAME receipt. Without this the two callbacks
        # (arriving within milliseconds) each run the dup-check below before either commits its
        # deposit, so both proceed and create a duplicate subscription + charge — exactly what
        # happened to receipt UGA2WAFXMQ (one KES 13,000 payment counted as two). The advisory
        # lock is held to end-of-transaction, so the second caller blocks here until the first
        # commits, then finds the committed row and skips.
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:r))"), {"r": str(txn_id)})
        dup = (await db.execute(
            select(WalletTransaction).where(
                WalletTransaction.trader_id == trader_id,
                WalletTransaction.mpesa_receipt == txn_id,
            ).limit(1)
        )).scalars().first()
        if dup:
            logger.info(f"[Billing] payment {txn_id} already processed for trader {trader_id} — skipped")
            return None

    balance = float(trader.subscription_balance or 0) + float(amount or 0)

    if target_plan is not None:
        price = float(PLAN_CONFIG[target_plan]["price"])
        plan = target_plan if balance + 0.01 >= price else None
    else:
        plan = _highest_affordable(balance)

    from app.services.ledger import record_activity
    from app.models.wallet import TransactionType as _TT

    if plan is None:
        # Still accumulating — hold the money and tell them where they stand.
        trader.subscription_balance = balance
        if float(amount or 0) > 0:
            await record_activity(db, trader_id, _TT.SUBSCRIPTION_DEPOSIT, float(amount),
                                  f"Subscription deposit via {source}", balance_after=balance,
                                  mpesa_receipt=txn_id)
        await db.commit()
        try:
            from app.services.sms import sms_subscription_deposit
            from app.models.subscription import SubscriptionPlan as _SP
            # Reference the plan the trader is ON (their tier), not just the cheapest — a Pro Max
            # user topping up should hear about Pro Max. Free users fall back to the cheapest plan.
            _tier_map = {"starter": _SP.STARTER, "pro": _SP.PRO, "pro_max": _SP.PRO_MAX}
            target = _tier_map.get((trader.tier or "").lower())
            cfg = PLAN_CONFIG[target] if target else min(PLAN_CONFIG.values(), key=lambda c: c["price"])
            due = max(0, float(cfg["price"]) - balance)
            if trader.phone:
                sms_subscription_deposit(trader.phone, trader.full_name, amount, balance,
                                         due, cfg["label"], account_number(trader_id),
                                         _paybill())
        except Exception as e:
            logger.warning(f"[Billing] deposit SMS failed for trader {trader_id}: {e}")
        logger.warning(f"[Billing] trader {trader_id} +{amount} -> balance {balance} (no plan yet)")
        return None

    # Activate / extend the plan; deduct its price from the balance.
    price = float(PLAN_CONFIG[plan]["price"])
    now = datetime.now(timezone.utc)
    was_active = (await active_plan(db, trader_id)) is not None
    latest = (await db.execute(
        select(Subscription).where(Subscription.trader_id == trader_id).order_by(Subscription.created_at.desc())
    )).scalars().first()
    still_active = bool(latest and latest.status == SubscriptionStatus.ACTIVE
                        and latest.expires_at and latest.expires_at > now)
    base = latest.expires_at if still_active else now
    new_exp = base + timedelta(days=30)

    if still_active:
        latest.plan = plan
        latest.amount = price
        latest.expires_at = new_exp
        latest.mpesa_transaction_id = txn_id or latest.mpesa_transaction_id
        latest.reminder_5d_sent = False
        latest.reminder_3d_sent = False
    else:
        db.add(Subscription(
            trader_id=trader_id, plan=plan, status=SubscriptionStatus.ACTIVE,
            amount=price, started_at=now, expires_at=new_exp, mpesa_transaction_id=txn_id or None,
        ))
    trader.tier = plan.value
    trader.subscription_balance = max(0.0, balance - price)
    # Ledger: record the incoming payment (if any) then the plan charge.
    if float(amount or 0) > 0:
        await record_activity(db, trader_id, _TT.SUBSCRIPTION_DEPOSIT, float(amount),
                              f"Subscription deposit via {source}", balance_after=balance,
                              mpesa_receipt=txn_id)
    await record_activity(db, trader_id, _TT.SUBSCRIPTION_CHARGE, -price,
                          f"{plan_label(plan)} subscription activated",
                          balance_after=trader.subscription_balance)
    await db.commit()

    # Credit 20% of the subscription price to the referring affiliate (if any)
    try:
        from app.api.routes.affiliates import credit_affiliate_commission
        await credit_affiliate_commission(
            db, trader_id,
            referred_by_code=trader.referred_by_code,
            subscription_price=price,
            plan_label=plan_label(plan),
        )
        await db.commit()
    except Exception as _e:
        logger.warning(f"[Billing] affiliate commission failed for trader {trader_id}: {_e}")

    try:
        from app.services.sms import sms_subscription_renewed
        exp_str = new_exp.astimezone(timezone(timedelta(hours=3))).strftime("%d %b %Y")
        sms_subscription_renewed(trader.phone, trader.full_name, plan_label(plan), exp_str, was_disconnected=not was_active)
    except Exception as e:
        logger.warning(f"[Billing] renewal SMS failed for trader {trader_id}: {e}")

    logger.warning(f"[Billing] trader {trader_id} {plan.value} activated via {source} until {new_exp} "
                   f"(balance left {trader.subscription_balance}, was_active={was_active})")
    return plan


def _paybill():
    return settings.SUBSCRIPTION_PAYBILL


# Backwards-compatible alias (manual Paybill C2B path).
async def activate_subscription_payment(db, trader_id: int, amount: float, txn_id: str = "", source: str = "mpesa"):
    return await credit_subscription_payment(db, trader_id, amount, txn_id, source, target_plan=None)
