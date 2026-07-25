import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
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

SYSTEM_PROMPT = """You are SparkP2P Support, an expert AI assistant for the SparkP2P automated crypto trading platform for Kenya.

PLATFORM OVERVIEW:
SparkP2P automates buying and selling of USDT on Binance P2P for Kenyan merchants. The desktop app watches a merchant's Binance P2P ads and handles orders end to end — sending payment instructions, verifying payment, and releasing crypto automatically.

HOW MONEY MOVES (this is the core of the platform — know it well):

1. SELL orders (the merchant sells USDT; the BUYER pays the merchant):
   - The buyer pays via M-Pesa Paybill 444174, using the merchant's Choice Bank account number as the account number. They can also pay by PesaLink to that same Choice Bank account.
   - The money lands in the merchant's CHOICE BANK account. SparkP2P matches the payment to the order and releases the crypto automatically.
   - So YES — SparkP2P absolutely uses Choice Bank. It is the account that receives sell-order payments. (Do NOT say we don't support Choice Bank — we do.)

2. BUY orders (the merchant buys USDT; the merchant PAYS the seller):
   - Paid either from the merchant's Choice Bank balance, or through the I&M Bot — a separate downloadable app that pays sellers from the merchant's own I&M Bank account (via M-Pesa or PesaLink). I&M payouts use prepaid "I&M Automation credits".

3. WITHDRAWALS (merchant moving their own money out of Choice Bank):
   - To M-Pesa: instant. To a bank account: via PesaLink.
   - Auto-withdraw: a merchant can set a threshold in Settings so that when their Choice Bank balance reaches it, the whole balance sweeps to their bank automatically over PesaLink.
   - Confirmed with an OTP. A 48-hour cooldown applies after changing the withdrawal bank account (security).

CHOICE BANK FEATURES:
- Balance and transactions show on the Dashboard > Transactions page.
- Statements: a merchant can generate an official Choice Bank account statement (up to 180 days) from the Transactions page (the "Statement" button). The PDF is password-protected — the password is the last 6 digits of their phone number.
- IMPORTANT DELAY BEHAVIOUR: Choice Bank sometimes credits the balance before the transaction appears on the Transactions page (a short lag). So a payment can be real and received even if the page hasn't listed it yet. If a merchant asks whether a specific payment arrived, USE THE check_transaction TOOL to look it up live against the bank — do not tell them it's missing based on the page alone.

OTHER FEATURES:
- Price Tracker: shows live competitor Binance P2P prices and helps track profit.
- Subscriptions: SparkP2P has paid plans (Bronze, Silver, Gold tiers). For current pricing, direct the merchant to the Subscriptions page — do not quote a specific price, as it can change.

ORDER STATUSES:
- Pending: waiting for the buyer's payment.
- Payment Received / Releasing: payment seen, crypto being released.
- Released / Completed: done.
- Cancelled / Expired: did not complete, no crypto released.
- Disputed: needs human review — escalate.

SECURITY & 2FA:
- For automatic release, the merchant sets up Google Authenticator (TOTP) in Settings; the bot generates the code itself and handles Binance's identity prompts.
- Never ask for or share a Binance login, TOTP secret, fund password, or OTP.

CHECKING A TRANSACTION (use the tool):
- When a merchant asks whether a payment arrived, call the check_transaction tool.
- The AMOUNT is the most reliable thing to look up by — the bank's records do NOT contain the buyer's M-Pesa code, so a lookup by M-Pesa code often won't resolve. So: if they give an amount, look up by amount. If they only give an M-Pesa code and it isn't found, ASK them for the exact KES amount and look up by that.
- If found: confirm it was received — amount, time, and the sender's name. Ask them to confirm the sender name matches who they expected.
- If NOT found after checking by amount: say it hasn't reflected on the bank yet, suggest waiting a few minutes, and offer to escalate to a human agent. Do not claim money is lost.

RULES:
1. Be concise, friendly, professional. Under ~150 words.
2. Never reveal other merchants' information.
3. For disputes, missing money that the tool can't find, or anything needing human review, end with: [ESCALATE: <brief reason>]
4. Escalate if unresolved after 2-3 exchanges.
5. Don't fabricate order statuses — point them to the Orders tab (but DO use the check_transaction tool for payments — that's real data).
6. Currency is KES and USDT.
7. After your reply, on a new line: [SUGGESTIONS: "option 1", "option 2", "option 3"] — each under 40 chars, relevant to what you answered. Example: [SUGGESTIONS: "Check another payment", "How do withdrawals work?", "Talk to an agent"]
"""

