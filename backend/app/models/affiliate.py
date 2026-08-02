import enum
from datetime import datetime, timezone, date

from sqlalchemy import (
    Column, Integer, String, Float, Boolean, Enum, DateTime, Date,
    ForeignKey, Text
)
from app.core.database import Base


class AffiliateStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class AffiliatePayoutStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"


class Affiliate(Base):
    __tablename__ = "affiliates"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), unique=True, nullable=False, index=True)
    status = Column(Enum(AffiliateStatus), default=AffiliateStatus.PENDING, nullable=False)
    referral_code = Column(String(20), unique=True, nullable=True, index=True)  # set on approval

    # Per-merchant switch (opt-in). The master AFFILIATES_ENABLED flag reveals the
    # PROGRAM; this decides whether THIS merchant sees their affiliate dashboard.
    # Defaults False: admin turns it on per merchant from the Affiliates list.
    visible = Column(Boolean, default=False, nullable=False)

    applied_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    approved_at = Column(DateTime(timezone=True), nullable=True)
    rejected_at = Column(DateTime(timezone=True), nullable=True)
    rejection_reason = Column(Text, nullable=True)

    # Running balance of unpaid commissions (KES)
    pending_balance = Column(Float, default=0.0)
    total_earned = Column(Float, default=0.0)
    total_paid_out = Column(Float, default=0.0)


class AffiliateEarning(Base):
    """One row per completed order that generated a commission."""
    __tablename__ = "affiliate_earnings"

    id = Column(Integer, primary_key=True, index=True)
    affiliate_id = Column(Integer, ForeignKey("affiliates.id"), nullable=False, index=True)
    referred_trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False, index=True)

    order_fee = Column(Float, nullable=False)      # total fee taken from the order
    commission = Column(Float, nullable=False)     # 10% of order_fee
    week_start = Column(Date, nullable=False)      # Monday of the week this earning belongs to

    paid_out = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class AffiliatePayout(Base):
    """Weekly payout record (created every Friday for qualifying affiliates)."""
    __tablename__ = "affiliate_payouts"

    id = Column(Integer, primary_key=True, index=True)
    affiliate_id = Column(Integer, ForeignKey("affiliates.id"), nullable=False, index=True)

    amount = Column(Float, nullable=False)
    week_start = Column(Date, nullable=False)
    week_end = Column(Date, nullable=False)
    status = Column(Enum(AffiliatePayoutStatus), default=AffiliatePayoutStatus.PENDING)

    paid_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
