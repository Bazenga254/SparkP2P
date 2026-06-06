"""24/7 server-side order tracking + notifications.

A server-side poller runs every 30s. For every trader with a Binance API key — whether or
not their app is open — it pulls their recent Binance order history, records completed orders
into the central Orders table, and fires Telegram alerts for new orders. Data and alerts no
longer require the desktop app to be running; the stored API key drives everything.

The incremental recorder never backtracks: on first activation or after an offline gap it sets
a session floor at 'now', so it won't flood stale-order alerts. The separate _backfill_orders
pass imports the FULL completed-order history (idempotent, every ~30 min), so the dashboard
reflects ALL trading — including trades done while the app was closed. Both the merchant
dashboard and the admin read these central Orders, so figures are consistent.
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
_REL_WINDOW_DAYS   = 30      # Binance's order history / EP-19 only span ~30 days (seed scan)
_REL_QUERY_DAYS    = 90      # how far back we read OUR OWN cache — surfaces older relationships
_REL_DETAIL_BUDGET = 60      # max getUserOrderDetail calls per background scan
_REL_MAX_PAGES     = 60      # background scan depth — full ~30-day history (~58 pages)
_POLL_CACHE_BUDGET = 12      # max getUserOrderDetail calls per poll for incremental caching
_REL_AMT_RATIO     = 2.0     # current amount >= ratio * usual -> flag
_REL_AMT_MIN_DELTA = 25000   # ...and at least this many KES above usual, to avoid noise
_rel_inflight       = set()  # (trader_id, taker_no) already enriched this process — scan once
_rel_window_covered = {}     # (trader_id, taker_no) -> True if a bg scan reached the full window
_rel_sem            = None   # lazily-created semaphore that serialises heavy background scans
_backfill_done      = set()  # trader_ids whose full-history counterparty backfill has run
_BACKFILL_MAX_CALLS = 3000   # safety cap on getUserOrderDetail calls per backfill run
_BACKFILL_CONCURRENCY = 6    # parallel detail lookups per batch (relay round-trips are ~1s each)


def _rel_window_label():
    m = _REL_WINDOW_DAYS // 30
    return f"last {m} months" if m >= 2 else f"last {_REL_WINDOW_DAYS} days"


_orders_backfill_at = {}        # trader_id -> last completed-order backfill time (UTC)
_ORDERS_BACKFILL_INTERVAL = 1800  # re-scan full history every 30 min to catch offline trades


async def _backfill_orders(trader_id, api_key, api_secret):
    """Import EVERY COMPLETED Binance order into the Orders table — not just the ones tracked
    while the bot was online — so profit/volume figures reflect ALL trading and the cost-basis
    replay has the full set of buys. EP-16 returns every field we need (amount, price,
    commission), so no per-order detail calls. Idempotent (dedup on binance_order_number), and
    self-gated to re-run at most every 30 min so trades made while the bot was OFF get picked
    up without needing a restart."""
    last = _orders_backfill_at.get(trader_id)
    nowt = datetime.now(timezone.utc)
    if last is not None and (nowt - last).total_seconds() < _ORDERS_BACKFILL_INTERVAL:
        return
    _orders_backfill_at[trader_id] = nowt
    try:
        from sqlalchemy import select as _sel
        from app.services.binance.sapi_client import get_user_order_history
        from app.models.order import Order, OrderSide, OrderStatus
        inserted = 0
        scanned = 0
        async with async_session() as db:
            page = 1
            while page <= _REL_MAX_PAGES:        # full available history (~30 days)
                try:
                    rows = await get_user_order_history(api_key, api_secret, page=page, rows=50)
                except Exception:
                    break
                page += 1
                if not rows:
                    break
                for o in rows:
                    scanned += 1
                    if (o.get("orderStatus") or "").upper() != "COMPLETED":
                        continue
                    ono = o.get("orderNumber")
                    if not ono:
                        continue
                    if (await db.execute(_sel(Order.id).where(Order.binance_order_number == ono))).scalar_one_or_none():
                        continue   # already recorded (by the live poller or a prior backfill)
                    ct = int(o.get("createTime") or 0)
                    side = OrderSide.SELL if (o.get("tradeType") or "").upper() == "SELL" else OrderSide.BUY
                    ts = datetime.fromtimestamp(ct / 1000, tz=timezone.utc) if ct else datetime.now(timezone.utc)
                    db.add(Order(
                        trader_id=trader_id,
                        binance_order_number=ono,
                        account_reference="BIN-" + str(ono),
                        side=side,
                        crypto_amount=float(o.get("amount") or 0),
                        crypto_currency=o.get("asset") or "USDT",
                        fiat_amount=float(o.get("totalPrice") or 0),
                        exchange_rate=float(o.get("unitPrice") or 0),
                        binance_commission=float(o.get("commission") or 0),
                        status=OrderStatus.COMPLETED,
                        counterparty_name=o.get("counterPartNickName"),
                        created_at=ts,
                        settled_at=ts,
                    ))
                    inserted += 1
                await db.commit()
        if inserted:
            logger.info("[Tracking] order backfill for trader %s: scanned %d, inserted %d completed orders", trader_id, scanned, inserted)
    except Exception as e:
        logger.warning("[Tracking] order backfill failed for trader %s: %s", trader_id, e)
        _orders_backfill_at.pop(trader_id, None)   # allow retry next poll


async def _backfill_counterparties(trader_id, api_key, api_secret):
    """ONE-TIME (per process) gentle background sweep of the full ~30-day order history that
    caches EVERY counterparty's COMPLETED trades into counterparty_trades. After this, every
    buyer's buy/sell breakdown is available instantly from cache — no per-buyer scan needed.
    Idempotent (skips already-cached orders) and rate-limited so it doesn't disrupt trading."""
    if trader_id in _backfill_done:
        return
    _backfill_done.add(trader_id)
    try:
        from sqlalchemy import text as T
        from app.services.binance.sapi_client import get_user_order_history, get_order_identity
        import time as _t
        cutoff = int(_t.time() * 1000) - _REL_WINDOW_DAYS * 86400 * 1000
        calls = 0
        cached = 0
        async with async_session() as db:
            page = 1
            while page <= _REL_MAX_PAGES and calls < _BACKFILL_MAX_CALLS:
                try:
                    rows = await get_user_order_history(api_key, api_secret, page=page, rows=50)
                except Exception:
                    break
                page += 1
                if not rows:
                    break
                page_min_ct = min(int(h.get("createTime") or 0) for h in rows)
                # Collect uncached COMPLETED candidates on this page
                cand = []
                for h in rows:
                    hono = str(h.get("orderNumber") or "")
                    if not hono:
                        continue
                    if (h.get("orderStatus") or "").upper() != "COMPLETED":
                        continue
                    if int(h.get("createTime") or 0) < cutoff:
                        continue
                    if (await db.execute(T("SELECT 1 FROM counterparty_trades WHERE order_number=:o"), {"o": hono})).first():
                        continue  # already cached (idempotent)
                    cand.append(h)
                # Resolve identities in parallel batches (relay round-trips are slow individually)
                for i in range(0, len(cand), _BACKFILL_CONCURRENCY):
                    if calls >= _BACKFILL_MAX_CALLS:
                        break
                    chunk = cand[i:i + _BACKFILL_CONCURRENCY]
                    calls += len(chunk)
                    results = await asyncio.gather(
                        *[get_order_identity(api_key, api_secret, str(h.get("orderNumber"))) for h in chunk],
                        return_exceptions=True,
                    )
                    for h, idd in zip(chunk, results):
                        if isinstance(idd, Exception) or not idd:
                            continue
                        tk = idd.get("taker_user_no")
                        if not tk:
                            continue
                        await db.execute(T(
                            "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
                            "VALUES (:o,:t,:u,:n,:tt,:p,'COMPLETED',:c) ON CONFLICT (order_number) DO NOTHING"
                        ), {"o": str(h.get("orderNumber")), "t": trader_id, "u": tk, "n": idd.get("counterparty_nickname"),
                            "tt": idd.get("trade_type"), "p": float(h.get("totalPrice") or 0),
                            "c": int(h.get("createTime") or 0)})
                        cached += 1
                    await db.commit()
                if page_min_ct < cutoff:
                    break
        logger.info("[Tracking] counterparty backfill done for trader %s: %d detail calls, %d cached", trader_id, calls, cached)
    except Exception as e:
        logger.warning("[Tracking] counterparty backfill failed for trader %s: %s", trader_id, e)
        _backfill_done.discard(trader_id)   # allow a retry on the next poll


