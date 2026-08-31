from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from datetime import datetime, timezone
from app.core.database import Base


class AccountShareLink(Base):
    """A password-protected, READ-ONLY public view of one Choice Bank account that a
    merchant (or an admin) can share by URL. Viewers on the website — never the app — can
    see the balance, the paybill/account numbers, optionally the transaction history (with
    the payer names), and deposit into the account by M-Pesa STK. They can NOT withdraw or
    transfer. Each link has its own password; the plaintext is never stored (bcrypt hash
    only), so nobody — merchant or admin — can read it back; a forgotten password is reset.

    After 4 failed password attempts the link auto-LOCKS and only an admin can unlock it
    from the admin dashboard. The owner can change the password, suspend/resume, or delete."""
    __tablename__ = "account_share_links"

    id = Column(Integer, primary_key=True, index=True)
    slug = Column(String(32), unique=True, index=True, nullable=False)   # the public URL id
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    # Which Choice account this link exposes (snapshot of the active/selected account).
    choice_account_id = Column(String(100), nullable=True)
    choice_account_number = Column(String(50), nullable=True)

    label = Column(String(120), nullable=True)                # e.g. "Family view", "Suppliers"
    password_hash = Column(String(255), nullable=False)       # bcrypt; NEVER exposed

    show_transactions = Column(Boolean, nullable=False, default=True)   # per-link viewer toggle
    allow_deposit = Column(Boolean, nullable=False, default=True)       # let viewers STK-deposit

    # active | suspended (owner) | locked (too many bad passwords — admin unlock only)
    status = Column(String(16), nullable=False, default="active", index=True)
    failed_attempts = Column(Integer, nullable=False, default=0)

    created_by = Column(String(16), nullable=False, default="merchant")  # merchant | admin
    view_count = Column(Integer, nullable=False, default=0)
    last_viewed_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
