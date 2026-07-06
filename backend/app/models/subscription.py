from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Enum as SAEnum, ForeignKey
from datetime import datetime, timezone
import enum
from app.core.database import Base


class SubscriptionPlan(str, enum.Enum):
    STARTER = "starter"
    PRO = "pro"
    PRO_MAX = "pro_max"
    ADVANCED = "advanced"


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "active"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    PENDING = "pending"


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False)
    plan = Column(SAEnum(SubscriptionPlan), nullable=False)
    status = Column(SAEnum(SubscriptionStatus), default=SubscriptionStatus.PENDING)
    amount = Column(Float, nullable=False)  # KES 5000 or 10000

    started_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)

    # M-Pesa payment reference
    mpesa_transaction_id = Column(String(50), nullable=True)
    mpesa_checkout_id = Column(String(100), nullable=True)

    # Expiry-reminder idempotency — set when each pre-expiry reminder has been sent.
    # reminder_5d_sent = 3-day reminder (repurposed; old name kept to avoid migration of existing rows).
    # reminder_3d_sent = 2-day reminder (repurposed).
    # reminder_1d_sent = 1-day reminder (new column).
    reminder_5d_sent = Column(Boolean, default=False, server_default="false")
    reminder_3d_sent = Column(Boolean, default=False, server_default="false")
    reminder_1d_sent = Column(Boolean, default=False, server_default="false")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    @property
    def is_active(self):
        if self.status != SubscriptionStatus.ACTIVE:
            return False
        if self.expires_at and datetime.now(timezone.utc) > self.expires_at:
            return False
        return True
