from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean
from app.core.database import Base


class PaybillStatement(Base):
    """Scraped M-PESA paybill transactions from org.ke.m-pesa.com statement page.
    Deduped by mpesa_ref. Merged with the payments table in admin views."""
    __tablename__ = "paybill_statement"

    id = Column(Integer, primary_key=True, index=True)
    mpesa_ref = Column(String(100), unique=True, index=True, nullable=False)  # M-PESA receipt/ref number
    direction = Column(String(20), nullable=False)   # inbound | outbound
    amount = Column(Float, nullable=False)
    phone = Column(String(100), nullable=True)
    counterparty_name = Column(String(255), nullable=True)
    balance_after = Column(Float, nullable=True)
    transaction_type = Column(String(50), nullable=True)   # C2B, B2B, withdrawal, etc.
    remarks = Column(String(500), nullable=True)
    transaction_at = Column(DateTime(timezone=True), nullable=True)  # actual M-PESA timestamp
    synced_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    source = Column(String(20), default='portal_sync')  # portal_sync | manual
