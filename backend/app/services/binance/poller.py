"""
Binance Order Poller — Housekeeping Mode

In the new architecture, the Chrome extension handles ALL Binance API calls.
This poller only handles:
  - Checking for stale orders (no update in X minutes → mark as expired)
  - Auto-settlement triggers (check wallets that hit threshold)
  - Marking traders as disconnected if no heartbeat in 2+ minutes
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models import Trader, TraderStatus, Order, OrderSide, OrderStatus

logger = logging.getLogger(__name__)


class BinanceOrderPoller:
    """
    Background housekeeping service.
    No longer polls Binance directly — the extension does that.
    """

    def __init__(self, poll_interval: int = 30):
        self.poll_interval = poll_interval  # seconds
        self.running = False
        self._daily_fee_last_run: str = ""  # YYYY-MM-DD of last daily fee run

    async def start(self):
        """Start the housekeeping loop."""
        self.running = True
        logger.info("Housekeeping poller started (extension handles Binance polling)")

        while self.running:
            try:
                await self._run_housekeeping()
            except Exception as e:
                logger.error(f"Housekeeping error: {e}")

            await asyncio.sleep(self.poll_interval)

    def stop(self):
        """Stop the housekeeping loop."""
        self.running = False
        logger.info("Housekeeping poller stopped")

    async def _run_housekeeping(self):
        """Run all housekeeping tasks."""
        async with async_session() as db:
            await self._check_stale_orders(db)
            await self._check_trader_heartbeats(db)
            await self._activate_pending_settlements(db)
            await self._check_settlement_thresholds(db)
            await self._run_daily_volume_fee(db)

    async def _run_daily_volume_fee(self, db: AsyncSession):
        """
        Run daily volume fee calculation once per day, after midnight UTC.
        Deducts 0.05% of each trader's daily trading volume from their wallet.
        """
        now = datetime.now(timezone.utc)
        # Only run after midnight (hour 0) and before 1am, and only once per day
        if now.hour != 0:
            return

        today_str = now.strftime("%Y-%m-%d")
        if self._daily_fee_last_run == today_str:
            return  # Already ran today

        try:
            from app.services.daily_fee import calculate_and_deduct_daily_fees
            # Calculate fees for the PREVIOUS day's volume
            logger.info("Running daily volume fee calculation...")
            await calculate_and_deduct_daily_fees(db)
            self._daily_fee_last_run = today_str
            logger.info("Daily volume fee calculation completed")
        except Exception as e:
            logger.error(f"Daily volume fee calculation failed: {e}")

    async def _check_stale_orders(self, db: AsyncSession):
        """
        Mark orders as expired if they've been pending too long.
        Binance P2P orders typically expire after 15 minutes.
        We give 20 minutes to account for processing delays.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=20)

        result = await db.execute(
            select(Order).where(
                Order.status == OrderStatus.PENDING,
                Order.created_at < cutoff,
            )
        )
        stale_orders = result.scalars().all()

        for order in stale_orders:
            order.status = OrderStatus.EXPIRED
            logger.info(
                f"Order {order.binance_order_number} expired "
                f"(pending since {order.created_at})"
            )

        if stale_orders:
            await db.commit()

    async def _check_trader_heartbeats(self, db: AsyncSession):
        """
        Mark traders as disconnected if no heartbeat from extension
        in the last 2 minutes.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=2)

        result = await db.execute(
            select(Trader).where(
                Trader.status == TraderStatus.ACTIVE,
                Trader.binance_connected == True,
                Trader.updated_at < cutoff,
            )
        )
        stale_traders = result.scalars().all()

        for trader in stale_traders:
            trader.binance_connected = False
            logger.warning(
                f"Trader {trader.id} ({trader.full_name}) disconnected — "
                f"no heartbeat since {trader.updated_at}"
            )

        if stale_traders:
            await db.commit()

    async def _activate_pending_settlements(self, db: AsyncSession):
        """
        Activate pending settlement methods after 48hr cooldown.
        Sends email notification when activated.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(hours=48)

        result = await db.execute(
            select(Trader).where(
                Trader.pending_settlement_method.isnot(None),
                Trader.settlement_changed_at <= cutoff,
            )
        )
        traders = result.scalars().all()

        for trader in traders:
            try:
                # Activate the pending method
                from app.models import SettlementMethod
                trader.settlement_method = SettlementMethod(trader.pending_settlement_method)
                trader.settlement_phone = trader.pending_settlement_phone
                trader.settlement_paybill = trader.pending_settlement_paybill
                trader.settlement_account = trader.pending_settlement_account
                trader.settlement_bank_name = trader.pending_settlement_bank_name

                # Clear pending
                trader.pending_settlement_method = None
                trader.pending_settlement_phone = None
                trader.pending_settlement_paybill = None
                trader.pending_settlement_account = None
                trader.pending_settlement_bank_name = None
                trader.settlement_changed_at = None

                logger.info(f"Activated pending settlement for trader {trader.id} ({trader.full_name})")

                # Send email notification
                try:
                    from app.services.email import send_email
                    send_email(
                        trader.email,
                        "SparkP2P - New Payment Method Activated",
                        f"""
                        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                            <div style="text-align: center; margin-bottom: 30px;">
                                <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
                            </div>
                            <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
                                <h2 style="color: #10b981; font-size: 20px; margin: 0 0 12px;">New Payment Method Active</h2>
                                <p style="color: #9ca3af; font-size: 14px;">
                                    Hi {trader.full_name}, your new payment method is now active and ready for withdrawals.
                                </p>
                                <p style="color: #fff; font-size: 14px; margin-top: 12px;">
                                    You can now withdraw funds using your updated payment method.
                                </p>
                            </div>
                        </div>
                        """,
                    )
                except Exception as e:
                    logger.warning(f"Failed to send activation email to {trader.email}: {e}")

                # Send SMS
                try:
                    from app.services.sms import send_otp_sms
                    send_otp_sms(trader.phone, "SparkP2P: Your new payment method is now active. You can now withdraw funds using it.")
                except Exception:
                    pass

            except Exception as e:
                logger.error(f"Failed to activate pending settlement for trader {trader.id}: {e}")

        if traders:
            await db.commit()

    async def _check_settlement_thresholds(self, db: AsyncSession):
        """
        Check if any trader's wallet balance exceeds their batch threshold.
        If so, trigger auto-settlement.
        """
        from app.models.wallet import Wallet
        from app.services.settlement.engine import SettlementEngine

        result = await db.execute(
            select(Trader).where(
                Trader.status == TraderStatus.ACTIVE,
                Trader.batch_settlement_enabled == True,
            )
        )
        traders = result.scalars().all()

        for trader in traders:
            try:
                wallet_result = await db.execute(
                    select(Wallet).where(Wallet.trader_id == trader.id)
                )
                wallet = wallet_result.scalar_one_or_none()

                if not wallet:
                    continue

                threshold = trader.batch_threshold or 50000
                if wallet.balance >= threshold:
                    logger.info(
                        f"Trader {trader.id} balance KES {wallet.balance} >= "
                        f"threshold KES {threshold} — triggering settlement"
                    )
                    engine = SettlementEngine(db)
                    await engine.batch_settle(trader.id)
            except Exception as e:
                logger.error(f"Settlement check failed for trader {trader.id}: {e}")


# Singleton
order_poller = BinanceOrderPoller()
