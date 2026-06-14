import os
import random
import string
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.models.trader import Trader

router = APIRouter()

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

# In-memory stores (reset on restart — acceptable for short-lived approval sessions)
_link_codes: dict = {}       # code -> {trader_id, expires_at}
_pending_approvals: dict = {}  # order_number -> {chat_id, message_id, status, trader_id, created_at}


def _tg_api_url():
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not tok:
        try:
            from app.core.config import settings
            tok = settings.TELEGRAM_BOT_TOKEN or ""
        except Exception:
            tok = ""
    return f"https://api.telegram.org/bot{tok}"


async def _tg_send(method: str, payload: dict):
    url = f"{_tg_api_url()}/{method}"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            r = await client.post(url, json=payload)
            return r.json()
        except Exception as e:
            print(f"[Telegram] {method} error: {e}")
            return None


def _generate_code() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


async def send_trader_message(trader, message: str, reply_markup=None, reply_to=None):
    """Send a Telegram message to a trader and return the raw API result (or None).
    Supports inline-keyboard buttons (reply_markup) and threaded replies (reply_to).
    Charges the Telegram-notify credit once on success."""
    chat_id = getattr(trader, "telegram_chat_id", None)
    if not chat_id:
        return None
    # Daily Telegram-alert cap by subscription tier (Starter 100 / Starter Pro 200 / Pro Max
    # unlimited). Once over cap, skip silently until the 03:00 EAT reset.
    tid = getattr(trader, "id", None)
    if tid is not None:
        try:
            from app.services.rate_limits import consume_tg_alert
            if not await consume_tg_alert(tid):
                return None
        except Exception:
            pass
    payload = {"chat_id": chat_id, "text": message}
    if "<b>" in message or "</b>" in message:
        payload["parse_mode"] = "HTML"
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    if reply_to is not None:
        payload["reply_to_message_id"] = reply_to
        payload["allow_sending_without_reply"] = True
    result = await _tg_send("sendMessage", payload)
    ok = bool(result and result.get("ok"))
    return result if ok else None


async def edit_trader_message(chat_id, message_id, text: str, reply_markup=None) -> bool:
    """Edit a previously-sent Telegram message in place (keeps the same message + buttons).
    Used to fill a sell-order alert with the full buyer history once the background scan
    completes, so the merchant sees ONE complete report instead of a stub follow-up."""
    if not chat_id or not message_id:
        return False
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text}
    if "<b>" in text or "</b>" in text:
        payload["parse_mode"] = "HTML"
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    result = await _tg_send("editMessageText", payload)
    return bool(result and result.get("ok"))


async def notify_trader(trader, message: str, reply_markup=None, reply_to=None) -> bool:
    """Send a Telegram notification to a trader if they have a chat_id linked.
    Returns True if sent successfully, False otherwise.
    Callers should fall back to SMS for security-critical notifications when False."""
    # Mirror to the phone's notification bar (independent of Telegram being linked).
    try:
        from app.services import push_queue
        push_queue.add(getattr(trader, "id", None), message)
    except Exception:
        pass
    result = await send_trader_message(trader, message, reply_markup=reply_markup, reply_to=reply_to)
    return result is not None


# ── Public webhook — Telegram pushes all updates here ───────────────────────

@router.post("/webhook")
async def telegram_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.json()

    # ── Text messages (/start, /link CODE) ──
    msg = body.get("message") or {}
    if msg:
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = (msg.get("text") or "").strip()

        if text == "/start":
            await _tg_send("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    "👋 Welcome to SparkP2P Bot!\n\n"
                    "To connect your account:\n"
                    "1. Open SparkP2P desktop app\n"
                    "2. Go to Settings → Connect Telegram\n"
                    "3. Copy the 6-character code shown\n"
                    "4. Send: /link YOUR_CODE\n\n"
                    "Example: /link ABC123"
                ),
            })
            return {"ok": True}

        if text.upper().startswith("/LINK") or text.startswith("/link"):
            parts = text.split()
            code = parts[1].upper() if len(parts) > 1 else ""
            entry = _link_codes.get(code)

            if not entry or time.time() > entry["expires_at"]:
                await _tg_send("sendMessage", {
                    "chat_id": chat_id,
                    "text": "❌ Invalid or expired code.\n\nGenerate a new one from the SparkP2P app under Settings → Connect Telegram.",
                })
                return {"ok": True}

            # Save chat_id to trader account
            await db.execute(
                update(Trader)
                .where(Trader.id == entry["trader_id"])
                .values(telegram_chat_id=chat_id)
            )
            await db.commit()
            _link_codes.pop(code, None)

            await _tg_send("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    "✅ Telegram connected to SparkP2P!\n\n"
                    "You will receive sell order approval requests here.\n"
                    "Tap YES to send payment details or NO to reject."
                ),
            })
            return {"ok": True}

    # ── Callback queries (YES / NO buttons) ──
    cb = body.get("callback_query") or {}
    if cb:
        cb_id = cb.get("id")
        data = cb.get("data", "")
        parts = data.split(":", 1)

        # ── Squad invite accept / decline ──
        if len(parts) == 2 and parts[0] in ("squadaccept", "squaddecline"):
            chat_id = str(cb.get("message", {}).get("chat", {}).get("id", ""))
            msg_id = cb.get("message", {}).get("message_id")
            await _handle_squad_invite(db, chat_id, msg_id, cb_id, parts[0], parts[1])
            return {"ok": True}

        if len(parts) == 2:
            action, order_number = parts
            ap = _pending_approvals.get(order_number)

            if ap:
                if action == "approve":
                    ap["status"] = "approved"
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "✅ Approved — payment details will be sent to buyer",
                    })
                    if ap.get("message_id"):
                        await _tg_send("editMessageText", {
                            "chat_id": ap["chat_id"],
                            "message_id": ap["message_id"],
                            "text": f"✅ APPROVED\n\nOrder {order_number}\nPayment details sent to buyer.",
                        })
                elif action == "reject":
                    ap["status"] = "rejected"
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "❌ Rejected — excuse message will be sent to buyer",
                    })
                    if ap.get("message_id"):
                        await _tg_send("editMessageText", {
                            "chat_id": ap["chat_id"],
                            "message_id": ap["message_id"],
                            "text": f"❌ REJECTED\n\nOrder {order_number}\nExcuse message sent. Order will cancel in 15 min.",
                        })
            else:
                await _tg_send("answerCallbackQuery", {
                    "callback_query_id": cb_id,
                    "text": "Order not found or already processed.",
                })

    return {"ok": True}


