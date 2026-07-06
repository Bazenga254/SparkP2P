"""Pre-expiry reminders — 3 days, 2 days, and 1 day before a subscription lapses.

Sends both SMS and Telegram (if the trader has Telegram connected).
Idempotent via reminder_5d_sent (3d), reminder_3d_sent (2d), reminder_1d_sent (1d) flags
on the subscription (column names kept from original to avoid re-migration).
Flags reset on renewal.

The disconnection-day message is sent by subscription_enforcer when it flips a sub to EXPIRED.
Gated by ENFORCEMENT_ENABLED so we never warn about a disconnection that won't happen.
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


def _telegram_reminder_msg(first_name: str, plan: str, expires: str, days: int, amount, acct: str, paybill: str) -> str:
    kes = f"KES {int(amount):,}"
    if days == 1:
        return (
            f"⚠️ *SparkP2P — Subscription expiring TODAY*\n\n"
            f"Hi {first_name}, your *{plan}* subscription expires on *{expires}*. "
            f"Your bot will be *disconnected* and settings reset if you don't renew.\n\n"
            f"*Renew now:* Pay {kes} via M-Pesa Paybill *{paybill}*, Account *{acct}*, "
            f"or use Choice Bank in the app. Renewal is instant once payment is received."
        )
    return (
        f"🔔 *SparkP2P — Subscription expiring in {days} day{'s' if days != 1 else ''}*\n\n"
        f"Hi {first_name}, your *{plan}* subscription expires on *{expires}*. "
        f"Renew to keep your bot running uninterrupted.\n\n"
        f"*Pay {kes}* via M-Pesa Paybill *{paybill}*, Account *{acct}*, "
        f"or instantly from your Choice Bank wallet in the app."
    )


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
                    if days_left > 3:
                        continue
                    trader = (await db.execute(select(Trader).where(Trader.id == sub.trader_id))).scalar_one_or_none()
                    if not trader:
                        continue

                    first = (trader.full_name or "").strip().split(" ")[0] or "Customer"
                    exp_str = sub.expires_at.astimezone(timezone(timedelta(hours=3))).strftime("%d %b %Y")
                    amount = plan_price(sub.plan)
                    acct = account_number(trader.id)
                    pb = settings.SUBSCRIPTION_PAYBILL
                    label = plan_label(sub.plan)

                    async def _notify(days_label: int):
                        """Send SMS + Telegram for a given days_label value."""
                        if trader.phone:
                            try:
                                sms_subscription_reminder(trader.phone, trader.full_name, label, exp_str, amount, acct, days_label, pb)
                            except Exception as e:
                                logger.warning(f"[Reminder] SMS failed for trader {trader.id}: {e}")
                        if getattr(trader, "telegram_chat_id", None):
                            try:
                                from app.api.routes.telegram import notify_trader
                                msg = _telegram_reminder_msg(first, label, exp_str, days_label, amount, acct, pb)
                                await notify_trader(trader, msg)
                            except Exception as e:
                                logger.warning(f"[Reminder] Telegram failed for trader {trader.id}: {e}")

                    # 1-day reminder (highest priority — send first, mark earlier flags too)
                    if days_left <= 1 and not sub.reminder_1d_sent:
                        await _notify(1)
                        sub.reminder_1d_sent = True
                        sub.reminder_3d_sent = True
                        sub.reminder_5d_sent = True
                        changed = True
                    # 2-day reminder
                    elif days_left <= 2 and not sub.reminder_3d_sent:
                        await _notify(2)
                        sub.reminder_3d_sent = True
                        sub.reminder_5d_sent = True
                        changed = True
                    # 3-day reminder
                    elif days_left <= 3 and not sub.reminder_5d_sent:
                        await _notify(3)
                        sub.reminder_5d_sent = True
                        changed = True

                if changed:
                    await db.commit()
        except Exception as e:
            logger.error(f"[Reminder] error: {e}")
        await asyncio.sleep(_INTERVAL)