# Tool the support bot can call to look up a real transaction on the merchant's
# Choice Bank account (live query — finds payments the Transactions page is still
# lagging on). Only wired into the authenticated per-merchant chat.
SUPPORT_TOOLS = [{
    "name": "check_transaction",
    "description": (
        "Look up whether a payment actually arrived on the merchant's Choice Bank account, "
        "querying the bank live. Use when the merchant gives an M-Pesa confirmation code, a "
        "bank reference, or asks whether a payment of a specific amount reflected."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "ref": {"type": "string", "description": "M-Pesa code / bank reference / transaction id the merchant gave, if any."},
            "amount": {"type": "number", "description": "The KES amount to look for, if the merchant gave one instead of a code."},
        },
    },
}]


class ChatRequest(BaseModel):
    message: str
    ticket_id: Optional[int] = None
    attachment_url: Optional[str] = None
    attachment_name: Optional[str] = None


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

    # Determine ticket state robustly (handles enum name, value, and str repr)
    _status = str(ticket.status).lower()
    is_closed = any(s in _status for s in ("closed", "ai_resolved"))
    is_escalated = "escalated" in _status

    if is_closed:
        return {
            "ticket_id": ticket.id,
            "reply": "This conversation has been closed. Please start a new chat if you have a new question.",
            "escalated": False,
        }

    # If escalated: store trader message and notify admin — no AI reply
    if is_escalated:
        messages = list(ticket.messages or [])
        user_msg = {"role": "user", "content": data.message, "ts": datetime.now(timezone.utc).isoformat()}
        if data.attachment_url:
            user_msg["attachment_url"] = data.attachment_url
            user_msg["attachment_name"] = data.attachment_name or "file"
        messages.append(user_msg)
        ticket.messages = messages
        ticket.updated_at = datetime.now(timezone.utc)
        await db.commit()
        # Notify admin via a placeholder — admins see it in Disputes tab on refresh
        return {
            "ticket_id": ticket.id,
            "reply": "Your message has been sent to the support team. They will reply shortly.",
            "escalated": True,
            "suggestions": [],
        }

    # Build message history
    messages = ticket.messages or []
    user_msg = {"role": "user", "content": data.message, "ts": datetime.now(timezone.utc).isoformat()}
    if data.attachment_url:
        user_msg["attachment_url"] = data.attachment_url
        user_msg["attachment_name"] = data.attachment_name or "file"
    messages.append(user_msg)

    # Call Claude — with the check_transaction tool so it can verify a payment
    # against the bank live when the merchant gives a code/reference/amount.
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        claude_messages = []
        for m in messages:
            claude_messages.append({"role": m["role"], "content": m["content"]})

        async def _run_tool(name, tool_input):
            if name != "check_transaction":
                return "Unknown tool."
            from app.services.choice_bank.lookup import find_transaction
            try:
                res = await find_transaction(
                    db, trader,
                    query=str(tool_input.get("ref") or "").strip(),
                    amount=tool_input.get("amount"),
                )
            except Exception as _e:
                logger.warning(f"[support] check_transaction failed: {_e}")
                return "The bank lookup could not run right now."
            if res.get("found"):
                return (f"FOUND: KES {res.get('amount')} — status {res.get('status')} — "
                        f"from {res.get('counterparty') or 'unknown'} — at {res.get('time') or 'unknown time'} "
                        f"(ref {res.get('reference') or res.get('tx_id') or '—'}, via {res.get('source')}).")
            reason = res.get("reason")
            if reason == "no_choice_account":
                return "This merchant has no Choice Bank account linked, so there is nothing to check."
            if reason == "bank_query_failed":
                return "The bank could not be reached right now — ask them to try again shortly."
            return "NOT FOUND on the Choice Bank account yet (checked live). It may still be settling."

        reply = ""
        for _hop in range(4):  # bounded tool loop
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                system=SYSTEM_PROMPT,
                messages=claude_messages,
                tools=SUPPORT_TOOLS,
                max_tokens=600,
            )
            if response.stop_reason == "tool_use":
                claude_messages.append({"role": "assistant", "content": response.content})
                tool_results = []
                for block in response.content:
                    if getattr(block, "type", None) == "tool_use":
                        out = await _run_tool(block.name, block.input or {})
                        tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": out})
                claude_messages.append({"role": "user", "content": tool_results})
                continue
            reply = "".join(b.text for b in response.content if getattr(b, "type", None) == "text").strip()
            break
        if not reply:
            reply = "I've looked into that. If you still need help, type 'human' to reach our team."
    except Exception as e:
        logger.error(f"Claude error: {e}")
        reply = "I'm having trouble connecting right now. Please try again in a moment, or type 'human' to speak with our support team."

    # Parse follow-up suggestions from AI response
    import re
    suggestions = []
    suggestions_match = re.search(r'\[SUGGESTIONS:\s*(.+?)\]', reply, re.IGNORECASE)
    if suggestions_match:
        raw = suggestions_match.group(1)
        # Extract quoted strings: "option 1", "option 2"
        suggestions = re.findall(r'"([^"]+)"', raw)
        reply = reply[:reply.index("[SUGGESTIONS:")].strip()

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
        "suggestions": suggestions[:3],  # max 3 follow-up chips
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
    """Get the most recent open or escalated ticket for the chat widget to resume."""
    from sqlalchemy import or_, cast, String
    result = await db.execute(
        select(SupportTicket)
        .where(
            SupportTicket.trader_id == trader.id,
            or_(
                cast(SupportTicket.status, String).ilike("OPEN"),
                cast(SupportTicket.status, String).ilike("ESCALATED"),
            ),
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


_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf",
                  "text/plain", "application/msword",
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
_MAX_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/support/upload")
async def upload_support_attachment(
    file: UploadFile = File(...),
    trader: Trader = Depends(get_current_trader),
):
    """Upload a file attachment for a support message. Returns the URL."""
    if file.content_type not in _ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="File type not allowed. Allowed: images, PDF, DOC, TXT.")
    data = await file.read()
    if len(data) > _MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 10 MB.")

    ext = os.path.splitext(file.filename or "file")[1].lower() or ".bin"
    filename = f"{uuid.uuid4().hex}{ext}"
    save_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "uploads", "support")
    os.makedirs(save_dir, exist_ok=True)
    with open(os.path.join(save_dir, filename), "wb") as f:
        f.write(data)

    return {"url": f"/uploads/support/{filename}", "name": file.filename, "type": file.content_type}


