"""Reconcile stale DISPUTED orders against Binance.

An order gets stuck as DISPUTED in our DB when it was flagged for manual review and
then resolved directly on Binance (completed or cancelled) — the bot deliberately
filters disputed/appeal orders out of its monitoring, so it never sees the resolution
and our status stays "disputed" forever, cluttering the admin Disputes page.

This poller checks each DISPUTED order's REAL status on Binance (via the trader's
relay) and flips it to COMPLETED / CANCELLED / EXPIRED so it drops off the list.

Safety:
  * READ-ONLY against Binance — it only reads each order's status and updates our own
    status label; it never touches money, releases, or the orders themselves.
  * Relay-gated: if the trader's relay/desktop is offline or the API errors, we SKIP
    that order (it stays DISPUTED and is retried next pass) — never guess.
  * No DB connection is held across a relay call (pool-safe), same as the tier poller.
"""
import asyncio
import logging

from sqlalchemy import select

from app.core.database import async_session
from app.models.order import Order, OrderStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

INTERVAL = 600   # reconcile every 10 minutes

# Binance C2C orderStatus (get_order_payment_details returns it uppercased) -> our status.
# Binance codes: 1=pending, 2=paid, 3=releasing, 4=completed, 5=cancelled, 6=expired.
# Word forms are handled too in case the detail endpoint returns text.
_TERMINAL = {
    4: OrderStatus.COMPLETED, "4": OrderStatus.COMPLETED, "COMPLETED": OrderStatus.COMPLETED, "RELEASED": OrderStatus.COMPLETED,
    5: OrderStatus.CANCELLED, "5": OrderStatus.CANCELLED, "CANCELLED": OrderStatus.CANCELLED, "CANCELED": OrderStatus.CANCELLED,
    6: OrderStatus.EXPIRED, "6": OrderStatus.EXPIRED, "EXPIRED": OrderStatus.EXPIRED,
}


async def reconcile_disputed_orders_once() -> int:
    """One reconcile pass. Returns the number of disputes cleared.

    ONE history call per trader (not per order): a relay round-trip is ~25s, so we must
    not make 30+ of them — get_user_order_history returns all of a trader's recent
    completed/cancelled orders in a single call, and we match our disputes against it.
    """
    from app.services.binance.sapi_client import get_user_order_history, relay_trader
    from app.core.security import decrypt_data

    # 1. Snapshot the disputed orders grouped by trader (+ creds), then RELEASE the session.
    async with async_session() as db:
        rows = (await db.execute(
            select(Order.binance_order_number, Order.trader_id)
            .where(Order.status == OrderStatus.DISPUTED)
        )).all()
        if not rows:
            return 0
        by_trader: dict[int, set] = {}
        for ono, tid in rows:
            by_trader.setdefault(tid, set()).add(str(ono))
        creds: dict[int, tuple] = {}
        for t in (await db.execute(select(Trader).where(Trader.id.in_(by_trader.keys())))).scalars().all():
            if t.binance_api_key and t.binance_api_secret:
                creds[t.id] = (t.binance_api_key, t.binance_api_secret)

    # 2. One relay history read PER TRADER — NO DB connection held across it. A trader
    #    whose relay is offline just errors and is skipped (retried next pass).
    updates: dict[str, OrderStatus] = {}
    for tid, onos in by_trader.items():
        c = creds.get(tid)
        if not c:
            continue
        relay_trader.set(tid)
        try:
            hist = await get_user_order_history(decrypt_data(c[0]), decrypt_data(c[1]), 1, 200)
        except Exception:
            continue   # relay offline / API error — skip this trader, retry next pass
        for o in (hist or []):
            num = str(o.get("orderNumber") or "")
            if num not in onos:
                continue
            raw = o.get("orderStatus")
            try:
                stnum = int(raw)
            except (TypeError, ValueError):
                stnum = None
            new = _TERMINAL.get(stnum) or _TERMINAL.get(str(raw or "").strip().upper())
            if new:
                updates[num] = new
        await asyncio.sleep(1)   # gentle pacing between traders

    if not updates:
        return 0

    # 3. Persist (fresh short session) — re-check status to avoid racing a live update.
    cleared = 0
    async with async_session() as db:
        for ono, new in updates.items():
            o = (await db.execute(select(Order).where(
                Order.binance_order_number == ono, Order.status == OrderStatus.DISPUTED
            ))).scalar_one_or_none()
            if o:
                o.status = new
                cleared += 1
                logger.info("[DisputeReconcile] %s: disputed -> %s", ono, new.value)
        if cleared:
            await db.commit()
    return cleared


async def dispute_reconciler():
    logger.info("[DisputeReconcile] started — clears resolved disputes every %ss", INTERVAL)
    while True:
        try:
            n = await reconcile_disputed_orders_once()
            if n:
                logger.info("[DisputeReconcile] cleared %d resolved dispute(s)", n)
        except Exception as e:
            logger.warning("[DisputeReconcile] pass failed: %s", str(e)[:120])
        await asyncio.sleep(INTERVAL)