def _build_relationship_lines(prior, cur_amt, ep19_count=0, covered=False):
    """Build advisory lines from a list of prior (trade_type, total_price) COMPLETED rows
    found in our own order history. Direction is MERCHANT-view: our SELL = they BOUGHT from
    us; our BUY = they SOLD to us. The current alert is a SELL (they are buying from us).

    We ALWAYS surface the buy/sell breakdown when we have at least one matched trade. If we've
    matched everything (full window covered, or matched >= EP-19's reported count) we make an
    absolute claim ("never sold to you"); otherwise we present it as the running tally so far.
    Returns [(kind, text)]."""
    import time as _t
    now_ms = int(_t.time() * 1000)
    # Each prior row is (trade_type, total_price, created_ms)
    buys  = [(float(r[1] or 0), int(r[2] or 0)) for r in prior if (r[0] or "").upper() == "SELL"]
    sells = [(float(r[1] or 0), int(r[2] or 0)) for r in prior if (r[0] or "").upper() == "BUY"]
    n_buy, n_sell = len(buys), len(sells)
    total = n_buy + n_sell
    lines = []
    all_ms    = [m for _, m in (buys + sells) if m]
    last_days = int((now_ms - max(all_ms)) / 86400000) if all_ms else None
    matched_all = covered or (ep19_count and total >= ep19_count)

    def _bs(label):  # buy/sell phrasing helper
        return f"bought from you {n_buy}×, sold to you {n_sell}×" if (n_buy and n_sell) else (
               f"bought from you {n_buy}×" if n_buy else f"sold to you {n_sell}×")

    # ── Returning / known-client statement WITH buy/sell direction ──
    if ep19_count > 0:                       # active in the last 30 days (per Binance EP-19)
        if total == 0:
            lines.append(("note", f"Returning client — {ep19_count} trade(s) with you in the last 30 days (analysing buy/sell…)"))
        elif matched_all:
            if n_sell and n_buy == 0:
                lines.append(("flag", f"Returning client — in the last 30 days they have ONLY sold to you ({n_sell}×); this would be their first buy from you"))
            elif n_buy and n_sell == 0:
                lines.append(("note", f"Returning client — has bought from you {n_buy}× in the last 30 days, never sold to you"))
            else:
                lines.append(("note", f"Returning client — {ep19_count} trades in the last 30 days: {_bs('')}"))
        else:
            lines.append(("note", f"Returning client — {ep19_count} trade(s) in the last 30 days (so far {_bs('')} — still analysing)"))
    elif total > 0:                          # older relationship — none in last 30d but in our cache
        age = f"~{last_days} days ago" if last_days is not None else "earlier"
        if n_sell and n_buy == 0:
            lines.append(("flag", f"Known client — last traded {age}; previously ONLY sold to you ({n_sell}×) — this would be their first buy"))
        else:
            lines.append(("note", f"Known client — last traded {age}: {_bs('')} (none in the last 30 days)"))
    else:
        return lines                         # genuinely new buyer — nothing to add

    # ── Volume caution: this order vs their usual buy size ──
    buy_amts  = [a for a, _ in buys]
    sell_amts = [a for a, _ in sells]
    ref = buy_amts if buy_amts else (buy_amts + sell_amts)
    if ref and cur_amt > 0:
        avg = sum(ref) / len(ref)
        if avg > 0 and cur_amt >= _REL_AMT_RATIO * avg and (cur_amt - avg) >= _REL_AMT_MIN_DELTA:
            mult = cur_amt / avg
            basis = "usual buy" if buy_amts else "usual trade"
            lines.append(("flag", f"Unusually large order — KES {int(cur_amt):,} is {mult:.1f}× their {basis} of ~KES {int(avg):,}"))
        else:
            lines.append(("note", f"Order size in line with their usual (~KES {int(avg):,})"))
    return lines


