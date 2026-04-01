import enum
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Enum, ForeignKey, JSON
from app.core.database import Base


class TicketStatus(str, enum.Enum):
    OPEN = "open"
    AI_RESOLVED = "ai_resolved"
    ESCALATED = "escalated"   # Sent to admin disputes tab
    CLOSED = "closed"


class SupportTicket(Base):
    __tablename__ = "support_tickets"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    subject = Column(String(255), nullable=True)
    status = Column(Enum(TicketStatus), default=TicketStatus.OPEN)
    messages = Column(JSON, default=list)  # [{role, content, ts}]
    escalation_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
