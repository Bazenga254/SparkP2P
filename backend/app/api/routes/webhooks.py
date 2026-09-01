"""External webhook receivers: inbound SMS (any gateway) + Mailgun inbound email OTP."""

import email as _email_lib
import logging
import re

from fastapi import APIRouter, Request

router = APIRouter()
logger = logging.getLogger(__name__)

# Choice Bank OTP format (same wording in both email and SMS bodies):
# Email: "Verification code 0423 for transaction of KES 3500.00 from ****8626."
# SMS:   "Verification code 1234 for transferring KES 3500.00 from account ****8626"
_CHOICE_OTP_RE = re.compile(
    r"[Vv]erification\s+code[:\s]+(\d{3,8})"
    r".*?\*{2,4}(\d{4})",
    re.DOTALL,
)


def _parse_choice_otp(body: str):
    """Return (otp, account_last_4) from a Choice Bank OTP email/SMS body, or (None, None)."""
    m = _CHOICE_OTP_RE.search(body or "")
    if not m:
        return None, None
    return m.group(1), m.group(2)


# account_last_4 -> {event, otp} for email verification (addOrUpdateEmail flow)
pending_email_verifications: dict[str, dict] = {}


def _resolve_otp(otp: str, account_last_4: str, source: str):
    """Fire asyncio event for any pending waiter — transaction OTP or email verification.
    Always caches the OTP so a confirm-sms call that starts slightly later can still pick it up."""
    import time as _t
    resolved = False

    # Transaction OTP (choice-pay-confirm-sms / send-money/confirm-sms)
    from app.api.routes.extension import _pending_sms_otps
    entry = _pending_sms_otps.get(account_last_4)
    if entry and entry.get("event"):
        entry["otp"] = otp
        entry["ts"] = _t.time()
        entry["event"].set()
        logger.warning(f"[{source}] Resolved transaction OTP waiter for ****{account_last_4} (a withdrawal WAS waiting)")
        resolved = True
    else:
        # No active waiter — cache OTP for up to 5 minutes so confirm-sms can pick it up
        _pending_sms_otps[account_last_4] = {"otp": otp, "ts": _t.time(), "event": None}
        logger.warning(f"[{source}] Cached OTP for ****{account_last_4} — NO waiter was listening (confirm step not running, or keyed to a different account last-4)")

    # Email verification (admin setup-otp-email)
    ev = pending_email_verifications.get(account_last_4)
    if ev:
        ev["otp"] = otp
        ev["event"].set()
        logger.info(f"[{source}] Resolved email-verification waiter for ****{account_last_4}")
        resolved = True


# ── Inbound SMS (Twilio / Advanta / Africa's Talking) ────────────────────────

@router.post("/sms-otp")
async def inbound_sms_webhook(request: Request):
    """
    Inbound SMS webhook from any SMS gateway.
    Normalises Twilio (From/Body), Advanta (mobile/message), and AT (from/text) payloads.
    No auth — gateway POSTs directly.
    """
    content_type = request.headers.get("content-type", "")
    payload = await request.json() if "json" in content_type else dict(await request.form())

    mobile = str(
        payload.get("From") or payload.get("from") or
        payload.get("mobile") or payload.get("msisdn") or ""
    )
    body = str(
        payload.get("Body") or payload.get("body") or
        payload.get("message") or payload.get("text") or ""
    )
    logger.info(f"[SMS-OTP] inbound from {mobile}: {body[:120]!r}")

    otp, account_last_4 = _parse_choice_otp(body)
    if not otp:
        # WARNING (visible in journalctl) WITH the body: a forwarded SMS that does
        # NOT parse as a Choice OTP is the exact failure behind "the OTP came but
        # the webhook didn't pick it up" — auto-withdraw then times out. Seeing the
        # real wording is how we catch a Choice SMS-format change vs the regex.
        logger.warning(f"[SMS-OTP] inbound from {mobile} did NOT parse as a Choice OTP — ignored. Body: {body[:200]!r}")
        return {"ok": True}

    logger.warning(f"[SMS-OTP] parsed OTP {otp} for account ****{account_last_4} (from {mobile})")
    _resolve_otp(otp, account_last_4, "SMS-OTP")
    return {"ok": True}


# ── Inbound Support Reply (Brevo Inbound Parsing on sparkp2p.com) ─────────────

