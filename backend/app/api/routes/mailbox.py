"""Admin dashboard mailbox — list/read the IMAP-fetched inbox, and compose/reply via Brevo
(the VPS blocks outbound SMTP, so sends go over the Brevo API as bonitocheluget@sparkp2p.com)."""
import base64
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_admin_trader
from app.core.config import settings
from app.core.database import get_db
from app.models.trader import Trader
from app.models.email_message import EmailMessage
from app.models.email_attachment import EmailAttachment
from app.services.email import send_email_ex

logger = logging.getLogger(__name__)
router = APIRouter()


def _row(m: EmailMessage, full: bool = False) -> dict:
    d = {
        "id": m.id, "folder": m.folder, "from_addr": m.from_addr, "from_name": m.from_name,
        "to_addr": m.to_addr, "subject": m.subject or "(no subject)", "snippet": m.snippet,
        "is_read": m.is_read, "is_support": m.is_support,
        "received_at": (m.received_at or m.created_at).isoformat() if (m.received_at or m.created_at) else None,
    }
    if full:
        d["body_html"] = m.body_html or ""
        d["body_text"] = m.body_text or ""
    return d


def _norm_subject(s: str) -> str:
    """Strip repeated Re:/Fwd:/Fw: prefixes and lowercase, for grouping a conversation."""
    s = (s or "").strip()
    while re.match(r'^(re|fwd|fw)\s*:', s, re.I):
        s = s.split(":", 1)[1].strip()
    return s.lower()


