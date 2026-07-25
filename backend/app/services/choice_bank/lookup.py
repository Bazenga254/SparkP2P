"""Look up a single Choice Bank transaction for a merchant.

Powers two things a merchant asked for:
  • "check this transaction" — they paste an M-Pesa code / bank reference / txId
    and we say whether the money actually arrived, even if the Transactions page
    hasn't shown it yet (Choice sometimes credits the balance before the txn is
    listed, and the 0002 webhook can lag).
  • the support bot's background transaction check.

Two sources, cheapest first:
  1. our own Payment ledger (what the webhook/poller already recorded);
  2. Choice's live /query/getTransList for the merchant's sub-account.
The live query is why this finds a payment the page is still missing.
"""
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, or_

from app.models.payment import Payment, PaymentDirection, PaymentStatus

logger = logging.getLogger(__name__)


def _norm(s) -> str:
    return "".join(str(s or "").split()).upper()


def _row_refs(tx: dict) -> list[str]:
    """Every identifier a getTransList row might carry the code/reference under."""
    ext = tx.get("extInfo") if isinstance(tx.get("extInfo"), dict) else {}
    return [_norm(v) for v in (
        tx.get("txId"), tx.get("externalTxId"), ext.get("externalTxId"),
        tx.get("referenceNo"), tx.get("reference"), tx.get("billRefNumber"),
        tx.get("mpesaReceipt"), ext.get("mpesaReceipt"),
    ) if v]


def _fmt_row(tx: dict, source: str) -> dict:
    try:
        amount = float(tx.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0.0
    ext = tx.get("extInfo") if isinstance(tx.get("extInfo"), dict) else {}
    ct = tx.get("createTime") or tx.get("completeTime")
    when = None
    if ct:
        try:
            when = datetime.fromtimestamp(int(ct) / 1000, tz=timezone.utc).isoformat()
        except Exception:
            when = str(ct)
    status = str(tx.get("txStatus") or "")
    return {
        "found": True,
        "source": source,
        "amount": round(amount, 2),
        "status": "success" if status in ("8", "", "success") else status,
        "tx_id": tx.get("txId") or "",
        "reference": tx.get("externalTxId") or ext.get("externalTxId") or "",
        "counterparty": tx.get("oppoAccountName") or ext.get("counterpartyName") or "",
        "time": when,
        "tx_type": tx.get("txType") or "",
    }


async def find_transaction(db, trader, query: str = "", amount: float | None = None, days: int = 30) -> dict:
    """Find a transaction on the merchant's Choice account by code/reference/txId
    (and/or amount). Returns {found: bool, ...} — never raises for "not found"."""
    if not getattr(trader, "choice_account_id", None):
        return {"found": False, "reason": "no_choice_account"}

    q = _norm(query)

    # 1) Our own ledger — matches what the webhook/poller already saved.
    if q:
        row = (await db.execute(
            select(Payment).where(
                Payment.trader_id == trader.id,
                or_(
                    Payment.mpesa_transaction_id == query.strip(),
                    Payment.mpesa_receipt_number == query.strip(),
                ),
            ).limit(1)
        )).scalar_one_or_none()
        if row:
            return {
                "found": True, "source": "ledger",
                "amount": round(float(row.amount or 0), 2),
                "status": (row.status.value if hasattr(row.status, "value") else str(row.status)),
                "tx_id": row.mpesa_transaction_id or "",
                "reference": row.mpesa_receipt_number or "",
                "counterparty": row.sender_name or "",
                "time": row.created_at.isoformat() if row.created_at else None,
                "direction": (row.direction.value if hasattr(row.direction, "value") else str(row.direction)),
            }

    # 2) Live query to Choice — this is what catches a payment the page is missing.
    from app.services.choice_bank import client as choice
    from app.services.sell_inbound_poller import _extract_rows

    now = datetime.now(timezone.utc)
    start_ms = int((now - timedelta(days=min(days, 180))).timestamp() * 1000)
    end_ms = int(now.timestamp() * 1000)

    try:
        # Success first (most lookups), then all statuses so a pending/failed one is still findable.
        for statuses in ([8], None):
            for page in (1, 2, 3):
                res = await choice.get_transaction_list(
                    trader.choice_account_id,
                    tx_status=statuses, start_ms=start_ms, end_ms=end_ms,
                    page_no=page, page_size=50,
                )
                rows = _extract_rows(res)
                if not rows:
                    break
                for tx in rows:
                    if q and q in _row_refs(tx):
                        return _fmt_row(tx, "bank")
                    if amount is not None and not q:
                        try:
                            if abs(float(tx.get("amount") or 0) - float(amount)) < 0.5:
                                return _fmt_row(tx, "bank")
                        except (TypeError, ValueError):
                            pass
                if len(rows) < 50:
                    break
    except Exception as e:
        logger.warning(f"[lookup] Choice query failed for trader {trader.id}: {e}")
        return {"found": False, "reason": "bank_query_failed"}

    return {"found": False, "reason": "not_found"}
