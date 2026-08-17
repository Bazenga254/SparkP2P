"""Public B2C callback ingress (Option A) for the downloadable B2C bot.

A merchant's B2C bot runs on their own machine with no public URL, so Safaricom can't POST the
async B2C/AccountBalance result to it directly. Instead the bot registers THESE public SparkP2P
URLs as its ResultURL/QueueTimeOutURL; we receive Daraja's callback, store it by ConversationID,
and the bot polls `GET /api/b2c/result/{conversationId}` to learn the paid/failed outcome.

In-memory store (single uvicorn worker, like the relay). Results are short-lived — the bot polls
within seconds — so a restart losing a few is acceptable at this stage; a DB table can back this
later for durability.
"""
import logging
import time

from fastapi import APIRouter, Request

router = APIRouter()
logger = logging.getLogger("sparkp2p.b2c")

# conversationId -> outcome dict. Capped so it can't grow unbounded.
_b2c_results: dict = {}
_MAX = 5000

# Inbound C2B payments (sell side): the buyer pays the merchant's Paybill, Safaricom POSTs it here
# (the merchant registers this confirmation URL on their shortcode). Newest last; capped. The bot
# polls GET /c2b/payments and matches each to a pending sell order by amount + payer name.
_c2b_payments: list = []
_C2B_MAX = 5000


def _prune():
    if len(_b2c_results) > _MAX:
        for k in sorted(_b2c_results, key=lambda k: _b2c_results[k].get("receivedAt", 0))[: len(_b2c_results) - _MAX]:
            _b2c_results.pop(k, None)


def _params(result: dict) -> dict:
    """Flatten Daraja's ResultParameters list into a {Key: Value} dict."""
    out = {}
    rp = (result.get("ResultParameters") or {}).get("ResultParameter") or []
    if isinstance(rp, dict):
        rp = [rp]
    for p in rp:
        if isinstance(p, dict) and "Key" in p:
            out[p["Key"]] = p.get("Value")
    return out


@router.post("/b2c/result")
async def b2c_result(request: Request):
    """Daraja B2C ResultURL. ResultCode 0 = paid; non-zero = failed (ResultDesc has the reason)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    result = body.get("Result", {}) if isinstance(body, dict) else {}
    cid = result.get("ConversationID")
    try:
        code = int(result.get("ResultCode"))
    except Exception:
        code = -1
    p = _params(result)
    entry = {
        "conversationId": cid,
        "originatorConversationId": result.get("OriginatorConversationID"),
        "success": code == 0,
        "resultCode": code,
        "resultDesc": result.get("ResultDesc"),
        "receipt": p.get("TransactionReceipt") or result.get("TransactionID"),
        "amount": p.get("TransactionAmount"),
        "receiverName": p.get("ReceiverPartyPublicName"),
        "completedAt": p.get("TransactionCompletedDateTime"),
        "receivedAt": time.time(),
    }
    if cid:
        _b2c_results[cid] = entry
        _prune()
    logger.warning("[B2C-CB] result cid=%s code=%s receipt=%s name=%r",
                   cid, code, entry.get("receipt"), entry.get("receiverName"))
    # Safaricom expects this exact ack shape.
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/b2c/timeout")
async def b2c_timeout(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    logger.warning("[B2C-CB] B2C queue timeout: %s", str(body)[:300])
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.get("/result/{conversation_id}")
async def get_b2c_result(conversation_id: str):
    """The bot polls this for each pending leg. {status: pending} until Daraja's callback lands."""
    r = _b2c_results.get(conversation_id)
    if not r:
        return {"status": "pending"}
    return {"status": "done", **r}


def _parse_balance(raw: str) -> list:
    """Daraja AccountBalance is a pipe/&-delimited string of per-account balances:
    'Working Account|KES|1000.00|1000.00|0.00|0.00&Utility Account|KES|500.00|500.00|...'.
    Fields per account: Name|Currency|Balance|Available|Reserved|Uncleared."""
    accounts = []
    for part in str(raw or "").split("&"):
        f = part.split("|")
        if len(f) >= 4 and f[0].strip():
            try:
                bal = float(f[2])
            except Exception:
                bal = None
            try:
                avail = float(f[3])
            except Exception:
                avail = None
            accounts.append({"name": f[0].strip(), "currency": f[1].strip() if len(f) > 1 else "KES",
                             "balance": bal, "available": avail})
    return accounts


