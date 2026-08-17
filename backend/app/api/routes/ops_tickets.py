"""Operations / support tickets — admin raises a case for a client to Choice Bank,
emails Choice Bank + notifies the client (email + SMS), and threads all replies.

Sending: FROM support@sparkp2p.com (sparkp2p.com is Brevo-verified). Replies route
back via Reply-To support+<ticket>@sparkp2p.com → Brevo inbound parse → the
/webhooks/support-reply endpoint, which appends them to the ticket thread.
"""
import base64
import logging
import os
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.trader import Trader
from app.models.ops_ticket import OpsTicket, OpsTicketStatus, OpsEmailTemplate
from app.api.routes.traders import get_current_trader
from app.api.deps import get_admin_trader
from app.services.email import send_email_ex

logger = logging.getLogger(__name__)
router = APIRouter()

# Where cases go, and who they come from.
CHOICE_OPS_EMAIL = "Operations@choice-bank.com"
SUPPORT_EMAIL = "support@sparkp2p.com"          # sender (sparkp2p.com is Brevo-verified)
REPLY_DOMAIN = "otp.sparkp2p.com"               # receives replies (MX already → this VPS)
SUPPORT_NAME = "SparkP2P Support"
# Admin is CC'd on every support email for oversight.
ADMIN_CC = "bonitocheluget@gmail.com"


def _cc_list(client_email: str = None) -> list:
    """Everyone copied on a support email: the admin always, plus the client's
    Choice-Bank email (their account email). send_email_ex drops the primary To."""
    return [ADMIN_CC] + ([client_email] if client_email else [])


def _reply_to(ticket_number: str) -> str:
    # +tag carries the ticket number so the inbound SMTP server can thread the
    # reply. We use otp.sparkp2p.com because its MX already points at this VPS's
    # inbound SMTP server (no extra DNS needed). Change the domain here if a
    # prettier reply address (e.g. reply.sparkp2p.com) is pointed at the VPS.
    return f"support+{ticket_number}@{REPLY_DOMAIN}"


def _now():
    return datetime.now(timezone.utc)


def _fill(text: str, ctx: dict) -> str:
    out = text or ""
    for k, v in ctx.items():
        out = out.replace("{" + k + "}", str(v if v is not None else ""))
    return out


def _to_html(text: str) -> str:
    """Clean, editable template text -> professional HTML: **bold** -> <b>bold</b>,
    line breaks -> <br>. Lets agents edit plain text instead of raw HTML."""
    t = text or ""
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = t.replace("\n", "<br>")
    return t


async def _next_ticket_number(db) -> str:
    year = _now().year
    n = (await db.execute(select(func.count(OpsTicket.id)))).scalar() or 0
    return f"SPK-{year}-{n + 1:06d}"


async def _send_sms(phone: str, text: str):
    # send_sms is a blocking, synchronous Advanta call — run it off the event loop.
    try:
        from app.services.sms import send_sms
        from fastapi.concurrency import run_in_threadpool
        await run_in_threadpool(send_sms, phone, text)
    except Exception as e:
        logger.warning("[ops] sms to %s failed: %s", phone, e)


# ── Attachments ──────────────────────────────────────────────────────────────
# Saved under backend/uploads/support/<ticket>/ and served at /uploads/support/...
_UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "uploads", "support")
_MAX_ATTACH_BYTES = 12 * 1024 * 1024  # 12 MB per file (Brevo rejects very large ones)


def _safe_name(name: str) -> str:
    name = os.path.basename(name or "file")
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip() or "file"
    return name[:120]


