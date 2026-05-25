import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Boolean, Float, Enum, DateTime, Text, JSON
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
    binance_fund_password = Column(String(512), nullable=True)  # Encrypted
    binance_verify_method = Column(String(20), default="none")  # none, totp, fund_password, manual
    gmail_email = Column(String(255), nullable=True)           # Gmail for OTP scanning
    gmail_cookies = Column(Text, nullable=True)                # Encrypted Gmail session cookies

    # Security question (set during registration, cannot be changed)
    security_question = Column(String(255), nullable=True)
    security_answer_hash = Column(String(255), nullable=True)
    security_answer_plain = Column(String(255), nullable=True)  # Plain text for admin verification

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

    # Trading config
    auto_release_enabled = Column(Boolean, default=True)
    auto_pay_enabled = Column(Boolean, default=True)  # Buy side auto-payment
    daily_trade_limit = Column(Integer, default=200)
    max_single_trade = Column(Integer, default=500000)  # KES
    spread_percentage = Column(Float, default=2.0)

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

    # Login security
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime(timezone=True), nullable=True)
    last_login = Column(DateTime(timezone=True), nullable=True)
    password_changed_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
