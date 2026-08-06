"""Operations / support tickets — admin raises a case for a client to Choice Bank,
emails Choice Bank + notifies the client (email + SMS), and threads all replies.

Sending: FROM support@sparkp2p.com (sparkp2p.com is Brevo-verified). Replies route
back via Reply-To support+<ticket>@sparkp2p.com → Brevo inbound parse → the
/webhooks/support-reply endpoint, which appends them to the ticket thread.
"""
import logging
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
SUPPORT_EMAIL = "support@sparkp2p.com"
SUPPORT_NAME = "SparkP2P Support"


def _reply_to(ticket_number: str) -> str:
    # +tag carries the ticket number so inbound parsing can thread the reply.
    return f"support+{ticket_number}@sparkp2p.com"


def _now():
    return datetime.now(timezone.utc)


def _fill(text: str, ctx: dict) -> str:
    out = text or ""
    for k, v in ctx.items():
        out = out.replace("{" + k + "}", str(v if v is not None else ""))
    return out


async def _next_ticket_number(db) -> str:
    year = _now().year
    n = (await db.execute(select(func.count(OpsTicket.id)))).scalar() or 0
    return f"SPK-{year}-{n + 1:06d}"


async def _send_sms(phone: str, text: str):
    try:
        from app.services.sms import send_otp_sms
        await send_otp_sms(phone, text)
    except Exception as e:
        logger.warning("[ops] sms to %s failed: %s", phone, e)


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
    body_html = _fill(tmpl.body, ctx) if tmpl else (body.details or "")
    body_html = body_html.replace("\n", "<br>")
    choice_to = (body.choice_email or "").strip() or CHOICE_OPS_EMAIL

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
        }],
    )
    db.add(ticket)
    await db.commit()

    # 1) Email Choice Bank.
    send_email_ex(choice_to, f"[{ticket_number}] {subject}", body_html,
                  sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                  reply_to_email=_reply_to(ticket_number), reply_to_name=SUPPORT_NAME)

    # 2) Notify the client — ticket number by email + SMS.
    if body.notify_client and client:
        if client.email:
            send_email_ex(
                client.email, f"We've opened a support case for you — {ticket_number}",
                f"Hi {client.full_name or ''},<br><br>We've raised a support case with Choice Bank on your behalf.<br>"
                f"<b>Ticket:</b> {ticket_number}<br><b>Issue:</b> {subject}<br><br>"
                f"We'll update you here as soon as we hear back. Reply to this email to add anything.<br><br>SparkP2P Support",
                sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                reply_to_email=_reply_to(ticket_number), reply_to_name=SUPPORT_NAME)
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
            "messages": t.messages or [],
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        })
    open_count = sum(1 for t in rows if t.status not in (OpsTicketStatus.RESOLVED, OpsTicketStatus.CLOSED))
    return {"tickets": out, "open": open_count}


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
        like = f"%{q.strip()}%"
        conds.append(or_(Payment.mpesa_transaction_id.ilike(like),
                         Payment.mpesa_receipt_number.ilike(like),
                         Payment.destination.ilike(like),
                         Payment.sender_name.ilike(like)))
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


@router.post("/admin/ops/tickets/{ticket_id}/reply")
async def reply_ticket(ticket_id: int, body: ReplyBody, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):
    t = await db.get(OpsTicket, ticket_id)
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is empty")
    html = text.replace("\n", "<br>")
    to_addr = t.choice_email if body.to == "choice" else t.client_email
    if not to_addr:
        raise HTTPException(status_code=400, detail=f"No {body.to} email on file for this ticket")

    send_email_ex(to_addr, f"[{t.ticket_number}] Re: {t.subject or 'Support case'}", html,
                  sender_name=SUPPORT_NAME, sender_email=SUPPORT_EMAIL,
                  reply_to_email=_reply_to(t.ticket_number), reply_to_name=SUPPORT_NAME)

    msgs = list(t.messages or [])
    msgs.append({"from": "agent", "name": body.agent_name or admin.full_name or "Admin",
                 "body": html, "ts": _now().isoformat(), "channel": "email", "to": body.to})
    t.messages = msgs
    t.status = OpsTicketStatus.AWAITING_CHOICE if body.to == "choice" else OpsTicketStatus.AWAITING_CLIENT
    await db.commit()
    return {"ok": True}


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
    await db.commit()
    return {"ok": True, "status": t.status.value}


# ── Inbound reply capture (called by Brevo Inbound Parsing) ───────────────────

async def handle_inbound_reply(*, to_addr: str, from_addr: str, subject: str, body_text: str, db: AsyncSession) -> bool:
    """Thread an inbound email into its ticket. Returns True if matched.
    Matches by the +tag in the To address (support+SPK-...@) or [SPK-...] in subject."""
    import re
    ticket_number = None
    m = re.search(r"support\+([A-Za-z0-9\-]+)@", to_addr or "")
    if m:
        ticket_number = m.group(1)
    if not ticket_number:
        m = re.search(r"(SPK-\d{4}-\d{6})", subject or "")
        if m:
            ticket_number = m.group(1)
    if not ticket_number:
        return False
    t = (await db.execute(select(OpsTicket).where(OpsTicket.ticket_number == ticket_number))).scalar_one_or_none()
    if not t:
        return False
    # Is this from Choice Bank or the client?
    fa = (from_addr or "").lower()
    if "choice-bank.com" in fa or (t.choice_email and t.choice_email.lower() in fa):
        origin, name = "choice", "Choice Bank"
    else:
        origin, name = "client", (t.client_email or from_addr)
    msgs = list(t.messages or [])
    msgs.append({"from": origin, "name": name, "body": (body_text or "").strip(),
                 "ts": _now().isoformat(), "channel": "email"})
    t.messages = msgs
    t.status = OpsTicketStatus.OPEN
    await db.commit()
    logger.info("[ops] inbound reply threaded into %s from %s", ticket_number, origin)
    return True
