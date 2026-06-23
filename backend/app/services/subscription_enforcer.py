"""Subscription enforcer — detects newly-expired subscriptions and locks the account.

Runs every few minutes. For each ACTIVE subscription whose expires_at has passed:
  1. Flip its status to EXPIRED.
  2. Unless the trader is billing-exempt, wipe their bot config to zero (destructive) so no
     automation keeps running — auto buy/sell, due-diligence, price-matching, price tracker,
     and all Binance counterparty filters are zeroed.

Choice Bank banking is untouched — it's the user's own money. The actual paid features are also
gated live at request time via app.services.enforcement, so this job is the durable cleanup
(wipe + status flip), not the only line of defence.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select, or_

from app.core.config import settings
from app.core.database import async_session
from app.models.subscription import Subscription, SubscriptionStatus
from app.models.trader import Trader
from app.services.enforcement import wipe_bot_config
from app.services.plans import active_plan

logger = logging.getLogger(__name__)

_INTERVAL = 300  # seconds


async def subscription_enforcer():
    logger.info("[Enforcer] subscription_enforcer started")
    while True:
        try:
            # Master switch off -> never lock or wipe anyone (feature ships as a no-op).
            if not settings.ENFORCEMENT_ENABLED:
                await asyncio.sleep(_INTERVAL)
                continue
            async with async_session() as db:
                now = datetime.now(timezone.utc)
                subs = (await db.execute(
                    select(Subscription).where(
                        Subscription.status == SubscriptionStatus.ACTIVE,
                        Subscription.expires_at.isnot(None),
                        Subscription.expires_at < now,
                    )
                )).scalars().all()
                if subs:
                    for sub in subs:
                        sub.status = SubscriptionStatus.EXPIRED
                        trader = (await db.execute(
                            select(Trader).where(Trader.id == sub.trader_id)
                        )).scalar_one_or_none()
                        if trader and not getattr(trader, "billing_exempt", False):
                            wipe_bot_config(trader)
                            logger.warning(
                                f"[Enforcer] subscription {sub.id} expired for trader {trader.id} "
                                f"({trader.email}) — locked + config wiped"
                            )
                            # Disconnection-day SMS.
                            try:
                                from app.services.billing import account_number
                                from app.services.plans import plan_price
                                from app.services.sms import sms_subscription_disconnected
                                if trader.phone:
                                    sms_subscription_disconnected(
                                        trader.phone, trader.full_name, plan_price(sub.plan),
                                        account_number(trader.id), settings.SUBSCRIPTION_PAYBILL,
                                    )
                            except Exception as _e:
                                logger.warning(f"[Enforcer] disconnect SMS failed for {trader.id}: {_e}")
                        else:
                            logger.warning(f"[Enforcer] subscription {sub.id} expired (trader exempt/missing)")
                    await db.commit()

                # Self-healing sweep: wipe any non-exempt trader who is currently locked (no active
                # plan) yet still carries live bot config — covers never-subscribed / cancelled
                # accounts that have no ACTIVE->EXPIRED transition to catch above.
                candidates = (await db.execute(
                    select(Trader).where(
                        Trader.billing_exempt.is_(False),
                        or_(
                            Trader.auto_release_enabled.is_(True),
                            Trader.auto_pay_enabled.is_(True),
                            Trader.cf_filters_enabled.is_(True),
                            Trader.price_tracker_enabled.is_(True),
                            Trader.pm_enabled.is_(True),
                            Trader.dd_enabled.is_(True),
                        ),
                    )
                )).scalars().all()
                wiped = 0
                for tr in candidates:
                    if await active_plan(db, tr.id) is None:
                        wipe_bot_config(tr)
                        wiped += 1
                if wiped:
                    await db.commit()
                    logger.warning(f"[Enforcer] swept {wiped} locked account(s) — config wiped")
        except Exception as e:
            logger.error(f"[Enforcer] error: {e}")
        await asyncio.sleep(_INTERVAL)
