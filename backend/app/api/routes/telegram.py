import os
import random
import string
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import update, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.models.trader import Trader
from app.models.order import Order

router = APIRouter()

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

# In-memory stores
_link_codes: dict = {}         # code -> {trader_id, expires_at}
_pending_approvals: dict = {}   # order_number -> {chat_id, message_id, status, trader_id, created_at, type?}
_pending_name_checks: dict = {} # order_number -> {chat_id, message_id, status, trader_id, created_at}
_pending_payment_decisions: dict = {} # order_number -> {chat_id, message_id, status, trader_id, created_at} — buy payment stuck: merchant chooses manual/cancel
_pending_otp_acks: dict = {}    # order_number -> {chat_id, message_id, trader_id, created_at}

APPROVAL_TIMEOUT = 2700  # 45 minutes


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
        # Subscription gate: no notifications at all when the plan is expired (locked).
        try:
            from app.services.enforcement import notifications_allowed
            if not await notifications_allowed(tid):
                return None
        except Exception:
            pass
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


async def notify_trader(trader, message: str, reply_markup=None, reply_to=None, side: str = None) -> bool:
    """Send a Telegram notification to a trader if they have a chat_id linked.
    Returns True if sent successfully, False otherwise.
    Callers should fall back to SMS for security-critical notifications when False.

    `side` tags an alert as belonging to a BUY-order ("buy") or SELL-order ("sell")
    so it honours the trader's Telegram alert preference (telegram_notify_scope:
    'both' | 'sell' | 'buy'). A trader who chose "Sell orders only" then gets no
    buy-order alerts, and vice-versa. Untagged alerts (side=None) — system alerts
    like bot up/down, KYC, subscriptions, payout confirmations — always send."""
    if side in ("buy", "sell"):
        scope = (getattr(trader, "telegram_notify_scope", "both") or "both")
        if (scope == "sell" and side == "buy") or (scope == "buy" and side == "sell"):
            return False   # muted by the trader's notification preference
    # Mirror to the phone's notification bar (independent of Telegram being linked).
    try:
        from app.services import push_queue
        push_queue.add(getattr(trader, "id", None), message)
    except Exception:
        pass
    result = await send_trader_message(trader, message, reply_markup=reply_markup, reply_to=reply_to)
    return result is not None


