"""
ImSweep — tracks automatic M-Pesa → I&M Bank sweeps triggered on trader withdrawals.

Every time a trader withdraws, the system calls Daraja B2B (BusinessPayBill) to
transfer the equivalent amount from SparkP2P's M-Pesa paybill into SparkP2P's I&M
Bank account, keeping the I&M balance funded for outgoing bank transfers.
"""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, Float, String, DateTime, ForeignKey
from app.core.database import Base


class ImSweep(Base):
    __tablename__ = "im_sweeps"

    id = Column(Integer, primary_key=True, index=True)

    # The withdrawal that triggered this sweep
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=True, index=True)
    withdrawal_tx_id = Column(Integer, ForeignKey("wallet_transactions.id"), nullable=True)

    # Sweep amount (same as the trader's gross withdrawal amount)
    amount = Column(Float, nullable=False)

    # M-Pesa B2B identifiers returned by Daraja
    mpesa_conversation_id = Column(String(100), nullable=True, index=True)
    mpesa_originator_id = Column(String(100), nullable=True)

    # "pending" → "completed" | "failed"
    status = Column(String(20), default="pending", nullable=False, index=True)
    failure_reason = Column(String(500), nullable=True)

    # Destination
    sweep_paybill = Column(String(20), nullable=True)   # I&M paybill used
    sweep_account = Column(String(50), nullable=True)   # I&M account credited

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    completed_at = Column(DateTime(timezone=True), nullable=True)
