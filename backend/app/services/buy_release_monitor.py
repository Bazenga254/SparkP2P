"""Buy-order release monitor — SERVER-SIDE, API-driven.

For every BUY order the trader has PAID (status PAYMENT_SENT), this poller asks the
Binance API for the live order status and acts on it — so the desktop NEVER has to
navigate back to the order page to watch for the seller's release:

  * status 4 (completed / released) -> mark the order done + "Buy done" (via
    _complete_buy_order), exactly as the old desktop ghost-detection did.
  * status 5/6 (cancelled / expired) -> reflect that and stop watching.
  * status 2/3 (paid / releasing) and > DELAY_MINUTES old -> nag the trader once.

Runs whether the trader is on desktop or phone (the mobile relay doesn't run the
desktop trading loop). Needs the trader's Binance API key + relay to reach Binance;
if it can't (relay down), it simply retries next tick.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.database import async_session
from app.models.order import Order, OrderSide, OrderStatus
from app.models.trader import Trader

logger = logging.getLogger(__name__)

DELAY_MINUTES = 10          # nag once the seller is this many minutes late releasing
MAX_AGE_MINUTES = 180       # keep watching a paid order for up to 3h, then give up
_CHECK_EVERY = 5            # seconds between scans — fast re-mark/release so a stuck
                            # order doesn't park the queue (orders are paid one-by-one)
_notified: set[int] = set()  # order ids already nagged (in-memory; resets on restart)
_confirmed_marked: set[int] = set()  # order ids Binance has confirmed PAID (st 2/3/4) — stop blind-marking them


async def buy_release_monitor():
    logger.info("[BuyReleaseMonitor] started — API release detection + %d-min nag", DELAY_MINUTES)
    while True:
        try:
            now = datetime.now(timezone.utc)
            floor = now - timedelta(minutes=MAX_AGE_MINUTES)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Order).where(
                        Order.side == OrderSide.BUY,
                        Order.status == OrderStatus.PAYMENT_SENT,
                        Order.payment_sent_at.isnot(None),
                        Order.payment_sent_at >= floor,
                        Order.settled_at.is_(None),
                    )
                )).scalars().all()

                from app.api.routes.extension import _sapi_creds
                from app.services.binance.sapi_client import (
                    get_order_payment_details, mark_order_as_paid, relay_trader,
                )

                # Pre-fetch traders once (many paid orders often share one trader).
                _tids = {o.trader_id for o in rows}
                _traders = {}
                if _tids:
                    _traders = {t.id: t for t in (await db.execute(
                        select(Trader).where(Trader.id.in_(_tids)))).scalars().all()}

                # ── PHASE 1 — probe every paid order's live status CONCURRENTLY ──────────────
                # The relay round-trip is the slow part; doing it serially made many paid orders
                # queue behind each other under load (the exact scenario that lost money). Bounded
                # concurrency keeps the relay from being swamped. On a probe FAILURE we fire an
                # idempotent blind mark-paid right here (also relay, safe to parallelize) — so a
                # relay blip during the check can never leave a paid order unmarked until it expires.
                _sem = asyncio.Semaphore(8)

                async def _probe(o):
                    trader = _traders.get(o.trader_id)
                    if not trader:
                        return (o, None, None)
                    async with _sem:
                        try:
                            _ak, _as = _sapi_creds(trader)
                            relay_trader.set(trader.id)
                            det = await get_order_payment_details(_ak, _as, o.binance_order_number)
                            return (o, trader, str(det.get("order_status") or "").strip())
                        except Exception as _e:
                            logger.debug("[BuyReleaseMonitor] status check failed for %s: %s",
                                         o.binance_order_number, _e)
                            if (o.id not in _confirmed_marked and o.payment_sent_at
                                    and o.payment_sent_at > now - timedelta(minutes=DELAY_MINUTES)):
                                try:
                                    relay_trader.set(trader.id)
                                    await mark_order_as_paid(*_sapi_creds(trader), o.binance_order_number)
                                    logger.warning("[BuyReleaseMonitor] status UNVERIFIABLE for %s — fired blind idempotent mark-paid (safety net)",
                                                   o.binance_order_number)
                                except Exception as _me2:
                                    logger.debug("[BuyReleaseMonitor] blind mark-paid failed for %s: %s — retry next tick",
                                                 o.binance_order_number, _me2)
                            return (o, trader, None)   # None = couldn't verify this tick

                probed = await asyncio.gather(*[_probe(o) for o in rows]) if rows else []

                # ── PHASE 2 — apply results SERIALLY (DB writes + nags use the one session) ──
                for o, trader, st in probed:
                    if not trader or st is None:
                        continue
                    if st == "4":
                        # Seller released — complete it and fire "Buy done".
                        from app.api.routes.extension import _complete_buy_order
                        await _complete_buy_order(o, trader, db, notify=True)
                        _notified.discard(o.id)
                        _confirmed_marked.discard(o.id)
                        logger.info("[BuyReleaseMonitor] order %s RELEASED (status 4) — completed",
                                    o.binance_order_number)
                        continue
                    if st in ("5", "6"):
                        o.status = OrderStatus.CANCELLED if st == "5" else OrderStatus.EXPIRED
                        await db.commit()
                        _notified.discard(o.id)
                        _confirmed_marked.discard(o.id)
                        logger.info("[BuyReleaseMonitor] order %s is now %s (status %s) — stop watching",
                                    o.binance_order_number, o.status.value, st)
                        continue
                    if st == "1":
                        # PAID here but Binance shows PENDING — the mark-paid didn't stick. If we
                        # don't fix it the order EXPIRES and the merchant loses money already sent.
                        # Re-mark PAID now (idempotent) so the seller is asked to release.
                        try:
                            relay_trader.set(trader.id)
                            _mp = await mark_order_as_paid(*_sapi_creds(trader), o.binance_order_number)
                            _ok = _mp.get("code") == "000000" or _mp.get("success") is True
                            logger.warning("[BuyReleaseMonitor] order %s was PAID but Binance showed PENDING — re-marked paid: %s",
                                           o.binance_order_number, "ok" if _ok else _mp)
                            if not _ok:
                                from app.api.routes.telegram import notify_trader
                                await notify_trader(
                                    trader,
                                    f"⚠️ URGENT: you already PAID buy order {o.binance_order_number} but Binance still "
                                    f"shows it UNPAID and we couldn't mark it. Open Binance and tap ‘Transferred / I have paid’ "
                                    f"NOW so the seller releases before the order expires.",
                                    side="buy")
                        except Exception as _me:
                            logger.warning("[BuyReleaseMonitor] re-mark-paid failed for %s: %s — retry next tick", o.binance_order_number, _me)
                        continue
                    if st in ("2", "3"):
                        # Confirmed PAID on Binance, awaiting release — stop blind-marking it.
                        _confirmed_marked.add(o.id)

                    # ── Nag: still awaiting release after DELAY_MINUTES ──
                    if o.payment_sent_at > now - timedelta(minutes=DELAY_MINUTES):
                        continue
                    if o.id in _notified:
                        continue
                    mins = int((now - o.payment_sent_at).total_seconds() // 60)
                    msg = (
                        "⏳ Crypto not released yet" + chr(10) +
                        "You paid KES " + f"{float(o.fiat_amount or 0):,.0f}" +
                        " for buy order " + (o.binance_order_number or "") + " " + str(mins) +
                        " min ago, but the seller has not released your " +
                        (f"{o.crypto_amount} " if o.crypto_amount else "") + (o.crypto_currency or "USDT") + "." + chr(10) +
                        "Open Binance and follow up — appeal the order if the seller keeps delaying."
                    )
                    try:
                        from app.api.routes.telegram import notify_trader
                        await notify_trader(trader, msg, side="buy")
                        _notified.add(o.id)
                        logger.info("[BuyReleaseMonitor] nagged trader %s for buy order %s (%dm unreleased)",
                                    trader.id, o.binance_order_number, mins)
                    except Exception as e:
                        logger.warning("[BuyReleaseMonitor] notify failed for order %s: %s", o.id, e)

                # ── SAFETY NET #2: money already left, order still PENDING/unmarked ──
                # A COMPLETED I&M payout exists but the order never advanced to
                # PAYMENT_SENT — the inline mark-paid path was missed (report slow/failed,
                # order force-completed, or the /result never ran). The PAYMENT_SENT scan
                # above can't see these (they're PENDING). This is the exact case where the
                # merchant has to tap 'Paid' by hand. Guarantee it here, without fail:
                # mark paid on Binance (idempotent), advance the order, and bill it once.
                await _rescue_paid_pending(db, now)
        except Exception as e:
            logger.warning("[BuyReleaseMonitor] loop error: %s", e)
        await asyncio.sleep(_CHECK_EVERY)


async def _rescue_paid_pending(db, now):
    """Mark paid + advance + bill any BUY order whose I&M payout COMPLETED (money sent)
    but which is still PENDING in our DB — the money-sent-but-unmarked gap."""
    from app.models.im_payout import ImPayout
    from app.api.routes.extension import _sapi_creds
    from app.services.binance.sapi_client import get_order_payment_details, mark_order_as_paid, relay_trader

    floor = now - timedelta(minutes=60)   # a paid-but-PENDING order is always very recent
    rows = (await db.execute(
        select(Order).join(
            ImPayout,
            (ImPayout.binance_order_number == Order.binance_order_number)
            & (ImPayout.trader_id == Order.trader_id),
        ).where(
            Order.side == OrderSide.BUY,
            Order.status == OrderStatus.PENDING,
            ImPayout.status == "completed",
            Order.created_at >= floor,
        )
    )).scalars().unique().all()

    for o in rows:
        trader = (await db.execute(select(Trader).where(Trader.id == o.trader_id))).scalar_one_or_none()
        if not trader:
            continue
        try:
            _ak, _as = _sapi_creds(trader)
            relay_trader.set(trader.id)
            det = await get_order_payment_details(_ak, _as, o.binance_order_number)
            st = str(det.get("order_status") or "").strip()
        except Exception as _e:
            logger.debug("[BuyReleaseMonitor] paid-pending check failed for %s: %s", o.binance_order_number, _e)
            continue

        if st in ("5", "6"):
            # Money sent but the order died on Binance — a REAL loss. Reflect + shout.
            o.status = OrderStatus.CANCELLED if st == "5" else OrderStatus.EXPIRED
            await db.commit()
            try:
                from app.api.routes.telegram import notify_trader
                await notify_trader(trader,
                    f"🚨 URGENT: buy order {o.binance_order_number} was PAID (KES {int(o.fiat_amount or 0):,} left your I&M account) "
                    f"but the order {'cancelled' if st == '5' else 'expired'} on Binance. The money may be lost — contact the seller / appeal now.",
                    side="buy")
            except Exception:
                pass
            logger.error("[BuyReleaseMonitor] MONEY-SENT-BUT-%s: order %s KES %s", o.status.value, o.binance_order_number, o.fiat_amount)
            continue

        if st == "1":
            # Unpaid on Binance though the money already left — mark it paid NOW.
            try:
                _mp = await mark_order_as_paid(_ak, _as, o.binance_order_number)
                if not (_mp.get("code") == "000000" or _mp.get("success") is True):
                    logger.warning("[BuyReleaseMonitor] paid-pending mark-paid not ok for %s: %s — retry next tick",
                                   o.binance_order_number, _mp)
                    continue
                logger.warning("[BuyReleaseMonitor] SAFETY: order %s had money sent but was UNPAID on Binance — marked paid",
                               o.binance_order_number)
            except Exception as _me:
                logger.warning("[BuyReleaseMonitor] paid-pending re-mark failed for %s: %s — retry next tick",
                               o.binance_order_number, _me)
                continue
        # st is now "1"(just marked), "2", "3" or "4": the order is paid on Binance.
        # Advance our record + bill it once so it's tracked and the PAYMENT_SENT scan
        # takes over watching for release.
        if not o.payment_sent_at:
            o.payment_sent_at = datetime.now(timezone.utc)
        o.choice_fee = 0
        o.status = OrderStatus.PAYMENT_SENT
        try:
            from app.services.im_billing import record_charge, AlreadyBilled
            from app.services.im_pricing import ACCOUNT_SPARKP2P
            pref = (await db.execute(select(ImPayout).where(
                ImPayout.binance_order_number == o.binance_order_number,
                ImPayout.trader_id == o.trader_id))).scalar_one_or_none()
            await record_charge(db, account_type=ACCOUNT_SPARKP2P, order_id=o.binance_order_number,
                                payout_amount=int(o.fiat_amount or 0), trader_id=o.trader_id,
                                bank_ref=(pref.bank_ref if pref else None))
        except AlreadyBilled:
            pass
        except Exception as _be:
            logger.error("[BuyReleaseMonitor] paid-pending bill failed for %s: %s", o.binance_order_number, _be)
        await db.commit()
        logger.warning("[BuyReleaseMonitor] SAFETY: advanced paid-but-PENDING order %s to PAYMENT_SENT (Binance st=%s)",
                       o.binance_order_number, st)
        if st == "4":
            # Already released (e.g. the merchant marked it manually) — complete it.
            try:
                from app.api.routes.extension import _complete_buy_order
                await _complete_buy_order(o, trader, db, notify=False)
            except Exception as _ce:
                logger.warning("[BuyReleaseMonitor] complete-after-advance failed for %s: %s", o.binance_order_number, _ce)
