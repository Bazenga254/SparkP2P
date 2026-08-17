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
