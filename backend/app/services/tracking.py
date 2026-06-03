"""While-online order tracking.

A server-side poller runs every 30s. For every trader whose bot is ONLINE (recent
heartbeat) and has a Binance API key, it pulls their recent Binance order history and
records orders completed *while the bot is online* into the central Orders table.

It never backtracks: on first activation or after any offline gap, it sets a session
floor at 'now', so orders from before activation / during downtime are ignored. Both the
merchant dashboard and the admin read these central Orders, so figures are consistent.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.trader import Trader
from app.models.order import Order, OrderSide, OrderStatus

logger = logging.getLogger(__name__)

ONLINE_WINDOW_SECS = 120   # trader considered online if heartbeat within this
GAP_SECS = 120             # a poll gap larger than this = bot was offline -> reset floor
POLL_INTERVAL_SECS = 30
BOOT_GRACE_SECS = 120   # after backend (re)start, dont reset floors (a restart != trader offline)
TERMINAL = {"COMPLETED", "CANCELLED", "CANCELLED_BY_SYSTEM"}
_poller_boot = None

# Relationship-analysis tuning
_REL_WINDOW_DAYS   = 30      # look-back window for "trades with you"
_REL_DETAIL_BUDGET = 40      # max getUserOrderDetail calls per cold counterparty backfill
_REL_SCAN_PAGES    = (2, 3, 4, 5, 6, 7, 8)  # extra history pages scanned during backfill (page 1 reused)
_REL_AMT_RATIO     = 2.0     # current amount >= ratio * usual -> flag
_REL_AMT_MIN_DELTA = 25000   # ...and at least this many KES above usual, to avoid noise


async def _analyze_counterparty(db, api_key, api_secret, trader_id, rows,
                                current_order, taker_no, full_nick, ep19_withus):
    """Profile the counterparty's trading relationship WITH THIS MERCHANT and return a
    list of advisory note strings (each tagged 'note' or 'flag').

    History nicknames are masked, so we identify past trades by the stable takerUserNo:
    cheaply prefix-filter candidates by masked nickname, then confirm via getUserOrderDetail
    (results cached in counterparty_trades so it's near-free after warm-up).

    Direction is from the MERCHANT's view: our SELL = they BOUGHT from us; our BUY = they
    SOLD to us. The current alert is always a SELL (they are buying from us)."""
    from sqlalchemy import text as T
    from app.services.binance.sapi_client import get_user_order_history, get_order_identity
    import time as _t
    if not taker_no:
        return []
    now_ms = int(_t.time() * 1000)
    cutoff = now_ms - _REL_WINDOW_DAYS * 86400 * 1000
    cur_ono = str(current_order.get("orderNumber") or "")
    try:
        cur_amt = float(current_order.get("totalPrice") or 0)
    except Exception:
        cur_amt = 0.0

    # Cache the current order too (so future alerts see it)
    try:
        await db.execute(T(
            "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
            "VALUES (:o,:t,:u,:n,:tt,:p,:s,:c) ON CONFLICT (order_number) DO UPDATE SET taker_user_no=EXCLUDED.taker_user_no"
        ), {"o": cur_ono, "t": trader_id, "u": taker_no, "n": full_nick,
            "tt": (current_order.get("tradeType") or "").upper(),
            "p": cur_amt, "s": (current_order.get("orderStatus") or "").upper(),
            "c": int(current_order.get("createTime") or now_ms)})
        await db.commit()
    except Exception:
        pass

    # How many of this counterparty's trades have we already cached?
    observed = (await db.execute(T(
        "SELECT COUNT(*) FROM counterparty_trades WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c"
    ), {"t": trader_id, "u": taker_no, "c": cutoff})).scalar() or 0

    # One-time cold backfill: the first time we ever see this counterparty (only the
    # current order cached), scan recent history to seed their past trades. After that we
    # rely on incremental caching (every new order caches itself), so steady-state cost is
    # just the SELECT below — no repeated history scans even if we can't reach all of EP-19.
    if ep19_withus and observed <= 1:
        prefix = (full_nick or "").lower()
        budget = _REL_DETAIL_BUDGET
        hist = list(rows)
        try:
            for pg in _REL_SCAN_PAGES:
                more = await get_user_order_history(api_key, api_secret, page=pg, rows=50)
                if not more:
                    break
                hist += more
        except Exception:
            pass
        for h in hist:
            if budget <= 0:
                break
            hono = str(h.get("orderNumber") or "")
            if not hono or hono == cur_ono:
                continue
            if (h.get("orderStatus") or "").upper() != "COMPLETED":
                continue
            if int(h.get("createTime") or 0) < cutoff:
                continue
            mp = (h.get("counterPartNickName") or "").split("*")[0]   # masked prefix
            if not mp or prefix[:len(mp)] != mp.lower():
                continue
            cached = (await db.execute(T(
                "SELECT 1 FROM counterparty_trades WHERE order_number=:o"
            ), {"o": hono})).first()
            if cached:
                continue
            budget -= 1
            try:
                idd = await get_order_identity(api_key, api_secret, hono)
            except Exception:
                continue
            # Confirm identity: stable takerUserNo (when they took our ad) OR exact
            # unmasked nickname (covers orders where we took their ad). Same prefix but
            # neither matches => a different person who happens to share the prefix.
            if idd.get("taker_user_no") != taker_no and idd.get("counterparty_nickname") != full_nick:
                continue
            await db.execute(T(
                "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
                "VALUES (:o,:t,:u,:n,:tt,:p,:s,:c) ON CONFLICT (order_number) DO NOTHING"
            ), {"o": hono, "t": trader_id, "u": taker_no, "n": idd.get("counterparty_nickname"),
                "tt": idd.get("trade_type"), "p": idd.get("total_price"),
                "s": idd.get("status"), "c": int(h.get("createTime") or 0)})
        await db.commit()

    # Confirmed prior trades with this counterparty (exclude the current order)
    prior = (await db.execute(T(
        "SELECT trade_type, total_price FROM counterparty_trades "
        "WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c AND order_number<>:o"
    ), {"t": trader_id, "u": taker_no, "c": cutoff, "o": cur_ono})).fetchall()

    buys_from_us = [float(r[1] or 0) for r in prior if (r[0] or "").upper() == "SELL"]  # they bought from us
    sells_to_us  = [float(r[1] or 0) for r in prior if (r[0] or "").upper() == "BUY"]   # they sold to us
    n_buy, n_sell = len(buys_from_us), len(sells_to_us)

    lines = []  # (kind, text) ; kind in {note, flag}
    total_obs = n_buy + n_sell
    if total_obs == 0:
        return lines  # nothing reliable to add beyond the standard "traded before" line

    # Did we manage to identify ALL of EP-19's reported trades? Only then can we make
    # absolute claims like "never sold to you". Otherwise report the matched sample
    # honestly — the unmatched ones could be in either direction.
    full = (not ep19_withus) or (total_obs >= ep19_withus)

    if full:
        if n_sell and n_buy == 0:
            lines.append(("flag", f"First time buying from you — every prior trade ({n_sell}) was them selling to you"))
        elif n_buy and n_sell == 0:
            lines.append(("note", f"Consistent buyer — all {n_buy} prior trades were buys from you, never a sell"))
        else:
            dom = "buys from you" if n_buy >= n_sell else "sells to you"
            lines.append(("note", f"Trade pattern: {n_buy} buys from you, {n_sell} sells to you — mostly {dom}"))
    else:
        unmatched = ep19_withus - total_obs
        lines.append(("note", f"Direction (sampled {total_obs} of {ep19_withus}): {n_buy} buys from you, {n_sell} sells to you — {unmatched} older trade(s) not yet analysed"))

    # Amount anomaly — compare this buy to their usual buy size (same direction)
    ref = buys_from_us if buys_from_us else (buys_from_us + sells_to_us)
    if ref and cur_amt > 0:
        avg = sum(ref) / len(ref)
        if avg > 0 and cur_amt >= _REL_AMT_RATIO * avg and (cur_amt - avg) >= _REL_AMT_MIN_DELTA:
            mult = cur_amt / avg
            basis = "usual buy" if buys_from_us else "usual trade"
            sample = "" if full else f" (from {len(ref)} matched orders)"
            lines.append(("flag", f"Large order — KES {int(cur_amt):,} is {mult:.1f}× their {basis} of ~KES {int(avg):,}{sample}"))
        else:
            lines.append(("note", f"Order size in line with their usual (~KES {int(avg):,})"))
    return lines


async def track_trader(db, trader) -> int:
    """Record this trader's newly-completed Binance orders into the Orders table,
    counting only those created during the current continuous online session."""
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import get_user_order_history

    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    gap = (now - trader.tracking_last_poll_at).total_seconds() if trader.tracking_last_poll_at else 1e9

    if trader.tracking_started_at is None:
        trader.tracking_started_at = now

    # Within boot grace (just after a backend restart) we never reset floors, because a
    # restart is not the trader going offline.
    in_boot_grace = (_poller_boot is not None and (now - _poller_boot).total_seconds() < BOOT_GRACE_SECS)
    if trader.tracking_high_water is None:
        trader.tracking_high_water = now_ms       # genuine first activation
        trader.tracking_last_poll_at = now
        await db.commit()
        return 0
    if gap > GAP_SECS and not in_boot_grace:
        # Trader returned from offline -> fresh session floor, skip the offline gap.
        trader.tracking_high_water = now_ms
        trader.tracking_last_poll_at = now
        await db.commit()
        return 0

    floor = int(trader.tracking_high_water)
    try:
        api_key = decrypt_data(trader.binance_api_key)
        api_secret = decrypt_data(trader.binance_api_secret)
        rows = await get_user_order_history(api_key, api_secret, page=1, rows=50)
    except Exception as e:
        trader.tracking_last_poll_at = now
        # Flag a dead/invalid key (residual ad filters can still block buyers, so a
        # dead key is otherwise invisible to the admin and trader).
        if str(e).startswith("INVALID_API_KEY") and not trader.binance_api_key_invalid:
            trader.binance_api_key_invalid = True
            logger.warning("[Tracking] trader %s API key invalid (%s)", trader.id, e)
        await db.commit()
        raise

    if trader.binance_api_key_invalid:
        trader.binance_api_key_invalid = False  # healthy read -> clear stale flag

    inserted = 0
    for o in rows:
        ct = int(o.get("createTime") or 0)
        if ct < floor:                       # before this online session -> ignore
            continue
        status_raw = (o.get("orderStatus") or "").upper()
        if status_raw not in TERMINAL:        # only record terminal (completed/cancelled)
            continue
        order_no = o.get("orderNumber")
        if not order_no:
            continue
        exists = (await db.execute(
            select(Order.id).where(Order.binance_order_number == order_no)
        )).scalar_one_or_none()
        if exists:                            # already recorded (by bot or prior poll)
            continue
        side = OrderSide.SELL if (o.get("tradeType") or "").upper() == "SELL" else OrderSide.BUY
        status = OrderStatus.COMPLETED if status_raw == "COMPLETED" else OrderStatus.CANCELLED
        db.add(Order(
            trader_id=trader.id,
            binance_order_number=order_no,
            account_reference="BIN-" + str(order_no),
            side=side,
            crypto_amount=float(o.get("amount") or 0),
            crypto_currency=o.get("asset") or "USDT",
            fiat_amount=float(o.get("totalPrice") or 0),
            exchange_rate=float(o.get("unitPrice") or 0),
            binance_commission=float(o.get("commission") or 0),
            status=status,
            counterparty_name=o.get("counterPartNickName"),
            created_at=datetime.fromtimestamp(ct / 1000, tz=timezone.utc) if ct else now,
            settled_at=(datetime.fromtimestamp(ct / 1000, tz=timezone.utc) if (ct and status == OrderStatus.COMPLETED) else None),
        ))
        inserted += 1

    # ── Telegram alert for NEW sell orders (buyer profile via EP-19) ──
    # Fires for sell orders created during this online session that we have not yet
    # alerted on — regardless of order status — so the merchant sees buyer details even
    # before Choice Bank is configured.
    try:
        if getattr(trader, "telegram_chat_id", None):
            from sqlalchemy import text as _sql_text
            from app.services.binance.sapi_client import get_counterparty_statistic, get_order_payment_details
            from app.api.routes.telegram import notify_trader, send_trader_message, _pending_approvals
            for o in rows:
                if (o.get("tradeType") or "").upper() != "SELL":
                    continue
                ct = int(o.get("createTime") or 0)
                if ct < floor:
                    continue
                ono = o.get("orderNumber")
                if not ono:
                    continue
                seen = (await db.execute(_sql_text(
                    "SELECT 1 FROM sell_order_notifications WHERE order_number = :o"
                ), {"o": str(ono)})).first()
                if seen:
                    continue
                # Mark first (avoid duplicate alerts across overlapping polls)
                await db.execute(_sql_text(
                    "INSERT INTO sell_order_notifications (order_number, trader_id) VALUES (:o, :t) ON CONFLICT DO NOTHING"
                ), {"o": str(ono), "t": trader.id})
                await db.commit()
                # Buyer profile via EP-19 (server-side; no browser)
                prof = {}
                try:
                    prof = await get_counterparty_statistic(api_key, api_secret, ono)
                except Exception:
                    prof = {}
                # Full (unmasked) buyer nickname + stable counterparty id from order detail
                _full_nick = None
                _taker_no = None
                try:
                    _det = await get_order_payment_details(api_key, api_secret, ono)
                    _full_nick = _det.get("counterparty_nickname")
                    _taker_no = _det.get("taker_user_no")
                except Exception:
                    _full_nick = None
                def _f(v, suffix=""):
                    return (f"{v}{suffix}" if v not in (None, "") else "N/A")
                t30 = prof.get("completedOrderNumOfLatest30day")
                tall = prof.get("completedOrderNum")
                rate30 = prof.get("finishRateLatest30Day")
                regd = prof.get("registerDays")
                withus = prof.get("numberOfTradesWithCounterpartyCompleted30day") or 0
                try:
                    amt = f"KES {int(float(o.get('totalPrice') or 0)):,}"
                except Exception:
                    amt = f"KES {o.get('totalPrice','?')}"
                _rate_txt = (f"{rate30*100:.2f}%" if rate30 is not None else "N/A")
                _before = ("Yes (" + str(withus) + " in 30d)") if withus else "No"

                # ── Advisory: assess the buyer against the merchant's own thresholds ──
                def _i(v):
                    try: return int(float(v))
                    except Exception: return None
                thr30  = int(trader.cf_all_trades_min or 0)        # Min Total Trades (30D)
                thrall = int(trader.cf_all_trades_min_all or 0)    # Min Total Trades (All-time)
                _t30, _tall, _regd, _withus = _i(t30), _i(tall), _i(regd), _i(withus) or 0
                _notes = []
                _flags = []   # cautionary
                # 30-day threshold check
                if thr30 > 0 and _t30 is not None:
                    if _t30 >= thr30:
                        _notes.append(f"Has surpassed your 30-day minimum of {thr30} ({_t30} trades in the last 30 days)")
                    else:
                        _flags.append(f"Below your 30-day minimum of {thr30} (only {_t30} trades)")
                # All-time threshold check
                if thrall > 0 and _tall is not None:
                    if _tall >= thrall:
                        _notes.append(f"Strong track record — {_tall} lifetime trades (your minimum is {thrall})")
                    else:
                        _flags.append(f"Below your all-time minimum of {thrall} ({_tall} lifetime trades)")
                # Repeat-client check
                if _withus > 0:
                    _notes.append(f"Returning client — has completed {_withus} trade(s) with you in the last 30 days")
                    # Deep relationship analysis: buy/sell direction pattern + amount anomaly
                    try:
                        _rel = await _analyze_counterparty(
                            db, api_key, api_secret, trader.id, rows, o, _taker_no, _full_nick, _withus
                        )
                    except Exception as _re:
                        logger.warning("[Tracking] counterparty analysis failed: %s", _re)
                        _rel = []
                    for _kind, _txt in _rel:
                        (_flags if _kind == "flag" else _notes).append(_txt)
                # Account-age check
                if _regd is not None:
                    if _regd >= 365:
                        _notes.append(f"Well-aged account ({_regd} days / ~{_regd//365}y) — established trader")
                    elif _regd >= 90:
                        _notes.append(f"Established account ({_regd} days old)")
                    elif _regd < 30:
                        _flags.append(f"New account — only {_regd} days old")
                # Completion-rate flag
                if rate30 is not None and rate30 < 0.90:
                    _flags.append(f"30-day completion rate is {_rate_txt} — below 90%")

                if _flags:
                    _verdict = "⚠️ <b>Review carefully</b> — some checks need attention"
                elif _notes:
                    _verdict = "✅ <b>Looks good</b> — meets your screening criteria"
                else:
                    _verdict = "ℹ️ <b>Limited history available</b> — use your judgement"

                _lines = [
                    "🔔 <b>New Sell Order — Approval Required</b>",
                    "",
                    f"Amount: {amt}",
                    f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                    f"Rate: {o.get('unitPrice','?')}",
                    f"Buyer: <b>{_full_nick or o.get('counterPartNickName') or 'Unknown'}</b>",
                    f"Order: {ono}",
                    "",
                    "Buyer Profile:",
                    f"- 30d trades: {_f(t30)}",
                    f"- All-time trades: {_f(tall)}",
                    f"- 30d completion: {_rate_txt}",
                    f"- Account age: {_f(regd, ' days')}",
                    f"- Traded with you before: {_before}",
                    "",
                    "Advisory:",
                    _verdict,
                ]
                for _n in _notes:
                    _lines.append(f"  • {_n}")
                for _fl in _flags:
                    _lines.append(f"  ⚠ {_fl}")
                _lines += ["", "Tap a button below to proceed."]
                msg = chr(10).join(_lines)
                _kb = {"inline_keyboard": [[
                    {"text": "✅ YES - Proceed", "callback_data": f"approve:{ono}"},
                    {"text": "❌ NO - Reject",   "callback_data": f"reject:{ono}"},
                ]]}
                _res = await send_trader_message(trader, msg, reply_markup=_kb)
                _mid = (_res or {}).get("result", {}).get("message_id")
                # Persist message_id + status; register for the YES/NO callback + desktop polling
                await db.execute(_sql_text(
                    "UPDATE sell_order_notifications SET tg_message_id = :m, last_status = :s, trade_type = 'SELL' WHERE order_number = :o"
                ), {"m": _mid, "s": (o.get("orderStatus") or "").upper(), "o": str(ono)})
                await db.commit()
                try:
                    import time as _time
                    _pending_approvals[str(ono)] = {
                        "chat_id": trader.telegram_chat_id,
                        "message_id": _mid,
                        "status": "pending",
                        "trader_id": trader.id,
                        "created_at": _time.time(),
                    }
                except Exception:
                    pass
                logger.info("[Tracking] sell-order Telegram alert sent: %s", ono)
    except Exception as _ne:
        logger.warning("[Tracking] sell-order notify failed: %s", _ne)

    # ── Telegram alert for NEW buy orders (SELLER payment details via EP-13) ──
    # On a buy order WE pay the seller, so show their account/phone/paybill + amount.
    try:
        if getattr(trader, "telegram_chat_id", None):
            from sqlalchemy import text as _sql_text2
            from app.services.binance.sapi_client import get_order_payment_details
            from app.api.routes.telegram import send_trader_message as _send2
            for o in rows:
                if (o.get("tradeType") or "").upper() != "BUY":
                    continue
                ct = int(o.get("createTime") or 0)
                if ct < floor:
                    continue
                ono = o.get("orderNumber")
                if not ono:
                    continue
                # Skip cancelled/terminal-without-payment: Binance wipes the seller's
                # payment fields once an order is cancelled, so there's nothing to pay.
                _st = (o.get("orderStatus") or "").upper()
                if _st in ("CANCELLED", "CANCELLED_BY_SYSTEM"):
                    continue
                seen = (await db.execute(_sql_text2(
                    "SELECT 1 FROM sell_order_notifications WHERE order_number = :o"
                ), {"o": str(ono)})).first()
                if seen:
                    continue
                # Fetch payment details FIRST — only alert if we actually have them, so we
                # never send a useless "details not available" message.
                pay = {}
                try:
                    pay = await get_order_payment_details(api_key, api_secret, ono)
                except Exception:
                    pay = {}
                if not pay.get("fields"):
                    # No payment fields yet (order too fresh / cancelled in-flight). Do NOT
                    # mark as seen — retry on the next poll once details populate.
                    continue
                await db.execute(_sql_text2(
                    "INSERT INTO sell_order_notifications (order_number, trader_id) VALUES (:o, :t) ON CONFLICT DO NOTHING"
                ), {"o": str(ono), "t": trader.id})
                await db.commit()
                try:
                    amt = f"KES {int(float(o.get('totalPrice') or 0)):,}"
                except Exception:
                    amt = f"KES {o.get('totalPrice','?')}"
                _bl = [
                    "<b>New Buy Order — Pay Seller</b>",
                    "",
                    f"Amount to send: {amt}",
                    f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                    f"Rate: {o.get('unitPrice','?')}",
                    f"Seller: <b>{pay.get('counterparty_nickname') or o.get('counterPartNickName') or 'Unknown'}</b>",
                    f"Order: {ono}",
                    "",
                    "Pay To:",
                    f"- Method: {pay.get('method') or 'N/A'}",
                ]
                for fld in pay["fields"]:
                    _bl.append(f"- {fld['label']}: {fld['value']}")
                _res2 = await _send2(trader, chr(10).join(_bl))
                _mid2 = (_res2 or {}).get("result", {}).get("message_id")
                await db.execute(_sql_text2(
                    "UPDATE sell_order_notifications SET tg_message_id = :m, last_status = :s, trade_type = 'BUY' WHERE order_number = :o"
                ), {"m": _mid2, "s": (o.get("orderStatus") or "").upper(), "o": str(ono)})
                await db.commit()
                logger.info("[Tracking] buy-order Telegram alert sent: %s", ono)
    except Exception as _be:
        logger.warning("[Tracking] buy-order notify failed: %s", _be)

    # ── Status follow-up: when a notified order becomes COMPLETED / CANCELLED, post a
    # short reply right under the original alert so the merchant sees the outcome. ──
    try:
        if getattr(trader, "telegram_chat_id", None):
            from sqlalchemy import text as _sql_text3
            from app.services.binance.sapi_client import get_order_payment_details  # noqa: F401
            from app.api.routes.telegram import send_trader_message as _send3, _pending_approvals as _pa3
            _TERMINAL = {
                "COMPLETED":           ("✅", "Order completed"),
                "CANCELLED":           ("❌", "Order cancelled — not completed"),
                "CANCELLED_BY_SYSTEM": ("❌", "Order auto-cancelled — not completed"),
            }
            for o in rows:
                ono = o.get("orderNumber")
                if not ono:
                    continue
                _cur = (o.get("orderStatus") or "").upper()
                if _cur not in _TERMINAL:
                    continue
                row = (await db.execute(_sql_text3(
                    "SELECT tg_message_id, last_status, status_notified FROM sell_order_notifications WHERE order_number = :o"
                ), {"o": str(ono)})).first()
                if not row:
                    continue  # we never alerted on this order — don't announce its outcome
                _mid_orig, _last, _done = row[0], row[1], row[2]
                if _done:
                    continue
                _icon, _label = _TERMINAL[_cur]
                await _send3(trader, f"{_icon} <b>{_label}</b>\nOrder: {ono}", reply_to=_mid_orig)
                await db.execute(_sql_text3(
                    "UPDATE sell_order_notifications SET status_notified = TRUE, last_status = :s WHERE order_number = :o"
                ), {"s": _cur, "o": str(ono)})
                await db.commit()
                # Clear any pending-approval entry (order is resolved)
                try:
                    _pa3.pop(str(ono), None)
                except Exception:
                    pass
                logger.info("[Tracking] order %s status follow-up sent: %s", ono, _cur)
    except Exception as _se:
        logger.warning("[Tracking] status follow-up failed: %s", _se)

    trader.tracking_last_poll_at = now
    await db.commit()
    if inserted:
        logger.info("[Tracking] trader %s recorded %d new while-online orders", trader.id, inserted)
    return inserted


async def tracking_poller():
    """Every 30s: track all online traders' while-online Binance orders."""
    global _poller_boot
    _poller_boot = datetime.now(timezone.utc)
    await asyncio.sleep(10)
    logger.info("[Tracking] poller started (every %ds)", POLL_INTERVAL_SECS)
    while True:
        try:
            async with async_session() as db:
                cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_WINDOW_SECS)
                # Online = app open (web heartbeat) OR bot loop heartbeat within the window.
                from sqlalchemy import or_ as _or
                traders = (await db.execute(
                    select(Trader).where(
                        Trader.binance_api_key.isnot(None),
                        _or(
                            Trader.last_extension_sync >= cutoff,
                            Trader.last_web_active >= cutoff,
                        ),
                    )
                )).scalars().all()
                for tr in traders:
                    try:
                        await track_trader(db, tr)
                    except Exception as e:
                        logger.warning("[Tracking] trader %s failed: %s", tr.id, e)
        except Exception as e:
            logger.error("[Tracking] poller error: %s", e)
        await asyncio.sleep(POLL_INTERVAL_SECS)


