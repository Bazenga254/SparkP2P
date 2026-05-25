"""
Auto-Sweep Service
==================
When a trader initiates a withdrawal, this service queues an ImSweep record.
The desktop app (running on the designated PC) polls /ext/pending-mpesa-sweeps
and executes the sweep via the M-PESA org portal (org.ke.m-pesa.com) — FREE.

Flow:
  1. Trader confirms withdrawal (OTP verified)
  2. trigger_im_sweep() creates an ImSweep with status="pending"
  3. Desktop app sees it via GET /ext/pending-mpesa-sweeps
  4. Desktop app navigates org portal and submits the withdrawal
  5. Desktop app calls POST /ext/mpesa-sweep-complete → status="completed"
  6. Settlement engine pays the trader (net amount after fees) in parallel
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.im_sweep import ImSweep

logger = logging.getLogger(__name__)


async def trigger_im_sweep(
    amount: float,
    trader_id: int,
    withdrawal_tx_id: int | None,
    reference: str,
    db: AsyncSession,
) -> dict:
    """
    Queue a pending M-PESA org portal sweep.

    The desktop app (org.ke.m-pesa.com automation) picks this up within 30 seconds
    and executes the "Organization Withdrawal From MPESA-Real Time" — no charge.

    Args:
        amount:            Gross withdrawal amount (before any fees).
        trader_id:         Trader who triggered the withdrawal.
        withdrawal_tx_id:  The wallet_transaction.id for the withdrawal (for linking).
        reference:         Short label e.g. "WD-trader@email.com-20260410".
        db:                Async DB session.

    Returns:
        dict with keys: success, sweep_id, error (if failed)
    """
    try:
        sweep = ImSweep(
            trader_id=trader_id,
            withdrawal_tx_id=withdrawal_tx_id,
            amount=amount,
            status="pending",
        )
        db.add(sweep)
        await db.commit()
        await db.refresh(sweep)
        logger.info(f"[Sweep] KES {amount:,.0f} sweep queued (sweep_id={sweep.id}) — desktop app will execute via org portal")
        return {"success": True, "sweep_id": sweep.id, "conversation_id": None}
    except Exception as e:
        logger.error(f"[Sweep] Failed to queue sweep: {e}")
        return {"success": False, "error": str(e)}
