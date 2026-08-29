"""Standing orders — merchant-scheduled recurring Choice Bank transfers.

Choice Bank's API has NO native standing-order endpoint; every transfer executes
immediately. So a standing order is OUR construct: a saved instruction (payee +
amount + schedule) that the standing_order_poller fires on the due date through
the SAME money path as a manual Send-Money transfer (choice.transfer -> send_otp
-> SMS-relay auto-confirm -> confirm_otp -> ledger + notify). No parallel money
path — see [[project_sparkp2p]] auto_withdraw for the pattern reused here.

Money moves UNATTENDED on the run day, so creation is guarded (validateAccount
name-verify + TOTP) and the executor is gated behind settings.STANDING_ORDERS_ENABLED.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, Time, ForeignKey

from app.core.database import Base


class StandingOrder(Base):
    __tablename__ = "standing_orders"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), index=True, nullable=False)

    # ── Payee (one of three rails) ──────────────────────────────────────────
    # rail: 'pesalink' (external bank) | 'mpesa' (B2C phone) | 'choice' (internal)
    rail = Column(String(12), nullable=False)
    payee_account = Column(String(64), nullable=False)   # bank a/c no | 9-digit phone | Choice a/c id
    payee_name = Column(String(120), nullable=False)
    payee_bank_code = Column(String(20), nullable=True)  # PesaLink CBK code; 'M-PESA' for mpesa; '' for choice
    payee_bank_name = Column(String(120), nullable=True)
    amount = Column(Float, nullable=False)
    remark = Column(String(140), nullable=True)

    # ── Schedule ────────────────────────────────────────────────────────────
    # schedule_type: 'monthly' (schedule_day = 1..31) | 'weekly' (schedule_day = 0..6, Mon=0)
    #              | 'once' (run_date set, deactivates after firing)
    schedule_type = Column(String(10), nullable=False)
    schedule_day = Column(Integer, nullable=True)
    run_date = Column(Date, nullable=True)               # for 'once'
    run_time = Column(Time, nullable=True)               # EAT wall-clock time to run (None → early morning)
    next_run_on = Column(Date, nullable=False, index=True)  # the date the next run is due (EAT)

    active = Column(Boolean, default=True, nullable=False)

    # ── Run tracking ────────────────────────────────────────────────────────
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    last_status = Column(String(20), nullable=True)      # success | skipped_no_funds | failed
    last_error = Column(String(300), nullable=True)
    last_tx_id = Column(String(64), nullable=True)
    run_count = Column(Integer, default=0, nullable=False)
    # A skip/fail only notifies once per due date (avoid daily-retry spam).
    last_notified_on = Column(Date, nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