async def _scan_counterparty_history(db, api_key, api_secret, trader_id, taker_no, full_nick,
                                     cur_ono, max_pages, target=0):
    """Page through order history and cache this counterparty's COMPLETED trades (matched by
    stable takerUserNo, unmasked-nickname fallback). Bounded by max_pages + detail budget.
    Returns covered(bool) = whether we reached the end of the window. Used synchronously to
    seed a cold buyer before the alert so the buy/sell breakdown is present immediately."""
    from sqlalchemy import text as T
    from app.services.binance.sapi_client import get_user_order_history, get_order_identity
    import time as _t
    cutoff = int(_t.time() * 1000) - _REL_WINDOW_DAYS * 86400 * 1000
    prefix = (full_nick or "").lower()
    budget = _REL_DETAIL_BUDGET
    covered = False
    matched = (await db.execute(T(
        "SELECT COUNT(*) FROM counterparty_trades WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c"
    ), {"t": trader_id, "u": taker_no, "c": cutoff})).scalar() or 0
    page = 1
    while page <= max_pages and budget > 0:
        if target and matched >= target:
            covered = True
            break
        try:
            more = await get_user_order_history(api_key, api_secret, page=page, rows=50)
        except Exception:
            break
        page += 1
        if not more:
            covered = True
            break
        page_min_ct = min(int(h.get("createTime") or 0) for h in more)
        for h in more:
            if budget <= 0:
                break
            hono = str(h.get("orderNumber") or "")
            if not hono or hono == cur_ono:
                continue
            if (h.get("orderStatus") or "").upper() != "COMPLETED":
                continue
            if int(h.get("createTime") or 0) < cutoff:
                continue
            mp = (h.get("counterPartNickName") or "").split("*")[0]
            if not mp or prefix[:len(mp)] != mp.lower():
                continue
            if (await db.execute(T("SELECT 1 FROM counterparty_trades WHERE order_number=:o"), {"o": hono})).first():
                continue
            budget -= 1
            try:
                idd = await get_order_identity(api_key, api_secret, hono)
            except Exception:
                continue
            if idd.get("taker_user_no") != taker_no and idd.get("counterparty_nickname") != full_nick:
                continue
            await db.execute(T(
                "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
                "VALUES (:o,:t,:u,:n,:tt,:p,'COMPLETED',:c) ON CONFLICT (order_number) DO NOTHING"
            ), {"o": hono, "t": trader_id, "u": taker_no, "n": idd.get("counterparty_nickname"),
                "tt": idd.get("trade_type"), "p": idd.get("total_price"),
                "c": int(h.get("createTime") or 0)})
            matched += 1
        await db.commit()
        if page_min_ct < cutoff:
            covered = True
            break
    return covered


async def _relationship_cached(db, trader_id, taker_no, current_order, full_nick, ep19_count=0):
    """FAST, no-API: cache the current order, then build relationship lines from whatever
    COMPLETED trades we've already cached for this counterparty over the window. Returns
    (lines, observed). Deeper history reconstruction is deferred to _enrich_counterparty_bg."""
    from sqlalchemy import text as T
    import time as _t
    if not taker_no:
        return [], 0, None
    now_ms = int(_t.time() * 1000)
    cutoff = now_ms - _REL_QUERY_DAYS * 86400 * 1000
    cur_ono = str(current_order.get("orderNumber") or "")
    try:
        cur_amt = float(current_order.get("totalPrice") or 0)
    except Exception:
        cur_amt = 0.0
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
    prior = (await db.execute(T(
        "SELECT trade_type, total_price, created_ms FROM counterparty_trades "
        "WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c AND order_number<>:o "
        "AND status='COMPLETED'"
    ), {"t": trader_id, "u": taker_no, "c": cutoff, "o": cur_ono})).fetchall()
    covered = _rel_window_covered.get((trader_id, taker_no), False)
    last_days = None
    _ms = [int(r[2] or 0) for r in prior if r[2]]
    if _ms:
        last_days = int((now_ms - max(_ms)) / 86400000)
    return _build_relationship_lines(prior, cur_amt, ep19_count, covered), len(prior), last_days


