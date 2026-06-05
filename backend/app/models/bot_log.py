from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from app.core.database import Base


class BotLog(Base):
    """Persisted bot-activity log lines pushed by a trader's desktop app, so admins can review
    them even across backend restarts (the old in-memory store was wiped on every restart)."""
    __tablename__ = "bot_logs"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), index=True, nullable=False)
    level = Column(String(20))            # info | warning | error | success
    message = Column(Text)
    time = Column(String(40))             # ISO timestamp from the desktop app
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
