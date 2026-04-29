from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from app.core.database import Base


class SurveyResponse(Base):
    __tablename__ = "survey_responses"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    phone = Column(String(20), nullable=False, index=True)

    q1_is_merchant = Column(String(10), nullable=True)
    q2_trade_frequency = Column(String(80), nullable=True)
    q3_daily_volume = Column(String(80), nullable=True)
    q4_account_frozen = Column(String(80), nullable=True)
    q5_has_automation = Column(String(10), nullable=True)
    q5_automation_name = Column(String(200), nullable=True)
    q6_biggest_challenge = Column(String(200), nullable=True)
    q7_daily_transactions = Column(String(80), nullable=True)

    is_qualified = Column(Boolean, default=False)
    disqualified = Column(Boolean, default=False)
    invite_sent = Column(Boolean, default=False)
    invite_sent_at = Column(DateTime(timezone=True), nullable=True)

    submitted_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