def _render_sell_alert(ctx, rel_lines):
    """Render the full sell-order approval message + keyboard from its component parts.
    Used both when first sending the alert and when the background scan edits it in place,
    so the layout and verdict stay identical. rel_lines = [(kind, text), ...] for the
    buyer-relationship section (empty until the full history scan completes)."""
    rel_notes = [t for k, t in rel_lines if k == "note"]
    rel_flags = [t for k, t in rel_lines if k == "flag"]
    notes = list(ctx["threshold_notes"])
    if ctx.get("returning_note"):
        notes.append(ctx["returning_note"])
    notes += rel_notes + list(ctx["account_notes"])
    flags = list(ctx["base_flags"]) + rel_flags
    if flags:
        verdict = "⚠️ <b>Review carefully</b> — some checks need attention"
    elif notes:
        verdict = "✅ <b>Looks good</b> — meets your screening criteria"
    else:
        verdict = "ℹ️ <b>Limited history available</b> — use your judgement"
    L = ["🔔 <b>New Sell Order — Approval Required</b>", ""] + list(ctx["header_lines"]) + \
        ["", "Buyer Profile:"] + list(ctx["prof_lines"]) + ["", "Advisory:", verdict]
    for n in notes:
        L.append(f"  • {n}")
    for f in flags:
        L.append(f"  ⚠ {f}")
    L += ["", "Tap a button below to proceed."]
    ono = ctx["ono"]
    kb = {"inline_keyboard": [[
        {"text": "✅ YES - Proceed", "callback_data": f"approve:{ono}"},
        {"text": "❌ NO - Reject",   "callback_data": f"reject:{ono}"},
    ]]}
    return chr(10).join(L), kb


async def _enrich_counterparty_bg(trader_id, api_key, api_secret, taker_no, full_nick,
                                  cur_ono, cur_amt, ep19_target, reply_to_mid,
                                  chat_id=None, ctx=None):
    """BACKGROUND (non-blocking): page through the full available order history (~30 days)
    to identify this counterparty's past trades and cache them, then EDIT the original alert
    in place to add the complete buyer-history section (so the merchant sees ONE full report,
    not a stub follow-up). Stops early once we've matched EP-19's reported count. Records
    whether the window was fully covered so wording is absolute ("in the last 30 days...").
    Heavy scans are serialised and each counterparty is scanned at most once per process."""
    global _rel_sem
    key = (trader_id, taker_no)
    if not taker_no or key in _rel_inflight:
        return
    _rel_inflight.add(key)
    if _rel_sem is None:
        _rel_sem = asyncio.Semaphore(1)
    try:
        from sqlalchemy import text as T
        from app.services.binance.sapi_client import get_user_order_history, get_order_identity
        from app.api.routes.telegram import send_trader_message, edit_trader_message
        import time as _t
        cutoff = int(_t.time() * 1000) - _REL_WINDOW_DAYS * 86400 * 1000   # scan window (Binance ~30d)
        query_cutoff = int(_t.time() * 1000) - _REL_QUERY_DAYS * 86400 * 1000  # display window (our cache, 90d)
        prefix = (full_nick or "").lower()
        budget = _REL_DETAIL_BUDGET
        covered = False
        target = int(ep19_target or 0)
        async with _rel_sem, async_session() as db:
            start_obs = (await db.execute(T(
                "SELECT COUNT(*) FROM counterparty_trades WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c"
            ), {"t": trader_id, "u": taker_no, "c": cutoff})).scalar() or 0
            matched = start_obs
            page = 1
            while page <= _REL_MAX_PAGES and budget > 0:
                if target and matched >= target:
                    covered = True   # found all of EP-19's reported trades -> done
                    break
                try:
                    more = await get_user_order_history(api_key, api_secret, page=page, rows=50)
                except Exception:
                    break
                page += 1
                if not more:
                    covered = True   # ran out of history before the window -> fully covered
                    break
                page_min_ct = min(int(h.get("createTime") or 0) for h in more)
                for h in more:
                    if budget <= 0:
                        break
                    hono = str(h.get("orderNumber") or "")
                    if not hono or hono == cur_ono:
                        continue
                    if (h.get("orderStatus") or "").upper() != "COMPLETED":
                        continue
                    if int(h.get("createTime") or 0) < cutoff:
                        continue
                    mp = (h.get("counterPartNickName") or "").split("*")[0]
                    if not mp or prefix[:len(mp)] != mp.lower():
                        continue
                    if (await db.execute(T("SELECT 1 FROM counterparty_trades WHERE order_number=:o"), {"o": hono})).first():
                        continue
                    budget -= 1
                    try:
                        idd = await get_order_identity(api_key, api_secret, hono)
                    except Exception:
                        continue
                    if idd.get("taker_user_no") != taker_no and idd.get("counterparty_nickname") != full_nick:
                        continue
                    # We only reach here for orders whose EP-16 history status is COMPLETED,
                    # so store 'COMPLETED' explicitly (getUserOrderDetail's orderStatus is a
                    # numeric code, not the string — relying on it broke the status filter).
                    await db.execute(T(
                        "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
                        "VALUES (:o,:t,:u,:n,:tt,:p,'COMPLETED',:c) ON CONFLICT (order_number) DO NOTHING"
                    ), {"o": hono, "t": trader_id, "u": taker_no, "n": idd.get("counterparty_nickname"),
                        "tt": idd.get("trade_type"), "p": idd.get("total_price"),
                        "c": int(h.get("createTime") or 0)})
                    matched += 1
                await db.commit()
                if page_min_ct < cutoff:
                    covered = True   # paged past the window cutoff -> full window covered
                    break
            _rel_window_covered[key] = covered
            prior = (await db.execute(T(
                "SELECT trade_type, total_price, created_ms FROM counterparty_trades "
                "WHERE trader_id=:t AND taker_user_no=:u AND created_ms>=:c AND order_number<>:o "
                "AND status='COMPLETED'"
            ), {"t": trader_id, "u": taker_no, "c": query_cutoff, "o": cur_ono})).fetchall()
        lines = _build_relationship_lines(prior, cur_amt, ep19_target, covered)
        # Edit the original alert in place to fold in the complete buyer history (one report).
        if ctx is not None and chat_id and reply_to_mid:
            try:
                text, kb = _render_sell_alert(ctx, lines)
                ok = await edit_trader_message(chat_id, reply_to_mid, text, reply_markup=kb)
                logger.info("[Tracking] alert edited with full buyer history: taker=%s trades=%d covered=%s ok=%s",
                            taker_no, len(prior), covered, ok)
                return
            except Exception as _ee:
                logger.warning("[Tracking] in-place edit failed, falling back to follow-up: %s", _ee)
        # Fallback: post a follow-up reply if we couldn't edit (and we found something)
        if lines and matched > start_obs:
            from sqlalchemy import select as _sel
            from app.models.trader import Trader as _Tr
            async with async_session() as db2:
                trader = (await db2.execute(_sel(_Tr).where(_Tr.id == trader_id))).scalar_one_or_none()
            if trader is not None:
                body = [f"📊 <b>Buyer history</b> — {full_nick or 'this buyer'}"]
                for kind, txt in lines:
                    body.append(("⚠ " if kind == "flag" else "• ") + txt)
                await send_trader_message(trader, chr(10).join(body), reply_to=reply_to_mid)
    except Exception as e:
        logger.warning("[Tracking] relationship enrichment failed: %s", e)


