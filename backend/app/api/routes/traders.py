import json
import logging
import random
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import select, update as sql_update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.security import encrypt_data, decode_access_token, create_access_token
from app.core.trading_day import trading_day_start, trading_day_key, trading_day_date, now_utc, TRADING_DAY_OFFSET_HOURS
from app.models import Trader, SettlementMethod
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.order import Order, OrderStatus
from app.services.binance.client import BinanceP2PClient
from app.services.mpesa.client import mpesa_client
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────

class BinanceConnectRequest(BaseModel):
    cookies: dict  # Browser cookies as {name: value} (legacy)
    cookies_full: Optional[list] = None  # Full cookie objects [{name, value, domain, path, secure, httpOnly, sameSite}, ...]
    csrf_token: str
    bnc_uuid: Optional[str] = None
    totp_secret: Optional[str] = None
    gmail_cookies: Optional[list] = None  # Gmail cookies from desktop app's Chrome browser


class CompleteProfileRequest(BaseModel):
    full_name: str
    phone: str
    otp_code: str


class SendProfileOtpRequest(BaseModel):
    phone: str


class VerificationConfigRequest(BaseModel):
    verify_method: str  # totp, fund_password, manual, none
    totp_secret: Optional[str] = None
    fund_password: Optional[str] = None


class SettlementConfigRequest(BaseModel):
    method: SettlementMethod
    phone: Optional[str] = None          # For M-Pesa
    paybill: Optional[str] = None        # For bank/paybill/till
    account: Optional[str] = None        # Account number
    bank_name: Optional[str] = None
    otp_code: Optional[str] = None       # Required for security verification
    security_answer: Optional[str] = None  # Required for security verification


class RequestSettlementOTP(BaseModel):
    """Request OTP before changing settlement method."""
    pass


class TradingConfigRequest(BaseModel):
    auto_release_enabled: Optional[bool] = None
    auto_pay_enabled: Optional[bool] = None
    daily_trade_limit: Optional[int] = None
    max_single_trade: Optional[int] = None
    batch_settlement_enabled: Optional[bool] = None
    batch_threshold: Optional[int] = None
    bot_trade_mode: Optional[str] = None  # 'both' | 'buy_only' | 'sell_only'
    dd_enabled: Optional[bool] = None
    bot_full_auto: Optional[bool] = None
    dd_min_30d_trades: Optional[int] = None
    dd_min_all_trades: Optional[int] = None
    dd_auto_cancel_new: Optional[bool] = None
    telegram_approval_enabled: Optional[bool] = None
    telegram_notify_scope: Optional[str] = None  # both | sell | buy
    # Counterparty filters (pushed to Binance via EP-7)
    cf_filters_enabled:        Optional[bool]  = None
    cf_completion_rate_min:    Optional[float] = None  # ratio 0.0–1.0
    cf_completion_rate_window: Optional[int]   = None  # 1=Last 30D, 2=All-time
    cf_all_trades_min:         Optional[int]   = None
    cf_trade_count_window:     Optional[int]   = None  # 1=Last 30D, 2=All-time
    cf_completed_trades_min:   Optional[int]   = None
    cf_buy_trades_min:         Optional[int]   = None
    cf_sell_trades_min:        Optional[int]   = None
    cf_volume_min:             Optional[float] = None
    cf_volume_asset:           Optional[str]   = None
    cf_volume_window:          Optional[int]   = None  # 1=Last 30D, 2=All-time
    cf_reg_days_min:           Optional[int]   = None
    cf_all_trades_min_all:     Optional[int]   = None
    cf_max_pay_mins:           Optional[int]   = None
    cf_max_release_mins:       Optional[int]   = None
    binance_fee_per_usdt:      Optional[float] = None


class BinanceApiKeyRequest(BaseModel):
    api_key: str
    api_secret: str
    test_only: bool = False   # verify the key via the relay but don't persist it


class DepositRequest(BaseModel):
    amount: float
    phone: str


class WalletResponse(BaseModel):
    balance: float
    reserved: float
    total_volume: float
    total_withdrawn: float
    total_fees_paid: float
    daily_volume: float
    daily_trades: int
    pending_withdrawal: bool = False
    pending_withdrawal_amount: float = 0.0
    next_sweep_at: str = ""


class TraderProfileResponse(BaseModel):
    id: int
    email: str
    phone: str
    full_name: str
    binance_connected: bool
    binance_username: Optional[str]
    settlement_method: Optional[str]
    settlement_destination: Optional[str]
    settlement_im_account: Optional[str] = None   # masked I&M account (primary)
    settlement_mpesa_phone: Optional[str] = None  # masked M-Pesa phone (fallback)
    auto_release_enabled: bool
    auto_pay_enabled: bool
    daily_trade_limit: int
    max_single_trade: int
    tier: str
    total_trades: int
    total_volume: float
    status: str
    is_admin: bool = False
    role: str = "trader"
    subscription_plan: Optional[str] = None
    subscription_status: Optional[str] = None
    subscription_expires: Optional[str] = None
    onboarding_complete: bool = False
    security_question: Optional[str] = None
    last_extension_sync: Optional[str] = None
    last_web_active: Optional[str] = None
    settlement_cooldown_until: Optional[str] = None  # ISO datetime when cooldown ends
    settlement_first_change_free: bool = False  # True if user has a method but never changed it (first post-onboarding change is free)
    password_change_cooldown_until: Optional[str] = None  # ISO datetime, 48hr after last pw change
    binance_verify_method: Optional[str] = None
    im_connected: bool = False
    gmail_connected: bool = False
    mpesa_portal_connected: bool = False
    has_totp: bool = False
    bot_trade_mode: str = 'both'
    batch_settlement_enabled: bool = True
    batch_threshold: int = 50000
    dd_enabled: bool = False
    bot_full_auto: bool = False
    binance_session_expired: bool = False
    dd_min_30d_trades: int = 20
    dd_min_all_trades: int = 0
    dd_auto_cancel_new: bool = False
    binance_merchant_tier: Optional[str] = None  # 'gold', 'silver', 'bronze'
    binance_api_key_saved: bool = False  # True if API key is stored (never expose the key itself)
    binance_api_key_invalid: bool = False  # True if Binance rejects the stored key
    price_tracker_enabled: bool = False  # admin-gated live competitor price tracker
    b2c_own_paybill_enabled: bool = False  # admin-gated B2C-via-own-paybill (hidden B2C plan + credits)
    buy_payout_via_im: bool = False        # buy orders paid via the standalone I&M Bot — desktop must NOT pay via Choice
    b2c_credits: int = 0                   # remaining B2C payout credits (1 credit = 1 payout = KES 8)
    binance_nickname: Optional[str] = None  # auto-detected Binance P2P nickname (for "your rank")
    binance_p2p_tier: Optional[str] = None  # real detected tier (gold/silver/bronze/normal) — drives badge
    pm_enabled: bool = False
    pm_target_rank: int = 1
    pm_scope: str = "all"
    pm_alert_drop: bool = True
    pm_alert_top1: bool = False
    pm_alert_overtaken: bool = False
    pm_alert_summary: bool = False
    pm_alert_reached: bool = False
    pm_alert_anomaly: bool = False
    pm_alert_watchlist: bool = True
    pm_watchlist: List[str] = []
    pm_autoprice: str = "off"
    pm_margin_min: float = 0.0
    pm_margin_max: float = 0.0
    pm_autoprice_error: Optional[str] = None
    cf_filters_enabled:        bool  = False
    cf_completion_rate_min:    float = 0.0
    cf_completion_rate_window: int   = 2
    cf_all_trades_min:         int   = 0
    cf_trade_count_window:     int   = 2
    cf_completed_trades_min:   int   = 0
    cf_buy_trades_min:         int   = 0
    cf_sell_trades_min:        int   = 0
    cf_volume_min:             float = 0.0
    cf_volume_asset:           str   = 'USDT'
    cf_volume_window:          int   = 2
    cf_reg_days_min:           int   = 0
    cf_all_trades_min_all:     int   = 0
    cf_max_pay_mins:           int   = 0
    cf_max_release_mins:       int   = 0
    binance_fee_per_usdt:      float = 0.25
    cf_last_pushed_at:         Optional[str] = None
    telegram_connected: bool = False
    telegram_approval_enabled: bool = False
    telegram_notify_scope: str = 'both'
    choice_account_id: Optional[str] = None
    choice_account_number: Optional[str] = None
    choice_kyc_status: Optional[str] = None
    choice_paybill: str = "444174"


# In-memory store for settlement-phone OTP verification (normalized phone -> {code, expires_at, trader_id, attempts})
_settle_phone_otps: dict[str, dict] = {}

# In-memory OTP store for Google profile phone verification (phone -> otp)
_profile_otp_codes: dict[str, str] = {}

# In-memory notification store (per trader)
_notifications: dict[int, list] = {}


def add_notification(trader_id: int, title: str, message: str, notif_type: str = "info"):
    """Add a notification for a trader. Called from anywhere in the app."""
    if trader_id not in _notifications:
        _notifications[trader_id] = []
    from datetime import datetime
    _notifications[trader_id].insert(0, {
        "title": title,
        "message": message,
        "type": notif_type,  # payment, release, order, settlement, info
        "time": datetime.now().strftime("%I:%M %p, %b %d"),
        "read": False,
    })
    # Keep only last 50
    _notifications[trader_id] = _notifications[trader_id][:50]


class SendPhoneOtpRequest(BaseModel):
    phone: str


class VerifyPhoneOtpRequest(BaseModel):
    phone: str
    code: str


# ── Routes ────────────────────────────────────────────────────────

# (M-Pesa B2C phone verification removed — replaced by SMS OTP below)


@router.post("/settlement/send-phone-otp")
async def send_settlement_phone_otp(
    data: SendPhoneOtpRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Send a one-time code by SMS to the Safaricom number the trader wants to use for settlement,
    to confirm they own the line. Replaces the old 'send KES 10 and read the M-Pesa name' check —
    name/KYC is now handled at the Choice Bank layer."""
    from app.services.sms import normalize_phone, sms_verification_code

    phone = normalize_phone(data.phone)
    if not phone.startswith("254") or len(phone) != 12:
        raise HTTPException(status_code=400, detail="Enter a valid Safaricom number, e.g. 0712345678.")

    code = str(random.randint(100000, 999999))
    _settle_phone_otps[phone] = {
        "code": code,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        "trader_id": trader.id,
        "attempts": 0,
    }

    sent = sms_verification_code(phone, code)
    if not sent:
        raise HTTPException(status_code=502, detail="Could not send the SMS code. Please try again.")

    logger.info(f"Settlement phone OTP sent to {phone} for trader {trader.id}")
    return {"status": "sent", "message": f"Code sent to ***{phone[-3:]}"}


@router.post("/settlement/verify-phone-otp")
async def verify_settlement_phone_otp(
    data: VerifyPhoneOtpRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Confirm the SMS code for the settlement phone number."""
    from app.services.sms import normalize_phone

    phone = normalize_phone(data.phone)
    rec = _settle_phone_otps.get(phone)
    if not rec or rec.get("trader_id") != trader.id:
        raise HTTPException(status_code=400, detail="No code was sent to this number. Tap “Send code” first.")

    if datetime.now(timezone.utc) > rec["expires_at"]:
        _settle_phone_otps.pop(phone, None)
        raise HTTPException(status_code=400, detail="That code has expired. Tap “Send code” to get a new one.")

    rec["attempts"] = rec.get("attempts", 0) + 1
    if rec["attempts"] > 5:
        _settle_phone_otps.pop(phone, None)
        raise HTTPException(status_code=429, detail="Too many incorrect attempts. Tap “Send code” to get a new one.")

    if data.code.strip() != rec["code"]:
        raise HTTPException(status_code=401, detail="Incorrect code. Please check and try again.")

    _settle_phone_otps.pop(phone, None)
    logger.info(f"Settlement phone {phone} verified by OTP for trader {trader.id}")
    return {"status": "verified"}


# Subscription plan -> which competitor merchant tiers the trader may see the stats for.
# starter (Bronze) -> bronze only; pro (Silver) -> bronze+silver; pro_max (Gold) -> all.
_PLAN_TIER_ACCESS = {"starter": ("bronze",), "pro": ("bronze", "silver"), "pro_max": ("gold", "silver", "bronze")}


def _allowed_merchant_tiers(plan) -> set:
    return set(_PLAN_TIER_ACCESS.get(plan, ("gold", "silver", "bronze")))


async def _active_sub_plan(trader, db=None) -> str | None:
    """The trader's active subscription plan key ('starter'|'pro'|'pro_max'|'advanced') or None.

    Opens its OWN short-lived session when db is None. The price-tracker / market-activity endpoints
    call this and must NOT hold a request-scoped DB connection across their slow get_board() relay
    call — doing so exhausts the connection pool under polling load (QueuePool timeout -> 500s)."""
    from app.models.subscription import Subscription, SubscriptionStatus

    async def _run(_db):
        r = await _db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader.id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            ).order_by(Subscription.expires_at.desc())
        )
        s = r.scalar_one_or_none()
        return s.plan.value if (s and s.is_active) else None

    if db is not None:
        return await _run(db)
    from app.core.database import async_session
    async with async_session() as _db:
        return await _run(_db)


def _nick_tier_from_board(board: dict) -> dict:
    """Map nick -> merchant tier from a live board (both sides)."""
    m = {}
    for side in ("buy", "sell"):
        for r in board.get(side) or []:
            n = r.get("nick")
            if n:
                m[n] = r.get("tier", "normal")
    return m


@router.get("/price-tracker")
async def get_price_tracker(
    asset: str = "USDT",
    fiat: str = "KES",
    trader: Trader = Depends(get_current_trader),
):
    """Live Binance P2P competitor order book (both sides, ranked). Admin-gated per trader."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    from app.services.price_tracker import get_board
    from app.services.binance import relay_router
    try:
        board = await get_board(asset=asset.upper(), fiat=fiat.upper())
        board["relay_connected"] = bool(relay_router.is_connected(trader.id))
        # Per-merchant-tier summary (online count + today's est. volume), gated to the plan.
        try:
            from app.services.market_flow import get_tier_breakdown
            allowed = _allowed_merchant_tiers(await _active_sub_plan(trader))
            bd = get_tier_breakdown(_nick_tier_from_board(board))
            board["tier_stats"] = {
                t: {"online": bd[t]["online"], "vol": bd[t]["traded"], "avail": bd[t]["avail"]}
                for t in ("gold", "silver", "bronze") if t in allowed
            }
            board["allowed_tiers"] = sorted(allowed)
        except Exception as _e:
            logger.warning(f"price-tracker tier stats failed: {_e}")
        return board
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Price tracker fetch failed: {e}")
        raise HTTPException(status_code=502, detail="Could not load live prices right now. Please try again.")


@router.get("/price-tracker/history")
async def get_price_tracker_history(
    hours: float = 6.0,
    trader: Trader = Depends(get_current_trader),
):
    """Recent market snapshots (best ask/bid, medians, liquidity) for the cockpit trend sparklines."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    from app.services.market_history import get_history
    return {"points": get_history(min(max(hours, 0.5), 48))}