def save_attachments(ticket_number: str, incoming: list):
    """incoming: [{name, content(base64, maybe data:-prefixed), type}].
    Returns (meta, for_email): meta = [{name,url,type,size}] to store in the thread;
    for_email = [{name, content(base64)}] to hand to Brevo."""
    meta, for_email = [], []
    if not incoming:
        return meta, for_email
    folder = os.path.join(_UPLOAD_DIR, _safe_name(ticket_number))
    os.makedirs(folder, exist_ok=True)
    for a in incoming:
        try:
            raw_b64 = (a.get("content") or "")
            if "," in raw_b64 and raw_b64.strip().lower().startswith("data:"):
                raw_b64 = raw_b64.split(",", 1)[1]
            data = base64.b64decode(raw_b64, validate=False)
            if not data or len(data) > _MAX_ATTACH_BYTES:
                logger.warning("[ops] attachment %s skipped (empty or too large)", a.get("name"))
                continue
            fname = _safe_name(a.get("name"))
            disk_name = f"{uuid.uuid4().hex[:8]}_{fname}"
            with open(os.path.join(folder, disk_name), "wb") as fh:
                fh.write(data)
            url = f"/uploads/support/{_safe_name(ticket_number)}/{disk_name}"
            meta.append({"name": fname, "url": url, "type": a.get("type") or "", "size": len(data)})
            for_email.append({"name": fname, "content": base64.b64encode(data).decode()})
        except Exception as e:
            logger.warning("[ops] attachment %s failed: %s", a.get("name"), e)
    return meta, for_email


# ── Templates ────────────────────────────────────────────────────────────────

class TemplateBody(BaseModel):
    key: str
    name: str
    subject: str
    body: str
    is_active: bool = True


@router.get("/admin/ops/templates")
async def list_templates(admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(OpsEmailTemplate).order_by(OpsEmailTemplate.name))).scalars().all()
    return {"templates": [{
        "id": t.id, "key": t.key, "name": t.name, "subject": t.subject,
        "body": t.body, "is_active": bool(t.is_active),
    } for t in rows]}