async def track_trader(db, trader) -> int:
    """Record this trader's newly-completed Binance orders into the Orders table,
    counting only those created during the current continuous online session."""
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import get_user_order_history, get_order_identity, relay_trader
    from sqlalchemy import text as _cpt_text

    # Route this trader's Binance calls through their own desktop (per_trader mode). Inherited by
    # the background tasks created below; harmless no-op in shared mode.
    relay_trader.set(trader.id)

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

    # Backfill ALL completed Binance orders into the Orders table (not just while-online ones)
    # so profit/volume + cost basis are complete. Self-gated to re-run every ~30 min, so trades
    # made while the bot was off are captured without a restart.
    asyncio.create_task(_backfill_orders(trader.id, api_key, api_secret))

    # One-time gentle backfill of the full counterparty history so every buyer's buy/sell
    # breakdown is available instantly from cache (runs in the background, once per process).
    if trader.id not in _backfill_done and getattr(trader, "telegram_chat_id", None):
        asyncio.create_task(_backfill_counterparties(trader.id, api_key, api_secret))

    inserted = 0
    _cache_budget = _POLL_CACHE_BUDGET
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

        # Incrementally cache this COMPLETED order's counterparty (stable takerUserNo) so the
        # buy/sell relationship history converges to completeness over time — no slow backfill
        # needed at high volume. Bounded per poll to keep the poll fast.
        if status == OrderStatus.COMPLETED and _cache_budget > 0:
            _cache_budget -= 1
            try:
                _idd = await get_order_identity(api_key, api_secret, order_no)
                if _idd.get("taker_user_no"):
                    await db.execute(_cpt_text(
                        "INSERT INTO counterparty_trades (order_number,trader_id,taker_user_no,full_nick,trade_type,total_price,status,created_ms) "
                        "VALUES (:o,:t,:u,:n,:tt,:p,'COMPLETED',:c) ON CONFLICT (order_number) DO NOTHING"
                    ), {"o": str(order_no), "t": trader.id, "u": _idd.get("taker_user_no"),
                        "n": _idd.get("counterparty_nickname"),
                        "tt": (o.get("tradeType") or "").upper(),
                        "p": float(o.get("totalPrice") or 0), "c": ct})
            except Exception:
                pass

    # ── Telegram alert for NEW sell orders (buyer profile via EP-19) ──
    # Fires for sell orders created during this online session that we have not yet
    # alerted on — regardless of order status — so the merchant sees buyer details even
    # before Choice Bank is configured.
    try:
        if getattr(trader, "telegram_chat_id", None) and (getattr(trader, "telegram_notify_scope", "both") or "both") != "buy":
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
                # Avg pay / release time (EP-19, in seconds) -> minutes. Prefer 30-day, fall
                # back to all-time. Pay time = how fast they pay us (matters on our sell orders);
                # release time = how fast they release crypto (matters when we buy from them).
                _apay = prof.get("avgPayTimeOfLatest30day") or prof.get("avgPayTime") or 0
                _arel = prof.get("avgReleaseTimeOfLatest30day") or prof.get("avgReleaseTime") or 0
                _pay_min = (_apay / 60.0) if _apay else None
                _rel_min = (_arel / 60.0) if _arel else None
                try:
                    amt = f"KES {int(float(o.get('totalPrice') or 0)):,}"
                except Exception:
                    amt = f"KES {o.get('totalPrice','?')}"
                _rate_txt = (f"{rate30*100:.2f}%" if rate30 is not None else "N/A")

                # Relationship from our cache (90-day window) — fetched up front so an OLDER
                # relationship (no trade in the last 30 days) is still recognised. Instant; the
                # background seed scan tops it up and edits this same message if needed.
                _rel, _obs, _last_days = [], 0, None
                _need_enrich = False
                if _taker_no:
                    try:
                        _rel, _obs, _last_days = await _relationship_cached(db, trader.id, _taker_no, o, _full_nick, withus)
                    except Exception as _re:
                        logger.warning("[Tracking] counterparty analysis failed: %s", _re)
                        _rel, _obs, _last_days = [], 0, None
                    # Returning buyer whose history we haven't fully reconstructed yet: the
                    # relationship line already shows "(analysing buy/sell…)"; run a deep
                    # background scan that edits the full breakdown into THIS message when ready
                    # (finding sparse trades at high volume can take a couple of minutes).
                    if withus > 0 and _obs < withus and (trader.id, _taker_no) not in _rel_inflight:
                        _need_enrich = True
                # "Traded with you before" reflects 30-day OR any older cached relationship
                if withus:
                    _before = f"Yes ({withus} in 30d)"
                elif _obs > 0:
                    _before = f"Yes (last ~{_last_days}d ago)" if _last_days is not None else "Yes (earlier)"
                else:
                    _before = "No"

                # ── Advisory: assess the buyer against the merchant's own thresholds ──
                def _i(v):
                    try: return int(float(v))
                    except Exception: return None
                thr30  = int(trader.cf_all_trades_min or 0)        # Min Total Trades (30D)
                thrall = int(trader.cf_all_trades_min_all or 0)    # Min Total Trades (All-time)
                _t30, _tall, _regd, _withus = _i(t30), _i(tall), _i(regd), _i(withus) or 0
                _threshold_notes = []
                _account_notes = []
                _base_flags = []   # cautionary (everything except relationship flags)
                # 30-day threshold check
                if thr30 > 0 and _t30 is not None:
                    if _t30 >= thr30:
                        _threshold_notes.append(f"Has surpassed your 30-day minimum of {thr30} ({_t30} trades in the last 30 days)")
                    else:
                        _base_flags.append(f"Below your 30-day minimum of {thr30} (only {_t30} trades)")
                # All-time threshold check
                if thrall > 0 and _tall is not None:
                    if _tall >= thrall:
                        _threshold_notes.append(f"Strong track record — {_tall} lifetime trades (your minimum is {thrall})")
                    else:
                        _base_flags.append(f"Below your all-time minimum of {thrall} ({_tall} lifetime trades)")
                # Repeat-client line is now carried by the relationship section (it states the
                # buy/sell direction). Only fall back to a plain note if we have no counterparty
                # id to analyse with but Binance still reports prior trades.
                _returning_note = None
                if not _taker_no and _withus > 0:
                    _returning_note = f"Returning client — has completed {_withus} trade(s) with you in the last 30 days"
                # Account-age check
                if _regd is not None:
                    if _regd >= 365:
                        _account_notes.append(f"Well-aged account ({_regd} days / ~{_regd//365}y) — established trader")
                    elif _regd >= 90:
                        _account_notes.append(f"Established account ({_regd} days old)")
                    elif _regd < 30:
                        _base_flags.append(f"New account — only {_regd} days old")
                # Completion-rate flag
                if rate30 is not None and rate30 < 0.90:
                    _base_flags.append(f"30-day completion rate is {_rate_txt} — below 90%")
                # Speed flags — slow counterparties waste the merchant's time
                _maxpay = int(trader.cf_max_pay_mins or 0)        # this is a SELL order -> they pay us
                _maxrel = int(trader.cf_max_release_mins or 0)    # how fast they release when they sell
                if _maxpay > 0 and _pay_min and _pay_min > _maxpay:
                    _base_flags.append(f"Slow to pay — averages {_pay_min:.1f} min to pay (your max is {_maxpay} min)")
                if _maxrel > 0 and _rel_min and _rel_min > _maxrel:
                    _base_flags.append(f"Slow to release — averages {_rel_min:.1f} min to release (your max is {_maxrel} min)")

                # Context for rendering — shared by the initial send AND the background edit
                _ctx = {
                    "ono": ono,
                    "header_lines": [
                        f"Amount: {amt}",
                        f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                        f"Rate: {o.get('unitPrice','?')}",
                        f"Buyer: <b>{_full_nick or o.get('counterPartNickName') or 'Unknown'}</b>",
                        f"Order: {ono}",
                    ],
                    "prof_lines": [
                        f"- 30d trades: {_f(t30)}",
                        f"- All-time trades: {_f(tall)}",
                        f"- 30d completion: {_rate_txt}",
                        f"- Avg pay time: {('%.1f min' % _pay_min) if _pay_min else 'N/A'}",
                        f"- Avg release time: {('%.1f min' % _rel_min) if _rel_min else 'N/A'}",
                        f"- Account age: {_f(regd, ' days')}",
                        f"- Traded with you before: {_before}",
                    ],
                    "threshold_notes": _threshold_notes,
                    "returning_note": _returning_note,
                    "account_notes": _account_notes,
                    "base_flags": _base_flags,
                }
                msg, _kb = _render_sell_alert(_ctx, _rel)
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
                # Deep background scan (non-blocking): reconstruct the buyer's full buy/sell
                # history and EDIT this message to replace the "loading…" placeholder.
                if _need_enrich:
                    try:
                        _cur_amt_bg = float(o.get("totalPrice") or 0)
                    except Exception:
                        _cur_amt_bg = 0.0
                    asyncio.create_task(_enrich_counterparty_bg(
                        trader.id, api_key, api_secret, _taker_no, _full_nick,
                        str(ono), _cur_amt_bg, withus, _mid,
                        trader.telegram_chat_id, _ctx,
                    ))
    except Exception as _ne:
        logger.warning("[Tracking] sell-order notify failed: %s", _ne)

    # ── Telegram alert for NEW buy orders (SELLER payment details via EP-13) ──
    # On a buy order WE pay the seller, so show their account/phone/paybill + amount.
    try:
        if getattr(trader, "telegram_chat_id", None) and (getattr(trader, "telegram_notify_scope", "both") or "both") != "sell":
            from sqlalchemy import text as _sql_text2
            from app.services.binance.sapi_client import get_order_payment_details, get_counterparty_statistic
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
                # Seller profile (EP-19) — on a BUY order we pay first then wait for THEM to
                # release, so their avg RELEASE time is the key speed metric to advise on.
                sprof = {}
                try:
                    sprof = await get_counterparty_statistic(api_key, api_secret, ono)
                except Exception:
                    sprof = {}
                def _sf(v, suffix=""):
                    return (f"{v}{suffix}" if v not in (None, "") else "N/A")
                s_t30 = sprof.get("completedOrderNumOfLatest30day")
                s_tall = sprof.get("completedOrderNum")
                s_rate = sprof.get("finishRateLatest30Day")
                s_regd = sprof.get("registerDays")
                s_arel = sprof.get("avgReleaseTimeOfLatest30day") or sprof.get("avgReleaseTime") or 0
                s_apay = sprof.get("avgPayTimeOfLatest30day") or sprof.get("avgPayTime") or 0
                s_rel_min = (s_arel / 60.0) if s_arel else None
                s_pay_min = (s_apay / 60.0) if s_apay else None
                s_rate_txt = (f"{s_rate*100:.2f}%" if s_rate is not None else "N/A")

                _bl = [
                    "<b>New Buy Order — Pay Seller</b>",
                    "",
                    f"Amount to send: {amt}",
                    f"Crypto: {o.get('amount','?')} {o.get('asset','USDT')}",
                    f"Rate: {o.get('unitPrice','?')}",
                    f"Seller: <b>{pay.get('counterparty_nickname') or o.get('counterPartNickName') or 'Unknown'}</b>",
                    f"Order: {ono}",
                    "",
                    "Seller Profile:",
                    f"- 30d trades: {_sf(s_t30)}",
                    f"- All-time trades: {_sf(s_tall)}",
                    f"- 30d completion: {s_rate_txt}",
                    f"- Account age: {_sf(s_regd, ' days')}",
                    f"- Avg release time: {('%.1f min' % s_rel_min) if s_rel_min else 'N/A'}",
                    f"- Avg pay time: {('%.1f min' % s_pay_min) if s_pay_min else 'N/A'}",
                ]
                # Advisory — flag a slow releaser (you'll be waiting on this person)
                _bnotes, _bflags = [], []
                _bmaxrel = int(trader.cf_max_release_mins or 0)
                if _bmaxrel > 0 and s_rel_min and s_rel_min > _bmaxrel:
                    _bflags.append(f"Slow to release — averages {s_rel_min:.1f} min (your max is {_bmaxrel} min); you may wait a while for USDT")
                elif s_rel_min is not None:
                    _bnotes.append(f"Releases in ~{s_rel_min:.1f} min on average")
                if s_rate is not None and s_rate < 0.90:
                    _bflags.append(f"30-day completion rate is {s_rate_txt} — below 90%")
                _bverdict = ("⚠️ <b>Review carefully</b> — some checks need attention" if _bflags
                             else ("✅ <b>Looks good</b>" if _bnotes else "ℹ️ <b>Limited history</b>"))
                _bl += ["", "Advisory:", _bverdict]
                for _n in _bnotes:
                    _bl.append(f"  • {_n}")
                for _fl in _bflags:
                    _bl.append(f"  ⚠ {_fl}")
                _bl += ["", "Pay To:", f"- Method: {pay.get('method') or 'N/A'}"]
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
            _scope = (getattr(trader, "telegram_notify_scope", "both") or "both")
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
                    "SELECT tg_message_id, last_status, status_notified, trade_type FROM sell_order_notifications WHERE order_number = :o"
                ), {"o": str(ono)})).first()
                if not row:
                    continue  # we never alerted on this order — don't announce its outcome
                _mid_orig, _last, _done, _tt = row[0], row[1], row[2], (row[3] or "").upper()
                if _done:
                    continue
                # Keep the relationship cache accurate regardless of notification settings:
                # a freshly COMPLETED order counts toward history; a cancelled one must not.
                await db.execute(_sql_text3(
                    "UPDATE counterparty_trades SET status = :s WHERE order_number = :o"
                ), {"s": _cur, "o": str(ono)})
                # Respect the merchant's notification scope — don't announce the outcome of an
                # order type they've muted (e.g. a BUY order's 'completed' when scope = sell).
                _muted = (_scope == "sell" and _tt == "BUY") or (_scope == "buy" and _tt == "SELL")
                if not _muted:
                    _icon, _label = _TERMINAL[_cur]
                    await _send3(trader, f"{_icon} <b>{_label}</b>\nOrder: {ono}", reply_to=_mid_orig)
                # Mark handled either way so it isn't re-processed every poll.
                await db.execute(_sql_text3(
                    "UPDATE sell_order_notifications SET status_notified = TRUE, last_status = :s WHERE order_number = :o"
                ), {"s": _cur, "o": str(ono)})
                await db.commit()
                # Clear any pending-approval entry (order is resolved)
                try:
                    _pa3.pop(str(ono), None)
                except Exception:
                    pass
                if not _muted:
                    logger.info("[Tracking] order %s status follow-up sent: %s", ono, _cur)
    except Exception as _se:
        logger.warning("[Tracking] status follow-up failed: %s", _se)

    trader.tracking_last_poll_at = now
    await db.commit()
    if inserted:
        logger.info("[Tracking] trader %s recorded %d new while-online orders", trader.id, inserted)
    return inserted


