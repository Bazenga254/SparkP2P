from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from datetime import datetime, timezone
from app.core.database import Base


class ChoiceAccount(Base):
    """Registry of every Choice Bank account a trader holds. A trader may hold several
    (e.g. a personal current account + one or more SME accounts) and switch which one is
    active. The ACTIVE row is mirrored onto the trader's own choice_account_id / _number /
    choice_kyc_status / onboarding_status columns, so every existing consumer that reads
    those trader fields keeps working unchanged — switching just repoints the mirror."""
    __tablename__ = "choice_accounts"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    account_id = Column(String(100), nullable=True, index=True)     # Choice internal account id
    account_number = Column(String(50), nullable=True, index=True)  # account number (== account_id in practice)
    label = Column(String(120), nullable=True)                      # user-facing name e.g. "Personal", "Acme Ltd"
    account_type = Column(String(24), nullable=False, default="personal")  # 'personal' | 'sme'
    business_type = Column(Integer, nullable=True)                  # SME businessType 1..4 (null for personal)

    kyc_status = Column(String(100), nullable=True)                 # approved/rejected/pending:<id>/onboarding:<id>
    onboarding_request_id = Column(String(64), nullable=True, index=True)
    onboarding_status = Column(String(16), nullable=True)           # in_progress/submitted/approved/rejected

    is_active = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
