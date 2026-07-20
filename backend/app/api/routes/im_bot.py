"""
I&M Bot — link between SparkP2P and the merchant's own downloadable I&M Bot.

The bot runs on the MERCHANT's machine, logged into THEIR I&M account, on THEIR
IP. SparkP2P never logs into a bank. The bot dials out and polls; nothing is
exposed on the merchant's PC.

Mounted at /api/im-bot (NOT /api/im — that belongs to the older im_bank.py
gateway routes).

  Merchant, from the browser (JWT auth):
    POST   /api/im-bot/keys          mint a key (plaintext shown ONCE)
    GET    /api/im-bot/keys          list this merchant's keys (never the key)
    DELETE /api/im-bot/keys/{id}     revoke
    GET    /api/im-bot/link-status   is my bot online?
  The bot itself (API-key auth):
    GET    /api/im-bot/ping          proves a key works end-to-end
    GET    /api/im-bot/poll          pending BUY orders to pay (leased)
    POST   /api/im-bot/result        report PAID / FAILED / UNKNOWN

BUY ORDERS ONLY. I&M can only send money out, so the bot pays sellers when the
merchant BUYS crypto. Sell orders stay on the Choice Bank gateway.

SAFETY — a buy order = we send fiat, then tell Binance we paid, then the seller
releases crypto, so a wrong answer is expensive both ways. Three independent
guards against paying a seller twice, and one rule against lying about it:
  * The poll only serves a trader whose buy_payout_via_im flag is ON (default
    OFF), so nothing here can touch the existing merchants.
  * A served order is LEASED, so it is not handed out again while in flight.
  * /result moves an order PENDING -> PAYMENT_SENT exactly once; a repeat is a
    no-op. This is the authoritative, persistent guard.
  * PAID marks the order paid. FAILED leaves it PENDING to retry. UNKNOWN (the
    bot could not tell whether money moved) NEVER marks paid — it alerts a human.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_trader_id_from_api_key, get_owner_from_api_key, get_client_ip
from app.api.routes.traders import get_current_trader
from app.core.database import get_db, async_session
from app.models import Trader, Order
from app.models.order import OrderSide, OrderStatus
from app.services import api_keys as keysvc
from app.services import im_bot_lease as lease

logger = logging.getLogger(__name__)
router = APIRouter()

# A bot polls well inside this, so a longer gap means it is not running.
ONLINE_WINDOW_S = 90

# Terminal result words the bot may report. Only PAID transitions the order.
RESULT_PAID = "PAID"
RESULT_FAILED = "FAILED"
RESULT_UNKNOWN = "UNKNOWN"


class CreateKeyRequest(BaseModel):
    name: str | None = None


# ── One-click launch handoff ──────────────────────────────────────────────────
# A merchant already signed into SparkP2P clicks "Launch I&M Bot"; SparkP2P mints
# a short-lived, one-time handoff CODE and opens the desktop app via a deep link.
# The app exchanges the code for its API key and lands signed-in — no second
# login. Same shape as the Google OAuth sid handoff: a code, not a credential.
import secrets, time as _time

_HANDOFF_TTL_S = 120                      # a code is good for two minutes
_handoff_codes: dict[str, tuple[int, float]] = {}  # code -> (trader_id, expires_at)


def _prune_handoffs():
    now = _time.time()
    for c in [c for c, (_, exp) in _handoff_codes.items() if exp < now]:
        _handoff_codes.pop(c, None)


@router.post("/handoff")
async def create_handoff(trader: Trader = Depends(get_current_trader)):
    """Mint a one-time code for launching the desktop app already signed in.
    Requires a live SparkP2P session — the code just carries that identity across
    to the app, it is not itself a credential."""
    _prune_handoffs()
    code = secrets.token_urlsafe(24)
    _handoff_codes[code] = (trader.id, _time.time() + _HANDOFF_TTL_S)
    return {
        "code": code,
        "deeplink": f"im-automation://handoff?code={code}",
        "expires_in": _HANDOFF_TTL_S,
    }


class HandoffExchange(BaseModel):
    code: str


@router.post("/handoff/exchange")
async def exchange_handoff(data: HandoffExchange, db: AsyncSession = Depends(get_db)):
    """The desktop app exchanges the handoff code for its API key. Public (the app
    has no session yet), but the code is one-time and short-lived, so only the app
    that just received the deep link can use it — and only once."""
    _prune_handoffs()
    entry = _handoff_codes.pop(data.code, None)   # one-time: pop on use
    if not entry or entry[1] < _time.time():
        raise HTTPException(status_code=401, detail="This launch link has expired. Click Launch again.")
    trader_id = entry[0]
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Account not found.")
    plaintext, row = await keysvc.create_key(trader_id, name="I&M Automation (launched from SparkP2P)")
    logger.info("im-bot handoff: trader %s launched the app, minted key %s…", trader_id, row.key_prefix)
    return {
        "ok": True,
        "api_key": plaintext,
        "username": trader.full_name or trader.email,
        "mode": "sparkp2p",
    }


def _public(row) -> dict:
    """A key row as the UI may see it — prefix only. The key itself does not
    exist anywhere to return."""
    return {
        "id": row.id,
        "name": row.name,
        "prefix": row.key_prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
        "last_used_ip": row.last_used_ip,
        "revoked": row.revoked_at is not None,
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
    }


def _online(row) -> bool:
    """Online = a live key polled within the window. as_utc() because a naive
    timestamp here would raise inside the status endpoint."""
    if row is None or row.revoked_at is not None:
        return False
    last = keysvc.as_utc(row.last_used_at)
    if last is None:
        return False
    return (datetime.now(timezone.utc) - last).total_seconds() <= ONLINE_WINDOW_S


# ═══════════════════════════════════════════════════════════
# MERCHANT (browser, JWT auth)
# ═══════════════════════════════════════════════════════════

@router.post("/keys")
async def create_api_key(data: CreateKeyRequest, trader: Trader = Depends(get_current_trader)):
    """Mint an API key for this merchant's I&M Bot.

    The plaintext is returned HERE AND ONLY HERE — we store just its hash, so it
    can never be shown again. The UI must make the merchant copy it now.
    """
    plaintext, row = await keysvc.create_key(trader.id, name=data.name)
    logger.info("im-bot: trader %s minted API key %s…", trader.id, row.key_prefix)
    return {
        "key": plaintext,          # ← the only time this ever leaves the server
        "shown_once": True,
        "api_key": _public(row),
    }


@router.get("/keys")
async def list_api_keys(trader: Trader = Depends(get_current_trader)):
    rows = await keysvc.list_keys(trader.id)
    live = [r for r in rows if r.revoked_at is None]
    # "Is my bot online?" = did any live key poll recently. last_used_at is the
    # heartbeat: the bot authenticates on every poll, so last-used IS last-seen.
    # as_utc in the sort key too: comparing a naive against an aware datetime
    # raises, and these rows come straight from the driver.
    newest = max(
        (r for r in live if r.last_used_at), key=lambda r: keysvc.as_utc(r.last_used_at), default=None
    )
    return {
        "keys": [_public(r) for r in rows],
        "online": _online(newest),
        "last_seen_at": newest.last_used_at.isoformat() if newest and newest.last_used_at else None,
    }


@router.delete("/keys/{key_id}")
async def revoke_api_key(key_id: int, trader: Trader = Depends(get_current_trader)):
    """Revoke a key. Takes effect on the bot's next poll — there is no cache to
    outlive it."""
    ok = await keysvc.revoke_key(trader.id, key_id)
    if not ok:
        # Same answer whether the key belongs to someone else or never existed:
        # do not confirm the existence of another merchant's key.
        raise HTTPException(status_code=404, detail="Key not found")
    logger.info("im-bot: trader %s revoked key id=%s", trader.id, key_id)
    return {"ok": True}


@router.get("/link-status")
async def link_status(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    """What the Settings card shows: is this merchant's bot connected?"""
    rows = await keysvc.list_keys(trader.id)
    live = [r for r in rows if r.revoked_at is None]
    # as_utc in the sort key too: comparing a naive against an aware datetime
    # raises, and these rows come straight from the driver.
    newest = max(
        (r for r in live if r.last_used_at), key=lambda r: keysvc.as_utc(r.last_used_at), default=None
    )
    from app.services import credits as creditsvc
    credits_enabled = creditsvc.trader_credits_enabled(trader)
    balance = creditsvc.trader_balance(trader)
    rate = await creditsvc.credit_rate_for_trader(db, trader.id) if credits_enabled else None
    return {
        "has_key": len(live) > 0,
        "online": _online(newest),
        "last_seen_at": newest.last_used_at.isoformat() if newest and newest.last_used_at else None,
        "last_seen_ip": newest.last_used_ip if newest else None,
        "buy_orders_only": True,
        # The ONE rail paying this merchant's BUY orders. Sells always stay on
        # Choice Bank regardless. own_paybill (the B2C plan) is admin-managed —
        # the merchant sees it but can't set it from here.
        "buy_payout_via_im": bool(trader.buy_payout_via_im),
        "on_b2c_plan": bool(getattr(trader, "b2c_own_paybill_enabled", False)),
        "payout_rail": (
            "own_paybill" if getattr(trader, "b2c_own_paybill_enabled", False)
            else "im_bot" if trader.buy_payout_via_im
            else "choice_bank"
        ),
        # Prepaid credits (only on the I&M / own-paybill rails; Choice Bank has none).
        "credits_enabled": credits_enabled,
        "credits": balance,
        "credit_rate": rate,
        "paused_no_credits": bool(credits_enabled and balance <= 0),
    }