PUBLIC_CHAT_PROMPT = """You are SparkP2P's friendly pre-sales assistant on the website. Help visitors understand what SparkP2P is and decide if it's right for them.

ABOUT SPARKP2P:
SparkP2P is an AI-powered desktop app that automates Binance P2P trading for Kenyan traders.
- Monitors incoming orders on Binance automatically
- Verifies M-Pesa payments in real time via business paybill
- Auto-releases crypto once payment is confirmed
- Tracks trades and profits 24/7 — even while you sleep
- No API keys needed — connects via your existing Chrome browser session
- Supports USDT, BTC, ETH, BNB, USDC, BUSD
- Works on Windows 10/11 (Mac and Linux coming soon)
- Pricing: Currently FREE — no subscription fees

GETTING STARTED:
1. Download from sparkp2p.com/download
2. Create a free account at sparkp2p.com/register
3. Connect Binance by scanning a QR code inside the app
4. Enter your M-Pesa paybill number
5. Done — bot starts working immediately

SUPPORTED COUNTRIES:
Currently only Kenya is supported. M-Pesa (Safaricom) is the payment verification method, which is Kenya-specific.
We are actively working on expanding to other countries — Uganda, Tanzania, Nigeria, and Ghana are on the roadmap. Interested users from other countries can join the waitlist by emailing support@sparkp2p.com.

CONTACT:
- Email: support@sparkp2p.com
- Phone/WhatsApp: +254797750249
- Contact form: sparkp2p.com/contact

RULES:
1. Be friendly, concise. Keep answers under 120 words.
2. To sign up: direct to sparkp2p.com/register
3. For existing account issues: direct to in-app chat or support@sparkp2p.com
4. Never invent features. If unsure, say "Email us at support@sparkp2p.com for details."
5. After your reply suggest 2-3 short follow-up questions using exactly: [SUGGESTIONS: "opt 1", "opt 2", "opt 3"]
"""