@router.post("/support-reply")
async def inbound_support_reply(request: Request):
    """Brevo inbound-parse webhook for @sparkp2p.com ticket replies (Choice Bank +
    clients). Threads the message into its OpsTicket by the +tag / [SPK-...] number."""
    try:
        payload = await request.json()
    except Exception:
        payload = dict(await request.form())
    items = payload.get("items") if isinstance(payload, dict) else None
    attachments = []
    if items and isinstance(items, list):
        item = items[0]
        sender    = (item.get("From") or {}).get("Address", "")
        to_list   = item.get("To") or []
        recipient = to_list[0].get("Address", "") if to_list else ""
        subject   = item.get("Subject", "")
        body      = item.get("RawTextBody") or item.get("ExtractedMarkdownMessage") or ""
        if not body:
            body = re.sub(r"<[^>]+>", " ", item.get("RawHtmlBody") or "")
        # Inline attachments Choice Bank / the client sent back (when Brevo includes
        # the base64 Content; download-token-only attachments are skipped).
        for a in (item.get("Attachments") or []):
            content = a.get("Content") or a.get("content")
            if content:
                attachments.append({"name": a.get("Name") or a.get("name") or "file",
                                    "content": content,
                                    "type": a.get("ContentType") or a.get("contentType") or ""})
    else:
        sender    = str(payload.get("sender") or payload.get("From") or "")
        recipient = str(payload.get("recipient") or payload.get("To") or "")
        subject   = str(payload.get("subject") or payload.get("Subject") or "")
        body      = re.sub(r"<[^>]+>", " ", str(payload.get("stripped-text") or payload.get("body-plain") or payload.get("body-html") or ""))
        # Attachments the inbound SMTP server extracted from the MIME message.
        for a in (payload.get("attachments") or []):
            if a.get("content"):
                attachments.append({"name": a.get("name") or "file", "content": a["content"],
                                    "type": a.get("type") or ""})
    body = body.strip()
    logger.info(f"[Support-Reply] from={sender} to={recipient} subject={subject!r} attachments={len(attachments)}")
    try:
        from app.core.database import async_session
        from app.api.routes.ops_tickets import handle_inbound_reply
        async with async_session() as db:
            matched = await handle_inbound_reply(to_addr=recipient, from_addr=sender, subject=subject, body_text=body, db=db, attachments=attachments)
        if not matched:
            logger.info("[Support-Reply] no matching ticket for to=%s subject=%r", recipient, subject)
    except Exception as e:
        logger.warning("[Support-Reply] handling failed: %s", e)
    return {"ok": True}


# ── Inbound Email OTP (Mailgun inbound parse) ─────────────────────────────────

@router.post("/email-otp")
async def inbound_email_webhook(request: Request):
    """
    Brevo inbound email parsing webhook. Fires when an email arrives at otp.sparkp2p.com.
    Brevo POSTs JSON: {"items": [{"From": {...}, "To": [...], "RawTextBody": "...", ...}]}
    No auth — Brevo posts directly; we validate by parsing expected OTP content.
    """
    try:
        payload = await request.json()
    except Exception:
        payload = dict(await request.form())

    # Brevo wraps each email in an "items" array
    items = payload.get("items") if isinstance(payload, dict) else None
    if items and isinstance(items, list):
        item = items[0]
        sender    = (item.get("From") or {}).get("Address", "")
        to_list   = item.get("To") or []
        recipient = to_list[0].get("Address", "") if to_list else ""
        subject   = item.get("Subject", "")
        body      = item.get("RawTextBody") or item.get("ExtractedMarkdownMessage") or ""
        if not body:
            raw_html = item.get("RawHtmlBody") or ""
            body = re.sub(r"<[^>]+>", " ", raw_html)
    else:
        # Fallback: Mailgun-style form fields
        sender    = str(payload.get("sender") or payload.get("From") or "")
        recipient = str(payload.get("recipient") or payload.get("To") or "")
        subject   = str(payload.get("subject") or payload.get("Subject") or "")
        body      = str(payload.get("stripped-text") or payload.get("body-plain") or
                        payload.get("body-html") or "")
        body = re.sub(r"<[^>]+>", " ", body)

    body = re.sub(r"\s+", " ", body).strip()
    logger.info(f"[Email-OTP] from={sender} to={recipient} subject={subject!r} body={body[:200]!r}")

    otp, account_last_4 = _parse_choice_otp(body)
    if not otp:
        logger.info(f"[Email-OTP] not a Choice Bank OTP email — ignored")
        return {"ok": True}

    logger.info(f"[Email-OTP] OTP {otp} for account ****{account_last_4}")
    _resolve_otp(otp, account_last_4, "Email-OTP")
    return {"ok": True}


