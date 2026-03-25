"""Message template service: seeding defaults, caching, and DB lookup."""

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models.message_template import MessageTemplate

logger = logging.getLogger(__name__)

# In-memory cache: key -> body
_template_cache: dict[str, str] = {}

DEFAULT_TEMPLATES = [
    {
        "key": "sms_deposit_received",
        "name": "Deposit Received",
        "channel": "sms",
        "body": "SparkP2P: KES {amount} deposited to your wallet. New balance: KES {balance}. Happy trading!",
        "variables": json.dumps(["amount", "balance"]),
    },
    {
        "key": "sms_withdrawal_sent",
        "name": "Withdrawal Sent",
        "channel": "sms",
        "body": "SparkP2P: KES {amount} sent to your M-Pesa. Remaining balance: KES {balance}.",
        "variables": json.dumps(["amount", "balance"]),
    },
    {
        "key": "sms_sell_order_completed",
        "name": "Sell Order Completed",
        "channel": "sms",
        "body": "SparkP2P: Sell order completed. {crypto_amount} {currency} released. KES {fiat_amount} credited to wallet.",
        "variables": json.dumps(["crypto_amount", "currency", "fiat_amount"]),
    },
    {
        "key": "sms_buy_order_completed",
        "name": "Buy Order Completed",
        "channel": "sms",
        "body": "SparkP2P: Buy order completed. KES {fiat_amount} paid to seller. {crypto_amount} {currency} received.",
        "variables": json.dumps(["crypto_amount", "currency", "fiat_amount"]),
    },
    {
        "key": "sms_insufficient_balance",
        "name": "Insufficient Balance",
        "channel": "sms",
        "body": "SparkP2P: Buy order for KES {amount} could not be processed. Balance: KES {balance}. Deposit more funds at sparkp2p.com",
        "variables": json.dumps(["amount", "balance"]),
    },
    {
        "key": "sms_session_disconnected",
        "name": "Session Disconnected",
        "channel": "sms",
        "body": "SparkP2P: Your Binance session disconnected. Auto-trading paused. Open Chrome with Binance to reconnect.",
        "variables": json.dumps([]),
    },
    {
        "key": "sms_verification_code",
        "name": "Verification Code",
        "channel": "sms",
        "body": "SparkP2P verification code: {code}. Valid for 10 minutes.",
        "variables": json.dumps(["code"]),
    },
    {
        "key": "sms_subscription_activated",
        "name": "Subscription Activated",
        "channel": "sms",
        "body": "SparkP2P: {plan} plan activated! Expires {expires}. Start trading at sparkp2p.com",
        "variables": json.dumps(["plan", "expires"]),
    },
]


async def seed_default_templates(force: bool = False):
    """Insert default templates if they don't already exist.
    If force=True, overwrite existing templates with defaults.
    """
    async with async_session() as db:
        for tpl in DEFAULT_TEMPLATES:
            result = await db.execute(
                select(MessageTemplate).where(MessageTemplate.key == tpl["key"])
            )
            existing = result.scalar_one_or_none()

            if existing and not force:
                continue

            if existing and force:
                existing.name = tpl["name"]
                existing.channel = tpl["channel"]
                existing.body = tpl["body"]
                existing.variables = tpl["variables"]
                existing.updated_at = datetime.now(timezone.utc)
            else:
                db.add(MessageTemplate(**tpl))

        await db.commit()

    # Refresh cache after seeding
    await refresh_template_cache()
    logger.info("Message templates seeded successfully")


async def refresh_template_cache():
    """Load all templates from DB into in-memory cache."""
    global _template_cache
    async with async_session() as db:
        result = await db.execute(select(MessageTemplate))
        templates = result.scalars().all()
        _template_cache = {t.key: t.body for t in templates}
    logger.info(f"Template cache refreshed: {len(_template_cache)} templates")


def get_cached_template(key: str) -> Optional[str]:
    """Get a template body from the in-memory cache. Returns None if not found."""
    return _template_cache.get(key)
