"""
Bot Offline Monitor
===================
Runs as a background task on the VPS. Every 60 seconds it checks all active
traders' last heartbeat (trader.updated_at). If a trader's bot has been silent
for more than BOT_OFFLINE_THRESHOLD_MINUTES, it sends an SMS + email alert.

This covers ALL failure scenarios: internet outage, power cut, app crash,
device off — because the VPS is always running and notices when heartbeats stop.

Notification is throttled to once per BOT_NOTIFY_COOLDOWN_MINUTES per trader
so the trader isn't spammed if the outage is long.

A "bot came back online" message is sent when the heartbeat resumes after
an alert was sent.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

BOT_OFFLINE_THRESHOLD_MINUTES    = 5    # Alert after 5 min of silence
BOT_NOTIFY_COOLDOWN_MINUTES      = 60   # Re-alert at most once per hour
CHECK_INTERVAL_SECONDS           = 60   # Check every 60s
PENDING_WD_ALERT_HOURS           = 4    # Alert trader after 4h pending withdrawal
PENDING_WD_NOTIFY_COOLDOWN_HOURS = 12   # Re-alert at most once per 12h per trader

# In-memory state — reset on service restart (acceptable)
_last_notified_at:    dict[int, datetime] = {}   # trader_id → when we last sent offline alert
_was_offline:         dict[int, bool]     = {}   # trader_id → True if we sent an alert for current outage
_wd_last_notified_at: dict[int, datetime] = {}   # trader_id → when we last sent pending-withdrawal alert


async def _check_traders():
    from app.core.database import async_session
    from app.models import Trader
    from sqlalchemy import select

    async with async_session() as db:
        from app.models.trader import TraderStatus
        result = await db.execute(
            select(Trader).where(
                Trader.status == TraderStatus.ACTIVE,
                Trader.updated_at.isnot(None),
            )
        )
        traders = result.scalars().all()

    now = datetime.now(timezone.utc)

    for trader in traders:
        try:
            last_seen = trader.updated_at
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=timezone.utc)

            silent_for = now - last_seen
            silent_minutes = silent_for.total_seconds() / 60

            trader_id = trader.id

            # Trader intentionally stopped the bot — skip all alerts
            if getattr(trader, 'bot_intentionally_stopped', False):
                _was_offline[trader_id] = False  # Reset so recovery msg isn't sent on restart
                continue

            cooldown_ok = (
                trader_id not in _last_notified_at or
                (now - _last_notified_at[trader_id]).total_seconds() / 60 >= BOT_NOTIFY_COOLDOWN_MINUTES
            )

            if silent_minutes >= BOT_OFFLINE_THRESHOLD_MINUTES:
                if cooldown_ok:
                    _last_notified_at[trader_id] = now
                    _was_offline[trader_id] = True
                    await _notify_offline(trader, int(silent_minutes))

            elif _was_offline.get(trader_id):
                # Bot came back — send recovery notification
                _was_offline[trader_id] = False
                await _notify_recovered(trader)

        except Exception as e:
            logger.warning(f"[BotMonitor] Error checking trader {trader.id}: {e}")


async def _notify_offline(trader, silent_minutes: int):
    logger.warning(f"[BotMonitor] Trader {trader.id} ({trader.full_name}) bot offline for {silent_minutes}m — notifying")
    msg = (
        f"⚠️ SparkP2P ALERT: Your trading bot has been offline for {silent_minutes} minutes. "
        f"Your Binance ads are live but UNATTENDED. Please check your internet connection, "
        f"power supply, or restart the SparkP2P desktop app immediately."
    )
    try:
        from app.api.routes.telegram import notify_trader
        sent = await notify_trader(trader, msg)
        if not sent:
            logger.info(f"[BotMonitor] Trader {trader.id} has no Telegram connected — offline alert not delivered (SMS disabled)")
    except Exception as e:
        logger.warning(f"[BotMonitor] Offline notification failed for trader {trader.id}: {e}")


async def _notify_recovered(trader):
    logger.info(f"[BotMonitor] Trader {trader.id} ({trader.full_name}) bot back online — notifying")
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, "✅ SparkP2P: Your trading bot is back online. Automation has resumed.")
    except Exception as e:
        logger.warning(f"[BotMonitor] Recovery notification failed for trader {trader.id}: {e}")


async def _check_pending_withdrawals():
    """Alert traders who have a withdrawal stuck in 'pending' for more than PENDING_WD_ALERT_HOURS."""
    from app.core.database import async_session
    from app.models import Trader
    from app.models.wallet import WalletTransaction, TransactionType
    from sqlalchemy import select

    cutoff = datetime.now(timezone.utc) - timedelta(hours=PENDING_WD_ALERT_HOURS)

    async with async_session() as db:
        result = await db.execute(
            select(WalletTransaction, Trader)
            .join(Trader, Trader.id == WalletTransaction.trader_id)
            .where(
                WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
                WalletTransaction.status == "pending",
                WalletTransaction.created_at <= cutoff,
            )
        )
        rows = result.all()

    now = datetime.now(timezone.utc)

    for tx, trader in rows:
        trader_id = trader.id
        cooldown_ok = (
            trader_id not in _wd_last_notified_at or
            (now - _wd_last_notified_at[trader_id]).total_seconds() / 3600 >= PENDING_WD_NOTIFY_COOLDOWN_HOURS
        )
        if not cooldown_ok:
            continue

        hours_pending = (now - tx.created_at.replace(tzinfo=timezone.utc if tx.created_at.tzinfo is None else tx.created_at.tzinfo)).total_seconds() / 3600
        _wd_last_notified_at[trader_id] = now

        logger.info(f"[BotMonitor] Trader {trader_id} has withdrawal pending {hours_pending:.1f}h — notifying")

        wd_msg = (
            f"⏳ SparkP2P: Your withdrawal of KES {abs(tx.amount):,.0f} is still being processed "
            f"({hours_pending:.0f} hours). Your funds are safe — we're working on it. "
            f"Contact support if this continues."
        )
        try:
            from app.api.routes.telegram import notify_trader
            await notify_trader(trader, wd_msg)
        except Exception as e:
            logger.warning(f"[BotMonitor] Pending-wd notification failed for trader {trader_id}: {e}")


async def start():
    logger.info(f"[BotMonitor] Started — checking every {CHECK_INTERVAL_SECONDS}s, alert after {BOT_OFFLINE_THRESHOLD_MINUTES}m silence")
    while True:
        try:
            await _check_traders()
        except Exception as e:
            logger.error(f"[BotMonitor] Unexpected error in bot check: {e}")
        try:
            await _check_pending_withdrawals()
        except Exception as e:
            logger.error(f"[BotMonitor] Unexpected error in pending-wd check: {e}")
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