def _html(body: str) -> str:
    esc = (body or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "<div style='font-family:sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap'>" + esc + "</div>"


@router.get("/admin/mailbox/messages")
async def list_messages(folder: str = Query("inbox"), support: int = Query(0),
                        limit: int = Query(50), offset: int = Query(0),
                        admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    q = select(EmailMessage).where(EmailMessage.folder == folder)
    if support:
        q = q.where(EmailMessage.is_support.is_(True))
    q = q.order_by(EmailMessage.received_at.desc().nullslast(), EmailMessage.id.desc())
    rows = (await db.execute(q.limit(min(limit, 100)).offset(offset))).scalars().all()
    return {"messages": [_row(m) for m in rows]}


@router.get("/admin/mailbox/counts")
async def counts(admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    unread = (await db.execute(select(func.count()).select_from(EmailMessage).where(
        EmailMessage.folder == "inbox", EmailMessage.is_read.is_(False)))).scalar() or 0
    support_unread = (await db.execute(select(func.count()).select_from(EmailMessage).where(
        EmailMessage.folder == "inbox", EmailMessage.is_support.is_(True),
        EmailMessage.is_read.is_(False)))).scalar() or 0
    return {"unread": unread, "support_unread": support_unread}


@router.post("/admin/mailbox/mark-all-read")
async def mark_all_read(admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    await db.execute(update(EmailMessage).where(
        EmailMessage.folder == "inbox", EmailMessage.is_read.is_(False)).values(is_read=True))
    await db.commit()
    return {"status": "ok"}


@router.get("/admin/mailbox/messages/{mid}")
async def get_message(mid: int, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    m = await db.get(EmailMessage, mid)
    if not m:
        raise HTTPException(404, "Message not found")
    if not m.is_read:
        m.is_read = True
        await db.commit()
    d = _row(m, full=True)
    atts = (await db.execute(select(EmailAttachment).where(EmailAttachment.email_id == m.id))).scalars().all()
    d["attachments"] = [{"id": a.id, "filename": a.filename, "size": a.size, "content_type": a.content_type} for a in atts]
    return d


@router.get("/admin/mailbox/attachments/{aid}")
async def download_attachment(aid: int, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    a = await db.get(EmailAttachment, aid)
    if not a:
        raise HTTPException(404, "Attachment not found")
    try:
        data = base64.b64decode(a.content_b64 or "")
    except Exception:
        raise HTTPException(500, "Corrupt attachment")
    fn = (a.filename or "attachment").replace('"', "").replace("\n", " ")
    return Response(content=data, media_type=a.content_type or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"'})


@router.get("/admin/mailbox/thread/{mid}")
async def get_thread(mid: int, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    """Return the whole conversation the message belongs to (received + sent), oldest first —
    grouped by normalized subject + the counterparty address, with attachments per message."""
    m = await db.get(EmailMessage, mid)
    if not m:
        raise HTTPException(404, "Message not found")
    if not m.is_read:
        m.is_read = True
        await db.commit()
    counterparty = (m.from_addr if m.folder == "inbox" else (m.to_addr or "").split(",")[0]).strip().lower()
    nsub = _norm_subject(m.subject)
    allmsgs = (await db.execute(select(EmailMessage).where(
        EmailMessage.folder.in_(("inbox", "sent"))))).scalars().all()
    thread = [x for x in allmsgs if _norm_subject(x.subject) == nsub and (
        (x.from_addr or "").lower() == counterparty or counterparty in (x.to_addr or "").lower())]
    thread.sort(key=lambda x: (x.received_at or x.created_at or datetime.now(timezone.utc)))

    atts_by = {}
    ids = [x.id for x in thread]
    if ids:
        for a in (await db.execute(select(EmailAttachment).where(EmailAttachment.email_id.in_(ids)))).scalars().all():
            atts_by.setdefault(a.email_id, []).append(
                {"id": a.id, "filename": a.filename, "size": a.size, "content_type": a.content_type})
    out = []
    for x in thread:
        r = _row(x, full=True)
        r["attachments"] = atts_by.get(x.id, [])
        out.append(r)
    reply_to_id = next((x.id for x in reversed(thread) if x.folder == "inbox"), m.id)
    return {"subject": m.subject, "counterparty": counterparty, "reply_to_id": reply_to_id, "messages": out}


class Attachment(BaseModel):
    name: str
    content: str   # base64-encoded file bytes (no data: prefix)


class SendRequest(BaseModel):
    to: str
    subject: str
    body: str
    attachments: list[Attachment] = []


class ReplyRequest(BaseModel):
    message_id: int
    body: str
    attachments: list[Attachment] = []


async def _store_sent(db, to_addr, subject, body, in_reply_to=None):
    db.add(EmailMessage(
        folder="sent", from_addr=settings.MAILBOX_FROM_EMAIL, from_name=settings.MAILBOX_FROM_NAME,
        to_addr=to_addr, subject=subject, snippet=" ".join((body or "").split())[:280],
        body_text=body, body_html=_html(body), in_reply_to=in_reply_to, is_read=True,
        received_at=datetime.now(timezone.utc)))
    await db.commit()


@router.post("/admin/mailbox/send")
async def send(body: SendRequest, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    if not settings.MAILBOX_FROM_EMAIL:
        raise HTTPException(400, "Mailbox sender not configured")
    ok = send_email_ex(body.to.strip(), body.subject or "(no subject)", _html(body.body),
                       sender_name=settings.MAILBOX_FROM_NAME, sender_email=settings.MAILBOX_FROM_EMAIL,
                       reply_to_email=settings.MAILBOX_FROM_EMAIL,
                       attachments=[a.dict() for a in body.attachments] or None)
    if not ok:
        raise HTTPException(502, "Send failed")
    await _store_sent(db, body.to.strip(), body.subject or "(no subject)", body.body)
    return {"status": "sent"}


@router.post("/admin/mailbox/reply")
async def reply(body: ReplyRequest, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    src = await db.get(EmailMessage, body.message_id)
    if not src or not src.from_addr:
        raise HTTPException(404, "Original message not found")
    subj = src.subject or ""
    if not subj.lower().startswith("re:"):
        subj = "Re: " + subj
    ok = send_email_ex(src.from_addr, subj, _html(body.body),
                       sender_name=settings.MAILBOX_FROM_NAME, sender_email=settings.MAILBOX_FROM_EMAIL,
                       reply_to_email=settings.MAILBOX_FROM_EMAIL,
                       attachments=[a.dict() for a in body.attachments] or None)
    if not ok:
        raise HTTPException(502, "Reply failed")
    await _store_sent(db, src.from_addr, subj, body.body, in_reply_to=src.message_id)
    return {"status": "sent"}