async def tracking_poller():
    """Every 30s: track EVERY trader with a Binance API key — 24/7, regardless of whether their
    app is open. Records completed orders into the central Orders table (so the dashboard reflects
    ALL trading, even trades done while the app was closed) and fires Telegram alerts for new
    orders. Notifications and data no longer depend on the desktop app being online; they run
    server-side from the stored Binance API key + secret."""
    global _poller_boot
    _poller_boot = datetime.now(timezone.utc)
    await asyncio.sleep(10)
    logger.info("[Tracking] poller started (every %ds, 24/7 for all API-key traders)", POLL_INTERVAL_SECS)
    while True:
        try:
            async with async_session() as db:
                # 24/7: poll every trader that has a Binance API key, online or not. The per-trader
                # floor/gap logic in track_trader handles the transition gracefully — a long offline
                # gap just resets the floor to 'now' (so there is no flood of stale-order alerts),
                # and _backfill_orders catches up any completed trades made while the app was closed.
                traders = (await db.execute(
                    select(Trader).where(Trader.binance_api_key.isnot(None))
                )).scalars().all()
                for tr in traders:
                    try:
                        await track_trader(db, tr)
                    except Exception as e:
                        logger.warning("[Tracking] trader %s failed: %s", tr.id, e)
        except Exception as e:
            logger.error("[Tracking] poller error: %s", e)
        await asyncio.sleep(POLL_INTERVAL_SECS)