@router.get("/market-activity")
async def get_market_activity(
    trader: Trader = Depends(get_current_trader),
):
    """24h market-activity estimate: traded volume (order-book depletion), average maker spread,
    liquidity now, and per-merchant flow. Volume is an ESTIMATE (balances/trades aren't public).

    Per-merchant-tier stats are gated by subscription: Bronze plan sees bronze only, Silver sees
    bronze+silver, Gold sees all. The top-line volume/liquidity/merchant counts reflect only the
    tiers the plan is allowed to see."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    from app.services.market_flow import get_summary, get_tier_breakdown
    from app.services.market_history import get_history
    summary = get_summary()

    pts = get_history(24)
    spreads = [round((p.get("ask_med") or 0) - (p.get("bid_med") or 0), 4) for p in pts if p.get("ask_med") and p.get("bid_med")]
    mids = [((p.get("ask_med") or 0) + (p.get("bid_med") or 0)) / 2 for p in pts if p.get("ask_med") and p.get("bid_med")]
    avg_spread = round(sum(spreads) / len(spreads), 3) if spreads else None
    avg_mid = (sum(mids) / len(mids)) if mids else 0
    spread_pct = round(avg_spread / avg_mid * 100, 3) if (avg_spread and avg_mid) else None
    last = pts[-1] if pts else {}
    summary["avg_spread"] = avg_spread
    summary["spread_pct"] = spread_pct
    summary["min_spread"] = round(min(spreads), 3) if spreads else None
    summary["max_spread"] = round(max(spreads), 3) if spreads else None
    summary["buy_liq_now"] = last.get("buy_liq")
    summary["sell_liq_now"] = last.get("sell_liq")

    # ── Tier tagging + subscription gating ────────────────────────────────────────
    try:
        from app.services.price_tracker import get_board
        board = await get_board(asset="USDT", fiat="KES")
        nick_tier = _nick_tier_from_board(board)
        plan = await _active_sub_plan(trader)
        allowed = _allowed_merchant_tiers(plan)
        full_access = plan in (None, "pro_max")   # Gold plan (or admin/no-plan) sees the whole market
        bd = get_tier_breakdown(nick_tier)

        # Tag each merchant with its tier for the per-tier tabs + badges.
        for m in summary.get("merchants", []):
            m["tier"] = nick_tier.get(m.get("nick"), "normal")

        # Live posted maker spread per merchant = their best sell-ad price minus their best buy-ad
        # price (KES/USDT). Realistic and real-time; shown only when they quote BOTH sides.
        sell_px, buy_px = {}, {}
        for r in (board.get("buy") or []):     # board["buy"] = SELL ads (merchant selling USDT)
            n, p = r.get("nick"), float(r.get("price") or 0)
            if n and p > 0:
                sell_px[n] = p if n not in sell_px else min(sell_px[n], p)
        for r in (board.get("sell") or []):    # board["sell"] = BUY ads (merchant buying USDT)
            n, p = r.get("nick"), float(r.get("price") or 0)
            if n and p > 0:
                buy_px[n] = p if n not in buy_px else max(buy_px[n], p)
        # Net margin = gross posted spread minus the merchant's cumulative Binance fee (both legs),
        # which depends on their Binance merchant tier: Gold 0.25, Silver 0.35, Bronze 0.40 KES/USDT.
        _tier_fee = {"gold": 0.25, "silver": 0.35, "bronze": 0.40}
        for m in summary.get("merchants", []):
            s, b = sell_px.get(m.get("nick")), buy_px.get(m.get("nick"))
            if s and b:
                fee = _tier_fee.get((m.get("tier") or "").lower(), 0.25)
                m["spread"] = round(s - b - fee, 2)
            else:
                m["spread"] = None

        summary["by_tier"] = {t: bd[t] for t in ("gold", "silver", "bronze") if t in allowed}
        summary["allowed_tiers"] = sorted(allowed)

        # Restricted plans: never expose merchants/totals for tiers above the plan. Full-access
        # plans keep the true whole-market totals for the "All merchants" view.
        if not full_access:
            summary["merchants"] = [m for m in summary.get("merchants", []) if m["tier"] in allowed]
            summary["bought_vol"] = sum(bd[t]["bought"] for t in allowed if t in bd)
            summary["sold_vol"] = sum(bd[t]["sold"] for t in allowed if t in bd)
            summary["total_vol"] = summary["bought_vol"] + summary["sold_vol"]
            summary["active_merchants"] = sum(bd[t]["online"] for t in allowed if t in bd)
            summary["buy_liq_now"] = sum(bd[t]["avail"] for t in allowed if t in bd)
    except Exception as _e:
        logger.warning(f"market-activity tier gating failed: {_e}")

    return summary


class PriceMonitorSettings(BaseModel):
    enabled: bool = False
    target_rank: int = 1
    scope: str = "all"          # 'all' | 'tier'
    alert_drop: bool = True
    alert_top1: bool = False
    alert_overtaken: bool = False
    alert_summary: bool = False
    alert_reached: bool = False
    alert_anomaly: bool = False
    alert_watchlist: bool = True
    autoprice: str = "off"      # 'off' | 'sim' | 'live'
    margin_min: float = 0.0     # KES per USDT
    margin_max: float = 0.0     # KES per USDT


@router.put("/price-monitor/settings")
async def save_price_monitor_settings(
    data: PriceMonitorSettings,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Save the merchant's price-monitor rank-alert settings."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    trader.pm_enabled = bool(data.enabled)
    trader.pm_target_rank = max(1, min(int(data.target_rank or 1), 50))
    trader.pm_scope = "tier" if data.scope == "tier" else "all"
    trader.pm_alert_drop = bool(data.alert_drop)
    trader.pm_alert_top1 = bool(data.alert_top1)
    trader.pm_alert_overtaken = bool(data.alert_overtaken)
    trader.pm_alert_summary = bool(data.alert_summary)
    trader.pm_alert_reached = bool(data.alert_reached)
    trader.pm_alert_anomaly = bool(data.alert_anomaly)
    trader.pm_alert_watchlist = bool(data.alert_watchlist)
    trader.pm_autoprice = data.autoprice if data.autoprice in ("off", "sim", "live") else "off"
    trader.pm_margin_min = max(0.0, float(data.margin_min or 0))
    trader.pm_margin_max = max(0.0, float(data.margin_max or 0))
    trader.pm_autoprice_error = None   # clear any prior failure so the bot retries with new settings
    await db.commit()
    return {"status": "saved"}


@router.post("/price-monitor/test")
async def test_price_monitor_alert(
    trader: Trader = Depends(get_current_trader),
):
    """Send a test Telegram message so the merchant can confirm alerts reach their phone."""
    from app.api.routes.telegram import notify_trader
    sent = await notify_trader(trader, "✅ SparkP2P test alert — your Telegram price-tracker notifications are working!")
    if not sent:
        raise HTTPException(status_code=400, detail="Couldn't send — link Telegram first in Settings → Notifications.")
    return {"sent": True}


class WatchlistAction(BaseModel):
    nick: str
    action: str = "add"   # 'add' | 'remove'


@router.post("/price-monitor/watchlist")
async def update_watchlist(
    data: WatchlistAction,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Add/remove a competitor merchant on the trader's price-tracker watchlist (max 25)."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    nick = (data.nick or "").strip()
    if not nick:
        raise HTTPException(status_code=400, detail="Merchant name required.")
    wl = [w for w in (trader.pm_watchlist or []) if w]
    low = nick.lower()
    if data.action == "remove":
        wl = [w for w in wl if w.lower() != low]
    elif any(w.lower() == low for w in wl):
        pass  # already tracked — no-op
    elif len(wl) >= 25:
        raise HTTPException(status_code=400, detail="Watchlist is full (max 25 merchants).")
    else:
        wl.append(nick)
    trader.pm_watchlist = wl
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(trader, "pm_watchlist")
    await db.commit()
    return {"watchlist": wl}


async def _cost_basis_status(trader, db):
    from app.models.order import Order, OrderStatus
    from app.services.cost_basis import status_for
    qry = select(Order).where(Order.trader_id == trader.id, Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]))
    if trader.cb_set_at:
        qry = qry.where(Order.created_at >= trader.cb_set_at)
    orders = (await db.execute(qry)).scalars().all()
    return status_for(trader, orders, min_margin=float(trader.pm_margin_min or 0))


@router.get("/cost-basis")
async def get_cost_basis(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    """Live cost-basis readout: held USDT, weighted-avg cost, phase and sell floor."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    return await _cost_basis_status(trader, db)


class CostBasisSettings(BaseModel):
    enabled: Optional[bool] = None
    starting_stock: Optional[float] = None
    starting_cost: Optional[float] = None
    cleared_buffer: Optional[float] = None


