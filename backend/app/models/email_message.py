from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime
from datetime import datetime, timezone
from app.core.database import Base


class EmailMessage(Base):
    """A single email in the admin dashboard mailbox. Received messages are pulled from the
    Zoho mailbox over IMAP; sent messages (compose/reply) go out via Brevo and are stored here
    as folder='sent'. Deduped by IMAP uid (inbox) and Message-ID."""
    __tablename__ = "email_messages"

    id = Column(Integer, primary_key=True, index=True)
    folder = Column(String(20), nullable=False, default="inbox", index=True)  # inbox | sent (dashboard view)
    imap_folder = Column(String(64), nullable=True, default="INBOX", index=True)  # source IMAP folder (per-folder UID baseline)
    uid = Column(String(64), nullable=True, index=True)          # IMAP UID (per imap_folder)
    message_id = Column(String(512), nullable=True, index=True)  # RFC 5322 Message-ID
    in_reply_to = Column(String(512), nullable=True)             # threading (References/In-Reply-To)

    from_addr = Column(String(320), nullable=True)
    from_name = Column(String(200), nullable=True)
    to_addr = Column(String(600), nullable=True)                 # comma-joined recipients
    subject = Column(String(1000), nullable=True)
    snippet = Column(String(300), nullable=True)                 # preview text
    body_text = Column(Text, nullable=True)
    body_html = Column(Text, nullable=True)

    is_read = Column(Boolean, nullable=False, default=False, index=True)
    is_support = Column(Boolean, nullable=False, default=False, index=True)  # surfaced in Support
    received_at = Column(DateTime(timezone=True), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
