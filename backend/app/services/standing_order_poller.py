"""Standing-order poller — fires due orders once per day through the shared
Choice money path. Gated by settings.STANDING_ORDERS_ENABLED: while False it
runs but executes nothing (so shipping it is a no-op until you flip the flag).

Design mirrors auto_withdraw_poller: read a short list of due order ids (releasing
the DB session), then process each in its own session so a slow Choice/relay call
never holds a connection. An order runs at most once per calendar day; on a
successful run it advances to its next occurrence, on insufficient funds it stays
due and retries the next day (notifying the merchant).
"""
import asyncio
import logging
from datetime import date, datetime, timezone

from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.models.standing_order import StandingOrder
from app.models.trader import Trader
from app.services.standing_orders import execute_standing_order, advance_after_run, now_eat, DEFAULT_RUN_TIME

logger = logging.getLogger("sparkp2p.standing_orders")

POLL_INTERVAL_S = 60          # every 1 min so a chosen run-time fires within ~1 min (cheap: a
                              # small indexed lookup; once/day + in-flight guards prevent re-firing)
_in_flight: set[int] = set()


def _ran_today(order, now) -> bool:
    lr = order.last_run_at
    if not lr:
        return False
    if lr.tzinfo is None:
        lr = lr.replace(tzinfo=timezone.utc)
    from datetime import timedelta
    return (lr + timedelta(hours=3)).date() >= now.date()   # EAT calendar day


def _due(order, now) -> bool:
    """Due if the run DATE has arrived AND, when that date is today, the run TIME
    (EAT) has been reached. A past-due date fires immediately."""
    if order.next_run_on > now.date():
        return False
    if order.next_run_on == now.date():
        rt = order.run_time or DEFAULT_RUN_TIME
        if now.time() < rt:
            return False
    return not _ran_today(order, now)


async def _process(order_id: int):
    async with async_session() as db:
        order = await db.get(StandingOrder, order_id)
        if not order or not order.active:
            return
        if not _due(order, now_eat()):
            return
        trader = await db.get(Trader, order.trader_id)
        if not trader:
            return

        status, tx_id, err = await execute_standing_order(order, trader, db)

        # Re-fetch into THIS session (execute_standing_order committed the ledger).
        order = await db.get(StandingOrder, order_id)
        order.last_run_at = datetime.now(timezone.utc)
        order.last_status = status
        order.last_error = err
        if tx_id:
            order.last_tx_id = tx_id

        notify_msg = None
        if status == "success":
            order.run_count = (order.run_count or 0) + 1
            advance_after_run(order)
        elif status == "skipped_no_funds":
            # Stay due; retry next day. Notify once per day.
            notify_msg = (f"⏸ Standing order to {order.payee_name} could not run today: "
                          f"insufficient Choice Bank balance for KES {float(order.amount):,.0f}. "
                          f"Top up and it will retry tomorrow.")
        else:  # failed
            notify_msg = (f"⚠ Standing order to {order.payee_name} (KES {float(order.amount):,.0f}) "
                          f"failed: {err or 'unknown error'}. It will retry tomorrow — or pause it.")

        today_eat = now_eat().date()
        if notify_msg and order.last_notified_on != today_eat:
            order.last_notified_on = today_eat
            try:
                from app.api.routes.telegram import notify_trader
                await notify_trader(trader, notify_msg)
            except Exception:
                pass

        await db.commit()
        logger.info("[standing-order] #%s trader %s -> %s%s", order_id, order.trader_id, status,
                    f" (tx {tx_id})" if tx_id else "")


async def _cycle():
    async with async_session() as db:
        ids = (await db.execute(
            select(StandingOrder.id).where(
                StandingOrder.active.is_(True),
                StandingOrder.next_run_on <= now_eat().date(),
            )
        )).scalars().all()
    for oid in ids:
        if oid in _in_flight:
            continue
        _in_flight.add(oid)
        try:
            await _process(oid)
        except Exception as e:
            logger.warning("[standing-order] #%s errored: %s", oid, e)
        finally:
            _in_flight.discard(oid)


async def standing_order_poller():
    logger.info("[standing-order] poller started (executor %s)",
                "ENABLED" if settings.STANDING_ORDERS_ENABLED else "DISABLED — flip STANDING_ORDERS_ENABLED to arm")
    while True:
        try:
            if settings.STANDING_ORDERS_ENABLED:
                await _cycle()
        except Exception as e:
            logger.warning("[standing-order] cycle error: %s", e)
        await asyncio.sleep(POLL_INTERVAL_S)