async def _handle_squad_invite(db, chat_id, msg_id, cb_id, action, sid):
    """Process a Squad invite Accept/Decline tapped in Telegram."""
    from sqlalchemy import select
    from app.models import Trader, Squad, SquadMember
    try:
        squad_id = int(sid)
    except (TypeError, ValueError):
        return
    trader = (await db.execute(select(Trader).where(Trader.telegram_chat_id == chat_id))).scalar_one_or_none()
    if not trader:
        await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Link your SparkP2P account first."})
        return
    inv = (await db.execute(select(SquadMember).where(
        SquadMember.squad_id == squad_id, SquadMember.trader_id == trader.id, SquadMember.status == "invited"
    ))).scalar_one_or_none()
    squad = (await db.execute(select(Squad).where(Squad.id == squad_id))).scalar_one_or_none()
    if not inv or not squad:
        await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Invite not found or already handled."})
        return

    if action == "squaddecline":
        inv.status = "left"
        await db.commit()
        await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Invite declined."})
        if msg_id:
            await _tg_send("editMessageText", {"chat_id": chat_id, "message_id": msg_id,
                                               "text": f"❌ You declined the invite to squad {squad.name}."})
        return

    # Accept — must not already be in another squad.
    cap = (await db.execute(select(Squad).where(Squad.captain_trader_id == trader.id))).scalar_one_or_none()
    mem = (await db.execute(select(SquadMember).where(
        SquadMember.trader_id == trader.id, SquadMember.status == "active"
    ))).scalar_one_or_none()
    if cap or mem:
        await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "You're already in a squad — leave it first."})
        return
    inv.status = "active"
    await db.commit()
    await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "✅ Joined the squad!"})
    if msg_id:
        await _tg_send("editMessageText", {"chat_id": chat_id, "message_id": msg_id,
                                           "text": f"✅ You joined squad {squad.name}!\nOpen SparkP2P → Price Tracker → Squad to see the live plan."})


# ── Generate a short-lived link code for the logged-in trader ────────────────

@router.post("/generate-link-code")
async def generate_link_code(trader: Trader = Depends(get_current_trader)):
    code = _generate_code()
    _link_codes[code] = {
        "trader_id": trader.id,
        "expires_at": time.time() + 600,  # 10 minutes
    }
    return {"code": code, "expires_in": 600, "bot_username": "Sparkp2p_bot"}


# ── Disconnect Telegram ──────────────────────────────────────────────────────

@router.post("/disconnect")
async def disconnect_telegram(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        update(Trader).where(Trader.id == trader.id).values(telegram_chat_id=None)
    )
    await db.commit()
    return {"ok": True}


# ── Check connection status ──────────────────────────────────────────────────

@router.get("/status")
async def telegram_status(trader: Trader = Depends(get_current_trader)):
    return {"connected": bool(trader.telegram_chat_id)}


# ── Send a test message to confirm the bot is working ────────────────────────

@router.post("/test")
async def send_test_message(trader: Trader = Depends(get_current_trader)):
    if not trader.telegram_chat_id:
        raise HTTPException(status_code=400, detail="Telegram not connected")

    resp = await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": (
            "✅ SparkP2P Telegram is working!\n\n"
            "You will receive sell order approval requests here.\n"
            "Each message will show the buyer's stats with YES/NO buttons."
        ),
    })

    if resp and resp.get("ok"):
        return {"ok": True}
    raise HTTPException(status_code=502, detail="Telegram API did not return ok")


