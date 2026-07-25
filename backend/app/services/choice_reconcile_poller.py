"""Reconcile EVERY Choice Bank credit onto the merchant's Transactions page.

The webhook (0002/0003) and the sell-order poller only record a payment that
MATCHES a pending Binance order. But money arriving is money arriving — if a
buyer pays after the order was cancelled, or the callback simply never fired,
the credit is real and sitting in the merchant's Choice account, yet it never
reached our DB and so never showed on the Transactions page. That is exactly the
"I received it but it's not on my page" complaint.

This poller fixes it at the source: for every linked merchant it lists their
Choice transactions and records any INBOUND credit we don't already have —
regardless of whether it maps to an order. It fetches each new transaction's
full detail (getTransResult) to capture the reference number (externalTxId, the
M-Pesa code the portal shows), so the page is complete AND a merchant can look a
payment up by that code.

INBOUND ONLY on purpose: the merchant's own payouts/withdrawals are already
recorded by the flows that make them, and re-recording them here risks
double-counting the outbound revenue figures. Inbound credits touch no revenue
math, so backfilling them is safe.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.trader import Trader
from app.models.payment import Payment, PaymentDirection, PaymentStatus

logger = logging.getLogger(__name__)

_CHECK_EVERY = 180          # seconds between sweeps
_BACKFILL_DAYS = 30         # how far back to reconcile
# Leave fresh credits alone so we never race the release flow: the webhook and
# the 30s sell-order poller must get first claim on an active-order payment (they
# link it to the order and release the crypto). A credit still unrecorded after
# this window is a genuine orphan (cancelled order, missed callback, plain
# deposit) and safe to backfill for visibility.
_MIN_AGE_S = 300

# Choice txTypes that are money COMING IN (pay-ins) — the only ones we record here.
_PAY_IN_TX_TYPES = {"TTID0003", "TTID0007", "TTID0008", "TTID0011", "TTID0023"}


def _to_dt(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


async def _reconcile_trader(db, trader) -> int:
    from app.services.choice_bank import client as choice
    from app.services.sell_inbound_poller import _extract_rows

    now = datetime.now(timezone.utc)
    start_ms = int((now - timedelta(days=_BACKFILL_DAYS)).timestamp() * 1000)
    end_ms = int(now.timestamp() * 1000)
    recorded = 0

    for page in range(1, 6):   # up to 250 recent txns
        try:
            res = await choice.get_transaction_list(
                trader.choice_account_id, tx_status=[8],
                start_ms=start_ms, end_ms=end_ms, page_no=page, page_size=50,
            )
        except Exception as e:
            logger.warning(f"[reconcile] getTransList failed for trader {trader.id}: {e}")
            break
        rows = _extract_rows(res)
        if not rows:
            break

        for tx in rows:
            if str(tx.get("txType") or "").upper() not in _PAY_IN_TX_TYPES:
                continue
            tx_id = str(tx.get("txId") or "")
            if not tx_id:
                continue
            # Too fresh — let the release flow claim an active-order payment first.
            if (now - _to_dt(tx.get("createTime") or tx.get("completeTime"))).total_seconds() < _MIN_AGE_S:
                continue
            # Already have it (from the webhook, the sell poller, or a prior sweep)?
            if (await db.execute(
                select(Payment.id).where(Payment.mpesa_transaction_id == tx_id)
            )).scalar_one_or_none():
                continue

            # Pull full detail to get the reference number (externalTxId).
            ext_ref, narrative = "", None
            try:
                det = (await choice.get_transaction_result(tx_id)).get("data") or {}
                ext = det.get("extInfo") if isinstance(det.get("extInfo"), dict) else {}
                ext_ref = det.get("externalTxId") or ext.get("externalTxId") or ""
                narrative = ext.get("transactionNarrative")
            except Exception as e:
                logger.warning(f"[reconcile] getTransResult({tx_id}) failed: {e}")

            try:
                amount = float(tx.get("amount") or 0)
            except (TypeError, ValueError):
                amount = 0.0
            if amount <= 0:
                continue

            db.add(Payment(
                trader_id=trader.id,
                direction=PaymentDirection.INBOUND,
                transaction_type="CHOICE_INBOUND",
                mpesa_transaction_id=tx_id,
                mpesa_receipt_number=ext_ref or None,     # the M-Pesa code / reference
                amount=amount,
                sender_name=tx.get("oppoAccountName") or "",
                remarks=narrative,
                status=PaymentStatus.COMPLETED,
                created_at=_to_dt(tx.get("createTime") or tx.get("completeTime")),
            ))
            recorded += 1

        if len(rows) < 50:
            break

    if recorded:
        await db.commit()
        logger.info(f"[reconcile] trader {trader.id} ({trader.full_name}): recorded {recorded} missing credit(s)")
    return recorded


async def choice_reconcile_poller():
    logger.info("[reconcile] poller started (every %ss)", _CHECK_EVERY)
    while True:
        try:
            async with async_session() as db:
                traders = (await db.execute(
                    select(Trader).where(Trader.choice_account_id.isnot(None))
                )).scalars().all()
            for t in traders:
                if not t.choice_account_id:
                    continue
                try:
                    async with async_session() as db:
                        await _reconcile_trader(db, t)
                except Exception as e:
                    logger.warning(f"[reconcile] trader {t.id} error: {e}")
        except Exception as e:
            logger.warning(f"[reconcile] sweep error: {e}")
        await asyncio.sleep(_CHECK_EVERY)
