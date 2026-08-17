"""Operations / support tickets — admin-created cases raised on a client's behalf
to Choice Bank (reversals, wrong payment, money-not-credited, etc.).

Distinct from the client-initiated SupportTicket (the in-app AI support chat):
an OpsTicket is opened by an admin, emailed to Choice Bank, and its number is sent
to the client by email + SMS. Choice Bank's replies and the client's messages are
threaded back into `messages`, and agents reply from support@sparkp2p.com — so the
whole conversation lives in the admin dashboard.
"""
import enum
from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Text, DateTime, Enum, ForeignKey, JSON, Boolean

from app.core.database import Base


class OpsTicketStatus(str, enum.Enum):
    OPEN = "open"                     # just created / awaiting Choice Bank
    AWAITING_CHOICE = "awaiting_choice"
    AWAITING_CLIENT = "awaiting_client"
    RESOLVED = "resolved"
    CLOSED = "closed"


class OpsTicket(Base):
    __tablename__ = "ops_tickets"

    id = Column(Integer, primary_key=True, index=True)
    ticket_number = Column(String(24), unique=True, index=True, nullable=False)  # e.g. SPK-2026-000123
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=True, index=True)  # the client the case is about
    category = Column(String(40), nullable=True)   # reversal | wrong_payment | not_credited | other | <template key>
    subject = Column(String(255), nullable=True)
    status = Column(Enum(OpsTicketStatus, values_callable=lambda obj: [e.name for e in obj]),
                    default=OpsTicketStatus.OPEN, index=True)

    # Full conversation thread. Each entry:
    #   {from: 'agent'|'choice'|'client'|'system', name, body, ts, channel: 'email'|'sms'|'note'}
    messages = Column(JSON, default=list)

    # True when an inbound reply (Choice/client) arrived and the admin hasn't opened
    # it yet — drives the "New reply" badge, tab count, and the Dashboard attention tile.
    needs_attention = Column(Boolean, nullable=False, default=False, index=True)

    choice_email = Column(String(255), nullable=True)   # who at Choice Bank this went to
    client_email = Column(String(255), nullable=True)   # snapshot of the client's email/phone at creation
    client_phone = Column(String(32), nullable=True)

    created_by = Column(Integer, ForeignKey("traders.id"), nullable=True)   # admin who opened it
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))


class OpsEmailTemplate(Base):
    """Reusable email templates for ops tickets. Placeholders like {client_name},
    {ticket_number}, {amount}, {order_number}, {details} are filled at send time."""
    __tablename__ = "ops_email_templates"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(40), unique=True, index=True, nullable=False)   # slug, e.g. 'reversal'
    name = Column(String(120), nullable=False)                          # human label
    subject = Column(String(255), nullable=False)
    body = Column(Text, nullable=False)                                 # HTML/text with {placeholders}
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
