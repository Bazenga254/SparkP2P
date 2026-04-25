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
        f"SparkP2P ALERT: Your trading bot has been offline for {silent_minutes} minutes. "
        f"Your Binance ads are live but UNATTENDED. Please check your internet connection, "
        f"power supply, or restart the SparkP2P desktop app immediately."
    )
    try:
        from app.services.sms import send_otp_sms
        send_otp_sms(trader.phone, msg)
    except Exception as e:
        logger.warning(f"[BotMonitor] SMS failed for trader {trader.id}: {e}")

    try:
        from app.services.email import send_email
        send_email(
            trader.email,
            "SparkP2P - Bot Offline Alert",
            f"""
            <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
                    <h2 style="color: #ef4444; font-size: 20px; margin: 0 0 12px;">⚠️ Bot Offline Alert</h2>
                    <p style="color: #9ca3af; font-size: 14px;">
                        Hi {trader.full_name},
                    </p>
                    <p style="color: #d1d5db; font-size: 14px;">
                        Your SparkP2P trading bot has been <strong style="color:#ef4444;">offline for {silent_minutes} minutes</strong>.
                        Your Binance P2P ads are still live but no orders are being processed automatically.
                    </p>
                    <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin: 16px 0; border-left: 4px solid #ef4444;">
                        <p style="color: #f59e0b; font-weight: 600; margin: 0 0 8px;">Possible causes:</p>
                        <ul style="color: #9ca3af; font-size: 13px; margin: 0; padding-left: 20px; line-height: 1.8;">
                            <li>Internet disconnection</li>
                            <li>Power outage</li>
                            <li>Device turned off or restarted</li>
                            <li>SparkP2P app crashed</li>
                        </ul>
                    </div>
                    <p style="color: #d1d5db; font-size: 14px;">
                        <strong>Action required:</strong> Please restart the SparkP2P desktop app or
                        manually manage your Binance orders until the bot is back online.
                    </p>
                </div>
            </div>
            """,
        )
    except Exception as e:
        logger.warning(f"[BotMonitor] Email failed for trader {trader.id}: {e}")


async def _notify_recovered(trader):
    logger.info(f"[BotMonitor] Trader {trader.id} ({trader.full_name}) bot back online — notifying")
    try:
        from app.services.sms import send_otp_sms
        send_otp_sms(
            trader.phone,
            f"SparkP2P: Your trading bot is back online. Automation has resumed."
        )
    except Exception as e:
        logger.warning(f"[BotMonitor] Recovery SMS failed for trader {trader.id}: {e}")

    try:
        from app.services.email import send_email
        send_email(
            trader.email,
            "SparkP2P - Bot Back Online",
            f"""
            <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
                    <h2 style="color: #10b981; font-size: 20px; margin: 0 0 12px;">Bot Back Online</h2>
                    <p style="color: #9ca3af; font-size: 14px;">
                        Hi {trader.full_name}, your SparkP2P trading bot is back online.
                        Automation has resumed and your Binance orders are being processed again.
                    </p>
                </div>
            </div>
            """,
        )
    except Exception as e:
        logger.warning(f"[BotMonitor] Recovery email failed for trader {trader.id}: {e}")


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

        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                trader.phone,
                f"SparkP2P: Your withdrawal of KES {abs(tx.amount):,.0f} is still being processed "
                f"({hours_pending:.0f} hours). Your funds are safe — we're working on it. "
                f"Contact support if this continues."
            )
        except Exception as e:
            logger.warning(f"[BotMonitor] Pending-wd SMS failed for trader {trader_id}: {e}")

        try:
            from app.services.email import send_email
            send_email(
                trader.email,
                "SparkP2P - Withdrawal Still Processing",
                f"""
                <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                  <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                    <h2 style="color:#f59e0b;font-size:20px;margin:0 0 12px;">&#8987; Withdrawal Delayed</h2>
                    <p style="color:#9ca3af;font-size:14px;">Hi {trader.full_name},</p>
                    <p style="color:#d1d5db;font-size:14px;">
                      Your withdrawal of <strong style="color:#fff;">KES {abs(tx.amount):,.0f}</strong>
                      has been pending for approximately <strong style="color:#f59e0b;">{hours_pending:.0f} hours</strong>.
                    </p>
                    <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b;">
                      <p style="color:#d1d5db;font-size:13px;margin:0;">
                        Your funds are <strong style="color:#10b981;">safe and intact</strong>.
                        The delay may be caused by a temporary issue with our payment partner.
                        We are processing your withdrawal and will notify you once it completes.
                      </p>
                    </div>
                    <p style="color:#9ca3af;font-size:13px;">
                      If you need urgent assistance, please contact support from the SparkP2P app.
                    </p>
                  </div>
                </div>
                """,
            )
        except Exception as e:
            logger.warning(f"[BotMonitor] Pending-wd email failed for trader {trader_id}: {e}")


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