def compute_pnl(orders):
    """Centralized P&L from a list of COMPLETED Order rows. Used by merchant + admin
    so both show identical figures. Gross = USDT sold x (avg sell - avg buy);
    fees = actual Binance commission (USDT) x rate; net = gross - fees."""
    buys = [o for o in orders if o.side == OrderSide.BUY]
    sells = [o for o in orders if o.side == OrderSide.SELL]

    def _side(os):
        usdt = sum((o.crypto_amount or 0) for o in os)
        kes = sum((o.fiat_amount or 0) for o in os)
        return {"orders": len(os), "usdt": round(usdt, 2), "kes": round(kes, 2),
                "avg_rate": round(kes / usdt, 2) if usdt else 0.0}

    # Cumulative cost-basis: replay chronologically; each sell books realized profit
    # against the running weighted-average buy cost. Booked profit never changes, so the
    # daily figure only grows as you trade (no retroactive re-averaging / fluctuation).
    _chron = sorted(orders, key=lambda o: (o.created_at, o.id))
    _inv_usdt = 0.0
    _inv_cost = 0.0
    _realized = 0.0
    for _o in _chron:
        _u = float(_o.crypto_amount or 0)
        _k = float(_o.fiat_amount or 0)
        if _o.side == OrderSide.BUY:
            _inv_usdt += _u
            _inv_cost += _k
        else:
            _avg = (_inv_cost / _inv_usdt) if _inv_usdt > 0 else ((_k / _u) if _u else 0)
            _rate = (_k / _u) if _u else 0
            _realized += _u * (_rate - _avg)
            _draw = min(_u, _inv_usdt)
            if _inv_usdt > 0:
                _inv_cost -= _avg * _draw
                _inv_usdt -= _draw
                if _inv_usdt < 0.0001:
                    _inv_usdt = 0.0
                    _inv_cost = 0.0
    b = _side(buys)
    s = _side(sells)
    spread = round(s["avg_rate"] - b["avg_rate"], 4) if (b["avg_rate"] and s["avg_rate"]) else 0.0
    gross = round(_realized, 2)
    # Only SELL-side commission is a true deduction from realized profit. Buy-side
    # commission is part of the USDT acquisition cost (already in the cost basis),
    # so counting it here too would double-charge it.
    fees_kes = round(sum((o.binance_commission or 0) * (o.exchange_rate or 0)
                         for o in orders if o.side == OrderSide.SELL), 2)
    net = round(gross - fees_kes, 2)
    return {
        "buy": b, "sell": s, "spread": spread,
        "spread_pct": round(spread / b["avg_rate"] * 100, 2) if b["avg_rate"] else 0.0,
        "gross_profit": gross, "fees_kes": fees_kes, "net_profit": net,
        "volume": round(b["kes"] + s["kes"], 2), "trades": b["orders"] + s["orders"],
    }
