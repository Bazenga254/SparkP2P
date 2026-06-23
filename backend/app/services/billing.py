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

from sqlalchemy import select

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


async def activate_subscription_payment(db, trader_id: int, amount: float, txn_id: str = "", source: str = "mpesa"):
    """Activate or extend a trader's subscription from a confirmed payment, then SMS them.

    Renewing early (still active) extends from the current expiry; renewing after disconnection
    starts a fresh 30-day period from now and the SMS tells them to reconfigure their bot.
    Returns the SubscriptionPlan applied, or None if the amount matched no plan / trader missing.
    """
    plan = plan_for_amount(amount)
    if plan is None:
        logger.warning(f"[Billing] payment {amount} for trader {trader_id} matches no plan price — ignored")
        return None
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        logger.error(f"[Billing] payment for unknown trader {trader_id} (ref amount {amount})")
        return None

    now = datetime.now(timezone.utc)
    # Was the trader entitled BEFORE this payment? If not, they were disconnected (reconfigure).
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
        latest.amount = float(amount)
        latest.expires_at = new_exp
        latest.mpesa_transaction_id = txn_id or latest.mpesa_transaction_id
        latest.reminder_5d_sent = False
        latest.reminder_3d_sent = False
    else:
        db.add(Subscription(
            trader_id=trader_id, plan=plan, status=SubscriptionStatus.ACTIVE,
            amount=float(amount), started_at=now, expires_at=new_exp,
            mpesa_transaction_id=txn_id or None,
        ))
    trader.tier = plan.value
    await db.commit()

    # Notify
    try:
        from app.services.sms import sms_subscription_renewed
        exp_str = new_exp.astimezone(timezone(timedelta(hours=3))).strftime("%d %b %Y")
        sms_subscription_renewed(trader.phone, trader.full_name, plan_label(plan), exp_str, was_disconnected=not was_active)
    except Exception as e:
        logger.warning(f"[Billing] renewal SMS failed for trader {trader_id}: {e}")

    logger.warning(f"[Billing] trader {trader_id} {plan.value} activated via {source} until {new_exp} "
                   f"(was_active={was_active})")
    return plan
