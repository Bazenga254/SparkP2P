"""Persistent deposit reconciliation poller.

The STK-push deposit flow creates a CHOICE_DEPOSIT payment with status=PENDING and schedules
a FastAPI BackgroundTask to verify the balance after 3 minutes. If the server restarts before
that task completes, the deposit stays pending forever.

This poller runs every 2 minutes and picks up any CHOICE_DEPOSIT payments that have been
pending for more than 2 minutes, then checks if the Choice Bank balance went up by the
expected amount. bal_before is stored in the payment's remarks field so it survives restarts.
"""

import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.payment import Payment, PaymentStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

_CHECK_EVERY = 120  # seconds between scans


async def deposit_reconcile_poller():
    logger.info("[DepositReconcile] poller started")
    while True:
        await asyncio.sleep(_CHECK_EVERY)
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=2)
            # Balance-delta reconciliation is only valid while the snapshotted bal_before is
            # still meaningful. Past ~6h the balance has usually moved on (spent/other deposits),
            # so a stale check would either false-complete or spam-warn forever. Older pending
            # deposits are left for manual review instead.
            cutoff_old = datetime.now(timezone.utc) - timedelta(hours=6)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Payment).where(
                        Payment.transaction_type == "CHOICE_DEPOSIT",
                        Payment.status == PaymentStatus.PENDING,
                        Payment.created_at <= cutoff,
                        Payment.created_at >= cutoff_old,
                    )
                )).scalars().all()

                if not rows:
                    continue

                from app.services.choice_bank import client as choice

                for p in rows:
                    try:
                        trader = (await db.execute(
                            select(Trader).where(Trader.id == p.trader_id)
                        )).scalar_one_or_none()
                        if not trader or not trader.choice_account_id:
                            continue

                        # Parse bal_before from remarks (stored at STK initiation)
                        bal_before = 0.0
                        if p.remarks:
                            m = re.search(r'bal_before:([\d.]+)', p.remarks)
                            if m:
                                bal_before = float(m.group(1))

                        bal_result = await choice.get_account_details(trader.choice_account_id)
                        bal_now = float((bal_result.get("data") or {}).get("balance") or 0)

                        if bal_now >= bal_before + float(p.amount) - 5:
                            p.status = PaymentStatus.COMPLETED
                            p.remarks = re.sub(r'\s*bal_before:[\d.]+', '', p.remarks or "").strip() + " [balance-verified]"
                            await db.commit()
                            logger.info(
                                f"[DepositReconcile] Payment {p.id} (KES {p.amount}) confirmed "
                                f"for trader {trader.id}: balance {bal_before}→{bal_now}"
                            )
                        else:
                            age_mins = int((datetime.now(timezone.utc) - p.created_at).total_seconds() // 60)
                            logger.warning(
                                f"[DepositReconcile] Payment {p.id} still unconfirmed after {age_mins}m: "
                                f"bal_before={bal_before}, now={bal_now}, expected≥{bal_before + float(p.amount) - 5}"
                            )
                    except Exception as e:
                        logger.warning(f"[DepositReconcile] Error on payment {p.id}: {e}")

        except Exception as e:
            logger.warning(f"[DepositReconcile] loop error: {e}")
