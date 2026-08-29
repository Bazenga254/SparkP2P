"""IMAP poller for the admin dashboard mailbox. Pulls new mail from the Zoho mailbox into
email_messages. Sending (compose/reply) is handled separately via Brevo — the VPS blocks
outbound SMTP. Connection-safe: never holds a DB session across the (slow) IMAP calls."""
import asyncio
import base64
import email
import imaplib
import logging
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

from sqlalchemy import select, func, cast, Integer

from app.core.config import settings
from app.core.database import async_session
from app.models.email_message import EmailMessage

logger = logging.getLogger(__name__)
POLL_INTERVAL = 60  # seconds
FIRST_RUN_LIMIT = 40  # only the most recent N on the very first sync

SUPPORT_HINTS = ("support", "help", "issue", "problem", "complaint", "dispute", "refund", "not credited")


def _decode(s: str) -> str:
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return str(s)


def _extract_bodies(msg):
    text, html = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            if "attachment" in str(part.get("Content-Disposition") or ""):
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                decoded = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            except Exception:
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and not text:
                text = decoded
            elif ctype == "text/html" and not html:
                html = decoded
    else:
        try:
            payload = msg.get_payload(decode=True)
            body = payload.decode(msg.get_content_charset() or "utf-8", errors="replace") if payload else ""
        except Exception:
            body = ""
        if msg.get_content_type() == "text/html":
            html = body
        else:
            text = body
    return text, html


MAX_ATTACH_BYTES = 15 * 1024 * 1024  # skip anything larger to avoid DB bloat


def _extract_attachments(msg):
    """Collect real attachments (parts with a filename or attachment disposition)."""
    out = []
    if not msg.is_multipart():
        return out
    for part in msg.walk():
        disp = str(part.get("Content-Disposition") or "").lower()
        filename = part.get_filename()
        if "attachment" not in disp and not filename:
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            payload = None
        if not payload or len(payload) > MAX_ATTACH_BYTES:
            continue
        out.append({
            "filename": (_decode(filename) or "attachment")[:400],
            "content_type": (part.get_content_type() or "application/octet-stream")[:160],
            "size": len(payload),
            "content_b64": base64.b64encode(payload).decode("ascii"),
        })
    return out


# Folders we never pull into the dashboard inbox (outbound / system / junk).
SYNC_EXCLUDE = {"drafts", "templates", "sent", "trash", "snoozed", "outbox", "spam", "archive"}


def _folder_name(line: bytes) -> str:
    """Parse the folder name out of an IMAP LIST response line (last quoted token)."""
    s = line.decode(errors="replace")
    name = s.rsplit('"/"', 1)[-1].strip()
    if len(name) >= 2 and name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    return name


def _parse_message(msg, folder: str, uid: str) -> dict:
    from_name, from_addr = parseaddr(_decode(msg.get("From")))
    text, html = _extract_bodies(msg)
    subj = _decode(msg.get("Subject"))
    to_addr = _decode(msg.get("To"))
    try:
        rec = parsedate_to_datetime(msg.get("Date"))
    except Exception:
        rec = datetime.now(timezone.utc)
    support = any(h in (subj + " " + to_addr).lower() for h in SUPPORT_HINTS)
    return {
        "imap_folder": folder, "uid": uid, "message_id": (msg.get("Message-ID") or "")[:500],
        "in_reply_to": (msg.get("In-Reply-To") or "")[:500],
        "from_addr": from_addr[:320], "from_name": (from_name or "")[:200],
        "to_addr": to_addr[:600], "subject": subj[:1000],
        "snippet": " ".join((text or "").split())[:280],
        "body_text": text, "body_html": html, "received_at": rec, "is_support": support,
        "attachments": _extract_attachments(msg),
    }


def _fetch_all_sync(baselines: dict):
    """Blocking IMAP fetch across ALL receiving folders (INBOX, Notification, Newsletter, any
    custom) — so Zoho-filtered mail still reaches the dashboard. One login; per-folder UID
    baseline from `baselines`; readonly select so the server's \\Seen flags aren't touched."""
    out = []
    M = imaplib.IMAP4_SSL(settings.MAILBOX_IMAP_HOST, settings.MAILBOX_IMAP_PORT)
    try:
        M.login(settings.MAILBOX_LOGIN, settings.MAILBOX_APP_PASSWORD)
        folders = []
        for line in (M.list()[1] or []):
            name = _folder_name(line)
            if name and name.lower() not in SYNC_EXCLUDE:
                folders.append(name)
        for folder in folders:
            baseline = baselines.get(folder, 0)
            try:
                typ, _ = M.select(folder, readonly=True)
                if typ != "OK":
                    continue
                if baseline:
                    typ, data = M.uid("search", None, f"UID {baseline + 1}:*")
                else:
                    typ, data = M.uid("search", None, "ALL")
                uids = data[0].split() if data and data[0] else []
                if not baseline:
                    uids = uids[-FIRST_RUN_LIMIT:]
                for u in uids:
                    uid = u.decode() if isinstance(u, bytes) else str(u)
                    if baseline and int(uid) <= baseline:
                        continue
                    typ, mdata = M.uid("fetch", uid, "(RFC822)")
                    if not mdata or not mdata[0]:
                        continue
                    out.append(_parse_message(email.message_from_bytes(mdata[0][1]), folder, uid))
            except Exception as e:
                logger.warning("[mailbox] folder %s fetch error: %s", folder, e)
    finally:
        try:
            M.logout()
        except Exception:
            pass
    return out


async def mailbox_poller():
    await asyncio.sleep(25)
    if not (settings.MAILBOX_LOGIN and settings.MAILBOX_APP_PASSWORD):
        logger.info("[mailbox] no MAILBOX_LOGIN/APP_PASSWORD set — poller idle")
        return
    logger.info("[mailbox] started (IMAP fetch across all folders every %ds)", POLL_INTERVAL)
    while True:
        try:
            async with async_session() as db:
                rows = (await db.execute(
                    select(EmailMessage.imap_folder, func.max(cast(EmailMessage.uid, Integer)))
                    .where(EmailMessage.folder == "inbox").group_by(EmailMessage.imap_folder)
                )).all()
            baselines = {(f or "INBOX"): (int(mx) if mx else 0) for f, mx in rows}
            msgs = await asyncio.to_thread(_fetch_all_sync, baselines)
            if msgs:
                from app.models.email_attachment import EmailAttachment
                async with async_session() as db:
                    stored = 0
                    for m in msgs:
                        mid = m.get("message_id")
                        if mid:
                            dup = (await db.execute(select(EmailMessage.id).where(
                                EmailMessage.folder == "inbox", EmailMessage.message_id == mid))).scalar()
                        else:
                            dup = (await db.execute(select(EmailMessage.id).where(
                                EmailMessage.folder == "inbox",
                                EmailMessage.imap_folder == m["imap_folder"],
                                EmailMessage.uid == m["uid"]))).scalar()
                        if dup:
                            continue
                        atts = m.pop("attachments", [])
                        em = EmailMessage(folder="inbox", is_read=False, **m)
                        db.add(em)
                        await db.flush()
                        for at in atts:
                            db.add(EmailAttachment(email_id=em.id, **at))
                        stored += 1
                    await db.commit()
                if stored:
                    logger.info("[mailbox] stored %d new message(s)", stored)
        except Exception as e:
            logger.warning("[mailbox] poll error: %s", e)
        await asyncio.sleep(POLL_INTERVAL)
