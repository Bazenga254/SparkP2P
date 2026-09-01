from sqlalchemy import Column, Integer, String, Numeric, DateTime, Boolean
from datetime import datetime, timezone
from app.core.database import Base


class NcbaIpnEvent(Base):
    """One inbound NCBA Paybill-Level Push Notification (IPN) — a system-to-system alert
    NCBA POSTs to us the instant a payment lands on our NCBA Paybill/Till 880100 (account
    SPARK FREELANCE SOLUTIONS / 1011775848). This is the reconciliation feed for SparkPay
    collections; every genuine, hash-verified notification is recorded here, de-duplicated
    on the M-Pesa reference (trans_id).

    The row is written only after the payload's Username/Password and SHA-256 Hash have
    been verified against our shared secret, so a stored row means an authentic payment."""
    __tablename__ = "ncba_ipn_events"

    id = Column(Integer, primary_key=True, index=True)
    trans_id = Column(String(32), unique=True, index=True, nullable=False)  # M-Pesa ref, e.g. RK91U5J2AD
    ft_ref = Column(String(40), nullable=True)                              # NCBA core-banking ref
    trans_type = Column(String(32), nullable=True)                          # Pay Bill / TILLNUMBER / PAYBILL
    business_short_code = Column(String(16), nullable=True, index=True)     # 880100
    bill_ref_number = Column(String(64), nullable=True)                     # NCBA till short code allocated to us
    narrative = Column(String(120), nullable=True)                          # payer narration
    amount = Column(Numeric(14, 2), nullable=True)
    mobile = Column(String(64), nullable=True)                              # payer phone (may be SHA-256 hashed)
    payer_name = Column(String(120), nullable=True)
    trans_time = Column(String(20), nullable=True)                          # YYYYMMDDhhmmss from NCBA

    verified = Column(Boolean, nullable=False, default=True)                # hash + credentials checked
    processed = Column(Boolean, nullable=False, default=False, index=True)  # consumed by a SparkPay order yet
    raw = Column(String, nullable=True)                                     # full JSON payload for audit

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