@router.put("/cost-basis")
async def save_cost_basis(data: CostBasisSettings, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    """Enable cost-basis protection and (one-time) set the merchant's current stock + avg cost."""
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(status_code=403, detail="Price Tracker is not enabled for your account.")
    if data.enabled is not None:
        trader.cb_enabled = bool(data.enabled)
    if data.cleared_buffer is not None:
        trader.cb_cleared_buffer = max(0.0, float(data.cleared_buffer))
    # Re-baseline the inventory whenever the merchant (re)enters their stock/cost.
    if data.starting_stock is not None or data.starting_cost is not None:
        trader.cb_starting_stock = max(0.0, float(data.starting_stock or 0))
        trader.cb_starting_cost = max(0.0, float(data.starting_cost or 0))
        trader.cb_set_at = datetime.now(timezone.utc)
    await db.commit()
    return await _cost_basis_status(trader, db)


@router.post("/detect-binance-name")
async def detect_binance_name(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Resolve + cache the merchant's public Binance nickname from their API (needs the relay online).
    Used by the price-tracker 'your rank' view so the merchant doesn't have to type their name."""
    if not trader.binance_api_key:
        raise HTTPException(status_code=400, detail="Connect your Binance API key first.")
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import get_merchant_ads, relay_trader
    from app.services.price_tracker import detect_nickname_from_ads
    relay_trader.set(trader.id)
    try:
        ads = await get_merchant_ads(decrypt_data(trader.binance_api_key), decrypt_data(trader.binance_api_secret))
    except Exception:
        raise HTTPException(status_code=502, detail="Couldn't reach your Binance ads — open the SparkP2P desktop app so your relay is online, then try again.")
    nick, p2p_tier = await detect_nickname_from_ads(ads)
    if not nick:
        raise HTTPException(status_code=404, detail="No live USDT/KES ad found to read your name from. Post an ad on Binance and try again.")
    trader.binance_nickname = nick
    if p2p_tier:
        trader.binance_p2p_tier = p2p_tier
        # Keep the merchant badge in sync with the reliable P2P medal (see save_binance_api_key).
        if p2p_tier in ("gold", "silver", "bronze"):
            trader.binance_merchant_tier = p2p_tier
    await db.commit()
    return {"nickname": nick, "tier": p2p_tier}


@router.post("/suspend-self")
async def suspend_self(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Suspend account after 3 failed settlement verifications."""
    trader.status = TraderStatus.SUSPENDED
    await db.commit()
    logger.warning(f"Trader {trader.id} ({trader.full_name}) self-suspended: 3 failed settlement verifications")
    return {"status": "suspended"}


@router.post("/send-profile-otp")
async def send_profile_otp(
    data: SendProfileOtpRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send OTP to verify phone number during Google profile completion."""
    phone = data.phone.strip().replace(" ", "")
    if phone.startswith("0"):
        phone = "254" + phone[1:]
    if not phone.startswith("254") or len(phone) != 12:
        raise HTTPException(status_code=400, detail="Invalid phone number. Use format 0712345678")

    # Check phone not already taken by another trader
    result = await db.execute(select(Trader).where(Trader.phone == phone))
    existing = result.scalar_one_or_none()
    if existing and existing.id != trader.id:
        raise HTTPException(status_code=400, detail="Phone number already registered to another account")

    otp = str(random.randint(100000, 999999))
    _profile_otp_codes[phone] = otp

    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(phone, otp)
    except Exception as e:
        logger.warning(f"Profile OTP SMS failed for {phone}: {e}")

    masked = f"***{phone[-4:]}"
    logger.info(f"Profile OTP sent to {masked} for trader {trader.id}")
    return {"message": f"OTP sent to {masked}", "phone_hint": masked}


@router.post("/complete-profile")
async def complete_profile(
    data: CompleteProfileRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Google OAuth users must complete their profile with phone + KYC name."""
    if not data.full_name or len(data.full_name) < 3:
        raise HTTPException(status_code=400, detail="Full name is required (minimum 3 characters)")
    if not data.phone or len(data.phone) < 10:
        raise HTTPException(status_code=400, detail="Valid phone number is required")

    # Normalize phone
    phone = data.phone.strip().replace(" ", "")
    if phone.startswith("0"):
        phone = "254" + phone[1:]
    if not phone.startswith("254") or len(phone) != 12:
        raise HTTPException(status_code=400, detail="Invalid phone number format")

    # Verify OTP
    stored_otp = _profile_otp_codes.get(phone)
    if not stored_otp or stored_otp != data.otp_code.strip():
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code")

    # Check phone not already taken by another trader
    result = await db.execute(select(Trader).where(Trader.phone == phone))
    existing = result.scalar_one_or_none()
    if existing and existing.id != trader.id:
        raise HTTPException(status_code=400, detail="Phone number already registered to another account")

    trader.full_name = data.full_name.upper()
    trader.phone = phone
    await db.commit()

    _profile_otp_codes.pop(phone, None)
    logger.info(f"Profile completed for trader {trader.id}: {trader.full_name}, {trader.phone}")
    return {"status": "ok", "full_name": trader.full_name, "phone": trader.phone}


@router.get("/notifications")
async def get_notifications(trader: Trader = Depends(get_current_trader)):
    """Get trader's notifications."""
    return _notifications.get(trader.id, [])


@router.post("/notifications/mark-read")
async def mark_notifications_read(trader: Trader = Depends(get_current_trader)):
    """Mark all notifications as read."""
    for n in _notifications.get(trader.id, []):
        n["read"] = True
    return {"status": "ok"}


@router.post("/web-heartbeat")
async def web_heartbeat(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Lightweight presence ping from an open dashboard (web or desktop app).
    Updates last_web_active so admin 'online' reflects an open dashboard in real time."""
    from datetime import datetime, timezone
    trader.last_web_active = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True}


@router.get("/cf-sync-status")
async def cf_sync_status(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Live check: read the merchant's SELL ad filters from Binance and compare to the
    saved DB value, so the UI can show whether filters are actually in sync with Binance."""
    if not trader.binance_api_key or not trader.binance_api_secret:
        return {"available": False, "reason": "no_api_key"}
    expected = int((trader.cf_all_trades_min_all or 0) if trader.cf_filters_enabled else 0)
    try:
        from app.core.security import decrypt_data
        from app.services.binance.sapi_client import get_merchant_ads, relay_trader
        # Route the EP-4 read through THIS trader's desktop relay (per-trader egress). Without this
        # the call hits the geo-blocked VPS IP directly, Binance returns no ads, and the UI then
        # wrongly reports "out of sync (Binance shows ?)". Mirrors the save/verify endpoints.
        relay_trader.set(trader.id)
        api_key = decrypt_data(trader.binance_api_key)
        api_secret = decrypt_data(trader.binance_api_secret)
        ads = await get_merchant_ads(api_key, api_secret)
    except Exception as e:
        # Relay/bot offline or Binance unreachable — can't confirm
        return {"available": False, "reason": "unreachable", "expected": expected, "detail": str(e)}
    sell_vals = [int(a.get("userAllTradeCountMin") or 0) for a in ads if (a.get("tradeType") or "").upper() == "SELL"]
    # With no live sell ads there is nothing to be out of sync with (filters apply when an ad is
    # posted), so treat an empty result as in-sync rather than flagging a false mismatch.
    synced = all(v == expected for v in sell_vals)
    return {
        "available": True,
        "synced": synced,
        "expected": expected,
        "binance_values": sell_vals,
        "sell_ad_count": len(sell_vals),
    }


@router.get("/profit-breakdown")
async def profit_breakdown(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    # Subscription gate: profit stats are hidden when the plan is expired (locked).
    from app.services.enforcement import subscription_locked
    if await subscription_locked(db, trader):
        return {"locked": True, "reason": "subscription_expired"}
    # P and L for today from the central Orders table (orders tracked while bot online).
    # Centralized: admin reads the same Orders so figures always match.
    from app.models.order import Order, OrderStatus
    from app.services.tracking import compute_pnl, today_realized_pnl
    now = datetime.now(timezone.utc)
    # Trading day boundary from the central source of truth (00:00 UTC = 03:00 EAT).
    today_start = trading_day_start(now)
    # Pull the FULL completed history so today's realized profit is matched against the cost
    # basis of USDT bought on earlier days (else selling old USDT shows 0 gross).
    all_rows = (await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
        )
    )).scalars().all()
    today_rows = [o for o in all_rows if o.created_at and o.created_at >= today_start]
    fee = trader.binance_fee_per_usdt if trader.binance_fee_per_usdt is not None else 0.25
    pnl = compute_pnl(today_rows, fee)            # today's buy/sell cards (volume, avg rates, counts)
    tp = today_realized_pnl(all_rows, fee_per_usdt=fee)   # net = USDT_sold x (margin - fee)
    pnl["gross_profit"] = tp["gross"]
    pnl["fees_kes"] = tp["fees"]

    # Outbound Choice Bank fees the merchant was ACTUALLY charged today: the KES withheld when the
    # bot paid the seller out of their Choice Bank account. Order.choice_fee is set (with the real
    # rail) only for buy orders the bot settled through Choice Bank — orders paid any other way
    # have choice_fee == 0. This is the SAME source the admin "Outbound fees by rail" reads, so the
    # merchant total always matches the admin. Only the total is shown to the merchant.
    from app.models.order import OrderSide as _Side
    choice_bank_fees = sum(
        float(o.choice_fee or 0)
        for o in today_rows
        if o.side == _Side.BUY
    )

    pnl["choice_bank_fees"] = round(choice_bank_fees, 2)
    pnl["net_profit"] = round(tp["net"] - choice_bank_fees, 2)
    return {
        "available": True,
        "date": today_start.strftime("%Y-%m-%d"),
        **pnl,
        "tier": trader.binance_merchant_tier or "bronze",
    }


@router.get("/profit-history")
async def profit_history(
    granularity: str = "day",   # day | week | month
    anchor: str = "",           # any date (YYYY-MM-DD) inside the period to show; default = today (EAT)
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Accumulated profit for ONE period at a time (same cost-basis method as the rest of the app):
    - granularity=day   -> the single day's profit
    - granularity=week  -> Mon–Sun total of the week containing `anchor`
    - granularity=month -> the whole month's total
    Returns the period's accumulated totals + a label + prev/next anchors for ‹ › navigation.
    Nothing is deleted — every past day/week/month stays reachable via navigation."""
    from app.services.enforcement import subscription_locked
    if await subscription_locked(db, trader):
        return {"locked": True, "reason": "subscription_expired"}
    from app.models.order import Order, OrderStatus
    from app.services.tracking import compute_pnl_daily
    from datetime import date as _date
    import calendar as _cal

    rows = (await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
        )
    )).scalars().all()
    _fee = trader.binance_fee_per_usdt if trader.binance_fee_per_usdt is not None else 0.25
    daily = compute_pnl_daily(rows, fee_per_usdt=_fee)   # {'YYYY-MM-DD': {gross,fees,net,volume,trades}} — UTC day

    today = _date.fromisoformat(trading_day_date())   # current trading day (central source)
    try:
        a = _date.fromisoformat(anchor) if anchor else today
    except Exception:
        a = today

    if granularity == "week":
        start = a - timedelta(days=a.weekday())          # Monday
        end = start + timedelta(days=6)                  # Sunday
        label = f"{start.strftime('%b')} {start.day} – {end.strftime('%b')} {end.day}, {end.year}"
        prev_a = (start - timedelta(days=1))
        next_a = (end + timedelta(days=1))
    elif granularity == "month":
        start = a.replace(day=1)
        end = a.replace(day=_cal.monthrange(a.year, a.month)[1])
        label = f"{_cal.month_name[a.month]} {a.year}"
        prev_a = start - timedelta(days=1)               # last day of previous month
        next_a = end + timedelta(days=1)                 # first day of next month
    else:  # day
        start = end = a
        label = f"{a.strftime('%a, %b')} {a.day}, {a.year}"
        prev_a = a - timedelta(days=1)
        next_a = a + timedelta(days=1)

    s_iso, e_iso = start.isoformat(), end.isoformat()
    items = [v for k, v in daily.items() if s_iso <= k <= e_iso]
    g = round(sum(i["gross"] for i in items), 2)
    f = round(sum(i["fees"] for i in items), 2)
    agg = {"gross": g, "fees": f, "net": round(g - f, 2),
           "volume": round(sum(i["volume"] for i in items), 2),
           "trades": sum(i["trades"] for i in items)}

    keys = sorted(daily.keys())
    rng = {"min": keys[0] if keys else None, "max": keys[-1] if keys else None}

    return {
        "granularity": granularity,
        "anchor": a.isoformat(),
        "label": label,
        "start": s_iso, "end": e_iso,
        **agg,
        "prev": prev_a.isoformat(),                       # always navigable back
        "next": next_a.isoformat() if next_a <= today else None,  # no navigating into the future
        "range": rng,
        "is_current": start <= today <= end,
    }


@router.get("/profit-series")
async def profit_series(
    bucket: str = "day",     # day | week | month  — the size of each bar
    start: str = "",         # range start (YYYY-MM-DD); default depends on bucket
    end: str = "",           # range end (YYYY-MM-DD); default today
    asset: str = "",         # filter to one coin (USDT/USDC/BTC…); "" or "ALL" = all coins
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Time-series for the Profit page charts. Returns a list of buckets across [start, end]
    at the chosen granularity, each carrying every metric so the frontend can chart Profit,
    Volume, Spread or Price: {key,label,net,gross,fees,volume,trades,spread,price,buy_rate,
    sell_rate}. Same cost-basis method as everywhere else."""
    from app.services.enforcement import subscription_locked
    if await subscription_locked(db, trader):
        return {"locked": True, "reason": "subscription_expired"}
    from app.models.order import Order, OrderStatus
    from app.services.tracking import compute_pnl_daily
    from datetime import date as _date

    rows = (await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
        )
    )).scalars().all()
    # Coins the trader has actually traded (for the filter dropdown), most-traded first.
    from collections import Counter as _Counter
    _counts = _Counter((o.crypto_currency or "USDT").upper() for o in rows)
    assets = [a for a, _ in _counts.most_common()]
    _sel = (asset or "").upper()
    if _sel and _sel != "ALL":
        rows = [o for o in rows if (o.crypto_currency or "USDT").upper() == _sel]
    _fee = trader.binance_fee_per_usdt if trader.binance_fee_per_usdt is not None else 0.25
    daily = compute_pnl_daily(rows, fee_per_usdt=_fee)

    today = _date.fromisoformat(trading_day_date())   # current trading day (central source)
    try:
        e = _date.fromisoformat(end) if end else today
    except Exception:
        e = today
    try:
        if start:
            s = _date.fromisoformat(start)
        elif bucket == "month":
            s = e.replace(month=1, day=1)                 # whole year
        elif bucket == "week":
            s = (e.replace(day=1)) - timedelta(days=(e.replace(day=1)).weekday())  # ~ this month's weeks
        else:
            s = e.replace(day=1)                          # this month, by day
    except Exception:
        s = e.replace(day=1)

    def metrics(items):
        g = round(sum(i["gross"] for i in items), 2)
        f = round(sum(i["fees"] for i in items), 2)
        bu = sum(i["buy_usdt"] for i in items); bk = sum(i["buy_kes"] for i in items)
        su = sum(i["sell_usdt"] for i in items); sk = sum(i["sell_kes"] for i in items)
        buy_rate = round(bk / bu, 2) if bu else 0.0
        sell_rate = round(sk / su, 2) if su else 0.0
        return {
            "net": round(g - f, 2), "gross": g, "fees": f,
            "volume": round(sum(i["volume"] for i in items), 2),
            "buy_volume": round(bk, 2), "sell_volume": round(sk, 2),
            "trades": sum(i["trades"] for i in items),
            "buy_rate": buy_rate, "sell_rate": sell_rate,
            "spread": round(sell_rate - buy_rate, 2) if (buy_rate and sell_rate) else 0.0,
            "price": sell_rate or buy_rate,
        }

    out = []
    if bucket == "hour":
        # Intraday view for a single day: bucket the selected day's orders by hour and value
        # each hour's sells at the day's average buy rate (intraday buy price barely moves).
        # Bucket hours by the trading-day offset (central source) so the intraday day runs from
        # the same reset boundary as everything else.
        off = timedelta(hours=TRADING_DAY_OFFSET_HOURS)
        day_str = e.isoformat()
        from collections import defaultdict
        hourly = defaultdict(lambda: {"gross": 0.0, "fees": 0.0, "net": 0.0, "volume": 0.0, "trades": 0,
                                      "buy_usdt": 0.0, "buy_kes": 0.0, "sell_usdt": 0.0, "sell_kes": 0.0})
        day_bu = day_bk = 0.0
        for o in rows:
            ts = o.created_at + off
            if ts.strftime("%Y-%m-%d") != day_str:
                continue
            u = float(o.crypto_amount or 0); k = float(o.fiat_amount or 0)
            h = hourly[ts.strftime("%H")]
            h["volume"] += k; h["trades"] += 1
            if (o.side.value if o.side else "") == "buy":
                h["buy_usdt"] += u; h["buy_kes"] += k; day_bu += u; day_bk += k
            else:
                h["sell_usdt"] += u; h["sell_kes"] += k
        day_buy_rate = (day_bk / day_bu) if day_bu else 0.0
        for hh in range(24):
            hk = f"{hh:02d}"
            h = hourly.get(hk)
            if h is None:
                if e == today and hh > (datetime.now(timezone.utc) + off).hour:
                    continue   # don't show future hours of the current day
                items = []
            else:
                gross = h["sell_kes"] - h["sell_usdt"] * day_buy_rate
                h["fees"] = round(_fee * h["sell_usdt"], 2)   # flat both-sides Binance fee on USDT sold
                h["gross"] = round(gross, 2); h["net"] = round(gross - h["fees"], 2)
                items = [h]
            out.append({"key": f"{day_str} {hk}", "label": f"{hk}:00", **metrics(items)})
        return {"bucket": bucket, "start": day_str, "end": day_str, "rows": out,
                "total": metrics(list(hourly.values())),
                "assets": assets, "asset": _sel or "ALL",
                "range": {"min": (sorted(daily)[0] if daily else None), "max": (sorted(daily)[-1] if daily else None)}}
    elif bucket == "month":
        cur = s.replace(day=1)
        while cur <= e:
            mkey = cur.strftime("%Y-%m")
            items = [v for k, v in daily.items() if k[:7] == mkey]
            out.append({"key": mkey, "label": cur.strftime("%b"), **metrics(items)})
            cur = (cur + timedelta(days=32)).replace(day=1)
    elif bucket == "week":
        cur = s - timedelta(days=s.weekday())             # Monday on/before start
        while cur <= e:
            we = cur + timedelta(days=6)
            items = [v for k, v in daily.items() if cur.isoformat() <= k <= we.isoformat()]
            out.append({"key": cur.isoformat(), "label": f"{cur.strftime('%b')} {cur.day}", **metrics(items)})
            cur = cur + timedelta(days=7)
    else:  # day
        cur = s
        while cur <= e:
            k = cur.isoformat()
            items = [daily[k]] if k in daily else []
            out.append({"key": k, "label": f"{cur.strftime('%a')} {cur.day}", **metrics(items)})
            cur = cur + timedelta(days=1)

    keys = sorted(daily.keys())
    return {
        "bucket": bucket,
        "start": s.isoformat(), "end": e.isoformat(),
        "rows": out,
        "total": metrics([v for k, v in daily.items() if s.isoformat() <= k <= e.isoformat()]),
        "assets": assets, "asset": _sel or "ALL",
        "range": {"min": keys[0] if keys else None, "max": keys[-1] if keys else None},
    }


@router.get("/binance-orders")
async def binance_orders(
    limit: int = 20,
    offset: int = 0,
    side: str = "",
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    # Orders tracked while the bot was online, from the central Orders table.
    # side: empty=all, incoming=sell, outgoing=buy. Newest first.
    from app.models.order import Order, OrderSide
    q = select(Order).where(Order.trader_id == trader.id)
    if side == "incoming":
        q = q.where(Order.side == OrderSide.SELL)
    elif side == "outgoing":
        q = q.where(Order.side == OrderSide.BUY)
    q = q.order_by(Order.created_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(q)).scalars().all()
    out = []
    for o in rows:
        out.append({
            "id": o.binance_order_number or o.id,
            "side": o.side.value if o.side else "sell",
            "fiat_amount": float(o.fiat_amount or 0),
            "crypto_amount": float(o.crypto_amount or 0),
            "crypto_currency": o.crypto_currency or "USDT",
            "exchange_rate": float(o.exchange_rate or 0),
            "status": o.status.value if o.status else "",
            "account_reference": o.binance_order_number or o.account_reference,
            "counterparty": o.counterparty_name,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "_binance": True,
        })
    return out


@router.get("/me", response_model=TraderProfileResponse)
async def get_profile(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get current trader's profile."""
    from app.models.subscription import Subscription, SubscriptionStatus

    destination = trader.settlement_phone or trader.settlement_paybill or ""
    if trader.settlement_account:
        destination = f"{destination} Acc: {trader.settlement_account}"

    # Get active subscription info
    sub_plan = None
    sub_status = None
    sub_expires = None
    result = await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.expires_at.desc())
    )
    sub = result.scalar_one_or_none()
    if sub and sub.is_active:
        sub_plan = sub.plan.value
        sub_status = sub.status.value
        sub_expires = sub.expires_at.isoformat() if sub.expires_at else None

    # Compute onboarding status — Binance + settlement + security question + TOTP required
    onboarding_complete = (
        (trader.binance_connected or bool(trader.binance_cookies))
        and trader.settlement_method is not None
        and bool(trader.security_question)
        and bool(trader.totp_secret)
    )

    return TraderProfileResponse(
        id=trader.id,
        email=trader.email,
        phone=trader.phone,
        full_name=trader.full_name,
        binance_connected=bool(trader.binance_connected or trader.binance_api_key),
        binance_username=trader.binance_username,
        settlement_method=trader.settlement_method.value if trader.settlement_method else None,
        settlement_destination=destination,
        settlement_im_account=("***" + trader.settlement_account[-4:]) if trader.settlement_account else None,
        settlement_mpesa_phone=("***" + trader.settlement_phone[-4:]) if trader.settlement_phone else None,
        auto_release_enabled=trader.auto_release_enabled,
        auto_pay_enabled=trader.auto_pay_enabled,
        daily_trade_limit=trader.daily_trade_limit,
        max_single_trade=trader.max_single_trade,
        tier=trader.tier,
        total_trades=trader.total_trades,
        total_volume=trader.total_volume,
        status=trader.status.value,
        is_admin=trader.is_admin,
        role=trader.role or "trader",
        subscription_plan=sub_plan,
        subscription_status=sub_status,
        subscription_expires=sub_expires,
        onboarding_complete=bool(onboarding_complete),
        security_question=trader.security_question,
        last_extension_sync=trader.last_extension_sync.isoformat() if trader.last_extension_sync else None,
        last_web_active=trader.last_web_active.isoformat() if trader.last_web_active else None,
        settlement_cooldown_until=(
            (trader.settlement_changed_at + timedelta(hours=48)).isoformat()
            if trader.settlement_changed_at and
               (trader.settlement_changed_at + timedelta(hours=48)) > datetime.now(timezone.utc)
            else None
        ),
        settlement_first_change_free=(
            bool(trader.settlement_method) and trader.settlement_changed_at is None
        ),
        password_change_cooldown_until=(
            (trader.password_changed_at + timedelta(hours=48)).isoformat()
            if trader.password_changed_at and
               (trader.password_changed_at + timedelta(hours=48)) > datetime.now(timezone.utc)
            else None
        ),
        binance_verify_method=trader.binance_verify_method or "none",
        im_connected=bool(trader.im_connected),
        gmail_connected=bool(trader.gmail_cookies),
        mpesa_portal_connected=bool(trader.mpesa_portal_connected),
        has_totp=bool(trader.totp_secret),
        batch_settlement_enabled=bool(trader.batch_settlement_enabled),
        batch_threshold=trader.batch_threshold or 50000,
        bot_trade_mode=trader.bot_trade_mode or 'both',
        dd_enabled=bool(trader.dd_enabled),
        bot_full_auto=bool(trader.bot_full_auto),
        binance_session_expired=bool(trader.binance_session_expired),
        dd_min_30d_trades=trader.dd_min_30d_trades or 20,
        dd_min_all_trades=trader.dd_min_all_trades or 0,
        dd_auto_cancel_new=bool(trader.dd_auto_cancel_new),
        binance_merchant_tier=trader.binance_merchant_tier or 'bronze',
        binance_api_key_saved=bool(trader.binance_api_key),
        price_tracker_enabled=bool(getattr(trader, "price_tracker_enabled", False)),
        b2c_own_paybill_enabled=bool(getattr(trader, "b2c_own_paybill_enabled", False)),
        buy_payout_via_im=bool(getattr(trader, "buy_payout_via_im", False)),
        b2c_credits=int(getattr(trader, "b2c_credits", 0) or 0),
        binance_nickname=getattr(trader, "binance_nickname", None),
        binance_p2p_tier=getattr(trader, "binance_p2p_tier", None),
        pm_enabled=bool(getattr(trader, "pm_enabled", False)),
        pm_target_rank=int(getattr(trader, "pm_target_rank", 1) or 1),
        pm_scope=getattr(trader, "pm_scope", "all") or "all",
        pm_alert_drop=bool(getattr(trader, "pm_alert_drop", True)),
        pm_alert_top1=bool(getattr(trader, "pm_alert_top1", False)),
        pm_alert_overtaken=bool(getattr(trader, "pm_alert_overtaken", False)),
        pm_alert_summary=bool(getattr(trader, "pm_alert_summary", False)),
        pm_alert_reached=bool(getattr(trader, "pm_alert_reached", False)),
        pm_alert_anomaly=bool(getattr(trader, "pm_alert_anomaly", False)),
        pm_alert_watchlist=bool(getattr(trader, "pm_alert_watchlist", True)),
        pm_watchlist=list(getattr(trader, "pm_watchlist", None) or []),
        pm_autoprice=getattr(trader, "pm_autoprice", "off") or "off",
        pm_margin_min=float(getattr(trader, "pm_margin_min", 0.0) or 0.0),
        pm_margin_max=float(getattr(trader, "pm_margin_max", 0.0) or 0.0),
        pm_autoprice_error=getattr(trader, "pm_autoprice_error", None),
        binance_api_key_invalid=bool(trader.binance_api_key_invalid),
        cf_filters_enabled=bool(trader.cf_filters_enabled),
        cf_completion_rate_min=trader.cf_completion_rate_min or 0.0,
        cf_completion_rate_window=trader.cf_completion_rate_window or 2,
        cf_all_trades_min=trader.cf_all_trades_min or 0,
        cf_trade_count_window=trader.cf_trade_count_window or 2,
        cf_completed_trades_min=trader.cf_completed_trades_min or 0,
        cf_buy_trades_min=trader.cf_buy_trades_min or 0,
        cf_sell_trades_min=trader.cf_sell_trades_min or 0,
        cf_volume_min=trader.cf_volume_min or 0.0,
        cf_volume_asset=trader.cf_volume_asset or 'USDT',
        cf_volume_window=trader.cf_volume_window or 2,
        cf_reg_days_min=trader.cf_reg_days_min or 0,
        cf_all_trades_min_all=trader.cf_all_trades_min_all or 0,
        cf_max_pay_mins=trader.cf_max_pay_mins or 0,
        cf_max_release_mins=trader.cf_max_release_mins or 0,
        binance_fee_per_usdt=trader.binance_fee_per_usdt if trader.binance_fee_per_usdt is not None else 0.25,
        cf_last_pushed_at=trader.cf_last_pushed_at.isoformat() if trader.cf_last_pushed_at else None,
        telegram_connected=bool(trader.telegram_chat_id),
        telegram_approval_enabled=bool(trader.telegram_approval_enabled),
        telegram_notify_scope=trader.telegram_notify_scope or 'both',
        choice_account_id=trader.choice_account_id or None,
        choice_account_number=trader.choice_account_number or None,
        choice_kyc_status=trader.choice_kyc_status or None,
        choice_paybill=settings.CHOICE_BANK_PAYBILL,
    )


@router.post("/connect-binance")
async def connect_binance(
    data: BinanceConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Connect Binance account by providing session cookies.
    Fetches user profile from Binance and verifies name match.
    """
    # Test the session
    client = BinanceP2PClient.from_raw(
        cookies=data.cookies,
        csrf_token=data.csrf_token,
        bnc_uuid=data.bnc_uuid or "",
        totp_secret=data.totp_secret,
    )
    is_valid = await client.check_session()

    # If validation fails, still save but warn
    # Some Binance sessions need specific headers that our check doesn't include
    if not is_valid:
        logger.warning(f"Binance session validation failed for trader {trader.id}, saving cookies anyway")

    # Fetch Binance profile to get verified name
    binance_profile = {}
    try:
        binance_profile = await client.get_user_profile()
    except Exception as e:
        logger.warning(f"Could not fetch Binance profile: {e}")

    binance_name = binance_profile.get("verified_name", "")

    # Check if name matches
    name_match = False
    if binance_name:
        # Compare case-insensitive
        name_match = trader.full_name.strip().upper() == binance_name.strip().upper()

    # Encrypt and store credentials
    trader.binance_cookies = encrypt_data(json.dumps(data.cookies))
    trader.binance_csrf_token = encrypt_data(data.csrf_token)
    trader.binance_session_expired = False   # fresh login — clear the reconnect banner
    if data.bnc_uuid:
        trader.binance_bnc_uuid = encrypt_data(data.bnc_uuid)
    if data.totp_secret:
        trader.binance_2fa_secret = encrypt_data(data.totp_secret)

    # Store full cookie objects for Playwright (with domain, path, secure, httpOnly, sameSite)
    if data.cookies_full:
        trader.binance_cookies_full = encrypt_data(json.dumps(data.cookies_full))
        logger.info(f"Stored {len(data.cookies_full)} full cookies for trader {trader.id}")

    # Save Gmail cookies when desktop app captures them (Gmail tab open alongside Binance)
    if data.gmail_cookies and len(data.gmail_cookies) > 0:
        trader.gmail_cookies = encrypt_data(json.dumps(data.gmail_cookies))
        logger.info(f"Gmail session synced: {len(data.gmail_cookies)} cookies for trader {trader.id}")

    # Mark as connected whenever cookies are saved
    if data.cookies_full or data.cookies:
        trader.binance_connected = True
    if binance_name:
        trader.binance_username = binance_name

    await db.commit()

    cookie_count = len(data.cookies_full) if data.cookies_full else len(data.cookies)
    return {
        "status": "cookies_stored",
        "message": "Cookies stored. Use Connect Binance to verify login.",
        "binance_name": binance_name,
        "registered_name": trader.full_name,
        "name_match": name_match,
        "cookies_received": cookie_count,
    }


@router.post("/update-name")
async def update_name_from_binance(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trader's name to match their Binance verified name."""
    if not trader.binance_username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No Binance name found. Connect Binance first.",
        )

    trader.full_name = trader.binance_username
    await db.commit()

    return {
        "status": "updated",
        "full_name": trader.full_name,
    }


@router.put("/verification")
async def update_verification(
    data: VerificationConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Configure how releases are verified on Binance."""
    if data.verify_method not in ("totp", "fund_password", "manual", "none"):
        raise HTTPException(status_code=400, detail="Invalid verification method")

    trader.binance_verify_method = data.verify_method

    if data.verify_method == "totp" and data.totp_secret:
        trader.binance_2fa_secret = encrypt_data(data.totp_secret)
    elif data.verify_method == "fund_password" and data.fund_password:
        trader.binance_fund_password = encrypt_data(data.fund_password)

    await db.commit()

    return {"status": "updated", "verify_method": data.verify_method}


@router.post("/settlement/request-otp")
async def request_settlement_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone before allowing settlement change."""
    import random
    from app.api.routes.auth import _login_otp_codes

    # Block if still in 48hr cooldown
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            hours_left = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)
            raise HTTPException(
                status_code=400,
                detail=f"You cannot change your payment method again for {hours_left} hours.",
            )

    otp_code = str(random.randint(100000, 999999))
    _login_otp_codes[f"settle_{trader.email}"] = otp_code

    # Send via SMS only (not email)
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception:
        pass

    return {
        "message": f"OTP sent to ***{trader.phone[-4:]}",
        "security_question": trader.security_question or "What is your mother's maiden name?",
    }


@router.put("/settlement")
async def update_settlement(
    data: SettlementConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update settlement configuration.
    Requires OTP + security answer for verification.
    New method has 48-hour cooldown before it can be used.
    """
    from app.api.routes.auth import _login_otp_codes
    from app.core.security import verify_password
    from datetime import datetime, timezone

    # Determine which specific field is being updated (targeted dual-method logic)
    updating_im = data.method == SettlementMethod.BANK_PAYBILL and data.account
    updating_mpesa = data.method == SettlementMethod.MPESA and data.phone

    # First-time check is per-method: first time setting THIS specific method is free
    if updating_im:
        is_truly_first_time = not trader.settlement_account
    elif updating_mpesa:
        is_truly_first_time = not trader.settlement_phone
    else:
        # Legacy (till/paybill): check both
        is_truly_first_time = not trader.settlement_phone and not trader.settlement_paybill

    # Free first change: settlement exists but was set during onboarding and never changed via Settings
    is_free_first_change = not is_truly_first_time and trader.settlement_changed_at is None
    is_first_time = is_truly_first_time or is_free_first_change

    if not is_first_time:
        # Verify OTP
        if not data.otp_code:
            raise HTTPException(status_code=400, detail="OTP code is required to change payment method")

        stored_otp = _login_otp_codes.get(f"settle_{trader.email}")
        if not stored_otp or stored_otp != data.otp_code:
            raise HTTPException(status_code=401, detail="Invalid or expired OTP code")

        # Verify security answer
        if not data.security_answer:
            raise HTTPException(status_code=400, detail="Security answer is required")

        if trader.security_answer_hash:
            if not verify_password(data.security_answer.strip().lower(), trader.security_answer_hash):
                raise HTTPException(status_code=401, detail="Incorrect security answer")

        # Clear OTP
        _login_otp_codes.pop(f"settle_{trader.email}", None)

    # Save as PENDING — only update the fields relevant to the method being changed.
    # This preserves the OTHER method's configuration (dual-method: I&M primary + M-Pesa fallback).
    if updating_im:
        # Only the I&M account is changing — don't touch M-Pesa phone
        trader.pending_settlement_method = "im_update"
        trader.pending_settlement_account = data.account
        trader.pending_settlement_paybill = "542542"
        trader.pending_settlement_bank_name = "I&M"
        trader.pending_settlement_phone = None  # not changing phone
    elif updating_mpesa:
        # Only the M-Pesa phone is changing — don't touch I&M account
        trader.pending_settlement_method = "mpesa_update"
        trader.pending_settlement_phone = data.phone
        trader.pending_settlement_account = None  # not changing account
        trader.pending_settlement_paybill = None
        trader.pending_settlement_bank_name = None
    else:
        # Legacy full-replacement (till / custom paybill)
        trader.pending_settlement_method = data.method.value
        trader.pending_settlement_phone = data.phone
        trader.pending_settlement_paybill = data.paybill
        trader.pending_settlement_account = data.account
        trader.pending_settlement_bank_name = data.bank_name

    trader.settlement_changed_at = datetime.now(timezone.utc)

    # If first-time (truly new or free first post-onboarding change), activate immediately
    if is_first_time:
        if updating_im:
            trader.settlement_account = data.account
            trader.settlement_paybill = "542542"
            trader.settlement_bank_name = "I&M"
            # I&M is primary method when both are present or when only I&M
            trader.settlement_method = SettlementMethod.BANK_PAYBILL
        elif updating_mpesa:
            trader.settlement_phone = data.phone
            # Set method: I&M primary if account already set, else M-Pesa
            if not trader.settlement_account:
                trader.settlement_method = SettlementMethod.MPESA
        else:
            trader.settlement_method = data.method
            trader.settlement_phone = data.phone
            trader.settlement_paybill = data.paybill
            trader.settlement_account = data.account
            trader.settlement_bank_name = data.bank_name
        trader.pending_settlement_method = None
        if is_truly_first_time:
            # No previous settlement — keep changed_at=None so first post-onboarding change is also free
            trader.settlement_changed_at = None
        else:
            # Free first change used — backdated so no active cooldown, but future changes need OTP
            trader.settlement_changed_at = datetime.now(timezone.utc) - timedelta(hours=72)

    await db.commit()

    # Send email notification
    from app.services.email import send_payment_method_added
    method_display = {
        "mpesa": "M-Pesa",
        "bank_paybill": f"Bank ({data.bank_name or 'Paybill'})",
        "till": "Till Number",
        "paybill": "Paybill",
    }.get(data.method.value, data.method.value)
    destination = data.phone or data.paybill or ""
    if data.account:
        destination = f"{destination} Acc: {data.account}"
    send_payment_method_added(trader.email, trader.full_name, method_display, destination)

    if trader.pending_settlement_method:
        return {
            "status": "pending",
            "method": data.method.value,
            "cooldown_until": (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
            "message": "New payment method saved. Your current method will remain active for 48 hours. You'll receive an email when the new method is ready.",
        }
    else:
        return {
            "status": "updated",
            "method": data.method.value,
            "message": "Payment method set successfully.",
        }


@router.put("/trading-config")
async def update_trading_config(
    data: TradingConfigRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trading configuration."""
    if data.auto_release_enabled is not None:
        trader.auto_release_enabled = data.auto_release_enabled
    if data.auto_pay_enabled is not None:
        trader.auto_pay_enabled = data.auto_pay_enabled
    if data.daily_trade_limit is not None:
        trader.daily_trade_limit = data.daily_trade_limit
    if data.max_single_trade is not None:
        trader.max_single_trade = data.max_single_trade
    if data.batch_settlement_enabled is not None:
        trader.batch_settlement_enabled = data.batch_settlement_enabled
    if data.batch_threshold is not None:
        trader.batch_threshold = data.batch_threshold
    if data.bot_trade_mode is not None and data.bot_trade_mode in ('both', 'buy_only', 'sell_only'):
        trader.bot_trade_mode = data.bot_trade_mode
    if data.dd_enabled is not None:
        trader.dd_enabled = data.dd_enabled
    if data.bot_full_auto is not None:
        trader.bot_full_auto = data.bot_full_auto
    if data.dd_min_30d_trades is not None:
        trader.dd_min_30d_trades = data.dd_min_30d_trades
    if data.dd_min_all_trades is not None:
        trader.dd_min_all_trades = data.dd_min_all_trades
    if data.dd_auto_cancel_new is not None:
        trader.dd_auto_cancel_new = data.dd_auto_cancel_new
    if data.telegram_approval_enabled is not None:
        trader.telegram_approval_enabled = data.telegram_approval_enabled
    if data.telegram_notify_scope in ('both', 'sell', 'buy'):
        trader.telegram_notify_scope = data.telegram_notify_scope

    # Counterparty filters
    cf_changed = False
    if data.cf_filters_enabled is not None:
        trader.cf_filters_enabled = data.cf_filters_enabled
        cf_changed = True
    if data.cf_completion_rate_min is not None:
        trader.cf_completion_rate_min = data.cf_completion_rate_min
        cf_changed = True
    if data.cf_completion_rate_window is not None:
        trader.cf_completion_rate_window = data.cf_completion_rate_window
        cf_changed = True
    if data.cf_all_trades_min is not None:
        trader.cf_all_trades_min = data.cf_all_trades_min
        cf_changed = True
    if data.cf_trade_count_window is not None:
        trader.cf_trade_count_window = data.cf_trade_count_window
        cf_changed = True
    if data.cf_completed_trades_min is not None:
        trader.cf_completed_trades_min = data.cf_completed_trades_min
        cf_changed = True
    if data.cf_buy_trades_min is not None:
        trader.cf_buy_trades_min = data.cf_buy_trades_min
        cf_changed = True
    if data.cf_sell_trades_min is not None:
        trader.cf_sell_trades_min = data.cf_sell_trades_min
        cf_changed = True
    if data.cf_volume_min is not None:
        trader.cf_volume_min = data.cf_volume_min
        cf_changed = True
    if data.cf_volume_asset is not None:
        trader.cf_volume_asset = data.cf_volume_asset
        cf_changed = True
    if data.cf_volume_window is not None:
        trader.cf_volume_window = data.cf_volume_window
        cf_changed = True
    if data.cf_reg_days_min is not None:
        trader.cf_reg_days_min = data.cf_reg_days_min
        cf_changed = True
    if data.cf_all_trades_min_all is not None:
        trader.cf_all_trades_min_all = data.cf_all_trades_min_all
        cf_changed = True
    if data.cf_max_pay_mins is not None:
        trader.cf_max_pay_mins = data.cf_max_pay_mins
    if data.cf_max_release_mins is not None:
        trader.cf_max_release_mins = data.cf_max_release_mins
    if data.binance_fee_per_usdt is not None:
        trader.binance_fee_per_usdt = data.binance_fee_per_usdt

    await db.commit()

    # Push filters to Binance whenever CF settings changed and API credentials are set.
    # When disabled, push all-zero values to CLEAR any existing filters from the Binance ad.
    push_warnings = []
    if cf_changed and trader.binance_api_key and trader.binance_api_secret:
        try:
            from app.core.security import decrypt_data
            from app.services.binance.sapi_client import get_merchant_ads, push_counterparty_filters, relay_trader
            relay_trader.set(trader.id)   # route via this trader's desktop in per_trader mode
            api_key    = decrypt_data(trader.binance_api_key)
            api_secret = decrypt_data(trader.binance_api_secret)
            ads = await get_merchant_ads(api_key, api_secret)
            pushed = 0
            skipped = 0
            for ad in ads:
                adv_no = ad.get("advNo") or ad.get("adsNo")
                if not adv_no:
                    continue
                # Counterparty filters apply ONLY to SELL ads (screening incoming buyers).
                # Never restrict BUY ads — that would block sellers from trading with us.
                if (ad.get("tradeType") or "").upper() != "SELL":
                    continue
                try:
                    # Binance EP-7: push All-time filter (userAllTradeCountMin window=2)
                    # 30D filter is enforced at bot level — bot sends cancel message if buyer fails
                    min_all = (trader.cf_all_trades_min_all or 0) if trader.cf_filters_enabled else 0
                    await push_counterparty_filters(
                        api_key=api_key, api_secret=api_secret, adv_no=adv_no,
                        completion_rate_min=0.0, completion_rate_window=2,
                        all_trades_min=min_all,
                        trade_count_window=2,
                        completed_trades_min=0,
                        buy_trades_min=0, sell_trades_min=0,
                        volume_min=0.0, volume_asset="USDT", volume_window=2, reg_days_min=0,
                    )
                    pushed += 1
                except Exception as ad_err:
                    logger.warning("Skipping ad %s: %s", adv_no, ad_err)
                    push_warnings.append(f"ad {adv_no}: {ad_err}")
            # Verify-after-push: read the ads back and confirm Binance actually has our value
            synced = True
            mismatch = None
            try:
                expected = int((trader.cf_all_trades_min_all or 0) if trader.cf_filters_enabled else 0)
                verify_ads = await get_merchant_ads(api_key, api_secret)
                for vad in verify_ads:
                    if (vad.get("tradeType") or "").upper() != "SELL":
                        continue
                    actual = int(vad.get("userAllTradeCountMin") or 0)
                    if actual != expected:
                        synced = False
                        mismatch = (actual, expected)
                        break
            except Exception as ve:
                synced = False
                logger.warning("CF verify-after-push failed: %s", ve)
            if pushed > 0:
                trader.cf_last_pushed_at = datetime.now(timezone.utc)
                # A successful EP-7 push only works for Gold Merchants, so tag the tier here too.
                # This self-heals the badge when the connect-time probe missed it (e.g. the relay
                # was offline at key-save), without any extra/destructive Binance call.
                if (trader.binance_merchant_tier or "").lower() != "gold":
                    trader.binance_merchant_tier = "gold"
                await db.commit()
            if synced and not push_warnings:
                return {"status": "updated", "filters_pushed": pushed, "synced": True}
            warns = " ".join(push_warnings)
            # 187040 = Binance rejects editing an ad with no tradable USDT inventory
            if "187040" in warns:
                return {"status": "updated", "filters_pushed": pushed, "synced": False, "reason": "no_usdt",
                        "warning": "Couldn't apply the filter — your sell ad has no USDT available to trade. "
                                   "Top up your sell ad's USDT on Binance, then click Save again."}
            if mismatch:
                return {"status": "updated", "filters_pushed": pushed, "synced": False,
                        "warning": f"Saved, but Binance still shows {mismatch[0]} (expected {mismatch[1]}). "
                                   + (f"Binance rejected the change: {warns}" if warns else "Your bot/relay may be offline — keep it running and click Save again.")}
            return {"status": "updated", "filters_pushed": pushed, "synced": False,
                    "warning": (f"Saved, but Binance rejected the change: {warns}" if warns else "Saved, but could not confirm the change reached Binance. Keep your bot running and click Save again.")}
        except Exception as e:
            logger.warning("Failed to push counterparty filters to Binance: %s", e)
            push_warnings.append(str(e))

    result = {"status": "updated"}
    if push_warnings:
        result["warning"] = f"Settings saved but Binance push failed: {push_warnings[0]}"
    return result


@router.put("/binance-api-key")
async def save_binance_api_key(
    data: BinanceApiKeyRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Save Binance API key + secret (encrypted). Verifies via EP-4, probes EP-7 for Gold Merchant tier."""
    from app.core.security import encrypt_data
    from app.services.binance.sapi_client import (
        verify_api_credentials, push_counterparty_filters, relay_trader,
        BinanceApiError, friendly_binance_error,
    )
    relay_trader.set(trader.id)   # route via this trader's desktop in per_trader mode

    if not data.api_key.strip() or not data.api_secret.strip():
        raise HTTPException(status_code=400, detail="API key and secret are required.")

    # Fail fast if the trader's relay isn't online — otherwise verification waits the full ~25s
    # relay timeout before failing, which looks like the save "hanging". The relay is required
    # because the server can't reach Binance directly.
    from app.services.binance import relay_router
    if not relay_router.is_connected(trader.id):
        raise HTTPException(
            status_code=400,
            detail="Your relay isn't online yet. Turn on the relay on your phone (or open the SparkP2P desktop app), wait until it shows online, then try again.",
        )

    # Verify credentials actually WORK before saving (EP-4). verify_api_credentials() raises on a
    # Binance error envelope (e.g. -1022 = secret doesn't match the key) so we reject loudly with a
    # clear message instead of silently 'saving' a broken key that pulls no data.
    try:
        ads = await verify_api_credentials(data.api_key.strip(), data.api_secret.strip())
    except BinanceApiError as e:
        raise HTTPException(status_code=400, detail=friendly_binance_error(e.code, e.msg))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not verify API credentials: {e}")

    if ads is None:
        raise HTTPException(status_code=400, detail="Invalid API credentials — could not fetch ads.")

    # Probe EP-7 to detect Gold Merchant tier (all-zero values = no-op, safe)
    merchant_capable = False
    if ads:
        try:
            await push_counterparty_filters(
                data.api_key.strip(),
                data.api_secret.strip(),
                ads[0]["advNo"],
                completion_rate_min=0.0,
                completion_rate_window=2,
                all_trades_min=0,
                trade_count_window=2,
                completed_trades_min=0,
            )
            merchant_capable = True
            trader.binance_merchant_tier = "gold"
        except Exception:
            # -1002 or any error means not Gold Merchant — leave existing tier unchanged
            pass

    # "Test connection" — credentials verified above; report success without saving them.
    if data.test_only:
        return {"status": "verified", "ads_found": len(ads), "merchant_capable": merchant_capable}

    trader.binance_api_key    = encrypt_data(data.api_key.strip())
    trader.binance_api_secret = encrypt_data(data.api_secret.strip())
    trader.binance_api_key_invalid = False  # freshly verified key is valid

    # Auto-detect the merchant's public nickname now (relay is online at connect time) so the
    # price-tracker "your rank" view can match them without a live relay call later.
    try:
        from app.services.price_tracker import detect_nickname_from_ads
        nick, p2p_tier = await detect_nickname_from_ads(ads)
        if nick:
            trader.binance_nickname = nick
        if p2p_tier:
            trader.binance_p2p_tier = p2p_tier
            # The public P2P medal (from vipLevel) is the RELIABLE Gold/Silver/Bronze signal. The
            # EP-7 probe above is fragile — it can fail with 187049 on a valid merchant's ad — so
            # trust the detected tier for the merchant badge instead of relying only on EP-7.
            if p2p_tier in ("gold", "silver", "bronze"):
                trader.binance_merchant_tier = p2p_tier
    except Exception:
        pass

    await db.commit()

    from app.api.deps import log_event
    await log_event(db, trader.id, f"Binance API key connected{' (Gold Merchant)' if merchant_capable else ''}", "success")

    return {"status": "saved", "ads_found": len(ads), "merchant_capable": merchant_capable}


@router.delete("/binance-api-key")
async def delete_binance_api_key(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Completely remove the stored Binance API key + secret from this account, leaving it
    'neutral' (no key). The actual key/secret are deleted from the database, so the same key
    can be connected to a different SparkP2P account. Counterparty-filter pushes and
    background SAPI calls simply stop for this account until a key is connected again."""
    trader.binance_api_key = None
    trader.binance_api_secret = None
    trader.binance_api_key_invalid = False
    trader.binance_merchant_tier = None   # tier was derived from the key
    await db.commit()
    return {"status": "deleted"}


# ── Profile, Security Question, Change Password ───────────────────

_change_pw_otp_codes: dict[str, str] = {}  # email -> OTP for in-app password change
_withdraw_otp_codes: dict[str, str] = {}  # email -> OTP for withdrawal confirmation
_pending_withdrawal_tx: dict = {}  # email -> {tx_id, amount} for Choice Bank OTP confirm


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = None
    binance_merchant_tier: Optional[str] = None  # 'gold', 'silver', 'bronze'


class SetSecurityQuestionRequest(BaseModel):
    security_question: str
    security_answer: str


class ChangePasswordRequest(BaseModel):
    otp_code: str
    new_password: str


@router.put("/profile")
async def update_profile(
    data: UpdateProfileRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update editable profile fields (full_name, binance_merchant_tier)."""
    updates = {}
    if data.full_name is not None:
        name = data.full_name.strip().upper()
        if len(name) < 3:
            raise HTTPException(status_code=400, detail="Full name must be at least 3 characters")
        updates["full_name"] = name
    if data.binance_merchant_tier is not None:
        if data.binance_merchant_tier not in ("gold", "silver", "bronze"):
            raise HTTPException(status_code=400, detail="merchant_tier must be gold, silver, or bronze")
        updates["binance_merchant_tier"] = data.binance_merchant_tier
    if updates:
        await db.execute(sql_update(Trader).where(Trader.id == trader.id).values(**updates))
        await db.commit()
        return {"message": "Profile updated", **updates}
    return {"message": "Nothing to update"}


@router.post("/security-question")
async def set_security_question(
    data: SetSecurityQuestionRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Set security question — only allowed if not already set (permanent)."""
    if trader.security_question:
        raise HTTPException(
            status_code=400,
            detail="Security question is already set and cannot be changed",
        )
    from app.core.security import hash_password
    await db.execute(
        sql_update(Trader).where(Trader.id == trader.id).values(
            security_question=data.security_question.strip(),
            security_answer_hash=hash_password(data.security_answer.strip().lower()),
            security_answer_plain=data.security_answer.strip().lower(),
        )
    )
    await db.commit()
    return {"message": "Security question saved successfully"}


@router.post("/change-password/request")
async def request_change_password_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone to authorize a password change."""
    if trader.password_changed_at:
        cooldown_end = trader.password_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds())
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "password_change_cooldown",
                    "message": "Password can only be changed once every 48 hours.",
                    "cooldown_until": cooldown_end.isoformat(),
                    "remaining_seconds": remaining,
                },
            )
    import random
    otp_code = str(random.randint(100000, 999999))
    _change_pw_otp_codes[trader.email] = otp_code
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception as e:
        logger.warning(f"Change-password OTP SMS failed for {trader.email}: {e}")
    masked = f"***{trader.phone[-4:]}"
    return {"message": f"OTP sent to {masked}", "phone_hint": masked}


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify OTP and update password (must differ from current). 48hr cooldown enforced."""
    import re
    # Enforce 48-hour cooldown
    if trader.password_changed_at:
        cooldown_end = trader.password_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds())
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "password_change_cooldown",
                    "message": "Password can only be changed once every 48 hours.",
                    "cooldown_until": cooldown_end.isoformat(),
                    "remaining_seconds": remaining,
                },
            )

    stored = _change_pw_otp_codes.get(trader.email)
    if not stored or stored != data.otp_code:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code")

    # Validate password strength
    from app.core.security import hash_password, verify_password
    pw = data.new_password
    errors = []
    if len(pw) < 8: errors.append("at least 8 characters")
    if len(re.findall(r"[A-Z]", pw)) < 2: errors.append("2 uppercase letters")
    if len(re.findall(r"[a-z]", pw)) < 2: errors.append("2 lowercase letters")
    if len(re.findall(r"[0-9]", pw)) < 2: errors.append("2 numbers")
    if len(re.findall(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?]", pw)) < 2: errors.append("2 special characters")
    if errors:
        raise HTTPException(status_code=400, detail=f"Password must contain: {', '.join(errors)}")

    if verify_password(data.new_password, trader.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different from your current password")

    now = datetime.now(timezone.utc)
    await db.execute(
        sql_update(Trader).where(Trader.id == trader.id).values(
            password_hash=hash_password(data.new_password),
            failed_login_attempts=0,
            locked_until=None,
            password_changed_at=now,
        )
    )
    _change_pw_otp_codes.pop(trader.email, None)
    await db.commit()
    from app.api.deps import log_event
    await log_event(db, trader.id, "Password changed", "warning")
    cooldown_until = (now + timedelta(hours=48)).isoformat()
    return {"message": "Password changed successfully", "cooldown_until": cooldown_until}


@router.get("/my-bot-logs")
async def my_bot_logs(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """The signed-in trader's own activity log (newest first) — server-side account events plus
    any desktop-pushed lines, persisted in the DB so it survives restarts."""
    from app.models.bot_log import BotLog
    rows = (await db.execute(
        select(BotLog).where(BotLog.trader_id == trader.id)
        .order_by(BotLog.created_at.desc()).limit(200)
    )).scalars().all()
    return [{"level": r.level, "message": r.message, "time": r.time} for r in rows]


@router.get("/my-permissions")
async def get_my_permissions(trader: Trader = Depends(get_current_trader)):
    """Returns the current employee's permissions (for role-based UI rendering)."""
    DEFAULT = {"disputes": True, "orders": True, "chat": True, "transactions": False, "withdrawals": False}
    return trader.permissions or DEFAULT


@router.get("/session-health")
async def get_session_health(
    trader: Trader = Depends(get_current_trader),
):
    """Get current session health status from the background monitor."""
    from app.services.binance.health import session_monitor
    health = session_monitor.get_health(trader.id)
    return {
        "score": health.get("score", 0),
        "status": health.get("status", "unknown"),
        "last_success": health.get("last_success"),
        "last_check": health.get("last_check"),
        "consecutive_failures": health.get("consecutive_failures", 0),
    }


@router.get("/desktop-credentials")
async def get_desktop_credentials(
    trader: Trader = Depends(get_current_trader),
):
    """
    Returns the trader's decrypted Binance verification credentials to the desktop app.
    Called once on startup so the bot can auto-enter PIN / TOTP when Binance asks.
    Only returns to the authenticated owner — never exposed to other users.
    """
    from app.core.security import decrypt_data
    fund_password = None
    totp_secret = None
    try:
        if trader.binance_fund_password:
            fund_password = decrypt_data(trader.binance_fund_password)
    except Exception:
        pass
    try:
        if trader.binance_2fa_secret:
            totp_secret = decrypt_data(trader.binance_2fa_secret)
    except Exception:
        pass
    # Also check trader.totp_secret — set by the TOTP setup/verify flow
    if not totp_secret:
        try:
            if trader.totp_secret:
                totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            pass
    account_number = f"P2PT{trader.id:04d}"
    return {
        "verify_method": trader.binance_verify_method or "none",
        "fund_password": fund_password,
        "totp_secret": totp_secret,
        "anthropic_api_key": settings.ANTHROPIC_API_KEY,
        "account_number": account_number,
        "phone_number": trader.phone or "",
        "im_account": trader.settlement_account or "",
        "choice_account_number": trader.choice_account_number or "",
        "choice_account_id": trader.choice_account_id or "",
        "choice_paybill": settings.CHOICE_BANK_PAYBILL,
    }


@router.post("/refresh-token")
async def refresh_token(
    trader: Trader = Depends(get_current_trader),
):
    """
    Exchange a valid (non-expired) JWT for a fresh 30-day token.
    Desktop app calls this every 20 minutes to keep the session alive.
    No OTP required — the existing valid token is proof of identity.
    """
    from app.models import TraderStatus
    if trader.status != TraderStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="Account is not active")
    new_token = create_access_token({"sub": str(trader.id), "email": trader.email})
    return {
        "access_token": new_token,
        "token_type": "bearer",
        "trader_id": trader.id,
        "full_name": trader.full_name,
        "role": trader.role or "trader",
    }


class InternalTransferRequest(BaseModel):
    recipient: str  # Phone number or email of the recipient
    amount: float


@router.post("/wallet/transfer")
async def internal_transfer(
    data: InternalTransferRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send money to another SparkP2P user. FREE - no transaction fees."""
    from app.services.internal_transfer import find_trader_by_phone, transfer_between_wallets

    if data.amount < 10:
        raise HTTPException(status_code=400, detail="Minimum transfer amount is KES 10")
    if data.amount > 500_000:
        raise HTTPException(status_code=400, detail="Maximum transfer amount is KES 500,000")

    recipient = data.recipient.strip()
    if not recipient:
        raise HTTPException(status_code=400, detail="Recipient phone or email is required")

    # Look up recipient by email or phone
    recipient_trader = None
    if "@" in recipient:
        result = await db.execute(
            select(Trader).where(Trader.email == recipient)
        )
        recipient_trader = result.scalar_one_or_none()
    else:
        recipient_trader = await find_trader_by_phone(db, recipient)

    if not recipient_trader:
        raise HTTPException(status_code=404, detail="Recipient not found on SparkP2P")

    if recipient_trader.id == trader.id:
        raise HTTPException(status_code=400, detail="You cannot send money to yourself")

    try:
        await transfer_between_wallets(
            db=db,
            from_trader_id=trader.id,
            to_trader_id=recipient_trader.id,
            amount=data.amount,
            description=f"Manual transfer to {recipient_trader.full_name}",
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Get updated sender wallet
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    updated_wallet = result.scalar_one_or_none()

    return {
        "status": "success",
        "message": f"KES {data.amount:,.0f} sent to {recipient_trader.full_name}",
        "amount": data.amount,
        "recipient_name": recipient_trader.full_name,
        "fee": 0,
        "new_balance": updated_wallet.balance if updated_wallet else 0,
    }


@router.get("/wallet", response_model=WalletResponse)
async def get_wallet(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get trader's wallet balance and stats."""
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet:
        return WalletResponse(
            balance=0, reserved=0, total_volume=0,
            total_withdrawn=0, total_fees_paid=0,
            daily_volume=0, daily_trades=0,
        )

    # Compute total P2P trading volume from completed orders
    vol_r = await db.execute(
        select(func.coalesce(func.sum(Order.fiat_amount), 0)).where(
            Order.trader_id == trader.id,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )
    total_volume = float(vol_r.scalar() or 0)

    # Check for any pending bank withdrawal
    from app.models.wallet import WalletTransaction, TransactionType
    pending_r = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.status == "pending",
        ).limit(1)
    )
    pending_txn = pending_r.scalar_one_or_none()

    # Compute next 15-min sweep boundary (UTC: :00/:15/:30/:45 every hour)
    from datetime import timedelta
    now_utc = datetime.now(timezone.utc)
    boundary_minute = ((now_utc.minute // 15) + 1) * 15
    if boundary_minute >= 60:
        next_sweep = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    else:
        next_sweep = now_utc.replace(minute=boundary_minute, second=0, microsecond=0)

    return WalletResponse(
        balance=wallet.balance,
        reserved=wallet.reserved,
        total_volume=total_volume,
        total_withdrawn=wallet.total_withdrawn,
        total_fees_paid=wallet.total_fees_paid,
        daily_volume=wallet.daily_volume,
        daily_trades=wallet.daily_trades,
        pending_withdrawal=pending_txn is not None,
        pending_withdrawal_amount=abs(pending_txn.amount) if pending_txn else 0.0,
        next_sweep_at=next_sweep.isoformat(),
    )


class WithdrawRequest(BaseModel):
    otp_code: str
    amount: Optional[float] = None


@router.post("/wallet/withdraw")
async def request_withdrawal(
    data: WithdrawRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Request withdrawal of wallet balance.
    Requires OTP verification. Checks 48-hour cooldown on new payment methods.
    """
    from app.services.settlement.engine import SettlementEngine
    from datetime import datetime, timezone

    # Verify OTP
    stored_otp = _withdraw_otp_codes.get(trader.email)
    if not stored_otp or stored_otp != data.otp_code.strip():
        raise HTTPException(status_code=401, detail="Invalid or expired OTP code")
    del _withdraw_otp_codes[trader.email]

    # If pending withdrawal already exists, return processing status instead of error
    from app.models.wallet import WalletTransaction, TransactionType
    pending_r = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.status == "pending",
        ).limit(1)
    )
    if pending_r.scalar_one_or_none():
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=202, content={
            "status": "processing",
            "pending": True,
            "message": "Your withdrawal is already being processed. We'll complete the transfer to your account shortly.",
        })

    # Check 48-hour cooldown
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            hours_left = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)
            raise HTTPException(
                status_code=400,
                detail=f"Your payment method was recently changed. For security, withdrawals are available in {hours_left} hours.",
            )

    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No funds available for withdrawal",
        )

    # Determine effective withdrawal amount (partial or full balance)
    if data.amount is not None and 0 < data.amount < wallet.balance:
        withdraw_amount = data.amount
    else:
        withdraw_amount = wallet.balance

    from app.services.settlement.engine import get_total_settlement_fee, MIN_WITHDRAWAL, BANK_MIN_WITHDRAWAL, get_bank_withdrawal_eligibility
    if withdraw_amount < MIN_WITHDRAWAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Minimum withdrawal is KES {MIN_WITHDRAWAL:,}. Your balance is KES {wallet.balance:,.0f}.",
        )

    # Stranded-balance check: block partial withdrawals that would leave a remainder
    # too small to ever withdraw (< MIN_WITHDRAWAL). Force the trader to take the full balance.
    remaining_after = wallet.balance - withdraw_amount
    if 0 < remaining_after < MIN_WITHDRAWAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Withdrawing KES {withdraw_amount:,.0f} would leave KES {remaining_after:,.0f} in your wallet, "
                f"which is below the KES {MIN_WITHDRAWAL:,} minimum and cannot be withdrawn later. "
                f"Please withdraw your full balance of KES {wallet.balance:,.0f} instead."
            ),
        )

    # Dual-method routing: I&M is primary (if configured + connected), M-Pesa is fallback
    im_configured = bool(trader.settlement_account)
    mpesa_configured = bool(trader.settlement_phone)
    is_bank = im_configured and trader.im_connected  # True → use I&M; False → use M-Pesa

    if not is_bank and not mpesa_configured:
        detail = (
            "I&M Bank is configured but not connected — please open the desktop app to reconnect. "
            "Add an M-Pesa number as fallback in Settings → Settlement to withdraw when I&M is offline."
        ) if im_configured else "No withdrawal method configured. Set up I&M Bank or M-Pesa in Settings → Settlement."
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    # For bank withdrawals, check tier eligibility
    if is_bank:
        eligibility = get_bank_withdrawal_eligibility(withdraw_amount)
        if not eligibility["eligible"]:
            min_req = eligibility.get("min_required", 0)
            if mpesa_configured:
                # I&M minimum not met but M-Pesa fallback is available — use M-Pesa
                is_bank = False
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{eligibility['reason']}. Keep trading to reach KES {min_req:,}.",
                )

    # Calculate fees
    safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, withdraw_amount)
    net_amount = withdraw_amount - total_fee

    if net_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Amount too low to cover fees (KES {total_fee})",
        )

    if is_bank:
        # ── Bank (I&M) traders: queue into hourly batch ───────────────────────
        engine = SettlementEngine(db)
        batch_result = await engine.queue_batch_withdrawal(
            trader.id,
            amount=withdraw_amount if data.amount is not None else None,
        )
        if not batch_result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=batch_result.get("error", "Failed to queue withdrawal"),
            )
        queued_net = batch_result["net_amount"]
        queued_fee = batch_result["fee_amount"]
        # Calculate the next :55 mark in EAT so the message shows the exact time
        from datetime import timezone as _tz, timedelta as _td
        _EAT = _tz(_td(hours=3))
        _now = datetime.now(_EAT)
        _next55 = _now.replace(minute=55, second=0, microsecond=0)
        if _now >= _next55:
            _next55 += _td(hours=1)
        _sweep_time = _next55.strftime("%-I:%M %p")  # e.g. "10:55 AM"
        return {
            "status": "queued",
            "message": (
                f"KES {queued_net:,.0f} queued for the {_sweep_time} batch transfer to your I&M account. "
                f"The sweep runs at {_sweep_time} — funds are disbursed to your bank account shortly after. "
                f"You will receive an SMS and email once the transfer completes."
            ),
            "amount_sent": queued_net,
            "transaction_fee": queued_fee,
            "batch_id": batch_result["batch_id"],
        }

    # ── M-PESA traders: B2C retired — withdrawals now go through Choice Bank ────
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="M-Pesa withdrawals now go through your Choice Bank account. Use Withdraw → Choice Bank → M-Pesa.",
    )


@router.get("/wallet/withdraw/preview")
async def preview_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Preview withdrawal fees before confirming."""
    from app.services.settlement.engine import get_total_settlement_fee, MIN_WITHDRAWAL, BANK_MIN_WITHDRAWAL, get_bank_withdrawal_eligibility

    result = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        return {"can_withdraw": False, "reason": "No funds available"}

    if wallet.balance < MIN_WITHDRAWAL:
        return {"can_withdraw": False, "reason": f"Minimum withdrawal is KES {MIN_WITHDRAWAL:,}"}

    # Dual-method: I&M primary (if configured + connected), else M-Pesa
    im_configured = bool(trader.settlement_account)
    mpesa_configured = bool(trader.settlement_phone)
    use_im = im_configured and bool(trader.im_connected)

    if use_im:
        eligibility = get_bank_withdrawal_eligibility(wallet.balance)
        if not eligibility["eligible"]:
            min_req = eligibility.get("min_required", 0)
            bal = round(wallet.balance, 2)
            if mpesa_configured:
                # Auto-fall through to M-Pesa (don't block)
                use_im = False
            else:
                return {
                    "can_withdraw": False,
                    "reason": (
                        f"Minimum I&M Bank withdrawal is KES {min_req:,}. "
                        f"Your balance is KES {bal:,.2f}. "
                        f"You need KES {max(0, min_req - bal):,.2f} more to withdraw."
                    ),
                    "min_required": min_req,
                    "balance": bal,
                    "cooldown_active": False,
                }

    balance = round(wallet.balance, 2)
    safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, balance)
    total_fee = round(total_fee, 2)
    net_amount = round(balance - total_fee, 2)

    # Check cooldown
    cooldown_active = False
    cooldown_hours = 0
    if trader.settlement_changed_at:
        cooldown_end = trader.settlement_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            cooldown_active = True
            cooldown_hours = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600)

    active_method = "bank_paybill" if use_im else "mpesa"
    return {
        "can_withdraw": net_amount > 0 and not cooldown_active,
        "balance": balance,
        "transaction_fee": total_fee,
        "you_receive": max(net_amount, 0),
        "cooldown_active": cooldown_active,
        "cooldown_hours": cooldown_hours,
        "settlement_method": active_method,
        "min_withdrawal": MIN_WITHDRAWAL,
        "force_full_withdrawal": balance < MIN_WITHDRAWAL * 2,
    }


@router.post("/wallet/withdraw/request-otp")
async def request_withdrawal_otp(
    trader: Trader = Depends(get_current_trader),
):
    """Send OTP to trader's phone to authorize an M-Pesa batch withdrawal."""
    import random
    otp_code = str(random.randint(100000, 999999))
    _withdraw_otp_codes[trader.email] = otp_code
    try:
        from app.services.sms import sms_verification_code
        sms_verification_code(trader.phone, otp_code)
    except Exception as e:
        logger.warning(f"Withdrawal OTP SMS failed for {trader.email}: {e}")
    masked = trader.phone[-4:] if trader.phone else "****"
    return {"status": "sent", "message": f"OTP sent to number ending {masked}"}


class CbWithdrawInitiateBody(BaseModel):
    amount: float

@router.post("/cb-withdraw-to-bank/initiate")
async def cb_withdraw_initiate(
    body: CbWithdrawInitiateBody,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 1: call applyForTransfer to create a pending Pesalink transfer at Choice Bank,
    then trigger Choice Bank to SMS a 4-digit OTP to the trader's registered mobile.
    Stores {tx_id, amount} for the confirm step (/cb-withdraw-to-bank).
    """
    from app.services.choice_bank import client as choice

    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    if not trader.cb_withdrawal_bank_code or not trader.cb_withdrawal_account:
        raise HTTPException(status_code=400, detail="No withdrawal bank account configured")
    if body.amount < 100:
        raise HTTPException(status_code=400, detail="Minimum withdrawal is KES 100")

    # Choice Bank withholds the outbound fee on its side (debits amount + fee from the trader's
    # account). We compute it here only to show + record it; we do NOT deduct it ourselves.
    from app.services.outbound_fees import outbound_fee as _outbound_fee
    _fee = _outbound_fee("BANK", body.amount)

    # Block if there's already a PENDING withdrawal in the last 2 hours
    from datetime import datetime, timezone, timedelta
    from app.models import Payment, PaymentStatus
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    existing = (await db.execute(
        select(Payment).where(
            Payment.trader_id == trader.id,
            Payment.transaction_type == "CHOICE_OUTBOUND",
            Payment.status == PaymentStatus.PENDING,
            Payment.created_at > cutoff,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"You have a withdrawal already processing (Ref: {existing.mpesa_transaction_id}). Please wait for it to complete before initiating another.",
        )

    remark = "".join(
        c for c in f"SparkP2P withdrawal to {trader.cb_withdrawal_bank_name or 'Bank'}"
        if c.isalnum() or c == " "
    )[:100]

    try:
        result = await choice.transfer(
            payer_account_id=trader.choice_account_id,
            payee_account_id=trader.cb_withdrawal_account,
            amount=body.amount,
            payee_bank_code=str(trader.cb_withdrawal_bank_code),
            payee_name=trader.cb_withdrawal_account_name or "",
            remark=remark,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transfer initiation failed: {exc}")

    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer rejected by Choice Bank"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned — cannot proceed")

    try:
        otp_result = await choice.send_otp(tx_id)
        if otp_result.get("code") not in ("00000",):
            logger.warning(f"[ChoiceBank] sendOtp returned {otp_result.get('code')}: {otp_result.get('msg')}")
    except Exception as exc:
        logger.warning(f"[ChoiceBank] sendOtp call failed: {exc}")

    _pending_withdrawal_tx[trader.email] = {"tx_id": tx_id, "amount": body.amount, "fee": _fee}
    masked = trader.phone[-4:] if trader.phone else "****"
    return {
        "status": "otp_sent",
        "fee": _fee,
        "message": f"OTP sent by Choice Bank to your registered phone ending {masked}. "
                   f"A transaction fee of KES {_fee} applies (deducted by Choice Bank). Enter the OTP to confirm.",
    }


@router.post("/cb-withdraw-to-mpesa/initiate")
async def cb_withdraw_to_mpesa_initiate(
    body: CbWithdrawInitiateBody,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 1: Withdraw from Choice Bank to M-Pesa.
    Uses applyForTransfer with payeeBankCode="M-PESA" and the trader's phone in 9-digit format.
    No Pesalink bank code needed — works in sandbox and production.
    """
    from app.services.choice_bank import client as choice

    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    if not trader.settlement_phone:
        raise HTTPException(status_code=400, detail="No M-Pesa settlement number configured. Please set your M-Pesa number in Settings.")
    from app.services.outbound_fees import outbound_fee as _outbound_fee, MPESA_MIN_WITHDRAWAL
    if body.amount < MPESA_MIN_WITHDRAWAL:
        raise HTTPException(status_code=400, detail=f"Minimum M-Pesa withdrawal is KES {MPESA_MIN_WITHDRAWAL:,}")
    # M-Pesa caps a single transaction at KES 250,000 — larger amounts must go to a bank account.
    if body.amount > 250000:
        raise HTTPException(status_code=400, detail="M-Pesa withdrawals are limited to KES 250,000 per transaction. Withdraw to your bank for larger amounts.")

    # Choice Bank withholds the outbound fee on its side (debits amount + fee from the trader's
    # account). We compute it here only to show + record it; we do NOT deduct it ourselves.
    _fee = _outbound_fee("MPESA", body.amount)

    # Block if there's already a PENDING withdrawal in the last 2 hours
    from datetime import datetime, timezone, timedelta
    from app.models import Payment, PaymentStatus
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    existing = (await db.execute(
        select(Payment).where(
            Payment.trader_id == trader.id,
            Payment.transaction_type == "CHOICE_OUTBOUND",
            Payment.status == PaymentStatus.PENDING,
            Payment.created_at > cutoff,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"You have a withdrawal already processing (Ref: {existing.mpesa_transaction_id}). Please wait for it to complete.",
        )

    # Convert settlement_phone to 9-digit format (strip 254 or leading 0)
    phone = (trader.settlement_phone or "").strip()
    if phone.startswith("254"):
        phone = phone[3:]
    elif phone.startswith("+254"):
        phone = phone[4:]
    elif phone.startswith("0"):
        phone = phone[1:]

    if len(phone) != 9 or not phone.isdigit():
        raise HTTPException(status_code=400, detail=f"Invalid M-Pesa settlement phone format: {trader.settlement_phone}")

    try:
        result = await choice.transfer(
            payer_account_id = trader.choice_account_id,
            payee_account_id = phone,
            amount           = body.amount,
            payee_bank_code  = "M-PESA",
            remark           = "SparkP2P withdrawal",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"M-Pesa transfer initiation failed: {exc}")

    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "M-Pesa transfer rejected"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")

    try:
        otp_result = await choice.send_otp(tx_id)
        if otp_result.get("code") not in ("00000",):
            logger.warning(f"[ChoiceBank] M-Pesa sendOtp returned {otp_result.get('code')}: {otp_result.get('msg')}")
    except Exception as exc:
        logger.warning(f"[ChoiceBank] M-Pesa sendOtp failed: {exc}")

    _pending_withdrawal_tx[trader.email] = {"tx_id": tx_id, "amount": body.amount, "channel": "MPESA", "phone": phone, "fee": _fee}
    masked = trader.settlement_phone[-4:] if trader.settlement_phone else "****"
    return {
        "status": "otp_sent",
        "fee": _fee,
        "message": f"OTP sent by Choice Bank to your registered phone. A transaction fee of KES {_fee} "
                   f"applies (deducted by Choice Bank). Enter the OTP to confirm the M-Pesa transfer to ...{masked}.",
    }


@router.post("/wallet/withdraw/simulate")
async def simulate_withdrawal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Simulate withdrawal (for testing without real M-Pesa)."""
    from app.services.settlement.engine import SettlementEngine

    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()

    if not wallet or wallet.balance <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No funds available for withdrawal",
        )

    balance_before = wallet.balance
    engine = SettlementEngine(db)
    success = await engine.batch_settle(trader.id, simulate=True)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Withdrawal simulation failed",
        )

    return {
        "status": "success",
        "simulated": True,
        "amount_settled": balance_before,
        "settlement_method": trader.settlement_method.value,
        "destination": trader.settlement_phone or trader.settlement_paybill,
    }


@router.get("/my-transactions")
async def get_my_transactions(
    limit: int = 100,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Real money transaction history — only payments table.
    Inbound:  M-Pesa C2B payments received (buyers pay paybill), Choice Bank STK deposits.
    Outbound: Settlement payouts sent out.
    Internal SparkP2P wallet accounting is excluded — not relevant here.
    """
    from app.models import Payment, PaymentDirection, PaymentStatus

    # Only show real Choice Bank movements — no old M-Pesa paybill C2B records
    CHOICE_TYPES = ["CHOICE_DEPOSIT", "CHOICE_INBOUND", "CHOICE_OUTBOUND"]
    pay_result = await db.execute(
        select(Payment)
        .where(
            Payment.trader_id == trader.id,
            Payment.transaction_type.in_(CHOICE_TYPES),
        )
        .order_by(Payment.created_at.desc())
        .limit(limit)
    )
    payments = pay_result.scalars().all()

    entries = []
    for p in payments:
        ttype = (p.transaction_type or "").upper()
        direction = "in" if p.direction == PaymentDirection.INBOUND else "out"
        status = p.status.value if hasattr(p.status, "value") else str(p.status)
        ref = p.mpesa_transaction_id or p.mpesa_receipt_number or ""

        # What KIND of movement is this? Every Choice Bank outbound - a seller
        # payout, a paybill payment and the merchant withdrawing their own float
        # to their own bank - is written with transaction_type CHOICE_OUTBOUND,
        # so the type alone cannot tell them apart. The remarks each writer sets
        # can. Only the withdrawal endpoint in this file writes the "Choice Bank
        # withdrawal" prefix (see withdraw_to_bank below) - if that wording ever
        # changes, change it here too or withdrawals silently stop being tagged.
        _rem = (p.remarks or "").strip()
        kind = "other"

        if ttype == "CHOICE_DEPOSIT":
            label, icon = "Choice Bank Deposit", "🏦"
            desc = f"M-Pesa STK to Choice Bank · {p.phone or ''}"
            kind = "deposit"
        elif ttype == "CHOICE_OUTBOUND" and _rem.lower().startswith("choice bank withdrawal"):
            label, icon = "Withdrawal", "🏧"
            bank = p.destination_type or "Bank"
            acct = p.destination or ""
            desc = f"Choice Bank → {bank}" + (f" · {acct}" if acct else "")
            kind = "withdrawal"
        elif ttype == "CHOICE_OUTBOUND":
            label, icon = "Bank Transfer", "🏛"
            bank = p.destination_type or "Bank"
            acct = p.destination or ""
            desc = f"{bank} · {acct}" if acct else bank
            kind = "payout"
        elif ttype in ("C2B", "CHOICE_INBOUND", "") and direction == "in":
            label, icon = "M-Pesa Received", "💳"
            desc = p.sender_name or p.remarks or "Payment received"
        elif direction == "out":
            label, icon = "M-Pesa Payout", "📤"
            desc = p.destination or p.remarks or "Payout sent"
        else:
            label, icon = "Payment", "💱"
            desc = p.remarks or p.sender_name or label

        tx_fee = 0
        if direction == "out":
            from app.services.outbound_fees import categorize as _cat, product_total_fee as _ptf
            tx_fee = _ptf(_cat(p.transaction_type, p.destination_type), abs(p.amount))

        # Name of the other party: recipient on outbound (payee), sender on inbound.
        # Stored in Payment.sender_name for both directions (payee_name on Choice payouts).
        counterparty_name = (p.sender_name or "").strip()

        if kind == "other":
            kind = "received" if direction == "in" else "payout"

        entries.append({
            "id": f"p{p.id}",
            "source": "payment",
            "label": label,
            "icon": icon,
            "kind": kind,
            "direction": direction,
            "amount": abs(p.amount),
            "tx_fee": tx_fee,
            "description": desc.strip(" ·"),
            "counterparty_name": counterparty_name,
            "reference": ref,
            "phone": p.phone or p.destination or "",
            "status": status,
            "created_at": p.created_at.isoformat() if p.created_at else "",
        })

    # I&M Bot payouts — from the dedicated im_payouts ledger (NOT the Payment
    # table, so it never touches Choice Bank balance or revenue math). Shows
    # completed / failed / pending buy-order payouts made from the merchant's own
    # I&M account, alongside their Choice Bank movements.
    from app.models.im_payout import ImPayout
    im_rows = (
        await db.execute(
            select(ImPayout)
            .where(ImPayout.trader_id == trader.id)
            .order_by(ImPayout.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    for r in im_rows:
        rail = "PesaLink" if (r.channel or "").upper() == "BANK" else "M-Pesa"
        dest = (r.destination or "").strip()
        desc = f"I&M · {rail}" + (f" · {dest}" if dest else "")
        if r.status == "failed" and r.detail:
            desc += f" — {r.detail[:60]}"
        entries.append({
            "id": f"im{r.id}",
            "source": "im_payout",
            "label": "I&M Payout",
            "icon": "💸",
            "kind": "payout",
            "direction": "out",
            "amount": float(r.amount or 0),
            "tx_fee": 0,
            "description": desc,
            "counterparty_name": "",
            "reference": r.bank_ref or "",
            "phone": dest,
            "status": r.status,   # completed | failed | pending
            "created_at": r.created_at.isoformat() if r.created_at else "",
        })

    # Merge Choice Bank + I&M into one time-ordered feed, newest first.
    entries.sort(key=lambda e: e.get("created_at") or "", reverse=True)
    return entries[:limit]



# ── Choice Bank → External Bank withdrawal account ────────────────────────────

class CbWithdrawalBankBody(BaseModel):
    bank_name:       str
    bank_code:       str
    account:         str
    account_name:    str
    totp_code:       str
    security_answer: str

class CbWithdrawBody(BaseModel):
    otp:    str
    amount: float

@router.get("/verify-bank-account")
async def verify_bank_account(
    bank_code: str,
    account:   str,
    trader:    Trader = Depends(get_current_trader),
):
    """Look up the registered account holder name for a Pesalink beneficiary.
    Returns { account_name } on success or raises 400/502 on failure.
    """
    from app.services.choice_bank import client as choice
    if not bank_code or not account:
        raise HTTPException(status_code=400, detail="bank_code and account are required")
    try:
        result = await choice.validate_account(account_id=account.strip(), bank_code=bank_code.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Name lookup failed: {exc}")
    if result.get("code") != "00000":
        code = result.get("code", "")
        msg = result.get("msg", "Account not found or bank unreachable")
        if code == "10001":
            raise HTTPException(status_code=503, detail="Pesalink lookup unavailable — please enter the account holder name manually")
        raise HTTPException(status_code=400, detail=msg)
    data = result.get("data") or {}
    name = data.get("accountName", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="No account name returned — verify the account number and bank")
    return {"account_name": name}


class CbAutoWithdrawBody(BaseModel):
    enabled:   bool
    threshold: float | None = None


@router.get("/cb-auto-withdraw")
async def get_cb_auto_withdraw(
    trader: Trader = Depends(get_current_trader),
):
    """Auto-sweep config: when the Choice Bank balance reaches the threshold, the
    whole balance is swept to the configured withdrawal bank (PesaLink only)."""
    return {
        "enabled":         bool(trader.cb_auto_withdraw_enabled),
        "threshold":       trader.cb_auto_withdraw_threshold,
        "bank_configured": bool(trader.cb_withdrawal_account and trader.cb_withdrawal_bank_code),
        "bank_name":       trader.cb_withdrawal_bank_name,
        "account":         trader.cb_withdrawal_account,
    }


@router.post("/cb-auto-withdraw")
async def set_cb_auto_withdraw(
    body:   CbAutoWithdrawBody,
    trader: Trader = Depends(get_current_trader),
    db:     AsyncSession = Depends(get_db),
):
    """Enable/disable the auto-sweep and set its threshold.

    Auto-sweep can only be armed once a withdrawal BANK account is saved — the
    sweep goes over PesaLink to that account and never to M-Pesa, so without it
    there is nowhere to send the money.
    """
    MIN_THRESHOLD = 1000  # a floor so a stray 0/typo can't sweep on every cent

    if body.enabled:
        if not (trader.cb_withdrawal_account and trader.cb_withdrawal_bank_code):
            raise HTTPException(
                status_code=400,
                detail="Save a withdrawal bank account first — auto-withdraw sends to your bank over PesaLink.",
            )
        if body.threshold is None or body.threshold < MIN_THRESHOLD:
            raise HTTPException(
                status_code=400,
                detail=f"Set a threshold of at least KES {MIN_THRESHOLD:,.0f}.",
            )
        trader.cb_auto_withdraw_enabled = True
        trader.cb_auto_withdraw_threshold = float(body.threshold)
        # Enabling (or re-saving) is an explicit "try now" — clear any failure
        # back-off so the next poll (<=60s) attempts a sweep instead of waiting
        # out a 10-minute cooldown from an earlier missed OTP.
        try:
            from app.services.auto_withdraw_poller import _retry_after
            _retry_after.pop(trader.id, None)
        except Exception:
            pass
    else:
        trader.cb_auto_withdraw_enabled = False
        # keep the threshold value so re-enabling remembers it

    await db.commit()
    return {
        "enabled":   bool(trader.cb_auto_withdraw_enabled),
        "threshold": trader.cb_auto_withdraw_threshold,
        "message":   ("Auto-withdraw ON — balances of KES "
                      f"{trader.cb_auto_withdraw_threshold:,.0f}+ will sweep to "
                      f"{trader.cb_withdrawal_bank_name or 'your bank'} via PesaLink."
                      if trader.cb_auto_withdraw_enabled else "Auto-withdraw turned off."),
    }


@router.get("/cb-withdrawal-bank")
async def get_cb_withdrawal_bank(
    trader: Trader = Depends(get_current_trader),
):
    """Return the trader's saved Choice Bank withdrawal destination + cooldown state."""
    from datetime import datetime, timezone, timedelta
    cooldown_until = None
    if trader.cb_withdrawal_changed_at:
        end = trader.cb_withdrawal_changed_at + timedelta(hours=48)
        if end > datetime.now(timezone.utc):
            cooldown_until = end.isoformat()
    return {
        "bank_name":     trader.cb_withdrawal_bank_name,
        "bank_code":     trader.cb_withdrawal_bank_code,
        "account":       trader.cb_withdrawal_account,
        "account_name":  trader.cb_withdrawal_account_name,
        "cooldown_until": cooldown_until,
        "first_change":  trader.cb_withdrawal_changed_at is None,
    }


@router.post("/cb-withdrawal-bank")
async def save_cb_withdrawal_bank(
    body:   CbWithdrawalBankBody,
    trader: Trader = Depends(get_current_trader),
    db:     AsyncSession = Depends(get_db),
):
    """Save / update the merchant's Choice Bank withdrawal bank account.
    Requires Google Authenticator TOTP + security answer every time.
    First save: no cooldown. Subsequent saves: 48-hour cooldown between changes.
    Sends email + SMS + Telegram on every successful save.
    """
    from datetime import datetime, timezone, timedelta
    from app.core.security import verify_password, decrypt_data

    # ── Cooldown check ────────────────────────────────────────────────────────
    is_first_change = trader.cb_withdrawal_changed_at is None
    if not is_first_change:
        cooldown_end = trader.cb_withdrawal_changed_at + timedelta(hours=48)
        if datetime.now(timezone.utc) < cooldown_end:
            remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds() / 3600) + 1
            raise HTTPException(
                status_code=400,
                detail=f"Security cooldown active. You can update your bank account again in {remaining} hour(s).",
            )

    # ── TOTP verification ─────────────────────────────────────────────────────
    if not trader.totp_secret:
        raise HTTPException(status_code=400, detail="Google Authenticator not set up. Please configure it in Profile & Security.")
    totp_secret = decrypt_data(trader.totp_secret)
    if not _verify_totp(totp_secret, body.totp_code.strip()):
        raise HTTPException(status_code=400, detail="Invalid Google Authenticator code. Please try again.")

    # ── Security question verification ────────────────────────────────────────
    if not trader.security_answer_hash or not verify_password(body.security_answer.strip().lower(), trader.security_answer_hash):
        raise HTTPException(status_code=400, detail="Incorrect security answer.")

    # ── Save bank details ─────────────────────────────────────────────────────
    prev_bank = trader.cb_withdrawal_bank_name or "None"
    trader.cb_withdrawal_bank_name    = body.bank_name.strip()
    trader.cb_withdrawal_bank_code    = body.bank_code.strip()
    trader.cb_withdrawal_account      = body.account.strip()
    trader.cb_withdrawal_account_name = body.account_name.strip()
    trader.cb_withdrawal_changed_at   = datetime.now(timezone.utc)
    await db.commit()

    # ── Notifications ─────────────────────────────────────────────────────────
    action     = "configured" if is_first_change else "updated"
    bank_label = f"{body.bank_name.strip()} — A/C {body.account.strip()}"
    notif_msg  = (
        f"🏦 Bank Withdrawal Account {action.capitalize()}\n"
        f"Bank: {bank_label}\n"
        f"Holder: {body.account_name.strip()}\n"
        f"If this was not you, contact support immediately."
    )

    # Email
    try:
        from app.services.email import send_email
        html = (
            f"<p>Hello {trader.name or trader.email},</p>"
            f"<p>Your <strong>Choice Bank withdrawal account</strong> has been <strong>{action}</strong>.</p>"
            f"<table style='border-collapse:collapse;width:100%'>"
            f"<tr><td style='padding:6px 12px;color:#555'>Bank</td><td style='padding:6px 12px'>{body.bank_name.strip()}</td></tr>"
            f"<tr><td style='padding:6px 12px;color:#555'>Account Number</td><td style='padding:6px 12px'>{body.account.strip()}</td></tr>"
            f"<tr><td style='padding:6px 12px;color:#555'>Account Holder</td><td style='padding:6px 12px'>{body.account_name.strip()}</td></tr>"
            f"</table>"
            f"<p style='color:#ef4444'>If you did not make this change, please contact SparkP2P support immediately.</p>"
        )
        send_email(trader.email, f"SparkP2P: Bank Withdrawal Account {action.capitalize()}", html)
    except Exception:
        pass

    # SMS
    try:
        from app.services.sms import send_sms
        sms_text = (
            f"SparkP2P: Your bank withdrawal account has been {action}. "
            f"Bank: {body.bank_name.strip()}, A/C: {body.account.strip()}. "
            f"Not you? Contact support immediately."
        )
        if trader.phone:
            send_sms(trader.phone, sms_text)
    except Exception:
        pass

    # Telegram
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, notif_msg)
    except Exception:
        pass

    cooldown_until = (trader.cb_withdrawal_changed_at + timedelta(hours=48)).isoformat()
    return {
        "message":       f"Bank withdrawal account {action} successfully.",
        "cooldown_until": cooldown_until,
        "first_change":  is_first_change,
    }


@router.post("/cb-withdraw-to-bank")
async def cb_withdraw_to_bank(
    body:   CbWithdrawBody,
    trader: Trader = Depends(get_current_trader),
    db:     AsyncSession = Depends(get_db),
):
    """
    Step 2: confirm the Pesalink transfer with the Choice Bank OTP.
    Calls confirmOperation(txId, otp) — this actually moves the money.
    Payment recorded as PENDING; webhook 0002 updates it to COMPLETED/FAILED.
    """
    from app.services.choice_bank import client as choice
    from app.models import Payment, PaymentDirection, PaymentStatus

    pending = _pending_withdrawal_tx.get(trader.email)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending withdrawal. Please request a new OTP.")

    tx_id  = pending.get("tx_id", "")
    amount = pending["amount"]
    fee    = pending.get("fee", 0)

    if not tx_id:
        raise HTTPException(status_code=400, detail="Invalid pending state. Please start over.")

    try:
        confirm = await choice.confirm_otp(tx_id, body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Confirmation request failed: {exc}")

    if confirm.get("code") != "00000":
        raise HTTPException(
            status_code=400,
            detail=confirm.get("msg", "OTP incorrect or expired — check the code and try again"),
        )

    del _pending_withdrawal_tx[trader.email]

    import time as _time
    _channel  = pending.get("channel", "BANK")
    _mpesa_ph = pending.get("phone", "")

    # No credit charge on outbound: Choice Bank withholds the KES fee on its side (debits
    # amount + fee from the trader's account) and remits our markup monthly. We just record it.
    if _channel == "MPESA":
        _dest      = trader.phone or _mpesa_ph  # full phone stored on trader
        _dest_type = "M-Pesa"
        _ben_name  = trader.full_name or ""
        _remarks   = f"Choice Bank withdrawal to M-Pesa {_dest}"
        _tg_dest   = f"M-Pesa {_dest}"
        _done_msg  = f"KES {amount:,.0f} transfer confirmed. Funds will be sent to M-Pesa {_dest} shortly."
    else:
        _dest      = trader.cb_withdrawal_account or ""
        _dest_type = trader.cb_withdrawal_bank_name or ""
        _ben_name  = trader.cb_withdrawal_account_name or ""
        _remarks   = f"Choice Bank withdrawal to {trader.cb_withdrawal_bank_name} {trader.cb_withdrawal_account}"
        _tg_dest   = f"{trader.cb_withdrawal_bank_name or ''} {trader.cb_withdrawal_account or ''}"
        _done_msg  = f"KES {amount:,.0f} transfer confirmed. Funds will arrive at {trader.cb_withdrawal_bank_name} shortly."

    # NOTE: get_my_transactions() tags a row as a WITHDRAWAL by the "Choice Bank
    # withdrawal" prefix on these remarks - it is the only thing that separates a
    # merchant moving their own float out from a seller payout, since both are
    # CHOICE_OUTBOUND. Change the wording here and change it there too.
    db.add(Payment(
        trader_id=trader.id,
        direction=PaymentDirection.OUTBOUND,
        mpesa_transaction_id=tx_id,
        transaction_type="CHOICE_OUTBOUND",
        amount=amount,
        fee=fee,
        destination=_dest,
        destination_type=_dest_type,
        sender_name=_ben_name,
        remarks=_remarks,
        status=PaymentStatus.PENDING,
    ))
    # Ledger row so the withdrawal shows in Recent Activity.
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_WITHDRAWAL, -float(amount),
                              f"Withdrawal to {_tg_dest}", status="pending", mpesa_receipt=tx_id)
    except Exception:
        pass
    await db.commit()

    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader,
            "📤 KES " + f"{amount:,.0f}" + " withdrawal confirmed" + chr(10) +
            "To: " + _tg_dest + chr(10) +
            "Fee: KES " + f"{fee:,.0f}" + chr(10) +
            "Ref: " + tx_id + chr(10) +
            "Status: Processing (you'll be notified when funds arrive)"
        )
    except Exception:
        pass

    return {
        "txId": tx_id,
        "status": "processing",
        "message": _done_msg,
    }

@router.post("/cb-withdraw-to-bank/auto")
async def cb_withdraw_to_bank_auto(
    trader: Trader = Depends(get_current_trader),
    db:     AsyncSession = Depends(get_db),
):
    """
    Step 2, hands-free: wait for the Choice Bank SMS OTP to arrive over the
    MacroDroid relay, then confirm the withdrawal with it.

    Deliberately does NOT re-implement the confirmation. It obtains the code and
    then calls cb_withdraw_to_bank() exactly as the manual flow does, so the
    Choice Bank call, the Payment row, the ledger entry and the Telegram notice
    can never drift apart between the two paths - this endpoint moves real money.

    Same relay the Choice Bank buy-order flow already uses (see
    choice_bank.send_money_confirm_sms): webhooks.py drops the SMS code into
    _pending_sms_otps keyed on the last 4 of the account and sets the event.
    """
    import asyncio as _asyncio
    from app.api.routes.extension import _pending_sms_otps

    pending = _pending_withdrawal_tx.get(trader.email)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending withdrawal. Please request a new OTP.")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")

    account_last_4 = str(trader.choice_account_id)[-4:]

    # The SMS can beat us here — webhooks.py caches the code even with no waiter,
    # so check for an already-delivered one before sitting down to wait.
    cached = _pending_sms_otps.get(account_last_4) or {}
    otp = cached.get("otp")

    if not otp:
        event = _asyncio.Event()
        _pending_sms_otps[account_last_4] = {"event": event, "otp": None}
        try:
            await _asyncio.wait_for(event.wait(), timeout=120.0)
        except _asyncio.TimeoutError:
            _pending_sms_otps.pop(account_last_4, None)
            raise HTTPException(
                status_code=504,
                detail="OTP not received from the SMS relay after 2 minutes. "
                       "Check MacroDroid is running on the phone with the Choice Bank SIM, "
                       "or enter the code manually.",
            )
        otp = (_pending_sms_otps.get(account_last_4) or {}).get("otp")

    _pending_sms_otps.pop(account_last_4, None)

    if not otp:
        raise HTTPException(status_code=504, detail="SMS relay fired but carried no OTP. Enter the code manually.")

    return await cb_withdraw_to_bank(
        CbWithdrawBody(otp=str(otp).strip(), amount=float(pending["amount"])),
        trader,
        db,
    )


@router.get("/wallet/transactions")
async def get_wallet_transactions(
    limit: int = 50,
    offset: int = 0,
    direction: str = None,   # "positive" | "negative" | None (all)
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get wallet transaction history."""
    filters = [
        WalletTransaction.trader_id == trader.id,
        ~WalletTransaction.description.contains("[CANCELLED"),
    ]
    if direction == "negative":
        filters.append(WalletTransaction.amount < 0)
    elif direction == "positive":
        filters.append(WalletTransaction.amount > 0)

    result = await db.execute(
        select(WalletTransaction)
        .where(*filters)
        .order_by(WalletTransaction.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    transactions = result.scalars().all()

    return [
        {
            "id": t.id,
            "type": t.transaction_type.value,
            "amount": t.amount,
            "balance_after": t.balance_after,
            "description": t.description,
            "status": t.status or "completed",
            "settlement_method": t.settlement_method or "",
            "destination": t.destination or "",
            "created_at": t.created_at.isoformat(),
        }
        for t in transactions
    ]


# ── Deposit Endpoints ─────────────────────────────────────────────

@router.post("/deposit")
async def initiate_deposit(
    data: DepositRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Initiate a deposit via M-Pesa STK Push."""
    # Validate amount
    if data.amount < 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Minimum deposit is KES 100",
        )
    if data.amount > 500_000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Maximum deposit is KES 500,000",
        )

    # Ensure wallet exists
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == trader.id)
    )
    wallet = result.scalar_one_or_none()
    if not wallet:
        wallet = Wallet(trader_id=trader.id)
        db.add(wallet)
        await db.flush()

    # Send STK Push
    account_ref = f"SparkP2P-Dep-{trader.id}"
    deposit_callback_url = f"{settings.MPESA_CALLBACK_BASE_URL}/api/traders/deposit/callback"
    try:
        stk_result = await mpesa_client.stk_push(
            phone=data.phone,
            amount=data.amount,
            account_reference=account_ref,
            description="Deposit to SparkP2P",
            callback_url=deposit_callback_url,
        )
    except Exception as e:
        logger.error(f"STK Push failed for deposit: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to initiate M-Pesa payment. Please try again.",
        )

    checkout_id = stk_result.get("CheckoutRequestID", "")

    # Create pending wallet transaction
    txn = WalletTransaction(
        trader_id=trader.id,
        wallet_id=wallet.id,
        transaction_type=TransactionType.DEPOSIT,
        amount=data.amount,
        balance_after=wallet.balance,  # Not yet credited
        description=f"M-Pesa deposit (pending) - {account_ref}",
        mpesa_checkout_id=checkout_id,
        status="pending",
    )
    db.add(txn)
    await db.commit()

    logger.info(f"Deposit STK Push sent to {data.phone} for KES {data.amount}, checkout={checkout_id}")

    return {
        "status": "pending",
        "checkout_request_id": checkout_id,
        "message": "STK Push sent to your phone. Please enter your M-Pesa PIN.",
    }


@router.post("/deposit/callback")
async def deposit_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """M-Pesa STK Push callback for deposits."""
    data = await request.json()
    logger.info(f"Deposit STK Callback: {data}")

    body = data.get("Body", {}).get("stkCallback", {})
    result_code = body.get("ResultCode")
    checkout_id = body.get("CheckoutRequestID", "")

    if not checkout_id:
        logger.warning("Deposit callback missing CheckoutRequestID")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    # Find the pending transaction
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.mpesa_checkout_id == checkout_id,
            WalletTransaction.transaction_type == TransactionType.DEPOSIT,
            WalletTransaction.status == "pending",
        )
    )
    txn = result.scalar_one_or_none()

    if not txn:
        logger.warning(f"No pending deposit found for checkout {checkout_id}")
        return {"ResultCode": 0, "ResultDesc": "Accepted"}

    if result_code == 0:
        # Success - credit the wallet
        # Extract receipt number from metadata
        metadata = body.get("CallbackMetadata", {}).get("Item", [])
        receipt = ""
        for item in metadata:
            if item.get("Name") == "MpesaReceiptNumber":
                receipt = item.get("Value", "")
                break

        # Get the wallet
        wallet_result = await db.execute(
            select(Wallet).where(Wallet.trader_id == txn.trader_id)
        )
        wallet = wallet_result.scalar_one_or_none()

        if wallet:
            wallet.balance += txn.amount
            wallet.total_earned += txn.amount
            txn.balance_after = wallet.balance
            txn.status = "completed"
            txn.mpesa_receipt = receipt
            txn.description = f"M-Pesa deposit - {receipt}"

            await db.commit()

            logger.info(
                f"Deposit credited: KES {txn.amount} to trader {txn.trader_id}, "
                f"new balance: {wallet.balance}, receipt: {receipt}"
            )

            # Send email notification
            trader_result = await db.execute(
                select(Trader).where(Trader.id == txn.trader_id)
            )
            trader = trader_result.scalar_one_or_none()
            if trader:
                from app.services.email import send_deposit_received
                send_deposit_received(
                    trader.email, trader.full_name, txn.amount, wallet.balance
                )
        else:
            logger.error(f"Wallet not found for trader {txn.trader_id} during deposit callback")
    else:
        # Failed
        txn.status = "failed"
        txn.description = f"M-Pesa deposit failed (code: {result_code})"
        await db.commit()
        logger.warning(f"Deposit failed for checkout {checkout_id}: code={result_code}")

    return {"ResultCode": 0, "ResultDesc": "Accepted"}


@router.get("/deposit/history")
async def get_deposit_history(
    limit: int = 50,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get deposit history for the trader."""
    result = await db.execute(
        select(WalletTransaction)
        .where(
            WalletTransaction.trader_id == trader.id,
            WalletTransaction.transaction_type == TransactionType.DEPOSIT,
        )
        .order_by(WalletTransaction.created_at.desc())
        .limit(limit)
    )
    deposits = result.scalars().all()

    return [
        {
            "id": d.id,
            "amount": d.amount,
            "status": d.status or "completed",
            "mpesa_receipt": d.mpesa_receipt,
            "balance_after": d.balance_after,
            "description": d.description,
            "created_at": d.created_at.isoformat(),
        }
        for d in deposits
    ]


@router.get("/deposit/status/{checkout_id}")
async def check_deposit_status(
    checkout_id: str,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Poll the status of a deposit by checkout request ID."""
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.mpesa_checkout_id == checkout_id,
            WalletTransaction.trader_id == trader.id,
        )
    )
    txn = result.scalar_one_or_none()

    if not txn:
        raise HTTPException(status_code=404, detail="Deposit not found")

    return {
        "status": txn.status or "pending",
        "amount": txn.amount,
        "balance_after": txn.balance_after,
        "mpesa_receipt": txn.mpesa_receipt,
    }


class GmailCredentials(BaseModel):
    gmail_email: str
    gmail_password: str


@router.post("/gmail-credentials")
async def save_gmail_credentials(
    data: GmailCredentials,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Save Gmail credentials for automated OTP scanning during order release."""
    trader.gmail_email = data.gmail_email
    trader.gmail_password = encrypt_data(data.gmail_password)
    await db.commit()
    return {"message": "Gmail credentials saved successfully"}


@router.get("/gmail-credentials")
async def get_gmail_credentials(
    trader: Trader = Depends(get_current_trader),
):
    """Check if Gmail session is active (synced from desktop app)."""
    return {
        "configured": bool(trader.gmail_cookies),
    }


class ImConnectRequest(BaseModel):
    cookies: list  # Full cookie objects from desktop app Chrome session


@router.post("/connect-im")
async def connect_im(
    data: ImConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Store I&M Bank session cookies captured by desktop app after manual login."""
    if not data.cookies or len(data.cookies) < 3:
        raise HTTPException(status_code=400, detail="Not enough cookies — make sure you are fully logged in to I&M.")
    trader.im_cookies = encrypt_data(json.dumps(data.cookies))
    trader.im_connected = True
    trader.last_extension_sync = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok", "message": "I&M session saved.", "cookies_received": len(data.cookies)}


@router.post("/pause-bot/request-otp")
async def request_pause_otp(trader: Trader = Depends(get_current_trader)):
    """Prepare pause verification. SMS OTP only sent when trader has no TOTP configured."""
    import random
    from app.api.routes.auth import _login_otp_codes
    has_totp = bool(trader.totp_secret)
    masked = trader.phone[-4:] if trader.phone else "****"
    if not has_totp:
        # No Google Authenticator — fall back to SMS OTP
        otp_code = str(random.randint(100000, 999999))
        _login_otp_codes[f"pause_{trader.email}"] = otp_code
        try:
            from app.services.sms import sms_verification_code
            sms_verification_code(trader.phone, otp_code)
        except Exception as e:
            logger.warning(f"Pause OTP SMS failed for {trader.email}: {e}")
        message = f"OTP sent to number ending {masked}"
    else:
        message = "Enter your Google Authenticator code to confirm."
    return {
        "status": "sent",
        "message": message,
        "security_question": trader.security_question or "",
        "has_totp": has_totp,
    }


class SetupTotpVerifyRequest(BaseModel):
    secret: str   # The generated secret to confirm
    code: str     # 6-digit code user entered from Google Authenticator


class SaveBinance2faRequest(BaseModel):
    secret: str   # the trader's EXISTING Binance Google Authenticator base32 secret
    code: str     # a current 6-digit code from their Binance app, to prove the secret is correct


@router.post("/binance-2fa/save")
async def save_binance_2fa(
    data: SaveBinance2faRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Store the trader's EXISTING Binance 2FA secret (so the bot can release crypto via the API
    hands-free), but ONLY after proving it's the right secret: we check it generates the code they
    just read off their Binance Authenticator. This stops a wrong/mismatched key being saved silently
    (which previously failed only later, at release time)."""
    import pyotp, base64
    secret = (data.secret or "").strip().replace(" ", "").upper()
    if not secret:
        raise HTTPException(status_code=400, detail="Paste your Binance 2FA secret key.")
    try:
        base64.b32decode(secret, casefold=True)
    except Exception:
        raise HTTPException(status_code=400, detail="That isn't a valid 2FA secret. Copy the Base32 key (letters A–Z and digits 2–7) from Binance → Security → Authenticator App → View Key.")
    if not pyotp.TOTP(secret).verify((data.code or "").strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="The code doesn't match that secret. Re-check the key and enter the CURRENT 6-digit code from your BINANCE Authenticator (not the SparkP2P one).")
    from app.core.security import encrypt_data
    trader.binance_2fa_secret = encrypt_data(secret)
    trader.binance_verify_method = "totp"
    await db.commit()
    return {"success": True, "message": "Binance 2FA verified and linked — the bot can now auto-release your crypto."}


@router.get("/setup-totp")
async def get_totp_setup(trader: Trader = Depends(get_current_trader)):
    """Generate a new TOTP secret and return the otpauth URI for QR code display."""
    import pyotp
    secret = pyotp.random_base32()
    app_name = "SparkP2P"
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=trader.email, issuer_name=app_name)
    return {"secret": secret, "uri": uri}


@router.post("/setup-totp/verify")
async def verify_and_save_totp(
    data: SetupTotpVerifyRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify the 6-digit code then save the TOTP secret to the trader's account."""
    import pyotp
    totp = pyotp.TOTP(data.secret)
    if not totp.verify(data.code.strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code. Make sure your phone's time is synced and try again.")
    # Save encrypted secret
    from app.core.security import encrypt_data
    trader.totp_secret = encrypt_data(data.secret)
    await db.commit()
    return {"success": True, "message": "Google Authenticator linked successfully."}


@router.delete("/setup-totp")
async def remove_totp(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Remove Google Authenticator from this account."""
    trader.totp_secret = None
    await db.commit()
    return {"success": True}


class VerifyTotpRequest(BaseModel):
    code: str

@router.post("/verify-totp")
async def verify_totp_code(
    data: VerifyTotpRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify a TOTP code for the current trader (used to unlock sensitive dashboard data)."""
    if not trader.totp_secret:
        raise HTTPException(status_code=400, detail="Google Authenticator not configured on this account.")
    from app.core.security import decrypt_data as decrypt_value
    try:
        secret = decrypt_value(trader.totp_secret)
    except Exception:
        secret = trader.totp_secret
    if not _verify_totp(secret, data.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid code. Please try again.")
    return {"success": True}


class PauseBotRequest(BaseModel):
    security_answer: str
    totp_code: Optional[str] = None


def _verify_totp(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code against a base32 secret (same algorithm as the desktop app)."""
    import hmac, hashlib, struct, time, base64
    try:
        secret_clean = secret.upper().replace(' ', '').replace('=', '')
        # Pad to multiple of 8
        pad = (8 - len(secret_clean) % 8) % 8
        key = base64.b32decode(secret_clean + '=' * pad)
        counter = int(time.time()) // 30
        # Check current window and ±1 for clock skew
        for offset in [-1, 0, 1]:
            msg = struct.pack('>Q', counter + offset)
            h = hmac.new(key, msg, hashlib.sha1).digest()
            o = h[19] & 0x0f
            otp = ((h[o] & 0x7f) << 24 | h[o+1] << 16 | h[o+2] << 8 | h[o+3]) % 1_000_000
            if str(otp).zfill(6) == code.strip():
                return True
        return False
    except Exception:
        return False


@router.post("/pause-bot/confirm")
async def confirm_pause_bot(data: PauseBotRequest, trader: Trader = Depends(get_current_trader)):
    """Verify security answer + Google Authenticator TOTP to authorise bot pause."""
    from app.core.security import verify_password

    if not trader.security_answer_hash or not verify_password(data.security_answer.strip().lower(), trader.security_answer_hash):
        raise HTTPException(status_code=400, detail="Incorrect security answer.")

    if trader.totp_secret:
        if not data.totp_code:
            raise HTTPException(status_code=400, detail="Google Authenticator code is required.")
        from app.core.security import decrypt_data
        try:
            totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            totp_secret = trader.totp_secret
        if not _verify_totp(totp_secret, data.totp_code):
            raise HTTPException(status_code=400, detail="Invalid Google Authenticator code.")

    return {"authorized": True}


@router.post("/disconnect-im")
async def disconnect_im(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Clear I&M Bank session."""
    trader.im_cookies = None
    trader.im_connected = False
    await db.commit()
    return {"status": "ok"}


class MpesaPortalConnectRequest(BaseModel):
    connected: bool = True


@router.post("/connect-mpesa-portal")
async def connect_mpesa_portal(
    data: MpesaPortalConnectRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Desktop app calls this once M-PESA org portal login is confirmed."""
    trader.mpesa_portal_connected = data.connected
    await db.commit()
    return {"status": "ok", "mpesa_portal_connected": data.connected}


@router.post("/disconnect-mpesa-portal")
async def disconnect_mpesa_portal(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Clear M-PESA org portal connection status."""
    trader.mpesa_portal_connected = False
    await db.commit()
    return {"status": "ok"}


@router.get("/stats/today")
async def get_today_stats(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Return 24-hour trading statistics that reset at 00:00 UTC (= 03:00 EAT), matching Binance.
    """
    # Trading day boundary from the central source of truth (00:00 UTC = 03:00 EAT).
    midnight_utc = trading_day_start()

    # Full completed history (RELEASED = sell done, COMPLETED = buy done) so today's realized
    # profit is matched against the cost basis of USDT bought on earlier days.
    orders_q = await db.execute(
        select(Order).where(
            Order.trader_id == trader.id,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )
    all_orders = orders_q.scalars().all()
    orders_today = [o for o in all_orders if o.created_at and o.created_at >= midnight_utc]

    trades_count = len(orders_today)
    usdt_traded = sum(o.crypto_amount for o in orders_today)
    kes_volume = sum(o.fiat_amount for o in orders_today)
    from collections import Counter
    currency_counts = Counter(o.crypto_currency for o in orders_today if o.crypto_currency)
    dominant_currency = currency_counts.most_common(1)[0][0] if currency_counts else 'USDT'

    # Avg rates from today's orders; profit = USDT_sold x (margin - fee) (matches Profit Tracker)
    from app.services.tracking import compute_pnl, today_realized_pnl
    _fee = trader.binance_fee_per_usdt if trader.binance_fee_per_usdt is not None else 0.25
    _pnl = compute_pnl(orders_today, _fee)
    _tp = today_realized_pnl(all_orders, fee_per_usdt=_fee)
    _pnl["gross_profit"] = _tp["gross"]
    _pnl["fees_kes"] = _tp["fees"]
    _pnl["net_profit"] = _tp["net"]
    gross_profit = _pnl["gross_profit"]

    # Treat every stats poll as a web-presence heartbeat so admin can see the trader is online
    trader.last_login = datetime.now(timezone.utc)
    await db.commit()

    return {
        "trades_count": trades_count,
        "usdt_traded": round(usdt_traded, 4),
        "kes_volume": round(kes_volume, 2),
        "gross_profit": round(gross_profit, 2),
        "avg_buy_rate": _pnl["buy"]["avg_rate"],
        "avg_sell_rate": _pnl["sell"]["avg_rate"],
        "fees_kes": _pnl["fees_kes"],
        "net_profit": _pnl["net_profit"],
        "reset_at": midnight_utc.isoformat(),
        "dominant_currency": dominant_currency,
    }


class PinChangeVerifyRequest(BaseModel):
    otp_code: str
    totp_code: str = None


@router.post("/verify-pin-change")
async def verify_pin_change(data: PinChangeVerifyRequest, trader: Trader = Depends(get_current_trader)):
    """Verify OTP + TOTP (no security answer) before allowing I&M PIN change."""
    from app.api.routes.auth import _login_otp_codes

    stored = _login_otp_codes.get(f"pause_{trader.email}")
    if not stored or stored != data.otp_code:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP code.")

    if trader.totp_secret:
        if not data.totp_code:
            raise HTTPException(status_code=400, detail="Google Authenticator code is required.")
        from app.core.security import decrypt_data
        try:
            totp_secret = decrypt_data(trader.totp_secret)
        except Exception:
            totp_secret = trader.totp_secret
        if not totp_secret or not _verify_totp(totp_secret, data.totp_code):
            raise HTTPException(status_code=400, detail="Invalid Google Authenticator code.")

    del _login_otp_codes[f"pause_{trader.email}"]
    return {"authorized": True}


@router.get("/rate-limit")
async def get_rate_limit(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Daily rate-limit status for the dashboard: trades + Telegram alerts vs the trader's
    subscription-tier caps, with the reset time (03:00 EAT). Used to show usage + a 'limit
    reached' countdown when exhausted."""
    from app.services.rate_limits import trade_rate_status, tg_rate_status
    from app.services.plans import active_plan, plan_label
    from app.services.enforcement import billing_active
    plan = await active_plan(db, trader.id)
    trades = await trade_rate_status(db, trader)
    telegram = tg_rate_status(plan, trader)
    active = await billing_active(db, trader)
    # locked = subscription expired (everything paid is off). daily_trade_blocked = subscribed but
    # today's trade cap is reached (only new trades are blocked; rest of the app stays usable).
    return {
        "plan": plan.value if plan else None,
        "plan_label": plan_label(plan),
        "trades": trades,
        "telegram": telegram,
        "billing_active": active,
        "locked": (not active),
        "exempt": bool(getattr(trader, "billing_exempt", False)),
        "daily_trade_blocked": bool(active and not trades.get("allowed", True)),
    }


# ── Ad automation: which of a merchant's Binance ads the bot runs, per side ────

@router.get("/ads")
async def list_ads(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """The merchant's live Binance ads, each with its automation mode. A mode of
    null means 'default' — the ad follows the trader's global bot_trade_mode
    (i.e. it IS automated, exactly as today). Only ads with a saved override
    differ."""
    from app.models.ad_automation import AdAutomation

    configs = {r.adv_no: r.mode for r in (await db.execute(
        select(AdAutomation).where(AdAutomation.trader_id == trader.id)
    )).scalars().all()}

    def _shape(ad):
        adv = ad.get("advNo") or ad.get("adsNo")
        if not adv:
            return None
        return {
            "adv_no": str(adv),
            "trade_type": (ad.get("tradeType") or ad.get("advType") or "").upper(),  # BUY | SELL
            "asset": ad.get("asset"),
            "fiat": ad.get("fiatUnit") or ad.get("fiat"),
            "price": ad.get("price") or (ad.get("adv", {}) or {}).get("price"),
            "status": ad.get("advStatus"),                       # 1=online, 3=offline
            "surplus": ad.get("surplusAmount"),
            "mode": configs.get(str(adv)),                       # None = default
        }

    ads_out, connected, err = [], False, None

    # 1) HMAC API key (via the relay) — PRIMARY. It's the reliable, canonical way
    #    to read a merchant's ads: signed, IP-routed through the desktop, no
    #    browser-session fragility. A valid key makes this the one true path.
    if trader.binance_api_key and trader.binance_api_secret:
        try:
            from app.core.security import decrypt_data
            from app.services.binance.sapi_client import get_merchant_ads, relay_trader, BinanceApiError, friendly_binance_error
            relay_trader.set(trader.id)
            try:
                ads = await get_merchant_ads(decrypt_data(trader.binance_api_key),
                                             decrypt_data(trader.binance_api_secret))
                connected = True
                ads_out = [s for s in (_shape(a) for a in (ads or [])) if s]
            except BinanceApiError as be:
                # e.g. -2008 dead key. Remember the reason, then try the cookie
                # session below so a merchant with a dead key still sees ads.
                connected = True
                err = friendly_binance_error(be.code, be.msg)
                logger.warning("list_ads: Binance rejected key for trader %s: %s", trader.id, be)
        except Exception as e:
            err = str(e)
            logger.warning("list_ads: HMAC ads fetch failed for trader %s: %s", trader.id, e)

    # 2) Cookie session — FALLBACK only. Used when there's no key or the key was
    #    rejected, so trading (which runs on the browser session) still surfaces
    #    ads here. If this succeeds we clear the key error, since ads DID load.
    if not ads_out and trader.binance_connected and trader.binance_cookies:
        try:
            from app.services.binance.client import BinanceP2PClient
            ads = await BinanceP2PClient.from_trader(trader).get_my_ads()
            connected = True
            ads_out = [s for s in (_shape(a) for a in (ads or [])) if s]
            if ads_out:
                err = None
        except Exception as e:
            logger.warning("list_ads: cookie get_my_ads fallback failed for trader %s: %s", trader.id, e)

    return {
        "connected": connected,
        "global_mode": trader.bot_trade_mode or "both",
        "ads": ads_out,
        "error": err,
    }


class AdModeRequest(BaseModel):
    mode: str   # 'both' | 'buy_only' | 'sell_only' | 'off' | 'default'


@router.put("/ads/{adv_no}")
async def set_ad_mode(
    adv_no: str,
    data: AdModeRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Set one ad's automation mode. 'default' clears the override so the ad
    follows the global mode again. Anything else pins it."""
    from app.models.ad_automation import AdAutomation, AD_MODES

    mode = (data.mode or "").strip()
    if mode not in AD_MODES and mode != "default":
        raise HTTPException(status_code=400, detail=f"mode must be one of {AD_MODES} or 'default'")

    existing = (await db.execute(
        select(AdAutomation).where(AdAutomation.trader_id == trader.id,
                                   AdAutomation.adv_no == str(adv_no))
    )).scalar_one_or_none()

    if mode == "default":
        if existing:
            await db.delete(existing)
    elif existing:
        existing.mode = mode
    else:
        db.add(AdAutomation(trader_id=trader.id, adv_no=str(adv_no), mode=mode))
    await db.commit()
    return {"ok": True, "adv_no": str(adv_no), "mode": None if mode == "default" else mode}
