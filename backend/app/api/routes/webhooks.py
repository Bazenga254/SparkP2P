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
    """Fire asyncio event for any pending waiter — transaction OTP or email verification."""
    resolved = False

    # Transaction OTP (choice-pay-confirm-sms)
    from app.api.routes.extension import _pending_sms_otps
    entry = _pending_sms_otps.get(account_last_4)
    if entry:
        entry["otp"] = otp
        entry["event"].set()
        logger.info(f"[{source}] Resolved transaction OTP waiter for ****{account_last_4}")
        resolved = True

    # Email verification (admin setup-otp-email)
    ev = pending_email_verifications.get(account_last_4)
    if ev:
        ev["otp"] = otp
        ev["event"].set()
        logger.info(f"[{source}] Resolved email-verification waiter for ****{account_last_4}")
        resolved = True

    if not resolved:
        logger.warning(f"[{source}] No pending waiter for ****{account_last_4} — OTP arrived but nobody is listening")


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
        logger.info(f"[SMS-OTP] not a Choice Bank OTP — ignored")
        return {"ok": True}

    logger.info(f"[SMS-OTP] OTP {otp} for account ****{account_last_4}")
    _resolve_otp(otp, account_last_4, "SMS-OTP")
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