class PublicChatMessage(BaseModel):
    role: str
    content: str


class PublicChatRequest(BaseModel):
    message: str
    history: list[PublicChatMessage] = []


@router.post("/public-chat")
async def public_chat(data: PublicChatRequest):
    """Pre-sales AI chat — no authentication required."""
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

        messages = [{"role": m.role, "content": m.content} for m in data.history]
        messages.append({"role": "user", "content": data.message})

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            system=PUBLIC_CHAT_PROMPT,
            messages=messages,
            max_tokens=400,
        )
        reply = response.content[0].text.strip()
    except Exception as e:
        logger.error(f"Public chat error: {e}")
        reply = "I'm having trouble connecting right now. Please email us at support@sparkp2p.com and we'll get back to you shortly."

    import re
    suggestions = []
    match = re.search(r'\[SUGGESTIONS:\s*(.+?)\]', reply, re.IGNORECASE)
    if match:
        suggestions = re.findall(r'"([^"]+)"', match.group(1))
        reply = reply[:reply.index("[SUGGESTIONS:")].strip()

    return {"reply": reply, "suggestions": suggestions[:3]}


class ContactRequest(BaseModel):
    name: str
    email: str
    subject: str
    message: str


@router.post("/contact")
async def submit_contact(data: ContactRequest):
    """Public contact form — no auth required. Forwards to support@sparkp2p.com via Brevo."""
    from app.services.email import send_email
    import html as html_lib

    safe_name    = html_lib.escape(data.name)
    safe_email   = html_lib.escape(data.email)
    safe_subject = html_lib.escape(data.subject)
    safe_message = html_lib.escape(data.message).replace("\n", "<br>")

    html_body = f"""
    <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
      <h1 style="color:#f59e0b;font-size:24px;margin:0 0 4px;">SparkP2P</h1>
      <p style="color:#888;font-size:13px;margin:0 0 28px;">New Contact Form Submission</p>
      <div style="background:#1a1d27;border-radius:12px;padding:28px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="color:#9ca3af;padding:6px 0;width:90px;">Name</td>
              <td style="color:#fff;font-weight:600;">{safe_name}</td></tr>
          <tr><td style="color:#9ca3af;padding:6px 0;">Email</td>
              <td style="color:#f59e0b;">{safe_email}</td></tr>
          <tr><td style="color:#9ca3af;padding:6px 0;">Subject</td>
              <td style="color:#fff;">{safe_subject}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #2d3147;margin:18px 0;" />
        <p style="color:#9ca3af;font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:1px;">Message</p>
        <p style="color:#e5e7eb;font-size:14px;line-height:1.7;margin:0;">{safe_message}</p>
      </div>
      <p style="color:#6b7280;font-size:12px;margin-top:20px;">
        Reply directly to <a href="mailto:{safe_email}" style="color:#f59e0b;">{safe_email}</a>
      </p>
    </div>
    """

    ok = send_email(
        to_email="support@sparkp2p.com",
        subject=f"[Contact] {data.subject} — from {data.name}",
        html_content=html_body,
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to send message. Please email support@sparkp2p.com directly.")
    return {"status": "sent"}


@router.get("/system-status")
async def system_status(trader: Trader = Depends(get_current_trader)):
    """Returns current health status of critical payment systems (I&M Bank, M-PESA Org)."""
    from app.services import system_health
    return system_health.get_status()