def compute_pnl(orders, fee_per_usdt=0.25):
    """Centralized P&L from a list of COMPLETED Order rows. Used by merchant + admin
    so both show identical figures. Gross = USDT sold x (avg sell - avg buy);
    fees = fee_per_usdt x USDT sold (flat both-sides Binance fee, ~0.1%/side x 2 ~= 0.25);
    net = gross - fees."""
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
    return _finalize_pnl(b, s, spread, gross, orders, fee_per_usdt)


def _finalize_pnl(b, s, spread, gross, orders, fee_per_usdt=0.25):
    # Binance fee modeled as a flat KES-per-USDT charge on the USDT sold. This is the cumulative
    # both-sides fee (~0.1%/side x 2 ~= 0.25), which correctly captures the buy-leg commission too
    # -- summing only per-order SELL commission previously omitted the buy leg and overstated net.
    fees_kes = round(fee_per_usdt * s["usdt"], 2)
    net = round(gross - fees_kes, 2)
    return {
        "buy": b, "sell": s, "spread": spread,
        "spread_pct": round(spread / b["avg_rate"] * 100, 2) if b["avg_rate"] else 0.0,
        "gross_profit": gross, "fees_kes": fees_kes, "net_profit": net,
        "volume": round(b["kes"] + s["kes"], 2), "trades": b["orders"] + s["orders"],
    }


