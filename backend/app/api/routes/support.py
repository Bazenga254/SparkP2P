import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db
from app.core.config import settings
from app.models import Trader
from app.models.support_ticket import SupportTicket, TicketStatus
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)
router = APIRouter()

SYSTEM_PROMPT = """You are SparkP2P Support, a helpful AI assistant for the SparkP2P peer-to-peer cryptocurrency trading platform.

SparkP2P helps Kenyan traders automate buying and selling of USDT on Binance P2P, with automatic M-Pesa settlements.

You can help traders with:
- How to connect their Binance account
- Understanding their wallet balance and withdrawals
- Explaining trade statuses (pending, payment received, released, completed, disputed)
- Settlement and M-Pesa payout questions
- Account settings, security questions, password changes
- Subscription plans (Starter KES 5,000/mo, Pro KES 10,000/mo)
- General platform navigation

Rules:
1. Be concise, friendly, and professional.
2. Never share other traders' information.
3. If a trader has a specific order dispute (missing payment, wrong amount, counterparty issue) that requires human review, tell them you are escalating to the support team and end your message with exactly: [ESCALATE: <brief reason>]
4. If you cannot resolve the issue after 2-3 exchanges, escalate.
5. Do not make up information about specific order statuses — tell the trader to check their Orders tab.
6. Currency is KES (Kenyan Shillings) and USDT.
"""


class ChatRequest(BaseModel):
    message: str
    ticket_id: Optional[int] = None


class EscalateRequest(BaseModel):
    ticket_id: int
    reason: Optional[str] = None


@router.post("/support/chat")
async def support_chat(
    data: ChatRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send a message to AI support. Creates or continues a ticket."""
    from openai import OpenAI

    # Load or create ticket
    ticket = None
    if data.ticket_id:
        result = await db.execute(
            select(SupportTicket).where(
                SupportTicket.id == data.ticket_id,
                SupportTicket.trader_id == trader.id,
            )
        )
        ticket = result.scalar_one_or_none()

    if not ticket:
        ticket = SupportTicket(
            trader_id=trader.id,
            subject=data.message[:100],
            messages=[],
            status=TicketStatus.OPEN,
        )
        db.add(ticket)
        await db.flush()

    # Don't allow chat on escalated/closed tickets
    if ticket.status in (TicketStatus.ESCALATED, TicketStatus.CLOSED):
        return {
            "ticket_id": ticket.id,
            "reply": "This conversation has been escalated to our support team. They will review your case shortly. You can start a new chat if you have a different question.",
            "escalated": True,
        }

    # Build message history
    messages = ticket.messages or []
    messages.append({
        "role": "user",
        "content": data.message,
        "ts": datetime.now(timezone.utc).isoformat(),
    })

    # Call OpenAI
    try:
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
        openai_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for m in messages:
            openai_messages.append({"role": m["role"], "content": m["content"]})

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=openai_messages,
            max_tokens=500,
            temperature=0.7,
        )
        reply = response.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"OpenAI error: {e}")
        reply = "I'm having trouble connecting right now. Please try again in a moment, or type 'human' to speak with our support team."

    # Check for escalation signal
    escalated = False
    escalation_reason = None
    if "[ESCALATE:" in reply:
        import re
        match = re.search(r'\[ESCALATE:\s*(.+?)\]', reply)
        escalation_reason = match.group(1).strip() if match else "Trader needs human support"
        reply = reply[:reply.index("[ESCALATE:")].strip()
        if not reply:
            reply = "I've escalated your case to our support team. They will review it shortly."
        ticket.status = TicketStatus.ESCALATED
        ticket.escalation_reason = escalation_reason
        escalated = True

    # Check if trader explicitly asks for human
    if any(kw in data.message.lower() for kw in ["human", "agent", "person", "staff", "escalate", "real person"]):
        ticket.status = TicketStatus.ESCALATED
        ticket.escalation_reason = "Trader requested human support"
        escalated = True
        reply = "Understood. I've escalated your conversation to our support team. They will review your case and get back to you. Your ticket ID is #" + str(ticket.id) + "."

    # Save assistant reply to history
    messages.append({
        "role": "assistant",
        "content": reply,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    ticket.messages = messages
    ticket.updated_at = datetime.now(timezone.utc)

    await db.commit()

    return {
        "ticket_id": ticket.id,
        "reply": reply,
        "escalated": escalated,
        "escalation_reason": escalation_reason,
    }


@router.get("/support/tickets")
async def get_my_tickets(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get trader's support ticket history."""
    result = await db.execute(
        select(SupportTicket)
        .where(SupportTicket.trader_id == trader.id)
        .order_by(SupportTicket.updated_at.desc())
        .limit(10)
    )
    tickets = result.scalars().all()
    return [
        {
            "id": t.id,
            "subject": t.subject,
            "status": t.status.value,
            "messages": t.messages or [],
            "escalation_reason": t.escalation_reason,
            "created_at": t.created_at.isoformat() if t.created_at else "",
            "updated_at": t.updated_at.isoformat() if t.updated_at else "",
        }
        for t in tickets
    ]


@router.get("/support/tickets/active")
async def get_active_ticket(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get the most recent open ticket for the chat widget to resume."""
    result = await db.execute(
        select(SupportTicket)
        .where(
            SupportTicket.trader_id == trader.id,
            SupportTicket.status == TicketStatus.OPEN,
        )
        .order_by(SupportTicket.updated_at.desc())
        .limit(1)
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        return None
    return {
        "id": ticket.id,
        "subject": ticket.subject,
        "status": ticket.status.value,
        "messages": ticket.messages or [],
    }
