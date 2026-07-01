from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from app.core.database import Base


class KycSubmission(Base):
    __tablename__ = "kyc_submissions"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    # Status flow: pending_review → rejected | approved → otp_pending → submitted → passed | failed
    status = Column(String(50), default="pending_review", nullable=False)

    # Personal / contact / financial
    first_name = Column(String(100))
    last_name = Column(String(100))
    middle_name = Column(String(100), default="")
    mobile = Column(String(20))
    id_number = Column(String(50))
    birthday = Column(String(20))
    gender = Column(Integer, default=1)
    email = Column(String(200))
    address = Column(String(500))
    kra_pin = Column(String(20))
    employment_status = Column(String(50))
    monthly_income = Column(String(20))

    # Documents (base64-encoded JPEG / PDF)
    front_photo_b64 = Column(Text)
    back_photo_b64 = Column(Text)
    selfie_b64 = Column(Text)
    kra_cert_b64 = Column(Text)
    kra_cert_content_type = Column(String(10), default="image")

    # Admin review
    admin_notes = Column(Text, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)

    # Choice Bank — populated after admin approves and submits
    choice_onboarding_id = Column(String(100), nullable=True)
    kyc_session_token = Column(String(50), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
