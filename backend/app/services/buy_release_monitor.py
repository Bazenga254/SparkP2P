"""Buy-order release monitor — SERVER-SIDE, API-driven.

For every BUY order the trader has PAID (status PAYMENT_SENT), this poller asks the
Binance API for the live order status and acts on it — so the desktop NEVER has to
navigate back to the order page to watch for the seller's release:

  * status 4 (completed / released) -> mark the order done + "Buy done" (via
    _complete_buy_order), exactly as the old desktop ghost-detection did.
  * status 5/6 (cancelled / expired) -> reflect that and stop watching.
  * status 2/3 (paid / releasing) and > DELAY_MINUTES old -> nag the trader once.

Runs whether the trader is on desktop or phone (the mobile relay doesn't run the
desktop trading loop). Needs the trader's Binance API key + relay to reach Binance;
if it can't (relay down), it simply retries next tick.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.order import Order, OrderSide, OrderStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

DELAY_MINUTES = 10          # nag once the seller is this many minutes late releasing
MAX_AGE_MINUTES = 180       # keep watching a paid order for up to 3h, then give up
_CHECK_EVERY = 25           # seconds between scans (release should surface within ~25s)
_notified: set[int] = set()  # order ids already nagged (in-memory; resets on restart)


async def buy_release_monitor():
    logger.info("[BuyReleaseMonitor] started — API release detection + %d-min nag", DELAY_MINUTES)
    while True:
        try:
            now = datetime.now(timezone.utc)
            floor = now - timedelta(minutes=MAX_AGE_MINUTES)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Order).where(
                        Order.side == OrderSide.BUY,
                        Order.status == OrderStatus.PAYMENT_SENT,
                        Order.payment_sent_at.isnot(None),
                        Order.payment_sent_at >= floor,
                        Order.settled_at.is_(None),
                    )
                )).scalars().all()

                for o in rows:
                    trader = (await db.execute(
                        select(Trader).where(Trader.id == o.trader_id)
                    )).scalar_one_or_none()
                    if not trader:
                        continue

                    # ── API release detection: has the seller released the crypto? ──
                    try:
                        from app.api.routes.extension import _sapi_creds
                        from app.services.binance.sapi_client import get_order_payment_details, relay_trader
                        _ak, _as = _sapi_creds(trader)
                        relay_trader.set(trader.id)
                        det = await get_order_payment_details(_ak, _as, o.binance_order_number)
                        st = str(det.get("order_status") or "").strip()
                        if st == "4":
                            # Seller released — complete it and fire "Buy done" (same path
                            # the desktop used to call). This is the authoritative signal.
                            from app.api.routes.extension import _complete_buy_order
                            await _complete_buy_order(o, trader, db, notify=True)
                            _notified.discard(o.id)
                            logger.info("[BuyReleaseMonitor] order %s RELEASED (status 4) — completed",
                                        o.binance_order_number)
                            continue
                        if st in ("5", "6"):
                            o.status = OrderStatus.CANCELLED if st == "5" else OrderStatus.EXPIRED
                            await db.commit()
                            _notified.discard(o.id)
                            logger.info("[BuyReleaseMonitor] order %s is now %s (status %s) — stop watching",
                                        o.binance_order_number, o.status.value, st)
                            continue
                        # st in ("2","3") -> still awaiting release; fall through to the nag.
                    except Exception as _e:
                        # Can't verify right now (relay down / transient). Don't nag on a
                        # failed check — just retry next tick.
                        logger.debug("[BuyReleaseMonitor] status check failed for %s: %s",
                                     o.binance_order_number, _e)
                        continue

                    # ── Nag: still awaiting release after DELAY_MINUTES ──
                    if o.payment_sent_at > now - timedelta(minutes=DELAY_MINUTES):
                        continue
                    if o.id in _notified:
                        continue
                    mins = int((now - o.payment_sent_at).total_seconds() // 60)
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
                        logger.info("[BuyReleaseMonitor] nagged trader %s for buy order %s (%dm unreleased)",
                                    trader.id, o.binance_order_number, mins)
                    except Exception as e:
                        logger.warning("[BuyReleaseMonitor] notify failed for order %s: %s", o.id, e)
        except Exception as e:
            logger.warning("[BuyReleaseMonitor] loop error: %s", e)
        await asyncio.sleep(_CHECK_EVERY)