class PayoutMethodRequest(BaseModel):
    via_im: bool   # True = pay buy orders via the merchant's own I&M Bot; False = Choice Bank


@router.post("/payout-method")
async def set_payout_method(
    data: PayoutMethodRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """The merchant chooses how their BUY orders are paid out: their own I&M Bot
    or Choice Bank. Sells are unaffected — they always settle on Choice Bank.

    Not allowed while on the B2C own-paybill plan: that rail is part of a paid
    plan and is admin-managed, so a merchant can't silently switch off what
    they're paying for. They're told to contact support.

    Turning I&M ON requires a configured bot (a live key): otherwise buy orders
    would route to a bot that will never poll and sit unpaid forever. Turning it
    OFF (back to Choice Bank) is always allowed — it is the safe default and must
    never be blocked, so a merchant can always fall back if their bot dies.
    """
    if getattr(trader, "b2c_own_paybill_enabled", False):
        raise HTTPException(
            status_code=409,
            detail="Your payout rail is set by your B2C plan (own Paybill). Contact support to change it.",
        )

    if data.via_im:
        live = [r for r in await keysvc.list_keys(trader.id) if r.revoked_at is None]
        if not live:
            raise HTTPException(
                status_code=400,
                detail="Connect your I&M Bot first — buy orders can't route to a bot that isn't set up.",
            )

    trader.buy_payout_via_im = bool(data.via_im)
    # Belt and braces: keep the two rail flags mutually exclusive. (b2c is already
    # False here — the guard above returned otherwise — but never let I&M coexist
    # with own-paybill.)
    if data.via_im:
        trader.b2c_own_paybill_enabled = False
    await db.commit()
    logger.info("im-bot: trader %s set buy payout via_im=%s", trader.id, data.via_im)
    return {"ok": True, "buy_payout_via_im": bool(data.via_im)}


# ═══════════════════════════════════════════════════════════
# THE BOT (API-key auth)
# ═══════════════════════════════════════════════════════════

@router.get("/ping")
async def ping(trader_id: int = Depends(get_trader_id_from_api_key)):
    """The bot's "Test connection". Proves the key resolves to exactly one
    trader, and marks the bot as seen (resolve_key updates last_used_at).

    Returns the trader id so a merchant can confirm the key is linked to the
    account they expect — a key silently linked to the WRONG trader would pay
    another merchant's orders from this merchant's bank account.
    """
    return {"ok": True, "trader_id": trader_id, "buy_orders_only": True}


@router.get("/account")
async def account(
    trader_id: int = Depends(get_trader_id_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """What the merchant's I&M Automation app needs to know about their SparkP2P
    account — so it can stop asking for things SparkP2P already has.

    DELIBERATELY REPORTS STATUS, NEVER CREDENTIALS. traders.py already says it:
    "never expose the key itself". The app's API key is scoped to polling buy
    orders and reporting results; if it could also fetch the merchant's Binance
    SECRET, then a leaked I&M key would hand over their Binance trading
    credentials. The app does not need them — when orders come from SparkP2P it
    never talks to Binance at all.
    """
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    return {
        "trader_id": trader.id,
        "name": trader.full_name,
        "email": trader.email,
        "binance": {
            "saved": bool(trader.binance_api_key),
            "invalid": bool(trader.binance_api_key_invalid),
            # binance_connected covers the browser-session route; either counts.
            "connected": bool(trader.binance_connected or trader.binance_api_key),
            "nickname": getattr(trader, "binance_nickname", None),
        },
        "buy_payout_via_im": bool(trader.buy_payout_via_im),
    }


def _job(order: Order) -> dict:
    """Shape a buy order into a payout job the I&M Bot can act on directly.

    order_id is the Binance order number — the bot uses it as its idempotency
    key (it records it and refuses to pay the same one twice), so it MUST be the
    stable per-order identifier, never a row id.
    """
    # The desktop reports method as 'mpesa' | 'im_bank' | 'other_bank'
    # (see telegram.py request-buy-approval, which is where we learn this).
    method = (order.seller_payment_method or "").lower()
    if method in ("mpesa", "m-pesa", "safaricom", "airtel"):
        rail_method = "M-PESA Kenya (Safaricom)"   # bot detects the telco from the number
        bank = None
    else:
        rail_method = "Bank Transfer"
        # NEVER fall back to the seller's NAME as the bank — that was a real bug
        # here, and the bot rightly refuses to guess a bank (banks.js once
        # resolved "coop bank" to Ecobank). No bank -> the bot fails loudly with
        # BANK_REQUIRED, which is correct: better a visible failure than paying
        # the wrong bank.
        bank = order.seller_payment_bank

    return {
        "order_id": order.binance_order_number,
        "amount": round(order.fiat_amount or 0),   # KES, whole shillings
        "method": rail_method,
        "raw_method": order.seller_payment_method,
        "destination": order.seller_payment_destination,   # phone or account no.
        "name": order.seller_payment_name or order.counterparty_real_name,
        "bank": bank,
        "expected_name": order.seller_payment_name or order.counterparty_real_name,
    }


@router.get("/poll")
async def poll(
    request: Request,
    trader_id: int = Depends(get_trader_id_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """The bot asks for buy orders to pay.

    Short (non-blocking) poll for now — returns the current pending set or an
    empty list. Only serves a trader whose buy_payout_via_im flag is ON, so a
    trader who has not opted in (all existing ones) gets nothing and the desktop
    app keeps paying their buys unchanged.

    Every returned order is LEASED, so a rapid re-poll or a second bot instance
    does not get the same order while a payment is in flight.
    """
    trader = await db.get(Trader, trader_id)
    if not trader or not trader.buy_payout_via_im:
        # Opted out (or unknown): nothing to do. Not an error — the bot just idles.
        return {"jobs": [], "enabled": False}

    # PAUSE AT ZERO CREDITS. A trader on a prepaid rail (I&M / own-paybill) must
    # have a credit for the next payout. At zero we serve NO jobs — the bot idles
    # and new Binance orders are ignored until they top up — rather than pay an
    # order we can't bill. Choice Bank traders never reach here (they can't have
    # buy_payout_via_im and Choice Bank at once).
    from app.services import credits as creditsvc
    if creditsvc.trader_credits_enabled(trader) and creditsvc.trader_balance(trader) <= 0:
        logger.info("im-bot poll: trader %s has 0 credits — paused, no jobs served", trader_id)
        return {"jobs": [], "enabled": True, "paused": True, "reason": "no_credits", "credits": 0}

    rows = (
        await db.execute(
            select(Order).where(
                Order.trader_id == trader_id,
                Order.side == OrderSide.BUY,
                Order.status == OrderStatus.PENDING,
                # Only serve an order we actually know how to pay. The server
                # only learns the seller's destination when the desktop reports
                # it (telegram.py request-buy-approval); until then the bot would
                # just fail the job and re-poll it forever.
                Order.seller_payment_destination.isnot(None),
            ).order_by(Order.created_at.asc())
        )
    ).scalars().all()

    from app.services.ad_automation import is_automated
    jobs = []
    for o in rows:
        # Respect the per-ad config: if this order's ad is set to sell_only/off,
        # don't pay it. No config for the ad -> falls back to the global mode.
        if not await is_automated(db, trader, o.binance_ad_number, "buy"):
            continue
        # Skip anything already in flight to this (or another) bot instance.
        if not lease.try_lease(o.binance_order_number, trader_id):
            continue
        jobs.append(_job(o))

    if jobs:
        logger.info("im-bot poll: served %d job(s) to trader %s", len(jobs), trader_id)
    return {"jobs": jobs, "enabled": True}


class ResultRequest(BaseModel):
    order_id: str                 # Binance order number
    result: str                   # PAID | FAILED | UNKNOWN
    bank_ref: str | None = None   # I&M reference, when there is one
    channel: str | None = None    # MPESA | BANK — rail used, for the fee record
    amount: float | None = None   # what the bot actually paid, for cross-check
    detail: str | None = None     # error text / note


async def _record_im_payout(
    db: AsyncSession,
    trader_id: int,
    order_number: str,
    status: str,
    *,
    amount: int = 0,
    channel: str | None = None,
    bank_ref: str | None = None,
    destination: str | None = None,
    detail: str | None = None,
) -> None:
    """Upsert the Transactions-dashboard ledger row for an I&M payout.

    Best-effort and fully isolated: it commits on its own, and any failure here is
    logged but NEVER raised — a display-ledger hiccup must not fail a real payout
    report (or, worse, make the bot re-pay). One row per (trader, order), so a
    FAILED that later succeeds updates the same line failed -> completed. Kept out
    of the Payment table on purpose — see app/models/im_payout.py.
    """
    from app.models.im_payout import ImPayout
    try:
        row = (
            await db.execute(
                select(ImPayout).where(
                    ImPayout.trader_id == trader_id,
                    ImPayout.binance_order_number == order_number,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            row = ImPayout(trader_id=trader_id, binance_order_number=order_number, status=status)
            db.add(row)
        row.status = status
        if amount:
            row.amount = int(amount)
        if channel:
            row.channel = channel
        if bank_ref:
            row.bank_ref = bank_ref
        if destination:
            row.destination = destination
        row.detail = detail
        row.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except Exception as _e:
        logger.warning("im-bot: could not record payout ledger for %s: %s", order_number, _e)
        try:
            await db.rollback()
        except Exception:
            pass


@router.post("/result")
async def result(
    data: ResultRequest,
    request: Request,
    trader_id: int = Depends(get_trader_id_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """The bot reports the outcome of a payout.

    PAID    -> order becomes PAYMENT_SENT (once), which hands off to the existing
               mark-paid-on-Binance + release + settlement flow untouched.
    FAILED  -> order stays PENDING so it can be retried; merchant is alerted.
    UNKNOWN -> the bot could not tell whether money moved. NEVER marked paid;
               a human is alerted to check the bank before anything is reported
               to Binance. This is the READY/no-ref case we saw live.
    """
    verdict = (data.result or "").upper()
    if verdict not in (RESULT_PAID, RESULT_FAILED, RESULT_UNKNOWN):
        raise HTTPException(status_code=400, detail="result must be PAID, FAILED or UNKNOWN")

    order = (
        await db.execute(
            select(Order).where(
                Order.binance_order_number == data.order_id,
                Order.trader_id == trader_id,
            )
        )
    ).scalar_one_or_none()

    if not order:
        # The lease (if any) is on an order we can't find for this trader — drop it.
        lease.release(data.order_id)
        raise HTTPException(status_code=404, detail="Order not found")

    # The order is resolved either way now — let the lease go so a legitimate
    # future retry (after a FAILED) is not blocked.
    lease.release(data.order_id)

    if verdict == RESULT_PAID:
        # IDEMPOTENT + NON-DOWNGRADING: only PENDING advances. If it is already
        # PAYMENT_SENT/RELEASED/COMPLETED, a duplicate PAID is a no-op — this is
        # the authoritative guard against a double "paid".
        applied = order.status == OrderStatus.PENDING
        if applied:
            order.status = OrderStatus.PAYMENT_SENT
            order.payment_sent_at = datetime.now(timezone.utc)
            try:
                from app.services.outbound_fees import outbound_fee as _outbound_fee
                order.choice_fee = _outbound_fee((data.channel or "MPESA").upper(), order.fiat_amount or 0)
            except Exception as _e:
                logger.warning("im-bot result: fee record failed for %s: %s", data.order_id, _e)

            # Bill this payout, in the SAME transaction as the status advance:
            # either the order is PAYMENT_SENT and on the ledger, or neither. The
            # rate is resolved inside record_charge from the trader's real
            # subscription — never trusted from the bot.
            from app.services.im_billing import record_charge, AlreadyBilled
            from app.services.im_pricing import ACCOUNT_SPARKP2P
            try:
                await record_charge(
                    db,
                    account_type=ACCOUNT_SPARKP2P,
                    order_id=data.order_id,
                    payout_amount=int(order.fiat_amount or 0),
                    trader_id=trader_id,
                    bank_ref=data.bank_ref,
                )
            except AlreadyBilled:
                # The order was PENDING but somehow already billed (e.g. a prior
                # crash between commit and this line on an earlier build). Advance
                # it anyway; do not bill twice.
                logger.info("im-bot result: order %s already billed — advancing without a second charge", data.order_id)
            except Exception as _e:
                # Billing must not lose a payment that already left the bank. If
                # we cannot write the charge, still advance the order (the money
                # moved) and shout — an unbilled payout is a revenue leak a human
                # can reconcile, but a lost release is a lost customer.
                logger.error("im-bot result: FAILED TO BILL paid order %s: %s", data.order_id, _e)
                await _alert(trader_id, f"⚠️ Paid buy order …{data.order_id[-8:]} but could NOT record its I&M charge — admin to reconcile.")

            await db.commit()
            logger.info("im-bot result: order %s PAID (ref=%s) -> PAYMENT_SENT", data.order_id, data.bank_ref)
            await _alert(trader_id, f"✅ I&M Bot paid buy order …{data.order_id[-8:]} — KES {int(order.fiat_amount or 0):,}. Ref {data.bank_ref or 'n/a'}.")
        else:
            # Already advanced by an earlier result — a duplicate PAID is a no-op.
            # 'applied' must reflect what THIS call did, so the bot never reads a
            # duplicate as a fresh success.
            logger.info("im-bot result: duplicate PAID for %s (status=%s) — no-op", data.order_id, order.status)
        # Surface it on the merchant's Transactions dashboard (completed).
        await _record_im_payout(
            db, trader_id, data.order_id, "completed",
            amount=int(order.fiat_amount or 0),
            channel=(data.channel or "MPESA").upper(),
            bank_ref=data.bank_ref,
            destination=order.seller_payment_destination,
        )
        return {"ok": True, "status": order.status.value, "applied": applied, "duplicate": not applied}

    if verdict == RESULT_FAILED:
        # Leave it PENDING so it can be retried. Do NOT touch Binance.
        logger.warning("im-bot result: order %s FAILED — %s", data.order_id, data.detail)
        await _alert(trader_id, f"❌ I&M Bot could not pay buy order …{data.order_id[-8:]}: {data.detail or 'unknown error'}. It will retry.")
        await _record_im_payout(
            db, trader_id, data.order_id, "failed",
            amount=int(order.fiat_amount or 0),
            channel=(data.channel or None),
            detail=data.detail,
            destination=order.seller_payment_destination,
        )
        return {"ok": True, "status": order.status.value, "applied": False}

    # UNKNOWN — the dangerous case. Never mark paid; get a human to check the bank.
    logger.error("im-bot result: order %s UNKNOWN (ref=%s) — human check needed", data.order_id, data.bank_ref)
    await _alert(
        trader_id,
        f"⚠️ I&M Bot is UNSURE whether buy order …{data.order_id[-8:]} was paid "
        f"(KES {int(order.fiat_amount or 0):,}, ref {data.bank_ref or 'none'}). "
        f"NOT marked paid. Check your I&M account before releasing.",
    )
    # Show it as pending on the dashboard — money may or may not have moved.
    await _record_im_payout(
        db, trader_id, data.order_id, "pending",
        amount=int(order.fiat_amount or 0),
        channel=(data.channel or None),
        bank_ref=data.bank_ref,
        detail=data.detail,
        destination=order.seller_payment_destination,
    )
    return {"ok": True, "status": order.status.value, "applied": False, "needs_human": True}


class PayoutReport(BaseModel):
    order_id: str                 # Binance order number the bot paid
    result: str                   # PAID | FAILED | UNKNOWN
    amount: float | None = None   # KES that left the bank (required for PAID)
    bank_ref: str | None = None   # I&M reference, when there is one
    detail: str | None = None


@router.post("/report-payout")
async def report_payout(
    data: PayoutReport,
    owner: tuple = Depends(get_owner_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """A BOT-ONLY account reports a completed payout for billing.

    Bot-only users are not SparkP2P clients: we do not track their Binance orders,
    so there is no order to advance — the report itself is the billable event.
    Only PAID is charged (at KES 12); FAILED/UNKNOWN record nothing, exactly as
    for traders.

    Traders must NOT use this — they bill through /result, which also advances
    their tracked order. A trader key here is refused so a payout is never billed
    twice by a client calling both.
    """
    account_type, owner_id = owner
    from app.services.im_pricing import ACCOUNT_BOT_ONLY, should_bill

    if account_type != ACCOUNT_BOT_ONLY:
        raise HTTPException(
            status_code=403,
            detail="Traders bill through /result. This endpoint is for bot-only accounts.",
        )

    verdict = (data.result or "").upper()
    if verdict not in (RESULT_PAID, RESULT_FAILED, RESULT_UNKNOWN):
        raise HTTPException(status_code=400, detail="result must be PAID, FAILED or UNKNOWN")

    # Only a payout that moved money is billed. FAILED and UNKNOWN are recorded
    # nowhere on the ledger — same rule as traders.
    if not should_bill(verdict):
        logger.info("im-bot report-payout: bot#%s order %s %s — not billed", owner_id, data.order_id, verdict)
        return {"ok": True, "billed": False, "outcome": verdict}

    amount = int(data.amount or 0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="a PAID payout must report a positive amount")

    from app.services.im_billing import record_charge, AlreadyBilled
    try:
        charge = await record_charge(
            db,
            account_type=ACCOUNT_BOT_ONLY,
            order_id=data.order_id,
            payout_amount=amount,
            bot_account_id=owner_id,
            bank_ref=data.bank_ref,
        )
        await db.commit()
    except AlreadyBilled as e:
        # A duplicate report — the payout is already on the ledger. Idempotent:
        # report success with the charge that already exists, bill nothing more.
        logger.info("im-bot report-payout: bot#%s order %s already billed — no-op", owner_id, data.order_id)
        return {"ok": True, "billed": False, "duplicate": True, "rate": e.existing.rate}

    logger.info("im-bot report-payout: bot#%s billed KES %s for order %s", owner_id, charge.rate, data.order_id)
    return {"ok": True, "billed": True, "rate": charge.rate, "outcome": verdict}


@router.get("/credits")
async def credits_status(
    owner: tuple = Depends(get_owner_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """The bot's credits taskbar. Serves BOTH populations by key:
        - a trader key  -> their b2c_credits, priced at their plan rate
        - a bot-only key -> im_bot_accounts.credits, priced at the flat 12
    Returns enough for the bot to show the balance, pause at zero, and open a
    top-up (min deposit, the paybill to pay)."""
    from app.core.config import settings
    from app.services import credits as creditsvc
    account_type, owner_id = owner

    from app.models.subscription import CreditPurchase
    from sqlalchemy import func as _func
    if account_type == pricing_ACCOUNT_BOT_ONLY():
        from app.models.im_bot_account import ImBotAccount
        acct = await db.get(ImBotAccount, owner_id)
        balance = creditsvc.bot_balance(acct) if acct else 0
        rate = creditsvc.credit_rate_bot_only()
        enabled = True
        account_ref = f"CB{owner_id}"   # pay to the paybill with this reference
        deposited = int((await db.execute(
            select(_func.coalesce(_func.sum(CreditPurchase.amount), 0))
            .where(CreditPurchase.bot_account_id == owner_id, CreditPurchase.status == "completed")
        )).scalar_one() or 0)
    else:
        trader = await db.get(Trader, owner_id)
        enabled = bool(trader and creditsvc.trader_credits_enabled(trader))
        balance = creditsvc.trader_balance(trader) if trader else 0
        rate = await creditsvc.credit_rate_for_trader(db, owner_id) if enabled else None
        account_ref = f"CR{owner_id}"
        deposited = int((await db.execute(
            select(_func.coalesce(_func.sum(CreditPurchase.amount), 0))
            .where(CreditPurchase.trader_id == owner_id, CreditPurchase.status == "completed")
        )).scalar_one() or 0)

    return {
        "credits_enabled": enabled,
        "credits": balance,
        "credit_rate": rate,
        "paused_no_credits": bool(enabled and balance <= 0),
        "min_deposit": creditsvc.MIN_DEPOSIT_KES,
        "paybill": settings.SUBSCRIPTION_PAYBILL,
        "account_ref": account_ref,
        "account_type": account_type,
        "deposited": deposited,   # total KES this account has paid to buy credits
    }


def pricing_ACCOUNT_BOT_ONLY():
    from app.services.im_pricing import ACCOUNT_BOT_ONLY
    return ACCOUNT_BOT_ONLY


class BotBuyCreditsRequest(BaseModel):
    amount: int
    phone: str


@router.post("/buy-credits")
async def bot_buy_credits(
    data: BotBuyCreditsRequest,
    owner: tuple = Depends(get_owner_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """STK-push credit top-up FROM THE DESKTOP BOT — authenticated by the API key,
    not a JWT (the bot has no session). Serves both populations: a trader
    (reference CR<id>, plan rate) or a bot-only account (CB<id>, flat 12). The
    STK callback grants the credits idempotently once paid, exactly like the
    dashboard's buy-credits."""
    from app.core.config import settings
    from app.services import credits as creditsvc
    from app.services.mpesa.client import mpesa_client
    from app.models.subscription import CreditPurchase

    account_type, owner_id = owner
    amount = int(data.amount or 0)
    if amount < creditsvc.MIN_DEPOSIT_KES:
        raise HTTPException(status_code=400, detail=f"Minimum credit purchase is KES {creditsvc.MIN_DEPOSIT_KES:,}.")
    phone = (data.phone or "").strip()
    if not phone:
        raise HTTPException(status_code=400, detail="An M-Pesa phone number is required.")

    if account_type == pricing_ACCOUNT_BOT_ONLY():
        rate = creditsvc.credit_rate_bot_only()
        ref = f"CB{owner_id}"
        cp = CreditPurchase(bot_account_id=owner_id, amount=amount, status="pending")
    else:
        trader = await db.get(Trader, owner_id)
        if not trader or not creditsvc.trader_credits_enabled(trader):
            raise HTTPException(status_code=403, detail="Credits are only for the I&M Bot or Own-Paybill rails.")
        rate = await creditsvc.credit_rate_for_trader(db, owner_id)
        ref = f"CR{owner_id}"
        cp = CreditPurchase(trader_id=owner_id, amount=amount, status="pending")

    est = creditsvc.credits_for(amount, rate)
    try:
        result = await mpesa_client.stk_push(
            phone=phone, amount=amount, account_reference=ref, description="I&M Credits",
        )
        checkout_id = result.get("CheckoutRequestID")
    except Exception as e:
        logger.error("im-bot buy-credits STK failed for %s %s: %s", account_type, owner_id, e)
        from app.services.mpesa.client import stk_error_message
        raise HTTPException(status_code=502, detail=stk_error_message(e))

    cp.mpesa_checkout_id = checkout_id
    cp.credits = est
    db.add(cp)
    await db.commit()
    logger.info("im-bot buy-credits: %s %s STK KES %s -> ~%s credits (ref %s)", account_type, owner_id, amount, est, ref)
    return {
        "status": "pending", "checkout_request_id": checkout_id, "credits": est,
        "message": f"STK of KES {amount:,} sent to {phone}. You'll get ~{est:,} credits once paid.",
    }


async def _alert(trader_id: int, text: str) -> None:
    """Telegram alert to the trader; never let a notification failure break the
    result path (the money decision has already been recorded)."""
    try:
        async with async_session() as db:
            trader = await db.get(Trader, trader_id)
        if trader:
            from app.api.routes.telegram import notify_trader
            await notify_trader(trader, text)
    except Exception as _e:
        logger.warning("im-bot alert failed for trader %s: %s", trader_id, _e)
