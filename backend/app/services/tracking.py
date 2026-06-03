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
            from app.services.binance.sapi_client import get_counterparty_statistic
            from app.api.routes.telegram import notify_trader
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
                _before = ("Yes (" + str(withus) + ")") if withus else "No"
                _lines = [
                    "🔔 New Sell Order",
                    "",
                    f"Amount: {amt}",
                    f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                    f"Rate: {o.get('unitPrice','?')}",
                    f"Buyer: {o.get('counterPartNickName') or 'Unknown'}",
                    f"Order: {ono}",
                    "",
                    "Buyer Profile:",
                    f"- 30d trades: {_f(t30)}",
                    f"- All-time trades: {_f(tall)}",
                    f"- 30d completion: {_rate_txt}",
                    f"- Account age: {_f(regd, ' days')}",
                    f"- Traded with you before: {_before}",
                ]
                msg = chr(10).join(_lines)
                await notify_trader(trader, msg)
                logger.info("[Tracking] sell-order Telegram alert sent: %s", ono)
    except Exception as _ne:
        logger.warning("[Tracking] sell-order notify failed: %s", _ne)

    # ── Telegram alert for NEW buy orders (SELLER payment details via EP-13) ──
    # On a buy order WE pay the seller, so show their account/phone/paybill + amount.
    try:
        if getattr(trader, "telegram_chat_id", None):
            from sqlalchemy import text as _sql_text2
            from app.services.binance.sapi_client import get_order_payment_details
            from app.api.routes.telegram import notify_trader as _notify2
            for o in rows:
                if (o.get("tradeType") or "").upper() != "BUY":
                    continue
                ct = int(o.get("createTime") or 0)
                if ct < floor:
                    continue
                ono = o.get("orderNumber")
                if not ono:
                    continue
                seen = (await db.execute(_sql_text2(
                    "SELECT 1 FROM sell_order_notifications WHERE order_number = :o"
                ), {"o": str(ono)})).first()
                if seen:
                    continue
                await db.execute(_sql_text2(
                    "INSERT INTO sell_order_notifications (order_number, trader_id) VALUES (:o, :t) ON CONFLICT DO NOTHING"
                ), {"o": str(ono), "t": trader.id})
                await db.commit()
                pay = {}
                try:
                    pay = await get_order_payment_details(api_key, api_secret, ono)
                except Exception:
                    pay = {}
                try:
                    amt = f"KES {int(float(o.get('totalPrice') or 0)):,}"
                except Exception:
                    amt = f"KES {o.get('totalPrice','?')}"
                _bl = [
                    "💸 New Buy Order — Pay Seller",
                    "",
                    f"Amount to send: {amt}",
                    f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                    f"Rate: {o.get('unitPrice','?')}",
                    f"Seller: {o.get('counterPartNickName') or 'Unknown'}",
                    f"Order: {ono}",
                    "",
                    "Pay To:",
                    f"- Method: {pay.get('method') or 'N/A'}",
                ]
                if pay.get("fields"):
                    for fld in pay["fields"]:
                        _bl.append(f"- {fld['label']}: {fld['value']}")
                else:
                    _bl.append("- (details not available yet — check the order page)")
                await _notify2(trader, chr(10).join(_bl))
                logger.info("[Tracking] buy-order Telegram alert sent: %s", ono)
    except Exception as _be:
        logger.warning("[Tracking] buy-order notify failed: %s", _be)

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
