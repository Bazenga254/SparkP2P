import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Float, Enum, DateTime, Text, ForeignKey, JSON
)
from app.core.database import Base


class OrderSide(str, enum.Enum):
    SELL = "sell"  # Merchant selling crypto, buyer pays KES
    BUY = "buy"   # Merchant buying crypto, merchant pays KES


class OrderStatus(str, enum.Enum):
    PENDING = "pending"           # Waiting for payment
    PAYMENT_RECEIVED = "payment_received"  # KES confirmed (sell side)
    PAYMENT_SENT = "payment_sent"  # KES sent to seller (buy side)
    RELEASING = "releasing"       # Auto-release in progress
    RELEASED = "released"         # Crypto released on Binance
    SETTLING = "settling"         # Settlement in progress
    COMPLETED = "completed"       # Fully done
    DISPUTED = "disputed"        # Flagged for manual review
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    # Binance P2P details
    binance_order_number = Column(String(100), unique=True, index=True, nullable=False)
    binance_ad_number = Column(String(100), nullable=True)
    side = Column(Enum(OrderSide), nullable=False)

    # Trade details
    crypto_amount = Column(Float, nullable=False)       # e.g., 50.0
    crypto_currency = Column(String(10), nullable=False)  # USDT, BTC
    fiat_amount = Column(Float, nullable=False)          # e.g., 6500.0
    exchange_rate = Column(Float, nullable=False)         # e.g., 130.0

    # Payment matching (sell side)
    account_reference = Column(String(100), unique=True, index=True)  # P2P-T001-98765
    unique_amount = Column(Float, nullable=True)  # Fallback matching

    # Buyer/Seller info (from Binance)
    counterparty_name = Column(String(255), nullable=True)
    counterparty_phone = Column(String(20), nullable=True)

    # Buy side payment details (parsed from Binance)
    seller_payment_method = Column(String(50), nullable=True)  # mpesa, bank
    seller_payment_destination = Column(String(100), nullable=True)  # Phone or account
    seller_payment_name = Column(String(255), nullable=True)

    # Status tracking
    status = Column(Enum(OrderStatus), default=OrderStatus.PENDING, index=True)

    # Timestamps
    payment_confirmed_at = Column(DateTime(timezone=True), nullable=True)
    payment_sent_at = Column(DateTime(timezone=True), nullable=True)      # Buy side
    released_at = Column(DateTime(timezone=True), nullable=True)
    settled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Fees
    platform_fee = Column(Float, default=15.0)  # KES
    settlement_fee = Column(Float, default=0.0)  # KES

    # AI fraud check
    risk_score = Column(Float, nullable=True)  # 0-100
    fraud_check_result = Column(JSON, nullable=True)