def compute_pnl_daily(orders, fee_per_usdt=0.25):
    """Per-day realized profit using the merchant's own method:
        net = USDT_sold x (avg_sell_rate - avg_buy_rate - fee_per_usdt)
    Each day stands on its own: gross = revenue from USDT SOLD that day minus what it would cost
    at the day's average buy rate (carried forward on no-buy days); fees = fee_per_usdt x USDT sold
    (flat both-sides Binance fee). Returns {'YYYY-MM-DD': {gross, fees, net, volume, trades}} keyed
    by the trading day (boundary comes from the central source of truth, app.core.trading_day)."""
    from collections import defaultdict
    from app.core.trading_day import trading_day_key
    day = defaultdict(lambda: {"gross": 0.0, "fees": 0.0, "net": 0.0, "volume": 0.0, "trades": 0,
                               "buy_usdt": 0.0, "buy_kes": 0.0, "sell_usdt": 0.0, "sell_kes": 0.0})
    for o in orders:
        u = float(o.crypto_amount or 0)
        k = float(o.fiat_amount or 0)
        dkey = trading_day_key(o.created_at)
        d = day[dkey]
        d["volume"] += k
        d["trades"] += 1
        if o.side == OrderSide.BUY:
            d["buy_usdt"] += u
            d["buy_kes"] += k
        else:
            d["sell_usdt"] += u
            d["sell_kes"] += k
    # Per-day spread profit: each day stands on its own — gross = revenue from the USDT you
    # SOLD that day, minus what that USDT cost you to BUY at the day's average buy rate (carried
    # forward when a day has no buys). This is stable and intuitive (no coupling to ancient
    # history), unlike a global cost-basis replay which made one day's profit depend on months
    # of earlier inventory.
    last_buy_rate = None
    for dk in sorted(day.keys()):
        d = day[dk]
        if d["buy_usdt"] > 0:
            br = d["buy_kes"] / d["buy_usdt"]
            last_buy_rate = br
        elif last_buy_rate is not None:
            br = last_buy_rate
        else:
            br = (d["sell_kes"] / d["sell_usdt"]) if d["sell_usdt"] else 0.0
        gross = d["sell_kes"] - d["sell_usdt"] * br
        fees = fee_per_usdt * d["sell_usdt"]   # flat both-sides Binance fee on USDT sold
        d["gross"] = round(gross, 2)
        d["fees"] = round(fees, 2)
        d["net"] = round(gross - fees, 2)
        d["volume"] = round(d["volume"], 2)
    return dict(day)


def today_realized_pnl(all_orders, fee_per_usdt=0.25):
    """Realized profit for the CURRENT trading day, using the per-day spread method:
    net = USDT_sold x (avg_sell - avg_buy - fee_per_usdt). This is the figure the Profit Tracker
    and dashboard 'Today' show. The trading-day boundary comes from the central source of truth.
    Returns {gross,fees,net,volume,trades} (zeros if no activity today)."""
    from app.core.trading_day import trading_day_key, now_utc
    daily = compute_pnl_daily(all_orders, fee_per_usdt)
    return daily.get(trading_day_key(now_utc()),
                     {"gross": 0.0, "fees": 0.0, "net": 0.0, "volume": 0.0, "trades": 0})
