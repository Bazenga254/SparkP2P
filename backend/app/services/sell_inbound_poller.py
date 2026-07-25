"""Active inbound-payment detector for SELL orders.

The Choice Bank push webhook (0002) is unreliable — it can fail to fire, or match a
payment to the wrong order, leaving a genuinely-paid SELL order uncredited (and eventually
cancelled). This poller actively queries /query/getTransList for every trader with a
pending SELL order, finds incoming credits, matches them to the correct order BY AMOUNT,
and records them (with the payer's name) so the normal release flow can proceed.

It complements the webhook: whichever sees the payment first records it; the txId dedup
prevents double-recording.
"""
import asyncio
import logging
from datetime import datetime, timezone
from sqlalchemy import select, func

from app.core.database import async_session
from app.models.order import Order, OrderSide, OrderStatus
from app.models.payment import Payment, PaymentDirection, PaymentStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

_CHECK_EVERY = 30  # seconds
# If a sell order has waited this long with no matching payment, hand it to the
# merchant: alert on Telegram and flip it to DISPUTED (manual mode) so it stops
# blocking and a person confirms with the buyer. (Agreed formula.)
_MATCH_TIMEOUT_S = 120

# Choice txTypes that are OUTBOUND (money leaving) — never an incoming customer payment.
_OUTBOUND_TX_TYPES = {
    "TTID0001", "TTID0002", "TTID0005", "TTID0006",
    "TTID0009", "TTID0024", "TTID0025", "TTID0027",
}


def _extract_rows(res: dict):
    """getTransList response is {"code","data":{"totalRows","result":[...]}} (or flat)."""
    if not isinstance(res, dict):
        return []
    data = res.get("data")
    if isinstance(data, dict) and isinstance(data.get("result"), list):
        return data["result"]
    if isinstance(res.get("result"), list):
        return res["result"]
    return []


async def _received_for_order(db, order_id) -> float:
    return float((await db.execute(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(
            Payment.order_id == order_id,
            Payment.direction == PaymentDirection.INBOUND,
            Payment.status == PaymentStatus.COMPLETED,
            Payment.transaction_type == "CHOICE_INBOUND",
        )
    )).scalar() or 0)


async def sell_inbound_poller():
    logger.info("[SellInbound] poller started")
    while True:
        await asyncio.sleep(_CHECK_EVERY)
        try:
            async with async_session() as db:
                pend = (await db.execute(select(Order).where(
                    Order.side == OrderSide.SELL,
                    Order.status == OrderStatus.PENDING,
                ))).scalars().all()
                if not pend:
                    continue

                by_trader = {}
                for o in pend:
                    by_trader.setdefault(o.trader_id, []).append(o)

                from app.services.choice_bank import client as choice
                for tid, orders in by_trader.items():
                    trader = (await db.execute(select(Trader).where(Trader.id == tid))).scalar_one_or_none()
                    if not trader or not trader.choice_account_id:
                        continue
                    try:
                        res = await choice.get_transaction_list(trader.choice_account_id, tx_status=[8], page_size=30)
                    except Exception as e:
                        logger.warning(f"[SellInbound] getTransList failed for trader {tid}: {e}")
                        continue

                    for tx in _extract_rows(res):
                        if str(tx.get("txType") or "").upper() in _OUTBOUND_TX_TYPES:
                            continue
                        tx_id = str(tx.get("txId") or "")
                        if not tx_id:
                            continue
                        try:
                            amount = float(tx.get("amount") or 0)
                        except (TypeError, ValueError):
                            continue
                        if amount <= 0:
                            continue
                        # dedup — already recorded by webhook or a previous poll
                        if (await db.execute(select(Payment).where(Payment.mpesa_transaction_id == tx_id))).scalar_one_or_none():
                            continue

                        sender_name = tx.get("oppoAccountName") or ""

                        # Match to the RIGHT order by AMOUNT *and* payer NAME (the agreed
                        # second factor). A wrong-name same-amount order is skipped, not
                        # forced. Unknown Binance name falls back to amount-only (fail-safe).
                        from app.services.sell_matching import pick_order
                        awaiting = [o for o in orders if o.status == OrderStatus.PENDING]
                        recv = {o.id: await _received_for_order(db, o.id) for o in awaiting}
                        res = pick_order(awaiting, amount, sender_name, recv)
                        if res.order is None:
                            # Real credit, but not for any awaiting order (wrong name, or a
                            # deposit/unrelated). The reconcile poller records it for the
                            # Transactions page; we just don't release crypto on it.
                            continue

                        matched = res.order
                        db.add(Payment(
                            order_id=matched.id, trader_id=tid,
                            direction=PaymentDirection.INBOUND,
                            mpesa_transaction_id=tx_id, transaction_type="CHOICE_INBOUND",
                            amount=amount, sender_name=sender_name,
                            mpesa_receipt_number=None,
                            status=PaymentStatus.COMPLETED,
                        ))
                        await db.commit()
                        logger.warning(
                            f"[SellInbound] MATCHED ({res.verdict}) KES {amount:.0f} from {sender_name!r} → "
                            f"order {matched.binance_order_number} (txId {tx_id}) — recorded; release flow will proceed."
                        )

                # ── Timeout → manual mode ──────────────────────────────────
                # A sell order still waiting for its payment after the timeout,
                # with nothing received, is handed to the merchant: alert + flip
                # to DISPUTED so it stops blocking and a person confirms.
                await _timeout_unpaid_orders(db)
        except Exception as e:
            logger.warning(f"[SellInbound] loop error: {e}")


async def _timeout_unpaid_orders(db):
    from app.api.routes.telegram import notify_trader
    now = datetime.now(timezone.utc)
    pend = (await db.execute(select(Order).where(
        Order.side == OrderSide.SELL, Order.status == OrderStatus.PENDING,
    ))).scalars().all()
    for o in pend:
        created = o.created_at
        if not created:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if (now - created).total_seconds() < _MATCH_TIMEOUT_S:
            continue
        # Any money received against it? If so it's mid-payment — leave it.
        if (await _received_for_order(db, o.id)) > 0:
            continue
        o.status = OrderStatus.DISPUTED          # manual mode (stops auto-matching it)
        await db.commit()
        try:
            trader = (await db.execute(select(Trader).where(Trader.id == o.trader_id))).scalar_one_or_none()
            if trader:
                await notify_trader(trader,
                    "⏱️ <b>Payment not found — please confirm with the buyer</b>\n\n"
                    f"<b>Order:</b> {o.binance_order_number}\n"
                    f"<b>Amount:</b> KES {int(o.fiat_amount or 0):,}\n"
                    f"<b>Buyer:</b> {o.counterparty_name or '—'}\n\n"
                    "We could not find a matching payment for this order within 2 minutes. "
                    "It has moved to manual mode — check your Choice Bank account and, if the "
                    "payment is there, release the crypto manually. If not, wait for the buyer or cancel."
                )
        except Exception as _e:
            logger.warning(f"[SellInbound] timeout notify failed for order {o.id}: {_e}")
        logger.warning(f"[SellInbound] TIMEOUT order {o.binance_order_number} → DISPUTED (manual mode)")
