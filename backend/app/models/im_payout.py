"""I&M payout display-ledger.

A record of every payout the I&M Bot reports for a SparkP2P client, written on
each /im-bot/result. It exists ONLY to surface I&M payouts on the merchant's
Transactions dashboard (completed / failed / pending) alongside their Choice Bank
movements.

Deliberately SEPARATE from the Payment table: Choice Bank balance and the admin
revenue/fee reports aggregate Payment rows by direction with no transaction_type
filter (e.g. admin.py sums all OUTBOUND payments), so an I&M row in Payment would
silently corrupt those figures. It is also separate from im_charges, which is the
billing ledger (successful, billed payouts only — no failed/pending, no rail).
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint

from app.core.database import Base


class ImPayout(Base):
    __tablename__ = "im_payouts"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    binance_order_number = Column(String(64), nullable=False, index=True)

    amount = Column(Integer, nullable=False, default=0)   # KES paid (or attempted)
    channel = Column(String(8), nullable=True)            # MPESA | BANK (PesaLink)
    status = Column(String(12), nullable=False)           # completed | failed | pending
    bank_ref = Column(String(64), nullable=True)          # I&M reference, when there is one
    destination = Column(String(120), nullable=True)      # seller's phone / account
    detail = Column(String(255), nullable=True)           # error text / note (failed/unknown)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # One row per order per trader — a retried FAILED that later succeeds UPDATES
    # the same row (failed -> completed) instead of adding a duplicate line.
    __table_args__ = (
        UniqueConstraint("trader_id", "binance_order_number", name="uq_im_payout_trader_order"),
    )