# ── Send approval request for a sell order ──────────────────────────────────

@router.post("/request-approval")
async def request_approval(
    payload: dict,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    if not trader.telegram_chat_id:
        raise HTTPException(status_code=400, detail="Telegram not connected")

    order = payload.get("order") or {}
    stats = payload.get("buyer_stats") or {}
    order_number = order.get("orderNumber")

    if not order_number:
        raise HTTPException(status_code=400, detail="Missing orderNumber")

    # Dedupe with the server-side tracking poller: if it already sent an approval
    # alert for this order, don't send a second button message — just return the
    # existing message_id so the desktop can keep polling approval-status.
    from sqlalchemy import text as _sql_text
    _existing = (await db.execute(_sql_text(
        "SELECT tg_message_id FROM sell_order_notifications WHERE order_number = :o"
    ), {"o": str(order_number)})).first()
    if _existing is not None:
        _ex_mid = _existing[0]
        if order_number not in _pending_approvals:
            _pending_approvals[order_number] = {
                "chat_id": trader.telegram_chat_id,
                "message_id": _ex_mid,
                "status": "pending",
                "trader_id": trader.id,
                "created_at": time.time(),
            }
        return {"ok": True, "message_id": _ex_mid, "deduped": True}

    b = stats
    all_time_raw = b.get("allTimeTrades", "N/A")
    all_time = (
        f"{all_time_raw} (Buy {b.get('buyTrades', 'N/A')} | Sell {b.get('sellTrades', 'N/A')})"
        if all_time_raw not in ("N/A", None, "")
        else "N/A"
    )

    try:
        amount_str = f"KES {int(float(order.get('totalPrice', 0))):,}"
    except Exception:
        amount_str = f"KES {order.get('totalPrice', '?')}"

    advisory = payload.get("advisory") or ""
    text = (
        (advisory + chr(10) + chr(10) if advisory else "") + "🔔 New Sell Order — Approval Required\n\n"
        f"Amount: {amount_str}\n"
        f"Buyer: {order.get('buyerNickname') or order.get('counterparty') or 'Unknown'}\n"
        f"Order: {order_number}\n\n"
        "Buyer Profile:\n"
        f"- All trades: {all_time}\n"
        f"- Last 30d trades: {b.get('last30dTrades', 'N/A')}\n"
        f"- 30d completion rate: {b.get('completionRate', 'N/A')}\n"
        f"- Avg pay time: {b.get('avgPayMins', 'N/A')}\n"
        f"- Trade partners: {b.get('counterparties', 'N/A')}\n"
        f"- Registered: {b.get('registeredDays', 'N/A')} days ago\n"
        f"- First trade: {b.get('firstTradeDays', 'N/A')} days ago\n"
        f"- Traded with you before: {'✅ Yes' if b.get('tradedBefore') else '❌ No'}\n\n"
        "Tap YES to send payment details, or NO to reject."
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✅ YES - Proceed", "callback_data": f"approve:{order_number}"},
        {"text": "❌ NO - Reject",   "callback_data": f"reject:{order_number}"},
    ]]}

    # Daily Telegram-alert cap by tier — once over cap, don't send the approval prompt.
    from app.services.rate_limits import consume_tg_alert as _consume_tg
    if not await _consume_tg(trader.id):
        return {"ok": False, "capped": True}

    resp = await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": text,
        "reply_markup": keyboard,
    })

    msg_id = None
    if resp and resp.get("ok"):
        msg_id = resp.get("result", {}).get("message_id")

    _pending_approvals[order_number] = {
        "chat_id": trader.telegram_chat_id,
        "message_id": msg_id,
        "status": "pending",
        "trader_id": trader.id,
        "created_at": time.time(),
    }

    # Record so the server-side tracking poller skips this order (no duplicate alert)
    # and so the status follow-up ("Order completed / cancelled") can reply under it.
    try:
        await db.execute(_sql_text(
            "INSERT INTO sell_order_notifications (order_number, trader_id, tg_message_id, last_status, trade_type) "
            "VALUES (:o, :t, :m, :s, 'SELL') "
            "ON CONFLICT (order_number) DO UPDATE SET tg_message_id = EXCLUDED.tg_message_id"
        ), {"o": str(order_number), "t": trader.id, "m": msg_id,
            "s": (order.get("orderStatus") or "").upper()})
        await db.commit()
    except Exception:
        pass

    return {"ok": True, "message_id": msg_id}


# ── Desktop app polls this to know if trader approved/rejected ───────────────

@router.get("/approval-status")
async def check_approval_status(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
):
    ap = _pending_approvals.get(order_number)
    if not ap:
        return {"status": "not_found"}

    # Auto-expire after 20 minutes
    if time.time() - ap["created_at"] > 1200:
        _pending_approvals.pop(order_number, None)
        return {"status": "timeout"}

    return {"status": ap["status"]}
