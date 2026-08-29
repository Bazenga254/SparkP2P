from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from datetime import datetime, timezone
from app.core.database import Base


class EmailAttachment(Base):
    """A file attached to a received email (extracted by the IMAP poller). Content is stored
    base64-encoded; downloaded on demand via /admin/mailbox/attachments/{id}."""
    __tablename__ = "email_attachments"

    id = Column(Integer, primary_key=True, index=True)
    email_id = Column(Integer, ForeignKey("email_messages.id"), nullable=False, index=True)
    filename = Column(String(400), nullable=True)
    content_type = Column(String(160), nullable=True)
    size = Column(Integer, nullable=True)          # bytes
    content_b64 = Column(Text, nullable=True)      # base64 file bytes
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
