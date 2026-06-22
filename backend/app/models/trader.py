import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Boolean, Float, Enum, DateTime, Text, JSON, Numeric, BigInteger
)
from app.core.database import Base


class SettlementMethod(str, enum.Enum):
    MPESA = "mpesa"
    BANK_PAYBILL = "bank_paybill"
    TILL = "till"
    PAYBILL = "paybill"


class TraderStatus(str, enum.Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    SUSPENDED = "suspended"
    PENDING = "pending"


class Trader(Base):
    __tablename__ = "traders"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    phone = Column(String(20), unique=True, index=True, nullable=False)
    full_name = Column(String(255), nullable=False)
    password_hash = Column(String(255), nullable=False)

    # Binance connection (encrypted)
    binance_cookies = Column(Text, nullable=True)  # Encrypted JSON {name: value}
    binance_cookies_full = Column(Text, nullable=True)  # Encrypted JSON [{name, value, domain, path, secure, httpOnly, sameSite}, ...] for Playwright
    binance_csrf_token = Column(String(512), nullable=True)  # Encrypted
    binance_2fa_secret = Column(String(512), nullable=True)  # Encrypted
    binance_bnc_uuid = Column(String(512), nullable=True)  # Encrypted
    binance_uid = Column(String(100), nullable=True)
    binance_username = Column(String(100), nullable=True)
    google_id = Column(String(100), nullable=True, default="")
    binance_connected = Column(Boolean, default=False)
    last_extension_sync = Column(DateTime(timezone=True), nullable=True)
    tracking_started_at = Column(DateTime(timezone=True), nullable=True)  # bot first activated
    tracking_high_water = Column(BigInteger, nullable=True)  # ms createTime of last counted order
    tracking_last_poll_at = Column(DateTime(timezone=True), nullable=True)
    binance_fund_password = Column(String(512), nullable=True)  # Encrypted
    binance_verify_method = Column(String(20), default="none")  # none, totp, fund_password, manual
    gmail_email = Column(String(255), nullable=True)           # Gmail for OTP scanning
    gmail_cookies = Column(Text, nullable=True)                # Encrypted Gmail session cookies

    # Security question (set during registration, cannot be changed)
    security_question = Column(String(255), nullable=True)
    security_answer_hash = Column(String(255), nullable=True)
    security_answer_plain = Column(String(255), nullable=True)  # Plain text for admin verification

    # Google Authenticator TOTP
    totp_secret = Column(String(255), nullable=True)   # Encrypted TOTP secret (None = not configured)

    # Settlement config (active — used for actual withdrawals)
    settlement_method = Column(Enum(SettlementMethod), default=SettlementMethod.MPESA)
    settlement_phone = Column(String(20), nullable=True)
    settlement_paybill = Column(String(20), nullable=True)
    settlement_account = Column(String(100), nullable=True)
    settlement_bank_name = Column(String(100), nullable=True)

    # Pending settlement (waiting 48hr cooldown before becoming active)
    pending_settlement_method = Column(String(50), nullable=True)
    pending_settlement_phone = Column(String(20), nullable=True)
    pending_settlement_paybill = Column(String(20), nullable=True)
    pending_settlement_account = Column(String(100), nullable=True)
    pending_settlement_bank_name = Column(String(100), nullable=True)
    settlement_changed_at = Column(DateTime(timezone=True), nullable=True)

    # Choice Bank → external bank withdrawal destination
    cb_withdrawal_bank_name    = Column(String(100), nullable=True)
    cb_withdrawal_bank_code    = Column(String(20),  nullable=True)   # CBK/Choice bank code
    cb_withdrawal_account      = Column(String(50),  nullable=True)   # account number
    cb_withdrawal_account_name = Column(String(100), nullable=True)   # account holder name
    cb_withdrawal_changed_at   = Column(DateTime(timezone=True),  nullable=True)   # last save timestamp (48h cooldown anchor)

    # Billing enforcement: exempt accounts (admins/test/grandfathered) bypass subscription gating
    # and are never locked out / config-wiped on expiry.
    billing_exempt = Column(Boolean, default=False, server_default="false")

    # Trading config
    auto_release_enabled = Column(Boolean, default=True)
    auto_pay_enabled = Column(Boolean, default=True)  # Buy side auto-payment
    daily_trade_limit = Column(Integer, default=200)
    max_single_trade = Column(Integer, default=500000)  # KES
    spread_percentage = Column(Float, default=2.0)

    # Bot trade mode: 'both' | 'buy_only' | 'sell_only'
    bot_trade_mode = Column(String(20), default='both')

    # Counterparty due diligence / screening
    dd_enabled = Column(Boolean, default=False)
    dd_min_30d_trades = Column(Integer, default=20)   # Tier 1 — hard requirement
    dd_min_all_trades = Column(Integer, default=0)    # Tier 2 — 0 = not enforced
    dd_auto_cancel_new = Column(Boolean, default=False)  # Auto-cancel brand-new accounts

    # Batch settlement config
    batch_settlement_enabled = Column(Boolean, default=True)
    batch_threshold = Column(Integer, default=50000)  # KES - settle when balance hits this
    batch_interval_hours = Column(Integer, default=6)  # Or settle every X hours

    # Status
    status = Column(Enum(TraderStatus), default=TraderStatus.PENDING)
    is_admin = Column(Boolean, default=False)
    role = Column(String(20), default="trader")  # trader, employee, admin

    # Stats
    total_trades = Column(Integer, default=0)
    total_volume = Column(Float, default=0.0)
    success_rate = Column(Float, default=100.0)
    trust_score = Column(Float, default=50.0)  # AI-managed, 0-100

    # Tier (affects per-trade fee)
    tier = Column(String(20), default="standard")  # standard, silver, gold

    # I&M Bank connection (encrypted session cookies)
    im_cookies = Column(Text, nullable=True)       # Encrypted JSON session cookies
    im_connected = Column(Boolean, default=False)  # True once desktop app syncs a live session

    # M-PESA org portal connection
    mpesa_portal_connected = Column(Boolean, default=False)  # True once desktop app logs into org portal

    # Vision-scraped ad prices (updated every ~1 min by the desktop bot)
    ad_buy_price = Column(Float, nullable=True)    # Trader's current Binance buy ad price
    ad_sell_price = Column(Float, nullable=True)   # Trader's current Binance sell ad price
    ad_prices_updated_at = Column(DateTime(timezone=True), nullable=True)

    # Bot online/offline state — set by desktop app on graceful shutdown
    bot_intentionally_stopped = Column(Boolean, default=False)

    # Admin-gated feature: live Binance P2P competitor price tracker on the merchant dashboard
    price_tracker_enabled = Column(Boolean, default=False, server_default="false")

    # The merchant's public Binance P2P nickname, auto-detected from their API (for the price tracker
    # "your rank" view). Cached because it's stable and the relay isn't always online.
    binance_nickname = Column(String(64), nullable=True)

    # Real Binance P2P tier detected from the public board (gold/silver/bronze, or 'normal' for a
    # non-merchant). Drives the sidebar badge — only shown for confirmed merchants. NULL = unknown.
    binance_p2p_tier = Column(String(10), nullable=True)

    # Price-monitor (Phase 2 Monitor) — merchant's rank-alert settings.
    pm_enabled = Column(Boolean, default=False, server_default="false")
    pm_target_rank = Column(Integer, default=1)
    pm_scope = Column(String(10), default="all")        # 'all' = whole table | 'tier' = within my tier
    pm_alert_drop = Column(Boolean, default=True, server_default="true")
    pm_alert_top1 = Column(Boolean, default=False, server_default="false")
    pm_alert_overtaken = Column(Boolean, default=False, server_default="false")
    pm_alert_summary = Column(Boolean, default=False, server_default="false")
    pm_alert_reached = Column(Boolean, default=False, server_default="false")   # reached/regained target rank
    pm_alert_anomaly = Column(Boolean, default=False, server_default="false")   # aggressive-market advisory

    # Competitor watchlist — track named merchants and alert when their board rank moves.
    pm_alert_watchlist = Column(Boolean, default=True, server_default="true")
    pm_watchlist = Column(JSON, nullable=True)   # list[str] of competitor Binance nicknames

    # Cost-basis sell-down mode (see docs/cost-basis-mode.md) — never price below what they paid.
    cb_enabled = Column(Boolean, default=False, server_default="false")
    cb_starting_stock = Column(Float, default=0.0)    # USDT held at cb_set_at
    cb_starting_cost = Column(Float, default=0.0)     # KES/USDT avg cost of that stock
    cb_set_at = Column(DateTime(timezone=True), nullable=True)   # baseline timestamp (one-time entry)
    cb_cleared_buffer = Column(Float, default=50.0)   # inventory below this = "stock depleted"

    # Auto-pricing (Phase 2 — the bot adjusts price to hold target rank within a KES margin band).
    pm_autoprice = Column(String(10), default="off")          # 'off' | 'sim' (preview) | 'live'
    pm_margin_min = Column(Float, default=0.0)                # KES per USDT — hard profit floor
    pm_margin_max = Column(Float, default=0.0)                # KES per USDT — most generous margin (when uncontested)
    pm_autoprice_error = Column(String(255), nullable=True)  # last hard failure reason (e.g. Binance -1002 not authorized)

    # Employee permissions (JSON object, only relevant when role="employee")
    # e.g. {"disputes": true, "orders": true, "chat": true, "transactions": false, "withdrawals": false}
    permissions = Column(JSON, nullable=True)

    # Binance merchant tier (gold/silver/bronze — determines per-trade fee on Binance)
    binance_merchant_tier = Column(String(10), nullable=True)  # 'gold', 'silver', 'bronze'

    # Binance SAPI credentials (encrypted) — required for counterparty filter pushes via EP-7
    binance_api_key    = Column(String(512), nullable=True)   # Encrypted
    binance_api_key_invalid = Column(Boolean, default=False)  # True if Binance rejects the key (-2008)
    binance_api_secret = Column(String(512), nullable=True)   # Encrypted

    # Counterparty filters — pushed to Binance ad via EP-7 when cf_filters_enabled=True
    cf_filters_enabled        = Column(Boolean, default=False)
    cf_completion_rate_min    = Column(Float,   default=0.0)   # ratio 0.0–1.0 (e.g. 0.80 = 80%)
    cf_completion_rate_window = Column(Integer, default=2)     # 1=Last 30D, 2=All-time
    cf_all_trades_min         = Column(Integer, default=0)
    cf_trade_count_window     = Column(Integer, default=2)     # 1=Last 30D, 2=All-time
    cf_completed_trades_min   = Column(Integer, default=0)
    cf_buy_trades_min         = Column(Integer, default=0)
    cf_sell_trades_min        = Column(Integer, default=0)
    cf_volume_min             = Column(Float,   default=0.0)
    cf_volume_asset           = Column(String(10), default='USDT')
    cf_volume_window          = Column(Integer, default=2)     # 1=Last 30D, 2=All-time
    cf_all_trades_min_all     = Column(Integer, default=0)
    cf_reg_days_min           = Column(Integer, default=0)
    cf_max_pay_mins           = Column(Integer, default=0)   # flag buyers slower than this avg pay time (0=off)
    cf_max_release_mins       = Column(Integer, default=0)   # flag sellers slower than this avg release time (0=off)
    cf_last_pushed_at         = Column(DateTime(timezone=True), nullable=True)

    # Profit calc: Binance fee deducted from the gross margin, in KES per USDT (net margin =
    # avg_sell - avg_buy - this). It is the CUMULATIVE both-sides fee: Binance charges ~0.1% per
    # side, so at ~129 KES/USDT that's 0.129 x 2 = ~0.258, rounded down to a safe flat 0.25.
    # Configurable in case Binance's fee changes. Default 0.25.
    binance_fee_per_usdt      = Column(Float, default=0.25)

    # Affiliate referral tracking
    referred_by_code = Column(String(20), nullable=True)  # referral code used at sign-up

    # Choice Bank BaaS sub-account
    choice_account_id = Column(String(100), nullable=True, index=True)  # Choice Bank internal account ID
    choice_account_number = Column(String(50), nullable=True, index=True)  # Account number for receiving payments
    choice_kyc_status = Column(String(100), nullable=True)      # approved/rejected, or pending:<onboardingId> / onboarding:<onboardingId>

    # Telegram integration
    telegram_chat_id = Column(String(50), nullable=True)  # Set when trader links via /link command
    telegram_approval_enabled = Column(Boolean, default=False)  # Require Telegram YES/NO for every sell order
    telegram_notify_scope = Column(String(8), default='both')  # which alerts to send: both | sell | buy
    # Daily Telegram-alert rate limit (per subscription tier). Counter resets at the trading-day
    # boundary (00:00 UTC); tg_alerts_day holds the YYYY-MM-DD it currently counts.
    tg_alerts_count = Column(Integer, default=0)
    tg_alerts_day = Column(String(10), nullable=True)

    # (Credit / trade-token system retired — replaced by subscription tiers + daily rate limits.)

    # Login security
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime(timezone=True), nullable=True)
    last_login = Column(DateTime(timezone=True), nullable=True)
    last_login_ip = Column(String(64), nullable=True)                # last sign-in IP — for new-device detection
    last_web_active = Column(DateTime(timezone=True), nullable=True)  # last dashboard heartbeat — live web presence
    audit_seen_at = Column(DateTime(timezone=True), nullable=True)    # super admin: last time they viewed the audit log (for the unread badge)
    live_today_net_profit = Column(Numeric(14, 2), default=0)  # cached daily live Binance stats (for admin)
    live_today_volume     = Column(Numeric(16, 2), default=0)
    live_today_trades     = Column(Integer, default=0)
    live_stats_date       = Column(DateTime(timezone=True), nullable=True)
    live_stats_at         = Column(DateTime(timezone=True), nullable=True)
    live_alltime_volume   = Column(Numeric(18, 2), default=0)
    live_alltime_trades   = Column(Integer, default=0)
    live_alltime_at       = Column(DateTime(timezone=True), nullable=True)
    pending_orders_count  = Column(Integer, default=0, server_default="0")  # live in-progress (non-terminal) Binance orders, refreshed each poll
    password_changed_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