async def send_otp_timeout_alert(trader, order_number: str, amount: float, name: str, method: str = "mpesa") -> bool:
    """Send an OTP-timeout alert with inline buttons asking if money actually moved.
    Stores the pending ack so the webhook can dismiss the buttons on reply."""
    if not getattr(trader, "telegram_chat_id", None):
        return False
    method_label = "M-Pesa" if "mpesa" in method.lower() else ("PesaLink" if "im_bank" in method.lower() else "Bank transfer")
    amt_str = f"KES {int(amount):,}"
    text = (
        f"⏱️ <b>OTP Timeout — Choice Bank Transfer</b>\n\n"
        f"<b>Order:</b> <code>...{order_number[-12:]}</code>\n"
        f"<b>Amount:</b> {amt_str}\n"
        f"<b>To:</b> {name}\n"
        f"<b>Via:</b> {method_label}\n\n"
        f"The Binance order was <b>cancelled</b> because the Choice Bank OTP didn't "
        f"arrive within 3 minutes.\n\n"
        f"⚠️ <b>Did the money actually leave your Choice Bank account?</b>"
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✅ No — it didn't move", "callback_data": f"otp_notmoved:{order_number}"},
        {"text": "⚠️ Yes — it moved",      "callback_data": f"otp_moved:{order_number}"},
    ]]}
    result = await send_trader_message(trader, text, reply_markup=keyboard)
    if result and result.get("ok"):
        _pending_otp_acks[order_number] = {
            "chat_id": str(trader.telegram_chat_id),
            "message_id": result["result"]["message_id"],
            "trader_id": getattr(trader, "id", None),
            "created_at": time.time(),
        }
        return True
    return False


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

        # ── OTP timeout ack (money moved / not moved) ──
        if len(parts) == 2 and parts[0] in ("otp_notmoved", "otp_moved"):
            otp_action, otp_order = parts[0], parts[1]
            ack = _pending_otp_acks.get(otp_order)
            chat_id = str(cb.get("message", {}).get("chat", {}).get("id", ""))
            msg_id = cb.get("message", {}).get("message_id")
            if otp_action == "otp_notmoved":
                await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Got it — no action needed."})
                await _tg_send("editMessageText", {
                    "chat_id": chat_id,
                    "message_id": msg_id,
                    "text": (
                        f"✅ <b>No money moved — no action needed</b>\n\n"
                        f"Order <code>...{otp_order[-12:]}</code>\n\n"
                        f"Choice Bank auto-expired the pending transfer. Binance order was cancelled."
                    ),
                    "parse_mode": "HTML",
                })
            else:  # otp_moved
                await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Acknowledged — please handle manually."})
                await _tg_send("editMessageText", {
                    "chat_id": chat_id,
                    "message_id": msg_id,
                    "text": (
                        f"⚠️ <b>Money moved — manual action required</b>\n\n"
                        f"Order <code>...{otp_order[-12:]}</code>\n\n"
                        f"Your money left Choice Bank but the Binance order was already cancelled. "
                        f"Contact the seller directly or submit a reversal request through Choice Bank to recover the funds."
                    ),
                    "parse_mode": "HTML",
                })
            _pending_otp_acks.pop(otp_order, None)
            return {"ok": True}

        # ── Squad invite accept / decline ──
        if len(parts) == 2 and parts[0] in ("squadaccept", "squaddecline"):
            chat_id = str(cb.get("message", {}).get("chat", {}).get("id", ""))
            msg_id = cb.get("message", {}).get("message_id")
            await _handle_squad_invite(db, chat_id, msg_id, cb_id, parts[0], parts[1])
            return {"ok": True}

        if len(parts) == 2:
            action, order_number = parts

            # ── Name mismatch callbacks ──────────────────────────────────────
            if action in ("name_approve", "name_reject"):
                nc = _pending_name_checks.get(order_number)
                if action == "name_approve":
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "✅ Releasing crypto now...",
                    })
                    if nc and nc.get("message_id"):
                        await _tg_send("editMessageText", {
                            "chat_id": nc["chat_id"],
                            "message_id": nc["message_id"],
                            "text": f"✅ APPROVED — RELEASING\n\nOrder {order_number}\nCrypto will be released via EP-20.",
                        })
                    # Signal the desktop bot via _pending_name_checks
                    if nc:
                        nc["status"] = "approved"
                    # Also call EP-20 directly from the server side
                    try:
                        from sqlalchemy import select as _sel
                        from app.models.trader import Trader as _Trader
                        _t = (await db.execute(_sel(_Trader).where(_Trader.id == (nc or {}).get("trader_id", 0)))).scalar_one_or_none()
                        if _t and _t.binance_api_key and _t.binance_api_secret:
                            from app.core.security import decrypt_data, binance_totp_secret
                            from app.services.binance.sapi_client import release_coin_2fa, relay_trader
                            relay_trader.set(_t.id)
                            _totp = binance_totp_secret(_t)
                            await release_coin_2fa(decrypt_data(_t.binance_api_key), decrypt_data(_t.binance_api_secret), order_number, totp_secret=_totp)
                    except Exception as _re:
                        import logging; logging.getLogger(__name__).warning("name_approve release failed: %s", _re)
                else:  # name_reject
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "🔒 Order held. Please review manually in Binance.",
                    })
                    if nc and nc.get("message_id"):
                        await _tg_send("editMessageText", {
                            "chat_id": nc["chat_id"],
                            "message_id": nc["message_id"],
                            "text": (
                                f"🔒 HELD — MANUAL REVIEW REQUIRED\n\n"
                                f"Order {order_number}\n\n"
                                f"Please log in to Binance P2P and review this order. "
                                f"Do NOT release crypto until the payment source is verified. "
                                f"Contact the buyer if needed to resolve the discrepancy."
                            ),
                        })
                    if nc:
                        nc["status"] = "rejected"
                return {"ok": True}

            # ── Buy payment-issue decision callbacks ─────────────────────────
            if action in ("pay_manual", "pay_cancel"):
                pd = _pending_payment_decisions.get(order_number)
                if action == "pay_manual":
                    await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "👍 You'll complete this order manually."})
                    if pd and pd.get("message_id"):
                        await _tg_send("editMessageText", {
                            "chat_id": pd["chat_id"], "message_id": pd["message_id"],
                            "text": f"✍️ MANUAL — Order {order_number}\n\nThe bot will stop trying this order. Please complete or cancel it yourself in Binance P2P.",
                        })
                    if pd:
                        pd["status"] = "manual"
                else:  # pay_cancel
                    # ── Pre-cancel safety: has money already gone out for this order? ──
                    # If the payment is already sent, or is in flight to the seller right
                    # now, cancelling FORFEITS that cash — the seller keeps the money and you
                    # get no crypto. This is the single biggest way to lose money here, so
                    # warn and require a SECOND tap to confirm before we cancel.
                    from sqlalchemy import select as _sel
                    from app.models.order import Order as _Order, OrderStatus as _OS
                    from app.services import im_bot_lease as _im_lease
                    _tid = (pd or {}).get("trader_id", 0)
                    _ord = (await db.execute(_sel(_Order).where(
                        _Order.binance_order_number == order_number,
                        _Order.trader_id == _tid,
                    ))).scalar_one_or_none()
                    _paid_states = (_OS.PAYMENT_SENT, _OS.RELEASING, _OS.RELEASED, _OS.SETTLING, _OS.COMPLETED)
                    _already_paid = bool(_ord and _ord.status in _paid_states)
                    _in_flight = _im_lease.is_leased(order_number)
                    _amt = int((_ord.fiat_amount if _ord else 0) or 0)

                    if (_already_paid or _in_flight) and not (pd or {}).get("cancel_armed"):
                        if pd is not None:
                            pd["cancel_armed"] = True
                        _lead = "You have ALREADY PAID" if _already_paid else "A payment is being sent RIGHT NOW —"
                        await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "⚠️ Payment already sent — please read"})
                        if pd and pd.get("message_id"):
                            await _tg_send("editMessageText", {
                                "chat_id": pd["chat_id"], "message_id": pd["message_id"],
                                "text": (f"⚠️ WAIT — {_lead} KES {_amt:,} to the seller for order {order_number}.\n\n"
                                         f"Cancelling now will NOT refund you: the seller keeps the money and you receive no crypto.\n\n"
                                         f"Only tap ❌ again if you accept losing KES {_amt:,}."),
                                "reply_markup": {"inline_keyboard": [
                                    [{"text": "❌ Cancel anyway — I accept the loss", "callback_data": f"pay_cancel:{order_number}"}],
                                    [{"text": "✅ Keep the order", "callback_data": f"pay_manual:{order_number}"}],
                                ]},
                            })
                        return {"ok": True}

                    _risky = _already_paid or _in_flight
                    await _tg_send("answerCallbackQuery", {"callback_query_id": cb_id, "text": "❌ Cancelling the order on Binance..."})
                    if pd and pd.get("message_id"):
                        _hdr = (f"❌ CANCELLING — you had already sent KES {_amt:,}; that money is now at risk with the seller"
                                if _risky else "❌ CANCELLING")
                        await _tg_send("editMessageText", {
                            "chat_id": pd["chat_id"], "message_id": pd["message_id"],
                            "text": f"{_hdr}\nOrder {order_number}\n\nThe bot is cancelling this order on Binance now.",
                        })
                    if pd:
                        pd["status"] = "cancel"
                    # Cancel on Binance server-side via EP-9 (relay-routed)
                    try:
                        from sqlalchemy import select as _sel
                        from app.models.trader import Trader as _Trader
                        _t = (await db.execute(_sel(_Trader).where(_Trader.id == (pd or {}).get("trader_id", 0)))).scalar_one_or_none()
                        if _t and _t.binance_api_key and _t.binance_api_secret:
                            from app.core.security import decrypt_data
                            from app.services.binance.sapi_client import cancel_order, relay_trader
                            relay_trader.set(_t.id)
                            _cresp = await cancel_order(decrypt_data(_t.binance_api_key), decrypt_data(_t.binance_api_secret), order_number)
                            _cancel_ok = (_cresp or {}).get("code") == "000000" or (_cresp or {}).get("success") is True
                            try:
                                from app.models.order import Order as _Order, OrderStatus as _OS
                                from app.services import im_bot_lease as _im_lease
                                _o = (await db.execute(_sel(_Order).where(
                                    _Order.trader_id == _t.id,
                                    _Order.binance_order_number == order_number,
                                ))).scalar_one_or_none()
                                _already_done = bool(_o and _o.status in (_OS.PAYMENT_SENT, _OS.RELEASING, _OS.RELEASED, _OS.SETTLING, _OS.COMPLETED))
                                if _cancel_ok and not _already_done:
                                    # Binance really cancelled it AND we hadn't paid — reflect that
                                    # so /im-bot/poll stops serving it and the release monitor stops.
                                    if _o:
                                        _o.status = _OS.CANCELLED
                                        await db.commit()
                                    _im_lease.release(order_number)
                                else:
                                    # Binance REFUSED (order already paid/releasing) OR we already
                                    # paid it. Do NOT mark it CANCELLED — that is what produced the
                                    # "cancelled — not completed" vs "Buy done" contradiction. Tell
                                    # the truth: it will complete, the payment is not lost.
                                    if pd and pd.get("message_id"):
                                        await _tg_send("editMessageText", {
                                            "chat_id": pd["chat_id"], "message_id": pd["message_id"],
                                            "text": (f"⚠️ Could NOT cancel order {order_number} — it is already paid and "
                                                     f"the seller is releasing the crypto. It will complete normally; your "
                                                     f"payment is not lost."),
                                        })
                                    import logging; logging.getLogger(__name__).info(
                                        "pay_cancel: not marking %s CANCELLED (cancel_ok=%s already_done=%s) — order is completing",
                                        order_number, _cancel_ok, _already_done)
                            except Exception as _ue:
                                import logging; logging.getLogger(__name__).warning("pay_cancel DB update failed: %s", _ue)
                    except Exception as _ce:
                        import logging; logging.getLogger(__name__).warning("pay_cancel cancel failed: %s", _ce)
                return {"ok": True}

            # ── Sell / Buy approval callbacks ────────────────────────────────
            ap = _pending_approvals.get(order_number)

            if ap:
                is_buy = ap.get("type") == "buy"

                if action in ("approve", "buy_approve"):
                    ap["status"] = "approved"
                    # Persist to DB so status survives a server restart
                    try:
                        from sqlalchemy import text as _sql_text
                        await db.execute(_sql_text(
                            "UPDATE sell_order_notifications SET last_status = 'APPROVED' WHERE order_number = :o"
                        ), {"o": str(order_number)})
                        await db.commit()
                    except Exception:
                        pass
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "✅ Approved — payment will be sent now" if is_buy else "✅ Approved — payment details sent to buyer",
                    })
                    if ap.get("message_id"):
                        edit_text = (
                            f"✅ APPROVED — PAYING NOW\n\nOrder ...{order_number[-12:]}\n"
                            f"Sending {ap.get('amount_str','')} to {ap.get('dest','')}"
                        ) if is_buy else f"✅ APPROVED\n\nOrder {order_number}\nPayment details sent to buyer."
                        await _tg_send("editMessageText", {
                            "chat_id": ap["chat_id"],
                            "message_id": ap["message_id"],
                            "text": edit_text,
                        })

                elif action in ("reject", "buy_decline"):
                    ap["status"] = "rejected"
                    try:
                        from sqlalchemy import text as _sql_text
                        await db.execute(_sql_text(
                            "UPDATE sell_order_notifications SET last_status = 'REJECTED' WHERE order_number = :o"
                        ), {"o": str(order_number)})
                        await db.commit()
                    except Exception:
                        pass
                    await _tg_send("answerCallbackQuery", {
                        "callback_query_id": cb_id,
                        "text": "❌ Declined — payment cancelled" if is_buy else "❌ Rejected — excuse message sent to buyer",
                    })
                    if ap.get("message_id"):
                        edit_text = (
                            f"❌ DECLINED — PAYMENT CANCELLED\n\nOrder ...{order_number[-12:]}\n"
                            f"No money sent. Order will expire."
                        ) if is_buy else f"❌ REJECTED\n\nOrder {order_number}\nExcuse message sent. Awaiting buyer cancellation."
                        await _tg_send("editMessageText", {
                            "chat_id": ap["chat_id"],
                            "message_id": ap["message_id"],
                            "text": edit_text,
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

    # ── Build the RICH advisory notification (accurate EP-19 stats + verdict), the SAME builder
    # the server-side tracking poller uses — instead of echoing the desktop's payload stats, which
    # are frequently blank (the "All trades: N/A / Trade partners: N/A" alert). We fetch the buyer's
    # Binance history server-side here and render it. Falls back to the basic text only when we
    # can't fetch (no API keys / lookup error), so a notification always goes out.
    text = None
    keyboard = {"inline_keyboard": [[
        {"text": "✅ YES - Proceed", "callback_data": f"approve:{order_number}"},
        {"text": "❌ NO - Reject",   "callback_data": f"reject:{order_number}"},
    ]]}
    try:
        if trader.binance_api_key and trader.binance_api_secret:
            from app.services.binance.sapi_client import get_counterparty_statistic, relay_trader
            from app.core.security import decrypt_data
            from app.services.tracking import _render_sell_alert
            relay_trader.set(trader.id)
            _ak = decrypt_data(trader.binance_api_key)
            _as = decrypt_data(trader.binance_api_secret)
            prof = await get_counterparty_statistic(_ak, _as, str(order_number)) or {}
            t30 = prof.get("completedOrderNumOfLatest30day"); tall = prof.get("completedOrderNum")
            rate30 = prof.get("finishRateLatest30Day"); regd = prof.get("registerDays")
            _apay = prof.get("avgPayTimeOfLatest30day") or prof.get("avgPayTime") or 0
            _arel = prof.get("avgReleaseTimeOfLatest30day") or prof.get("avgReleaseTime") or 0
            _pay_min = (_apay / 60.0) if _apay else None
            _rel_min = (_arel / 60.0) if _arel else None
            _rate_txt = (f"{rate30*100:.2f}%" if rate30 is not None else "N/A")

            def _f(v, sfx=""):
                return (f"{int(v):,}{sfx}" if isinstance(v, (int, float))
                        else (f"{v}{sfx}" if v not in (None, "") else "N/A"))

            def _i(v):
                try: return int(float(v))
                except Exception: return None

            thr30 = int(getattr(trader, "cf_all_trades_min", 0) or 0)
            thrall = int(getattr(trader, "cf_all_trades_min_all", 0) or 0)
            _t30, _tall, _regd = _i(t30), _i(tall), _i(regd)
            _notes, _accnotes, _flags = [], [], []
            if not ((t30 is not None) or (tall is not None)):
                _flags.append("⚠️ Buyer stats unavailable — couldn't fetch this buyer's Binance history "
                              "(temporary lookup failure). The blanks are NOT confirmed zeros; a returning "
                              "client can look brand-new here. Verify manually before rejecting.")
            if thr30 > 0 and _t30 is not None:
                (_notes if _t30 >= thr30 else _flags).append(
                    f"Has surpassed your 30-day minimum of {thr30} ({_t30} trades in the last 30 days)"
                    if _t30 >= thr30 else f"Below your 30-day minimum of {thr30} (only {_t30} trades)")
            if thrall > 0 and _tall is not None:
                (_notes if _tall >= thrall else _flags).append(
                    f"Strong track record — {_tall} lifetime trades (your minimum is {thrall})"
                    if _tall >= thrall else f"Below your all-time minimum of {thrall} ({_tall} lifetime trades)")
            if _regd is not None:
                if _regd >= 365: _accnotes.append(f"Well-aged account ({_regd} days / ~{_regd//365}y) — established trader")
                elif _regd >= 90: _accnotes.append(f"Established account ({_regd} days old)")
                elif _regd < 30: _flags.append(f"New account — only {_regd} days old")
            if rate30 is not None and rate30 < 0.90:
                _flags.append(f"30-day completion rate is {_rate_txt} — below 90%")

            _ctx = {
                "ono": str(order_number),
                "header_lines": [
                    f"Amount: {amount_str}",
                    f"Buyer: <b>{order.get('buyerNickname') or order.get('counterparty') or 'Unknown'}</b>",
                    f"Order: {order_number}",
                ],
                "prof_lines": [
                    f"- 30d trades: {_f(t30)}",
                    f"- All-time trades: {_f(tall)}",
                    f"- 30d completion: {_rate_txt}",
                    f"- Avg pay time: {('%.1f min' % _pay_min) if _pay_min else 'N/A'}",
                    f"- Avg release time: {('%.1f min' % _rel_min) if _rel_min else 'N/A'}",
                    f"- Account age: {_f(regd, ' days')}",
                ],
                "threshold_notes": _notes, "account_notes": _accnotes,
                "base_flags": _flags, "returning_note": None,
            }
            text, keyboard = _render_sell_alert(_ctx, [])
    except Exception as _rich_e:
        import logging; logging.getLogger(__name__).warning("request_approval rich alert failed for %s: %s", order_number, _rich_e)
        text = None

    if text is None:
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

    # Daily Telegram-alert cap by tier — once over cap, don't send the approval prompt.
    from app.services.rate_limits import consume_tg_alert as _consume_tg
    if not await _consume_tg(trader.id):
        return {"ok": False, "capped": True}

    resp = await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
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
    db: AsyncSession = Depends(get_db),
):
    ap = _pending_approvals.get(order_number)

    # Not in memory — server may have restarted. Restore from DB if the notification exists.
    if not ap:
        from sqlalchemy import text as _sql_text
        row = (await db.execute(_sql_text(
            "SELECT tg_message_id, last_status FROM sell_order_notifications WHERE order_number = :o"
        ), {"o": str(order_number)})).first()
        if row:
            _db_status = (row[1] or "").upper()
            if _db_status in ("APPROVED",):
                return {"status": "approved"}
            if _db_status in ("REJECTED",):
                return {"status": "rejected"}
            # Pending/unknown — recreate in-memory so next approve/reject press works
            _pending_approvals[order_number] = {
                "chat_id": str(trader.telegram_chat_id or ""),
                "message_id": row[0],
                "status": "pending",
                "trader_id": trader.id,
                "created_at": time.time(),
            }
            return {"status": "pending"}
        return {"status": "not_found"}

    if time.time() - ap["created_at"] > APPROVAL_TIMEOUT:
        _pending_approvals.pop(order_number, None)
        return {"status": "timeout"}

    return {"status": ap["status"]}


# ── Send approval request for a BUY order payment ───────────────────────────

class BuyApprovalRequest(BaseModel):
    order_number: str
    seller_name: str = ""
    amount: float
    method: str = "mpesa"          # mpesa | im_bank | other_bank
    phone: str = ""
    account_number: str = ""
    bank_name: str = ""
    choice_balance: float = 0.0
    # Seller profile stats from Binance EP-19
    trades_30d: int | None = None
    trades_all: int | None = None
    completion_rate: str = ""      # e.g. "99.76%"
    account_age_days: int | None = None
    avg_release_mins: float | None = None
    avg_pay_mins: float | None = None
    advisory: str = ""             # e.g. "Looks good" or "Caution"


async def _persist_payment_details(db: AsyncSession, trader: Trader, data: BuyApprovalRequest) -> None:
    """Record where this buy order's seller gets paid, onto the order itself.

    The desktop sends method as 'mpesa' | 'im_bank' | 'other_bank':
      mpesa       -> pay the PHONE
      im_bank     -> PesaLink to an account AT I&M
      other_bank  -> PesaLink to an account at bank_name

    Never overwrites a populated field with a blank: this endpoint can be called
    more than once for an order, and a later call with an empty bank_name must
    not erase a destination we already know.

    Must never break the notification — a payment is about to happen either way.
    """
    try:
        order = (
            await db.execute(
                select(Order).where(
                    Order.binance_order_number == data.order_number,
                    Order.trader_id == trader.id,
                )
            )
        ).scalar_one_or_none()
        if not order:
            return

        method = (data.method or "").strip().lower()
        dest = (data.phone or "").strip() if method == "mpesa" else (data.account_number or "").strip()
        # An I&M seller is paid at I&M; for any other bank, take the reported name.
        bank = "I&M Bank" if method == "im_bank" else (data.bank_name or "").strip()

        if method:
            order.seller_payment_method = method
        if dest:
            order.seller_payment_destination = dest
        if (data.seller_name or "").strip():
            order.seller_payment_name = data.seller_name.strip()
        if bank:
            order.seller_payment_bank = bank
        await db.commit()
    except Exception as e:
        logger.warning(f"could not persist payment details for {data.order_number}: {e}")


@router.post("/request-buy-approval")
async def request_buy_approval(
    data: BuyApprovalRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Notify trader of an incoming buy order and auto-pay immediately (no approval gate).
    Previously required Telegram YES/NO — removed because with multiple concurrent orders
    the approval response was being mis-matched to the wrong order. The bot now pays
    automatically and the merchant only receives informational alerts (before + after payment).

    ALSO PERSISTS WHERE THE SELLER IS PAID. The desktop already extracts this from
    Binance and sends it here; until now we only formatted a Telegram message and
    threw it away, so every buy order had seller_payment_* = NULL and the I&M Bot's
    /poll had nothing real to serve. This is the only place the server ever learns
    a seller's payment details, so record them.
    """
    await _persist_payment_details(db, trader, data)

    if not trader.telegram_chat_id:
        return {"ok": True, "auto_approved": True}

    if data.method in ("im_bank", "other_bank"):
        dest = f"{'PesaLink' if data.method == 'im_bank' else 'Bank'} {data.bank_name or ''} a/c {data.account_number or '?'}"
    else:
        dest = f"M-Pesa {data.phone or '?'}"

    amt_str = f"KES {int(data.amount):,}"
    name = data.seller_name or "Unknown seller"
    # Balance line — RAIL AWARE. An I&M-rail trader pays sellers from their own I&M
    # account using prepaid I&M credits, NOT Choice Bank — so "CB Balance" was
    # misleading. Show the relevant balance for the rail they're actually on.
    if getattr(trader, "buy_payout_via_im", False):
        from app.services import credits as _creditsvc
        _bal_label = "I&M Credits"
        _bal_val = f"{_creditsvc.trader_balance(trader):,} payouts left"
    else:
        _bal_label = "CB Balance"
        _bal_val = f"KES {int(data.choice_balance):,}" if data.choice_balance else "?"

    profile_lines = []
    if data.trades_30d is not None:
        profile_lines.append(f"  30d trades: {data.trades_30d:,}")
    if data.completion_rate:
        profile_lines.append(f"  Completion: {data.completion_rate}")
    if data.avg_release_mins is not None:
        profile_lines.append(f"  Avg release: {data.avg_release_mins:.1f} min")
    profile_section = ("\n" + "\n".join(profile_lines)) if profile_lines else ""

    advisory_section = ""
    if data.advisory:
        icon = "✅" if "good" in data.advisory.lower() else "⚠️"
        advisory_section = f"\n{icon} {data.advisory}"

    text = (
        f"🚀 <b>Buy order — paying automatically</b>\n\n"
        f"<b>Amount:</b> {amt_str}\n"
        f"<b>Seller:</b> {name}\n"
        f"<b>Paying to:</b> {dest}\n"
        f"<b>{_bal_label}:</b> {_bal_val}\n"
        f"<b>Order:</b> <code>...{data.order_number[-12:]}</code>"
        f"{profile_section}"
        f"{advisory_section}\n\n"
        f"<i>Payment executing now — you will be notified when sent and when complete.</i>"
    )

    # Informational only — no approval buttons
    await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
    })

    return {"ok": True, "auto_approved": True}


# ── Name mismatch alert — payment sender ≠ buyer Binance name ────────────────

class NameMismatchAlert(BaseModel):
    order_number: str
    amount: float
    payment_method: str = "mpesa"    # "mpesa" | "pesalink"
    sender_name: str = ""            # Name from Choice Bank webhook
    buyer_binance_name: str = ""     # Buyer's Binance display name


@router.post("/name-mismatch-alert")
async def name_mismatch_alert(
    data: NameMismatchAlert,
    trader: Trader = Depends(get_current_trader),
):
    """Send a Telegram YES/NO prompt when the payment sender name doesn't match
    the buyer's Binance name. YES → bot calls EP-20 to release. NO → merchant
    must handle manually."""
    if not trader.telegram_chat_id:
        return {"ok": False, "reason": "no_telegram"}

    method_label = "PesaLink" if data.payment_method == "pesalink" else "M-Pesa"
    amt_str = f"KES {int(data.amount):,}"

    text = (
        f"⚠️ <b>Payment Name Mismatch — Your Action Required</b>\n\n"
        f"<b>Order:</b> {data.order_number}\n"
        f"<b>Amount:</b> {amt_str}\n"
        f"<b>Method:</b> {method_label}\n\n"
        f"A payment has been received in your Choice Bank account for the above order. "
        f"However, the sender's registered name does not match the buyer's Binance name:\n\n"
        f"  • <b>Sender name</b> ({method_label}): <code>{data.sender_name or 'Unknown'}</code>\n"
        f"  • <b>Buyer name</b> (Binance): <code>{data.buyer_binance_name or 'Unknown'}</code>\n\n"
        f"This may indicate the buyer used a third-party account. Please review the order "
        f"carefully before deciding.\n\n"
        f"<b>Would you like to release the crypto, or hold for manual review?</b>"
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✅ Release Crypto", "callback_data": f"name_approve:{data.order_number}"},
        {"text": "🔒 Hold — Review Manually", "callback_data": f"name_reject:{data.order_number}"},
    ]]}

    resp = await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": keyboard,
    })
    ok = bool(resp and resp.get("ok"))
    if ok:
        _pending_name_checks[data.order_number] = {
            "chat_id": str(trader.telegram_chat_id),
            "message_id": resp["result"]["message_id"],
            "status": "pending",
            "trader_id": trader.id,
            "created_at": time.time(),
        }
    return {"ok": ok}


class PaymentIssueAlert(BaseModel):
    order_number: str
    seller_name: str = ""
    amount: float = 0
    reason: str = ""


@router.post("/payment-issue-alert")
async def payment_issue_alert(
    data: PaymentIssueAlert,
    trader: Trader = Depends(get_current_trader),
):
    """Buy payment couldn't complete automatically. Ask the merchant what to do:
    ✍️ complete manually (bot backs off) or ❌ cancel (bot cancels via EP-9). The bot
    never cancels on its own — only on this explicit merchant command."""
    if not trader.telegram_chat_id:
        return {"ok": False, "reason": "no_telegram"}
    amt_str = f"KES {int(data.amount):,}" if data.amount else ""
    text = (
        f"⚠️ <b>Payment Issue — Your Decision Needed</b>\n\n"
        f"<b>Order:</b> {data.order_number}\n"
        + (f"<b>Seller:</b> {data.seller_name}\n" if data.seller_name else "")
        + (f"<b>Amount:</b> {amt_str}\n" if amt_str else "")
        + (f"<b>Problem:</b> {data.reason}\n" if data.reason else "")
        + f"\nThe bot could not complete this payment automatically. How would you like to proceed?"
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✍️ I'll complete it manually", "callback_data": f"pay_manual:{data.order_number}"},
        {"text": "❌ Cancel the order", "callback_data": f"pay_cancel:{data.order_number}"},
    ]]}
    resp = await _tg_send("sendMessage", {
        "chat_id": trader.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": keyboard,
    })
    ok = bool(resp and resp.get("ok"))
    if ok:
        _pending_payment_decisions[data.order_number] = {
            "chat_id": str(trader.telegram_chat_id),
            "message_id": resp["result"]["message_id"],
            "status": "pending",
            "trader_id": trader.id,
            "created_at": time.time(),
        }
    return {"ok": ok}


@router.get("/payment-decision")
async def payment_decision(
    order_number: str,
    trader: Trader = Depends(get_current_trader),
):
    """Desktop polls the merchant's decision for a stuck buy payment: pending | manual | cancel | none."""
    pd = _pending_payment_decisions.get(order_number)
    return {"status": (pd or {}).get("status", "none")}
