"""B2C Automation bot ↔ SparkP2P link.

Mirrors im_bot.py but for the downloadable B2C Automation app (own-Paybill Daraja send/receive).
Credits are the merchant's prepaid B2C credits (`trader.b2c_credits`, the same balance the Own-Paybill
plan uses): the bot polls its balance, consumes one per payout, and tops up via STK. Keys are scoped
`b2c_bot` so the B2C bot's online status never mingles with the I&M bot's.
"""
import logging
import secrets
import time as _time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db, get_client_ip, security
from app.models.trader import Trader
from app.services import api_keys as keysvc
from app.services import credits as creditsvc

router = APIRouter()
logger = logging.getLogger("sparkp2p.b2c_bot")

_SCOPE = "b2c_bot"
ONLINE_WINDOW_S = 180
_HANDOFF_TTL_S = 180
_handoff_codes: dict = {}   # code -> (trader_id, expires_at)


def _prune():
    now = _time.time()
    for c in [c for c, (_, e) in _handoff_codes.items() if e < now]:
        _handoff_codes.pop(c, None)


async def _trader_from_b2c_key(request: Request,
                               cred: HTTPAuthorizationCredentials = Depends(security)) -> int:
    """Authenticate the B2C bot by its long-lived `sp2p_…` key (scope b2c_bot). The key IS the
    identity — the trader is resolved from its hash. No get_db (resolve_key uses its own session)."""
    if not cred:
        raise HTTPException(status_code=401, detail="Not authenticated")
    tid = await keysvc.resolve_key(cred.credentials, scope=_SCOPE, client_ip=get_client_ip(request))
    if tid is None:
        raise HTTPException(status_code=401, detail="Invalid or revoked API key")
    return tid


def _online(row) -> bool:
    if row is None or row.revoked_at is not None:
        return False
    last = keysvc.as_utc(row.last_used_at)
    return last is not None and (datetime.now(timezone.utc) - last).total_seconds() <= ONLINE_WINDOW_S


# ── LAUNCH HANDOFF (browser → app) ────────────────────────────────────────────
@router.post("/handoff")
async def create_handoff(trader: Trader = Depends(get_current_trader)):
    """Mint a one-time code so the desktop app opens already signed in. Requires a live SparkP2P
    session; the code just carries the identity across via the b2c-automation:// deep link."""
    _prune()
    code = secrets.token_urlsafe(24)
    _handoff_codes[code] = (trader.id, _time.time() + _HANDOFF_TTL_S)
    return {"code": code, "deeplink": f"b2c-automation://handoff?code={code}", "expires_in": _HANDOFF_TTL_S}


class HandoffExchange(BaseModel):
    code: str


@router.post("/handoff/exchange")
async def exchange_handoff(data: HandoffExchange, db: AsyncSession = Depends(get_db)):
    """The app exchanges the one-time handoff code for its API key (public, but the code is
    single-use and short-lived)."""
    _prune()
    entry = _handoff_codes.pop(data.code, None)
    if not entry or entry[1] < _time.time():
        raise HTTPException(status_code=401, detail="This launch link has expired. Click Launch again.")
    trader = await db.get(Trader, entry[0])
    if not trader:
        raise HTTPException(status_code=404, detail="Account not found.")
    plaintext, row = await keysvc.create_key(trader.id, name="B2C Automation (launched from SparkP2P)", scope=_SCOPE)
    logger.info("b2c-bot handoff: trader %s launched the app, minted key %s…", trader.id, row.key_prefix)
    return {"ok": True, "api_key": plaintext, "username": trader.full_name or trader.email, "mode": "sparkp2p"}


