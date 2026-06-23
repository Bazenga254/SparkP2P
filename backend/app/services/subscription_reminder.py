"""Pre-expiry SMS reminders — 5 days and 3 days before a subscription lapses.

Idempotent via the reminder_5d_sent / reminder_3d_sent flags on the subscription (reset on
renewal). The disconnection-day SMS is sent by the subscription_enforcer when it flips a sub to
EXPIRED. Gated by ENFORCEMENT_ENABLED so we never warn about a disconnection that won't happen.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.models.subscription import Subscription, SubscriptionStatus
from app.models.trader import Trader
from app.services.billing import account_number
from app.services.plans import plan_label, plan_price
from app.services.sms import sms_subscription_reminder

logger = logging.getLogger(__name__)

_INTERVAL = 3600  # hourly


async def subscription_reminder():
    logger.info("[Reminder] subscription_reminder started")
    while True:
        try:
            if not settings.ENFORCEMENT_ENABLED:
                await asyncio.sleep(_INTERVAL)
                continue
            async with async_session() as db:
                now = datetime.now(timezone.utc)
                subs = (await db.execute(select(Subscription).where(
                    Subscription.status == SubscriptionStatus.ACTIVE,
                    Subscription.expires_at.isnot(None),
                    Subscription.expires_at > now,
                ))).scalars().all()
                changed = False
                for sub in subs:
                    days_left = (sub.expires_at - now).total_seconds() / 86400.0
                    if days_left > 5:
                        continue
                    trader = (await db.execute(select(Trader).where(Trader.id == sub.trader_id))).scalar_one_or_none()
                    if not trader or getattr(trader, "billing_exempt", False) or not trader.phone:
                        continue
                    exp_str = sub.expires_at.astimezone(timezone(timedelta(hours=3))).strftime("%d %b %Y")
                    amount = plan_price(sub.plan)
                    acct = account_number(trader.id)
                    pb = settings.SUBSCRIPTION_PAYBILL
                    # 3-day (urgent) takes priority; also marks 5d so we don't double-send.
                    if days_left <= 3 and not sub.reminder_3d_sent:
                        sms_subscription_reminder(trader.phone, trader.full_name, plan_label(sub.plan), exp_str, amount, acct, 3, pb)
                        sub.reminder_3d_sent = True
                        sub.reminder_5d_sent = True
                        changed = True
                    elif days_left <= 5 and not sub.reminder_5d_sent:
                        sms_subscription_reminder(trader.phone, trader.full_name, plan_label(sub.plan), exp_str, amount, acct, 5, pb)
                        sub.reminder_5d_sent = True
                        changed = True
                if changed:
                    await db.commit()
        except Exception as e:
            logger.error(f"[Reminder] error: {e}")
        await asyncio.sleep(_INTERVAL)