@router.post("/balance/result")
async def balance_result(request: Request):
    """AccountBalance ResultURL — the actual balance. Parsed into per-account balances so the bot
    can show the merchant's live Paybill balance (B2C pays from the Utility/Working account)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    result = body.get("Result", {}) if isinstance(body, dict) else {}
    cid = result.get("ConversationID")
    p = _params(result)
    raw = p.get("AccountBalance")
    accounts = _parse_balance(raw)
    # Capture the async outcome — a bad SecurityCredential/initiator ACKs fine but returns a non-zero
    # ResultCode here with NO AccountBalance, so the bot would otherwise just show an empty balance.
    try:
        _rc = int(result.get("ResultCode"))
    except Exception:
        _rc = -1
    _rdesc = result.get("ResultDesc")
    if cid:
        _b2c_results[cid] = {
            "conversationId": cid, "type": "balance",
            "balance": raw, "accounts": accounts,
            "resultCode": _rc, "resultDesc": _rdesc, "receivedAt": time.time(),
        }
        _prune()
    logger.warning("[B2C-CB] balance cid=%s rc=%s accounts=%s", cid, _rc, [(a["name"], a["balance"]) for a in accounts])
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.post("/balance/timeout")
async def balance_timeout(request: Request):
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


# ── C2B (sell side): the buyer pays the merchant's Paybill ────────────────────
@router.post("/c2b/validation")
async def c2b_validation(request: Request):
    """C2B ValidationURL. With ResponseType=Completed we accept everything and reconcile on
    confirmation (matching the payment to a sell order is done bot-side, not here)."""
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


def record_c2b(body: dict):
    """Record a C2B buyer payment into the store for the B2C bot to poll + name-match. Called by
    the dedicated /c2b/confirmation endpoint AND mirrored from the platform's existing
    /api/payment/c2b/confirm handler (so a shared Paybill like 4041355 feeds both the platform's
    subscription/credit routing AND the B2C sell-side without changing its registered C2B URL).
    Deduped by TransID."""
    if not isinstance(body, dict):
        return None
    tx = body.get("TransID")
    if tx and any(p.get("transId") == tx for p in _c2b_payments):
        return None   # already recorded (both callers may fire)
    payer = " ".join(str(x) for x in [body.get("FirstName"), body.get("MiddleName"), body.get("LastName")] if x).strip()
    try:
        amount = float(body.get("TransAmount") or 0)
    except Exception:
        amount = 0.0
    entry = {
        "transId": tx,
        "amount": amount,
        "msisdn": body.get("MSISDN"),
        "payerName": payer,
        "billRef": body.get("BillRefNumber") or "",
        "shortcode": str(body.get("BusinessShortCode") or body.get("ShortCode") or ""),
        "transTime": body.get("TransTime"),
        "receivedAt": time.time(),
    }
    _c2b_payments.append(entry)
    if len(_c2b_payments) > _C2B_MAX:
        del _c2b_payments[: len(_c2b_payments) - _C2B_MAX]
    logger.warning("[B2C-CB] C2B in: amt=%s from=%r ref=%r short=%s tx=%s",
                   amount, payer, entry["billRef"], entry["shortcode"], entry["transId"])
    return entry


@router.post("/c2b/confirmation")
async def c2b_confirmation(request: Request):
    """C2B ConfirmationURL — the actual buyer payment. Carries the payer's REAL M-Pesa name
    (First/Middle/Last), which the bot matches against the buyer's Binance name for instant
    verification. Store it; the bot polls /c2b/payments and matches by amount + name."""
    try:
        body = await request.json()
    except Exception:
        try:
            body = dict(await request.form())
        except Exception:
            body = {}
    record_c2b(body)
    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.get("/c2b/payments")
async def c2b_payments(shortcode: str = "", since: float = 0.0):
    """Bot poll: C2B payments received after `since` (epoch secs), optionally for one shortcode."""
    out = [p for p in _c2b_payments
           if p["receivedAt"] > since and (not shortcode or p["shortcode"] == str(shortcode))]
    return {"payments": out, "now": time.time()}
