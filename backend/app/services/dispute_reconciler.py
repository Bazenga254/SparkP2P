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
_PAGE_ROWS = 50    # Binance caps listUserOrderHistory at 50 rows/page (asked 100, got 50)
_MAX_PAGES = 10    # walk up to 500 recent orders per trader to find older disputes

# listUserOrderHistory (EP-16) returns ONLY terminal orders, and orderStatus is a STRING
# enum, not an int — real observed values include COMPLETED, CANCELLED_BY_SYSTEM (buyer
# never paid → Binance auto-cancel), CANCELLED_BY_USER, etc. We classify by SUBSTRING so
# every cancel/complete/expire variant is recognised (an exact-string map missed
# CANCELLED_BY_SYSTEM and left those disputes stuck forever). Numeric codes (4/5/6) are
# also handled in case another endpoint feeds this.
def _classify(raw) -> "OrderStatus | None":
    s = str(raw or "").strip().upper()
    if not s:
        return None
    if s in ("4", "5", "6"):
        return {"4": OrderStatus.COMPLETED, "5": OrderStatus.CANCELLED, "6": OrderStatus.EXPIRED}[s]
    if "COMPLET" in s or "FINISH" in s or "RELEASE" in s:
        return OrderStatus.COMPLETED
    if "EXPIRE" in s:
        return OrderStatus.EXPIRED
    if "CANCEL" in s:
        return OrderStatus.CANCELLED
    return None   # still-active (pending/trading/paid/appealing) — leave DISPUTED


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

    # 2. History read PER TRADER — NO DB connection held across it. A trader whose relay
    #    is offline just errors and is skipped (retried next pass). We PAGINATE because
    #    Binance caps listUserOrderHistory at ~100 rows/page; a high-volume trader's older
    #    disputes fall off page 1, so we walk pages until every one of this trader's
    #    disputed order numbers is found (or we hit end-of-history / the page cap).
    updates: dict[str, OrderStatus] = {}
    for tid, onos in by_trader.items():
        c = creds.get(tid)
        if not c:
            continue
        relay_trader.set(tid)
        key, secret = decrypt_data(c[0]), decrypt_data(c[1])
        remaining = set(onos)          # disputed order numbers we still need to locate
        seen_rows = 0
        matched_here = 0
        first_keys = None
        found_statuses: dict[str, int] = {}   # raw orderStatus -> count, for disputed orders we located
        try:
            for page in range(1, _MAX_PAGES + 1):
                hist = await get_user_order_history(key, secret, page, _PAGE_ROWS)
                if not hist:
                    break
                if first_keys is None and hist:
                    first_keys = sorted(list(hist[0].keys()))[:12]
                seen_rows += len(hist)
                for o in hist:
                    num = str(o.get("orderNumber") or "")
                    if num not in remaining:
                        continue
                    raw = o.get("orderStatus")
                    new = _classify(raw)
                    if new:
                        updates[num] = new
                        matched_here += 1
                    else:
                        k = str(raw)
                        found_statuses[k] = found_statuses.get(k, 0) + 1
                    remaining.discard(num)   # found it (terminal or not) — stop looking
                if not remaining or len(hist) < _PAGE_ROWS:
                    break                    # all found, or we reached the end of history
                await asyncio.sleep(0.5)
        except Exception as e:
            logger.warning("[DisputeReconcile] trader %s: history read failed (%s) — skipped",
                           tid, str(e)[:80])
            continue   # relay offline / API error — skip this trader, retry next pass
        # WARNING-level so it survives journalctl's INFO filter — lets us SEE it working.
        logger.warning("[DisputeReconcile] trader %s: %d disputed, scanned %d history rows, "
                       "resolved %d, still-unresolved %d%s",
                       tid, len(onos), seen_rows, matched_here, len(remaining),
                       (f", non-terminal statuses={found_statuses}" if found_statuses else
                        ("" if matched_here else (f", sample keys={first_keys}" if first_keys else ", empty history"))))
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
