from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime, timezone
from app.core.database import Base


class MessageTemplate(Base):
    __tablename__ = "message_templates"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(100), unique=True, nullable=False)  # e.g., "sms_deposit_received"
    name = Column(String(200), nullable=False)  # Human-readable name
    channel = Column(String(10), nullable=False)  # "sms" or "email"
    subject = Column(String(255), nullable=True)  # Email subject (null for SMS)
    body = Column(Text, nullable=False)  # Template body with {variables}
    variables = Column(Text, nullable=True)  # JSON list of available variables
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
