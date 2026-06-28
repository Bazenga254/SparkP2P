"""Buy-order release monitor.

When a trader has PAID a seller on a BUY order (status PAYMENT_SENT) but the seller hasn't released
the crypto within DELAY_MINUTES, Telegram the trader so they can follow up / appeal. This runs
SERVER-SIDE (not in the desktop), so the alert fires whether the trader is on desktop or phone —
the mobile relay doesn't run the desktop trading loop that used to trigger this.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.order import Order, OrderSide, OrderStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

DELAY_MINUTES = 10          # alert once the seller is this many minutes late releasing
MAX_AGE_MINUTES = 60        # stop alerting once the order is this old — by now it's resolved/cancelled
                            # or the trader has long since seen it (also caps restart re-spam)
_CHECK_EVERY = 60           # seconds between scans
_notified: set[int] = set()  # order ids already alerted (in-memory; resets on restart)


async def buy_release_monitor():
    """Every minute, alert traders whose paid BUY orders haven't been released within DELAY_MINUTES."""
    logger.info("[BuyReleaseMonitor] started (%d-min threshold)", DELAY_MINUTES)
    while True:
        try:
            now = datetime.now(timezone.utc)
            cutoff = now - timedelta(minutes=DELAY_MINUTES)
            floor = now - timedelta(minutes=MAX_AGE_MINUTES)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Order).where(
                        Order.side == OrderSide.BUY,
                        Order.status == OrderStatus.PAYMENT_SENT,
                        Order.payment_sent_at.isnot(None),
                        Order.payment_sent_at <= cutoff,
                        Order.payment_sent_at >= floor,   # don't nag dead/old orders forever
                        Order.settled_at.is_(None),       # skip if _complete_buy_order already ran
                    )
                )).scalars().all()

                for o in rows:
                    if o.id in _notified:
                        continue
                    trader = (await db.execute(
                        select(Trader).where(Trader.id == o.trader_id)
                    )).scalar_one_or_none()
                    if not trader:
                        continue
                    mins = int((datetime.now(timezone.utc) - o.payment_sent_at).total_seconds() // 60)
                    msg = (
                        "⏳ Crypto not released yet" + chr(10) +
                        "You paid KES " + f"{float(o.fiat_amount or 0):,.0f}" +
                        " for buy order " + (o.binance_order_number or "") + " " + str(mins) +
                        " min ago, but the seller has not released your " +
                        (f"{o.crypto_amount} " if o.crypto_amount else "") + (o.crypto_currency or "USDT") + "." + chr(10) +
                        "Open Binance and follow up — appeal the order if the seller keeps delaying."
                    )
                    try:
                        from app.api.routes.telegram import notify_trader
                        await notify_trader(trader, msg)
                        _notified.add(o.id)
                        logger.info(
                            "[BuyReleaseMonitor] alerted trader %s for buy order %s (%dm unreleased)",
                            trader.id, o.binance_order_number, mins,
                        )
                    except Exception as e:
                        logger.warning("[BuyReleaseMonitor] notify failed for order %s: %s", o.id, e)
        except Exception as e:
            logger.warning("[BuyReleaseMonitor] loop error: %s", e)
        await asyncio.sleep(_CHECK_EVERY)
