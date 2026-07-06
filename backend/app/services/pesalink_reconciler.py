"""
PesaLink payment reconciliation poller.

Runs every 5 minutes. Queries Choice Bank for the real status of
recent outbound bank-transfer payments that are marked COMPLETED.
If Choice Bank reports failure, the payment is updated to FAILED
and the trader receives a Telegram alert.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session as AsyncSessionLocal
from app.models import Payment, PaymentStatus, Trader

logger = logging.getLogger(__name__)


async def pesalink_reconciliation_poller():
    """Check PesaLink payment outcomes every 5 minutes."""
    await asyncio.sleep(120)  # Give boot 2 min before first run
    while True:
        try:
            await _reconcile_pesalink_payments()
        except Exception as e:
            logger.error(f"[PesaLink reconciler] error: {e}")
        await asyncio.sleep(300)  # Every 5 min


async def _reconcile_pesalink_payments():
    from app.services.choice_bank import client as choice_client

    cutoff = datetime.now(timezone.utc) - timedelta(hours=4)
    async with AsyncSessionLocal() as db:
        # Find recent outbound bank-transfer payments still marked COMPLETED
        result = await db.execute(
            select(Payment).where(
                Payment.direction == "OUTBOUND",
                Payment.destination_type == "Bank Transfer",
                Payment.status == PaymentStatus.COMPLETED,
                Payment.created_at >= cutoff,
                Payment.mpesa_transaction_id.isnot(None),
            )
        )
        payments = result.scalars().all()

    if not payments:
        return

    logger.info(f"[PesaLink reconciler] Checking {len(payments)} recent bank transfer payment(s)")

    for pmt in payments:
        try:
            await _check_one(pmt)
        except Exception as e:
            logger.warning(f"[PesaLink reconciler] {pmt.mpesa_transaction_id}: {e}")


async def _check_one(pmt: Payment):
    from app.services.choice_bank import client as choice_client

    tx_id = pmt.mpesa_transaction_id  # UTRANS...
    if not tx_id:
        return

    # Try Choice Bank interbank details endpoint
    resp = await choice_client._post("/trans/getInterBankTransferDetails", {"applicationId": tx_id})
    code = resp.get("code", "")
    logger.debug(f"[PesaLink reconciler] {tx_id}: code={code} resp={resp}")

    data = resp.get("data") or {}
    status_str = str(data.get("status") or data.get("transferStatus") or "").upper()

    # Choice Bank failure indicators
    is_failed = (
        code in ("10007", "20002", "20003", "10001") or  # known error codes
        "FAIL" in status_str or
        "REJECT" in status_str or
        "INVALID" in status_str or
        (resp.get("msg") or "").lower() in ("invalid account", "failed")
    )
    is_completed = status_str in ("COMPLETED", "SUCCESS", "SUCCESSFUL") or code == "00000"

    if not is_failed and not is_completed:
        logger.debug(f"[PesaLink reconciler] {tx_id}: status ambiguous ({status_str}, code={code}) — keeping COMPLETED")
        return

    if is_failed:
        failure_msg = resp.get("msg") or data.get("failureReason") or "PesaLink rejected"
        logger.warning(f"[PesaLink reconciler] {tx_id} FAILED: {failure_msg}")
        async with AsyncSessionLocal() as db:
            pmt_db = await db.get(Payment, pmt.id)
            if pmt_db and pmt_db.status == PaymentStatus.COMPLETED:
                pmt_db.status = PaymentStatus.FAILED
                pmt_db.remarks = (pmt_db.remarks or "") + f" [Auto-reconciled FAILED: {failure_msg}]"
                await db.commit()
                logger.warning(f"[PesaLink reconciler] Payment {pmt.id} ({tx_id}) → FAILED")
                # Notify the trader
                try:
                    async with AsyncSessionLocal() as db2:
                        trader = await db2.get(Trader, pmt.trader_id)
                    if trader:
                        from app.api.routes.telegram import notify_trader as _tg
                        await _tg(
                            trader,
                            f"⚠️ <b>Bank transfer failed</b>\n\n"
                            f"KES {int(pmt.amount):,} to <code>{pmt.destination}</code> was rejected by PesaLink.\n"
                            f"Reason: {failure_msg}\n"
                            f"Ref: <code>{tx_id}</code>\n\n"
                            f"Please retry the payment manually from the Choice Bank dashboard.",
                        )
                except Exception as ne:
                    logger.warning(f"[PesaLink reconciler] notify failed: {ne}")
