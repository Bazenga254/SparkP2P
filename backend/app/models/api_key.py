"""
Merchant API keys — long-lived credentials for software a merchant runs
themselves (today: the downloadable I&M Bot).

Why this exists: `get_current_trader_id` authenticates with a JWT, which is
right for the desktop app a human just logged into, and useless for a bot that
runs unattended for weeks on a merchant's PC — the token expires and the bot
goes silent.

Deliberately its own table rather than columns on `traders`:
  - CREATE TABLE cannot touch existing rows. Adding columns to a live `traders`
    table with real merchants on it is a bigger risk for no benefit.
  - A merchant can hold several keys, so one can be rotated before the old is
    revoked, instead of a re-generate breaking a running bot.
  - Revocation, last-seen and scope are properties of a KEY, not of a trader.
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Index

from app.core.database import Base


class MerchantApiKey(Base):
    __tablename__ = "merchant_api_keys"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    # The key is NEVER stored. Only its SHA-256 hash, which is what an
    # incoming key is matched against — so a database leak cannot be replayed
    # against a merchant's bank payouts. Unique: two keys colliding would let
    # one merchant's bot receive another merchant's orders.
    key_hash = Column(String(64), nullable=False, unique=True, index=True)

    # First few characters, kept in the clear purely so the UI can say WHICH key
    # ("sp2p_A1b2C3d4…") without being able to reconstruct it.
    key_prefix = Column(String(24), nullable=False)

    name = Column(String(100), nullable=True)          # merchant-visible label
    scope = Column(String(32), nullable=False, default="im_bot")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    # Doubles as the bot's heartbeat: the poller authenticates on every poll, so
    # "last used" IS "last seen". No separate heartbeat endpoint needed.
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    last_used_ip = Column(String(45), nullable=True)   # 45 = max IPv6 length
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def active(self) -> bool:
        return self.revoked_at is None


# Serving a merchant's live keys is the hot path (every poll), so index the way
# it is actually queried: this trader's un-revoked keys.
Index("ix_merchant_api_keys_trader_active", MerchantApiKey.trader_id, MerchantApiKey.revoked_at)
