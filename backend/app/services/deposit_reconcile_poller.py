"""Persistent deposit reconciliation poller.

The STK-push deposit flow creates a CHOICE_DEPOSIT payment with status=PENDING and schedules a
background task that watches the transaction (getTransResult) until it settles. If the server
restarts before that finishes — or the payer takes longer than the watch window to enter their
M-Pesa PIN — the deposit would stay pending forever. This poller finishes the job.

It queries the transaction's AUTHORITATIVE status by txId. It deliberately does NOT compare
account balances: the previous balance-delta heuristic was wrong in both directions, because any
concurrent movement on the account (the bot paying a buy order, a retry deposit landing) changes
the balance. It once marked a genuinely FAILED deposit as COMPLETED because the retry's money
arrived inside the check window.

Choice txStatus: -1=Timeout, 1=Pending, 2=Processing, 4=Failed, 8=SUCCESS.
"""

import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.payment import Payment, PaymentStatus

logger = logging.getLogger(__name__)

_CHECK_EVERY = 120          # seconds between scans
_MIN_AGE_MIN = 2            # give the inline monitor a head start
_MAX_AGE_DAYS = 7           # don't rescan ancient rows forever

_SETTLED = {"8": PaymentStatus.COMPLETED, "4": PaymentStatus.FAILED, "-1": PaymentStatus.FAILED}


async def deposit_reconcile_poller():
    logger.info("[DepositReconcile] poller started")
    while True:
        await asyncio.sleep(_CHECK_EVERY)
        try:
            now = datetime.now(timezone.utc)
            rows_cutoff = now - timedelta(minutes=_MIN_AGE_MIN)
            floor = now - timedelta(days=_MAX_AGE_DAYS)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Payment).where(
                        Payment.transaction_type == "CHOICE_DEPOSIT",
                        Payment.status == PaymentStatus.PENDING,
                        Payment.created_at <= rows_cutoff,
                        Payment.created_at >= floor,
                    )
                )).scalars().all()

                if not rows:
                    continue

                from app.services.choice_bank import client as choice

                for p in rows:
                    tx_id = (p.mpesa_transaction_id or "").strip()
                    if not tx_id or tx_id.startswith("cb_stk_"):
                        continue  # no Choice txId was returned — nothing authoritative to query

                    try:
                        r = await choice.get_transaction_result(tx_id)
                        data = r.get("data") if isinstance(r, dict) else None
                        status_code = str((data or {}).get("txStatus") or "")
                        new_status = _SETTLED.get(status_code)

                        if new_status is None:
                            age_mins = int((now - p.created_at).total_seconds() // 60)
                            logger.info(
                                "[DepositReconcile] payment %s (KES %s) still in flight after %sm (txStatus=%s)",
                                p.id, p.amount, age_mins, status_code or "?",
                            )
                            continue

                        p.status = new_status
                        # Drop any stale bal_before left by the old balance-delta flow.
                        base = re.sub(r"\s*bal_before:[\d.]+", "", p.remarks or "").strip()
                        p.remarks = (base + (" [tx-verified]" if new_status is PaymentStatus.COMPLETED
                                             else " [tx-failed]")).strip()
                        await db.commit()
                        logger.info(
                            "[DepositReconcile] payment %s (KES %s) → %s (txStatus=%s, txId=%s)",
                            p.id, p.amount, new_status.value, status_code, tx_id,
                        )
                    except Exception as e:
                        logger.warning(f"[DepositReconcile] Error on payment {p.id}: {e}")

        except Exception as e:
            logger.warning(f"[DepositReconcile] loop error: {e}")
