from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text
from app.core.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    actor_id = Column(Integer, nullable=False, index=True)       # Who performed the action
    actor_role = Column(String(20), nullable=False)               # admin / employee
    action = Column(String(100), nullable=False)                  # e.g. "view_trader_detail"
    target_trader_id = Column(Integer, nullable=True, index=True) # Whose data was accessed
    detail = Column(Text, nullable=True)                          # Extra context
    ip_address = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
