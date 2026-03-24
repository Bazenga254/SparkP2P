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
            await self._check_settlement_thresholds(db)

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
