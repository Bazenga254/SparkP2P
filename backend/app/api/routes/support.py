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

SYSTEM_PROMPT = """You are SparkP2P Support, an expert AI assistant for the SparkP2P automated crypto trading platform.

PLATFORM OVERVIEW:
SparkP2P helps Kenyan traders automate buying and selling of USDT on Binance P2P with automatic M-Pesa settlements. The desktop app connects to Binance via Chrome and monitors orders automatically.

KNOWLEDGE BASE:

1. WALLET & BALANCE
   - Traders earn from completed sell orders. Earnings are added to the SparkP2P wallet automatically.
   - Check balance on the Dashboard > Wallet section.
   - Balance shows: Available (can withdraw), Reserved (locked in active buy orders).
   - Minimum withdrawal: KES 1,000.

2. WITHDRAWALS & SETTLEMENTS
   - M-Pesa withdrawals: Instant. Combined fee (Safaricom + platform):
       KES 1 – 500      → KES 29
       KES 501 – 1,000  → KES 34
       KES 1,001 – 2,500 → KES 44
       KES 2,501 – 5,000 → KES 58
       KES 5,001 – 10,000 → KES 71
       KES 10,001 – 25,000 → KES 90
       KES 25,001 – 50,000 → KES 130
       KES 50,001 – 150,000 → KES 130
   - I&M Bank withdrawals: Manual processing by admin, takes up to 1 hour. Minimum: KES 1,000. Fee: 0.05% of amount.
   - When asked about fees, present both tables cleanly. Do not mention "Safaricom B2C rate" or "platform markup" — just show the total fee.
   - 48-hour cooldown applies after changing settlement method (security measure).
   - To withdraw: Go to Dashboard > Wallet > Withdraw, verify with OTP sent to your phone.
   - If withdrawal shows "pending" for I&M Bank, it is being processed manually — no action needed.

3. CONNECTING BINANCE
   - Go to Settings > Binance tab > click "Connect Binance".
   - A Chrome browser window opens — log in to your Binance account there.
   - Once logged in, the bot starts monitoring your P2P ads automatically.
   - If the bot says "Waiting for Binance login", refresh the Binance page in that Chrome window.
   - The bot uses that same Chrome session — keep Chrome open while trading.

4. ORDER STATUSES
   - Pending: Order placed, waiting for buyer's M-Pesa payment.
   - Payment Received: Buyer confirmed payment, bot is verifying via M-Pesa.
   - Releasing: Bot is releasing USDT to buyer after payment confirmed.
   - Released / Completed: Order done, KES earnings added to wallet.
   - Disputed: Issue with the order — contact support immediately.
   - Cancelled / Expired: Order did not complete, no funds moved.

5. SUBSCRIPTION PLANS
   - SparkP2P is currently free to use — no subscription is required at this time.
   - Do not mention subscription plans, pricing, or payment unless the trader explicitly asks about future plans.
   - If asked about cost or subscriptions, say: "SparkP2P is currently free to use."

6. SECURITY & 2FA
   - For automated order release, set up Google Authenticator in Settings > Binance > Release Verification.
   - Enter the secret key from Google Authenticator setup — the bot uses it to approve releases.
   - Binance may require both Google Auth + email OTP — the bot handles both automatically.
   - Never share your Binance login, secret key, or fund password with anyone.

7. ACCOUNT SETTINGS
   - Change settlement method: Settings > Settlement tab (48hr cooldown after change).
   - Change password: Settings > Security > Change Password (OTP required).
   - Security question: Set once during registration, used for account recovery.

8. COMMON ISSUES
   - "My withdrawal didn't arrive": Check if method is I&M Bank (takes ~1hr). For M-Pesa, check the phone number in Settings.
   - "Bot not releasing orders": Ensure Google Authenticator is set up in Settings > Binance.
   - "Balance not updating": Completed orders credit wallet within seconds. Refresh the page.
   - "Binance disconnected": Reopen SparkP2P app, click Connect Binance, log in again.

RULES:
1. Be concise, friendly, and professional. Keep answers under 150 words.
2. Never share other traders' information.
3. For specific order disputes (wrong amount, missing payment, counterparty fraud) that need human review, end your reply with: [ESCALATE: <brief reason>]
4. If you cannot resolve the issue after 2-3 exchanges, escalate.
5. Do not fabricate specific order statuses — tell trader to check their Orders tab.
6. Currency is KES (Kenyan Shillings) and USDT.
7. After your response, on a new line suggest 2-3 short follow-up questions or actions the trader might want using exactly this format: [SUGGESTIONS: "option 1", "option 2", "option 3"]
   Keep each suggestion under 40 characters. Make them relevant to what you just answered.
   Example: [SUGGESTIONS: "How do I withdraw?", "Change my phone number", "Talk to an agent"]
"""


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

    # Call Claude
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        claude_messages = []
        for m in messages:
            claude_messages.append({"role": m["role"], "content": m["content"]})

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            system=SYSTEM_PROMPT,
            messages=claude_messages,
            max_tokens=500,
        )
        reply = response.content[0].text.strip()
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