@router.post("/admin/ops/templates")
async def upsert_template(body: TemplateBody, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    key = (body.key or "").strip().lower().replace(" ", "_")
    if not key or not body.name or not body.subject or not body.body:
        raise HTTPException(status_code=400, detail="key, name, subject and body are required")
    row = (await db.execute(select(OpsEmailTemplate).where(OpsEmailTemplate.key == key))).scalar_one_or_none()
    if row is None:
        row = OpsEmailTemplate(key=key)
        db.add(row)
    row.name = body.name
    row.subject = body.subject
    row.body = body.body
    row.is_active = 1 if body.is_active else 0
    await db.commit()
    return {"ok": True, "key": key}


@router.delete("/admin/ops/templates/{template_id}")
async def delete_template(template_id: int, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    row = await db.get(OpsEmailTemplate, template_id)
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


# ── Tickets ──────────────────────────────────────────────────────────────────

class CreateTicketBody(BaseModel):
    trader_id: int | None = None
    category: str = "other"          # template key or free category
    subject: str = ""
    amount: str = ""
    reference: str = ""              # UTRANS / order reference
    mpesa_code: str = ""             # M-Pesa receipt code
    choice_account: str = ""         # client's Choice account number (defaults to their saved one)
    txn_datetime: str = ""           # date & time of the transaction
    details: str = ""
    choice_email: str = ""           # override recipient; defaults to CHOICE_OPS_EMAIL
    notify_client: bool = True
    body_override: str = ""          # admin-customised email body (clean text); wins over the template
    attachments: list = []           # [{name, content(base64), type}] to attach to the Choice email


@router.post("/admin/ops/tickets")
async def create_ticket(body: CreateTicketBody, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    client = await db.get(Trader, body.trader_id) if body.trader_id else None
    tmpl = (await db.execute(select(OpsEmailTemplate).where(OpsEmailTemplate.key == body.category))).scalar_one_or_none()

    ticket_number = await _next_ticket_number(db)
    ctx = {
        "ticket_number": ticket_number,
        "client_name": (client.full_name if client else "the client"),
        "amount": body.amount, "reference": body.reference, "details": body.details,
        "order_number": body.reference,
        "mpesa_code": body.mpesa_code or "—",
        "choice_account": body.choice_account or (getattr(client, "choice_account_number", None) if client else None) or "—",
        "txn_datetime": body.txn_datetime or "—",
        "client_phone": (client.phone if client else "—"),
        "support_phone": "0758930896",
    }
    subject = body.subject or (_fill(tmpl.subject, ctx) if tmpl else f"Support case — Ticket {ticket_number}")
    # The admin can fully customise the email in a preview before sending; that wins.
    if (body.body_override or "").strip():
        body_html = _to_html(_fill(body.body_override, ctx))
    else:
        body_html = _to_html(_fill(tmpl.body, ctx) if tmpl else (body.details or ""))
    choice_to = (body.choice_email or "").strip() or CHOICE_OPS_EMAIL

    att_meta, att_email = save_attachments(ticket_number, body.attachments)

    ticket = OpsTicket(
        ticket_number=ticket_number,
        trader_id=client.id if client else None,
        category=body.category, subject=subject,
        status=OpsTicketStatus.AWAITING_CHOICE,
        choice_email=choice_to,
        client_email=(client.email if client else None),
        client_phone=(client.phone if client else None),
        created_by=admin.id,
        messages=[{
            "from": "agent", "name": admin.full_name or "Admin",
            "body": body_html, "ts": _now().isoformat(), "channel": "email", "to": "choice",
            "attachments": att_meta,
        }],
    )
    db.add(ticket)
    await db.commit()

    # 1) Email Choice Bank — CC the admin + the client's Choice-Bank email.
    send_email_ex(choice_to, f"[{ticket_number}] {subject}", body_html,
                  sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                  reply_to_email=_reply_to(ticket_number), reply_to_name=SUPPORT_NAME,
                  attachments=att_email, cc=_cc_list(client.email if client else None))

    # 2) Notify the client — ticket number by email + SMS (admin CC'd).
    if body.notify_client and client:
        if client.email:
            send_email_ex(
                client.email, f"We've opened a support case for you — {ticket_number}",
                f"Hi {client.full_name or ''},<br><br>We've raised a support case with Choice Bank on your behalf.<br>"
                f"<b>Ticket:</b> {ticket_number}<br><b>Issue:</b> {subject}<br><br>"
                f"We'll update you here as soon as we hear back. Reply to this email to add anything.<br><br>SparkP2P Support",
                sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                reply_to_email=_reply_to(ticket_number), reply_to_name=SUPPORT_NAME,
                cc=_cc_list())
        if client.phone:
            await _send_sms(client.phone, f"SparkP2P: we've opened support ticket {ticket_number} for your issue. We'll update you shortly.")

    return {"ok": True, "ticket_number": ticket_number, "id": ticket.id}


@router.get("/admin/ops/tickets")
async def list_tickets(status: str = "", admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    q = select(OpsTicket).order_by(OpsTicket.updated_at.desc())
    rows = (await db.execute(q)).scalars().all()
    out = []
    for t in rows:
        if status and t.status.value != status:
            continue
        client = await db.get(Trader, t.trader_id) if t.trader_id else None
        out.append({
            "id": t.id, "ticket_number": t.ticket_number, "category": t.category,
            "subject": t.subject, "status": t.status.value,
            "client_name": client.full_name if client else None,
            "client_email": t.client_email, "client_phone": t.client_phone,
            "choice_email": t.choice_email,
            "needs_attention": bool(t.needs_attention),
            "messages": t.messages or [],
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        })
    open_count = sum(1 for t in rows if t.status not in (OpsTicketStatus.RESOLVED, OpsTicketStatus.CLOSED))
    attention = sum(1 for t in rows if t.needs_attention)
    return {"tickets": out, "open": open_count, "attention": attention}


@router.get("/admin/ops/client-transactions")
async def client_transactions(trader_id: int, q: str = "",
                              admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    """A client's Choice Bank transactions — for search-and-populate on a new ticket,
    so support doesn't retype (and mistype) the M-Pesa code / ref / amount / time."""
    from app.models.payment import Payment
    from sqlalchemy import or_
    client = await db.get(Trader, trader_id)
    conds = [Payment.trader_id == trader_id,
             Payment.transaction_type.in_(["CHOICE_DEPOSIT", "CHOICE_INBOUND", "CHOICE_OUTBOUND"])]
    if (q or "").strip():
        qs = q.strip()
        like = f"%{qs}%"
        ors = [Payment.mpesa_transaction_id.ilike(like),   # UTRANS / Choice txn ID
               Payment.mpesa_receipt_number.ilike(like),   # M-Pesa reference code
               Payment.destination.ilike(like),            # paybill / account / phone
               Payment.sender_name.ilike(like),            # counterparty name
               Payment.bill_ref_number.ilike(like),
               Payment.remarks.ilike(like)]
        # A numeric query also matches the amount (with or without commas/KES).
        _num = qs.replace(",", "").replace("KES", "").replace("kes", "").strip()
        try:
            _amt = float(_num)
            ors.append(Payment.amount == _amt)
            ors.append(Payment.amount == -_amt)
        except ValueError:
            pass
        conds.append(or_(*ors))
    rows = (await db.execute(
        select(Payment).where(*conds).order_by(Payment.created_at.desc()).limit(40)
    )).scalars().all()
    out = []
    for p in rows:
        out.append({
            "reference": p.mpesa_transaction_id or "",
            "mpesa_code": p.mpesa_receipt_number or "",
            "amount": abs(p.amount) if p.amount is not None else 0,
            "direction": p.direction.value if p.direction else "",
            "type": p.transaction_type,
            "destination": p.destination or p.phone or "",
            "counterparty": p.sender_name or "",
            "status": p.status.value if hasattr(p.status, "value") else str(p.status),
            "txn_datetime": p.created_at.strftime("%d %b %Y, %I:%M %p") if p.created_at else "",
        })
    return {"transactions": out,
            "choice_account": getattr(client, "choice_account_number", None) if client else None}


class ReplyBody(BaseModel):
    body: str
    to: str = "choice"       # 'choice' | 'client'
    agent_name: str = ""
    attachments: list = []   # [{name, content(base64), type}]


@router.post("/admin/ops/tickets/{ticket_id}/reply")
async def reply_ticket(ticket_id: int, body: ReplyBody, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    t = await db.get(OpsTicket, ticket_id)
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    text = (body.body or "").strip()
    att_meta, att_email = save_attachments(t.ticket_number, body.attachments)
    if not text and not att_meta:
        raise HTTPException(status_code=400, detail="Message is empty")
    html = _to_html(text) or "(see attached)"
    to_addr = t.choice_email if body.to == "choice" else t.client_email
    if not to_addr:
        raise HTTPException(status_code=400, detail=f"No {body.to} email on file for this ticket")

    # CC the admin always; when replying to Choice, also CC the client's email.
    cc = _cc_list(t.client_email if body.to == "choice" else None)
    send_email_ex(to_addr, f"[{t.ticket_number}] Re: {t.subject or 'Support case'}", html,
                  sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                  reply_to_email=_reply_to(t.ticket_number), reply_to_name=SUPPORT_NAME,
                  attachments=att_email, cc=cc)

    msgs = list(t.messages or [])
    msgs.append({"from": "agent", "name": body.agent_name or admin.full_name or "Admin",
                 "body": html, "ts": _now().isoformat(), "channel": "email", "to": body.to,
                 "attachments": att_meta})
    t.messages = msgs
    t.status = OpsTicketStatus.AWAITING_CHOICE if body.to == "choice" else OpsTicketStatus.AWAITING_CLIENT
    t.needs_attention = False    # replying counts as reading it
    await db.commit()
    return {"ok": True}


@router.post("/admin/ops/tickets/{ticket_id}/read")
async def mark_read(ticket_id: int, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    """Clear the 'new reply' flag once the admin opens the ticket."""
    t = await db.get(OpsTicket, ticket_id)
    if t and t.needs_attention:
        t.needs_attention = False
        await db.commit()
    return {"ok": True}


@router.get("/admin/ops/attention-count")
async def attention_count(admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    """How many ops cases have an unread reply — for the Dashboard attention tile."""
    n = (await db.execute(select(func.count(OpsTicket.id)).where(OpsTicket.needs_attention.is_(True)))).scalar() or 0
    return {"count": n}


class StatusBody(BaseModel):
    status: str


@router.post("/admin/ops/tickets/{ticket_id}/status")
async def set_status(ticket_id: int, body: StatusBody, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    t = await db.get(OpsTicket, ticket_id)
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    try:
        t.status = OpsTicketStatus(body.status)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid status")
    t.needs_attention = False
    await db.commit()
    return {"ok": True, "status": t.status.value}


# ── Inbound reply capture (called by Brevo Inbound Parsing) ───────────────────

async def handle_inbound_reply(*, to_addr: str, from_addr: str, subject: str, body_text: str,
                               db: AsyncSession, attachments: list = None) -> bool:
    """Thread an inbound email into its ticket. Returns True if matched.
    Matches by the +tag in the To address (support+SPK-...@) or [SPK-...] in subject."""
    import re
    ticket_number = None
    m = re.search(r"support\+([A-Za-z0-9\-]+)@", to_addr or "")
    if m:
        ticket_number = m.group(1)
    if not ticket_number:
        m = re.search(r"(SPK-\d{4}-\d{6})", subject or "", re.IGNORECASE)
        if m:
            ticket_number = m.group(1)
    if not ticket_number:
        return False
    # Ticket numbers are stored UPPERCASE (SPK-YYYY-NNNNNN), but the +tag in the recipient
    # address is routinely lowercased in transit (e.g. 'support+spk-2026-000001@...'), which
    # made this exact match fail and SILENTLY DROP the reply. Normalize to uppercase.
    ticket_number = ticket_number.upper()
    t = (await db.execute(select(OpsTicket).where(OpsTicket.ticket_number == ticket_number))).scalar_one_or_none()
    if not t:
        # The +tag resolved to no ticket — fall back to the [SPK-...] number in the subject.
        sm = re.search(r"(SPK-\d{4}-\d{6})", subject or "", re.IGNORECASE)
        if sm:
            ticket_number = sm.group(1).upper()
            t = (await db.execute(select(OpsTicket).where(OpsTicket.ticket_number == ticket_number))).scalar_one_or_none()
    if not t:
        logger.info("[ops] inbound reply: no matching ticket for to=%s subject=%r", to_addr, subject)
        return False
    # Is this from Choice Bank or the client?
    fa = (from_addr or "").lower()
    if "choice-bank.com" in fa or (t.choice_email and t.choice_email.lower() in fa):
        origin, name = "choice", "Choice Bank"
    else:
        origin, name = "client", (t.client_email or from_addr)
    att_meta, _ = save_attachments(t.ticket_number, attachments or [])
    msgs = list(t.messages or [])
    msgs.append({"from": origin, "name": name, "body": (body_text or "").strip(),
                 "ts": _now().isoformat(), "channel": "email", "attachments": att_meta})
    t.messages = msgs
    t.status = OpsTicketStatus.OPEN
    t.needs_attention = True     # unread until the admin opens it
    await db.commit()
    logger.info("[ops] inbound reply threaded into %s from %s", ticket_number, origin)
    await _notify_new_reply(t, origin, body_text, len(att_meta), db)
    return True


async def _notify_new_reply(ticket, origin: str, body_text: str, n_att: int, db: AsyncSession):
    """Alert the admin who raised the case that a reply arrived — Telegram + SMS
    fallback — so they don't have to watch their inbox."""
    who = "Choice Bank" if origin == "choice" else "the client"
    preview = re.sub(r"\s+", " ", (body_text or "")).strip()[:180]
    att = f" (+{n_att} attachment{'s' if n_att != 1 else ''})" if n_att else ""
    msg = (f"📩 <b>New reply on {ticket.ticket_number}</b>\n"
           f"From: <b>{who}</b>\n"
           f"{ticket.subject or ''}\n\n"
           f"{preview}{att}\n\n"
           f"Open Support → Support Tickets to respond.")
    try:
        admin = await db.get(Trader, ticket.created_by) if ticket.created_by else None
        if admin:
            from app.api.routes.telegram import notify_trader
            sent = await notify_trader(admin, msg)
            if not sent and getattr(admin, "phone", None):
                await _send_sms(admin.phone, f"SparkP2P: new reply from {who} on ticket {ticket.ticket_number}. Open Support to respond.")
    except Exception as e:
        logger.warning("[ops] new-reply notify failed for %s: %s", ticket.ticket_number, e)
