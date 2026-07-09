"""Reconcile outbound Choice Bank transfer statuses against Choice's ACTUAL result.

Transfers are recorded optimistically (the initiation/OTP-confirm only means "submitted").
Choice can still reject a transfer later (e.g. "Invalid Account"), and its failure webhook is
unreliable — so a failed transfer can sit in our app showing "completed". This poller queries
Choice /query/getTransResult for recent outbound payments and corrects the status to match,
alerting the merchant when a payment that looked completed actually FAILED.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.payment import Payment, PaymentStatus

logger = logging.getLogger(__name__)

_CHECK_EVERY = 60  # seconds
_LOOKBACK_HOURS = 3

_FAILED = {"4", "-1", "failed", "timeout"}
_SUCCESS = {"8", "success", "completed", "00000"}


def _status_of(res: dict) -> str:
    if not isinstance(res, dict):
        return ""
    data = res.get("data")
    src = data if isinstance(data, dict) else res
    return str(src.get("txStatus") or "")


async def outbound_reconcile_poller():
    logger.info("[OutboundReconcile] poller started")
    while True:
        await asyncio.sleep(_CHECK_EVERY)
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=_LOOKBACK_HOURS)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Payment).where(
                        Payment.transaction_type == "CHOICE_OUTBOUND",
                        Payment.status.in_([PaymentStatus.PENDING, PaymentStatus.COMPLETED]),
                        Payment.created_at >= cutoff,
                        Payment.mpesa_transaction_id.isnot(None),
                    )
                )).scalars().all()
                if not rows:
                    continue

                from app.services.choice_bank import client as choice
                for p in rows:
                    try:
                        res = await choice.get_transaction_result(p.mpesa_transaction_id)
                    except Exception as e:
                        logger.warning(f"[OutboundReconcile] getTransResult failed for payment {p.id}: {e}")
                        continue
                    st = _status_of(res)

                    if st in _FAILED and p.status != PaymentStatus.FAILED:
                        _was_completed = (p.status == PaymentStatus.COMPLETED)
                        p.status = PaymentStatus.FAILED
                        await db.commit()
                        logger.warning(
                            f"[OutboundReconcile] Payment {p.id} (KES {p.amount:.0f} → {p.destination}) "
                            f"was {'COMPLETED' if _was_completed else 'PENDING'} but Choice FAILED it — corrected to FAILED."
                        )
                        # If it had already been reported as completed, the buy order may be marked
                        # paid on Binance while no money left — alert the merchant to act.
                        try:
                            from app.models.trader import Trader
                            from app.api.routes.telegram import notify_trader
                            _t = (await db.execute(select(Trader).where(Trader.id == p.trader_id))).scalar_one_or_none()
                            if _t:
                                _order_ref = ""
                                if p.remarks and p.remarks.upper().startswith("BUY "):
                                    _order_ref = p.remarks.split(":")[0].replace("BUY", "").strip()
                                _extra = (f"\n\n⚠️ This order may be marked PAID on Binance but the money did NOT leave. "
                                          f"Please review/cancel it on Binance or contact the seller." if _was_completed else "")
                                await notify_trader(_t,
                                    f"❌ <b>Transfer failed</b>\n\nKES {int(p.amount):,} → {p.sender_name or p.destination} "
                                    f"was rejected by the bank" + (f" (order {_order_ref})" if _order_ref else "") + "." + _extra)
                        except Exception:
                            pass

                    elif st in _SUCCESS and p.status == PaymentStatus.PENDING:
                        p.status = PaymentStatus.COMPLETED
                        await db.commit()
                        logger.info(f"[OutboundReconcile] Payment {p.id} PENDING → COMPLETED (Choice confirmed).")
        except Exception as e:
            logger.warning(f"[OutboundReconcile] loop error: {e}")
