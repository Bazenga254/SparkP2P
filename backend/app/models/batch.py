from datetime import datetime, timezone
from sqlalchemy import Column, Integer, Float, String, DateTime, ForeignKey, Boolean
from app.core.database import Base


class WithdrawalBatch(Base):
    """
    One per hourly cycle. Collects all pending bank-trader withdrawals,
    then triggers a single M-PESA sweep + parallel I&M disbursements.

    Status lifecycle:
      collecting → sweeping → disbursing → completed | failed
    """
    __tablename__ = "withdrawal_batches"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String(20), default="collecting", nullable=False, index=True)
    total_amount = Column(Float, default=0.0, nullable=False)

    alerted = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    closed_at = Column(DateTime(timezone=True), nullable=True)    # when stopped accepting
    swept_at = Column(DateTime(timezone=True), nullable=True)     # when M-PESA sweep done
    completed_at = Column(DateTime(timezone=True), nullable=True) # when all transfers done


class BatchItem(Base):
    """
    Individual trader disbursement within a WithdrawalBatch.
    One item per trader per batch.

    Status lifecycle:
      queued → processing → completed | failed
    """
    __tablename__ = "batch_items"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("withdrawal_batches.id"), nullable=False, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    wallet_tx_id = Column(Integer, ForeignKey("wallet_transactions.id"), nullable=True)

    gross_amount = Column(Float, nullable=False)    # full withdrawal (before fees)
    net_amount = Column(Float, nullable=False)      # what trader receives after fees
    fee_amount = Column(Float, nullable=False)      # total fee deducted

    destination = Column(String(200), nullable=True)      # I&M account number
    destination_name = Column(String(200), nullable=True) # trader's registered name

    status = Column(String(20), default="queued", nullable=False, index=True)
    failure_reason = Column(String(500), nullable=True)
    im_reference = Column(String(100), nullable=True)  # I&M txn ref after success
    retry_count = Column(Integer, default=0, nullable=False)
    alerted = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    completed_at = Column(DateTime(timezone=True), nullable=True)
