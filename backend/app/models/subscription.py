from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Enum as SAEnum, ForeignKey
from datetime import datetime, timezone
import enum
from app.core.database import Base


class SubscriptionPlan(str, enum.Enum):
    STARTER = "starter"
    PRO = "pro"


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

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    @property
    def is_active(self):
        if self.status != SubscriptionStatus.ACTIVE:
            return False
        if self.expires_at and datetime.now(timezone.utc) > self.expires_at:
            return False
        return True