# ── MERCHANT (browser, JWT) — Settings card + key management ───────────────────
@router.get("/link-status")
async def link_status(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    """What the Settings 'B2C Bot' card shows: is this merchant's B2C bot connected, and its credits."""
    rows = [r for r in await keysvc.list_keys(trader.id) if getattr(r, "scope", "im_bot") == _SCOPE]
    live = [r for r in rows if r.revoked_at is None]
    newest = max((r for r in live if r.last_used_at), key=lambda r: keysvc.as_utc(r.last_used_at), default=None)
    bal = int(getattr(trader, "b2c_credits", 0) or 0)
    return {
        "has_key": len(live) > 0,
        "online": _online(newest),
        "last_seen_at": newest.last_used_at.isoformat() if newest and newest.last_used_at else None,
        "last_seen_ip": newest.last_used_ip if newest else None,
        "on_b2c_plan": bool(getattr(trader, "b2c_own_paybill_enabled", False)),
        "credits": bal,
        "paused_no_credits": bal <= 0,
    }


@router.post("/keys")
async def create_key(trader: Trader = Depends(get_current_trader)):
    """Mint a B2C-bot API key manually (for merchants who connect via key instead of Launch)."""
    plaintext, row = await keysvc.create_key(trader.id, name="B2C Automation", scope=_SCOPE)
    return {"key": plaintext, "shown_once": True, "prefix": row.key_prefix}


# ── BOT-FACING (api-key auth) ─────────────────────────────────────────────────
@router.get("/credits")
async def credits_status(trader_id: int = Depends(_trader_from_b2c_key), db: AsyncSession = Depends(get_db)):
    """Live B2C credit balance for the bot header."""
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Account not found")
    from app.services import im_weekly_plan as _weekly
    rate = await creditsvc.credit_rate_for_trader(db, trader_id)
    bal = int(getattr(trader, "b2c_credits", 0) or 0)
    from app.core.config import settings
    resp = {
        "credits": bal, "rate": rate,
        "unlimited": False,
        "paused_no_credits": bal <= 0,
        "username": trader.full_name or trader.email,
        "on_b2c_plan": bool(getattr(trader, "b2c_own_paybill_enabled", False)),
        # For the bot's "Buy credits" dialog: pay to this paybill with this account ref (manual),
        # or fire an STK from the bot. Credits update automatically once M-Pesa confirms.
        "paybill": settings.SUBSCRIPTION_PAYBILL,
        "account_ref": f"CR{trader_id}",
        "min_deposit": creditsvc.MIN_DEPOSIT_KES,
    }
    # Mirror the SparkP2P dashboard EXACTLY: a merchant on the weekly package shows the
    # weekly plan (Unlimited when active, Expired→renew when lapsed) — NOT on-demand credits.
    # Without this the bot silently fell back to showing the stale b2c_credits balance, so the
    # bot and the dashboard disagreed. On-demand credits only show when NOT on weekly mode.
    if _weekly.on_weekly_mode(trader):
        wk = _weekly.status(trader)
        resp["weekly"] = wk
        resp["unlimited"] = bool(wk["active"])
        resp["paused_no_credits"] = not wk["active"]

    # SUBSCRIPTION GATE — same rule as the I&M bot's poll (im_bot.py). B2C automation is a
    # PAID feature: a linked merchant whose SparkP2P subscription has lapsed is BLOCKED from
    # using the bot (no payouts) until they renew, regardless of any credit/weekly balance.
    # Only reachable with a b2c_bot key (i.e. always a SparkP2P-linked bot), so this never
    # affects a purely standalone install.
    from app.services.enforcement import billing_active
    active = await billing_active(db, trader)
    resp["subscription_active"] = bool(active)
    if not active:
        resp["blocked"] = True
        resp["reason"] = "subscription_expired"
        resp["paused_no_credits"] = True
        resp["unlimited"] = False
    return resp


class ConsumeReq(BaseModel):
    order_ref: str | None = None
    count: int = 1


@router.post("/consume")
async def consume(data: ConsumeReq, trader_id: int = Depends(_trader_from_b2c_key), db: AsyncSession = Depends(get_db)):
    """Decrement b2c_credits after a successful B2C payout (1 credit = 1 payout). Idempotency is the
    bot's responsibility (it only calls this once a Daraja result is final)."""
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Account not found")
    from app.services.enforcement import billing_active
    from app.services import im_weekly_plan as _weekly
    bal = int(getattr(trader, "b2c_credits", 0) or 0)
    # Subscription gate first — a lapsed subscriber is blocked (the bot shouldn't have paid out).
    if not await billing_active(db, trader):
        return {"ok": False, "blocked": True, "reason": "subscription_expired", "credits": bal, "paused_no_credits": True}
    # On the weekly package, payouts are covered by the flat fee — never spend on-demand credits.
    # (Active → unlimited; expired → the bot is paused and shouldn't be paying out at all, but if it
    # does we still must not silently drain the stale b2c_credits balance.)
    if _weekly.on_weekly_mode(trader):
        active = _weekly.on_active_weekly_plan(trader)
        return {"ok": True, "credits": bal, "unlimited": active, "paused_no_credits": not active}
    n = max(1, int(data.count or 1))
    new_bal = max(0, bal - n)
    trader.b2c_credits = new_bal
    await db.commit()
    logger.info("b2c-bot: trader %s consumed %d credit(s) (%d→%d) ref=%s", trader_id, n, bal, new_bal, data.order_ref)
    return {"ok": True, "credits": new_bal, "paused_no_credits": new_bal <= 0}


class BuyCreditsReq(BaseModel):
    amount: int
    phone: str


@router.post("/buy-credits")
async def buy_credits(data: BuyCreditsReq, trader_id: int = Depends(_trader_from_b2c_key), db: AsyncSession = Depends(get_db)):
    """STK-push top-up of b2c_credits from the bot (same flow as the dashboard; callback grants the
    credits idempotently once paid)."""
    from app.services.mpesa.client import mpesa_client, stk_error_message
    from app.models.subscription import CreditPurchase

    amount = int(data.amount or 0)
    if amount < creditsvc.MIN_DEPOSIT_KES:
        raise HTTPException(status_code=400, detail=f"Minimum credit purchase is KES {creditsvc.MIN_DEPOSIT_KES:,}.")
    phone = (data.phone or "").strip()
    if not phone:
        raise HTTPException(status_code=400, detail="An M-Pesa phone number is required.")

    trader = await db.get(Trader, trader_id)
    if not trader or not creditsvc.trader_credits_enabled(trader):
        raise HTTPException(status_code=403, detail="Credits are only for the I&M Bot / Own-Paybill rails.")
    rate = await creditsvc.credit_rate_for_trader(db, trader_id)
    est = creditsvc.credits_for(amount, rate)
    try:
        result = await mpesa_client.stk_push(phone=phone, amount=amount,
                                              account_reference=f"CR{trader_id}", description="B2C Credits")
        checkout_id = result.get("CheckoutRequestID")
    except Exception as e:
        logger.error("b2c-bot buy-credits STK failed for trader %s: %s", trader_id, e)
        raise HTTPException(status_code=502, detail=stk_error_message(e))

    db.add(CreditPurchase(trader_id=trader_id, amount=amount, status="pending",
                          mpesa_checkout_id=checkout_id, credits=est))
    await db.commit()
    logger.info("b2c-bot buy-credits: trader %s STK KES %s -> ~%s credits", trader_id, amount, est)
    return {"status": "pending", "checkout_request_id": checkout_id, "credits": est,
            "message": f"STK of KES {amount:,} sent to {phone}. You'll get ~{est:,} credits once paid."}
