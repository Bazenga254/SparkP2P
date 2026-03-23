import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Float, Enum, DateTime, Text, ForeignKey, JSON
)
from app.core.database import Base


class PaymentDirection(str, enum.Enum):
    INBOUND = "inbound"    # C2B - buyer paying us
    OUTBOUND = "outbound"  # B2C/B2B - us paying seller/trader


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"
    REVERSED = "reversed"


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    direction = Column(Enum(PaymentDirection), nullable=False)

    # M-Pesa transaction details
    mpesa_transaction_id = Column(String(100), unique=True, index=True)
    mpesa_receipt_number = Column(String(100), nullable=True)
    transaction_type = Column(String(50), nullable=True)  # C2B, B2C, B2B

    # Payment details
    amount = Column(Float, nullable=False)
    phone = Column(String(20), nullable=True)
    bill_ref_number = Column(String(100), nullable=True)  # Account number for C2B
    sender_name = Column(String(255), nullable=True)

    # For outbound payments (B2C/B2B)
    destination = Column(String(100), nullable=True)  # Phone, Paybill+Acc
    destination_type = Column(String(20), nullable=True)  # mpesa, bank_paybill, till
    remarks = Column(String(255), nullable=True)  # "Payment from John Doe"

    # Status
    status = Column(Enum(PaymentStatus), default=PaymentStatus.PENDING)

    # Raw callback data for debugging
    raw_callback = Column(JSON, nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