# ── NCBA Paybill-Level Push Notification (IPN) — SparkPay collection reconciliation ──
# NCBA POSTs a JSON alert to us the instant money lands on Paybill/Till 880100
# (SPARK FREELANCE SOLUTIONS / 1011775848). We authenticate it three ways before trusting
# it — the Username + Password NCBA embeds, and a SHA-256 Hash over the payload keyed with
# our shared Secret Key — then record it (de-duplicated on the M-Pesa ref) and answer with
# the exact {"ResultCode":"0",...} NCBA's spec requires. Wrong creds / bad hash → ResultCode 1.
def _ncba_expected_hash(secret_key: str, p: dict) -> str:
    """Reproduce NCBA's hash: SHA-256 of a fixed concatenation, then Base64 of the HEX digest
    string (not the raw bytes) — matching their Java sample exactly."""
    import hashlib as _hl, base64 as _b64
    parts = [
        secret_key,
        str(p.get("TransType") or ""),
        str(p.get("TransID") or ""),
        str(p.get("TransTime") or ""),
        str(p.get("TransAmount") or ""),
        str(p.get("BusinessShortCode") or p.get("AccountNr") or ""),
        str(p.get("BillRefNumber") or ""),
        str(p.get("Mobile") or p.get("PhoneNr") or ""),
        str(p.get("name") or p.get("CustomerName") or ""),
        "1",
    ]
    hex_digest = _hl.sha256("".join(parts).encode("utf-8")).hexdigest()
    return _b64.b64encode(hex_digest.encode("utf-8")).decode("utf-8")


@router.post("/ncba/ipn")
async def ncba_ipn(request: Request):
    from app.core.config import settings
    from app.core.database import async_session
    from app.models.ncba_ipn_event import NcbaIpnEvent
    from sqlalchemy import select
    import json as _json

    try:
        payload = await request.json()
    except Exception:
        logger.warning("[NCBA-IPN] non-JSON body — rejected")
        return {"ResultCode": "1", "ResultDesc": "Invalid payload"}

    trans_id = str(payload.get("TransID") or "").strip()
    logger.info("[NCBA-IPN] TransID=%s amount=%s shortcode=%s ref=%s",
                trans_id, payload.get("TransAmount"), payload.get("BusinessShortCode"),
                payload.get("BillRefNumber"))

    # 1) credentials NCBA embeds in the payload
    if (str(payload.get("Username") or "") != settings.NCBA_IPN_USERNAME
            or str(payload.get("Password") or "") != settings.NCBA_IPN_PASSWORD):
        logger.warning("[NCBA-IPN] bad username/password — rejected (TransID=%s)", trans_id)
        return {"ResultCode": "1", "ResultDesc": "Authentication failed"}

    # 2) SHA-256 hash over the payload, keyed with our shared secret
    got = str(payload.get("Hash") or payload.get("HashVal") or payload.get("SecretKey") or "")
    expected = _ncba_expected_hash(settings.NCBA_IPN_SECRET_KEY, payload)
    if not got or got != expected:
        logger.warning("[NCBA-IPN] hash mismatch — rejected (TransID=%s)", trans_id)
        return {"ResultCode": "1", "ResultDesc": "Hash verification failed"}

    if not trans_id:
        return {"ResultCode": "1", "ResultDesc": "Missing TransID"}

    # 3) record — idempotent on the M-Pesa reference (NCBA may retry the same notification)
    try:
        async with async_session() as db:
            existing = (await db.execute(
                select(NcbaIpnEvent).where(NcbaIpnEvent.trans_id == trans_id)
            )).scalar_one_or_none()
            if existing is None:
                _amt = payload.get("TransAmount")
                try:
                    _amt = float(str(_amt)) if _amt not in (None, "") else None
                except (TypeError, ValueError):
                    _amt = None
                db.add(NcbaIpnEvent(
                    trans_id=trans_id,
                    ft_ref=str(payload.get("FTRef") or "")[:40] or None,
                    trans_type=str(payload.get("TransType") or "")[:32] or None,
                    business_short_code=str(payload.get("BusinessShortCode") or "")[:16] or None,
                    bill_ref_number=str(payload.get("BillRefNumber") or "")[:64] or None,
                    narrative=str(payload.get("Narrative") or "")[:120] or None,
                    amount=_amt,
                    mobile=str(payload.get("Mobile") or "")[:64] or None,
                    payer_name=str(payload.get("name") or payload.get("CustomerName") or "")[:120] or None,
                    trans_time=str(payload.get("TransTime") or "")[:20] or None,
                    verified=True,
                    processed=False,
                    raw=_json.dumps(payload)[:8000],
                ))
                await db.commit()
                logger.info("[NCBA-IPN] recorded verified payment TransID=%s", trans_id)
            else:
                logger.info("[NCBA-IPN] duplicate TransID=%s — already recorded", trans_id)
    except Exception as e:
        # Never fail NCBA's delivery on our storage hiccup — we've authenticated it and logged it.
        logger.error("[NCBA-IPN] store error for TransID=%s: %s", trans_id, e)

    return {"ResultCode": "0", "ResultDesc": "Received"}
