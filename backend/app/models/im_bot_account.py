"""
Bot-only accounts — people who use I&M Automation but are NOT SparkP2P clients.

This is the population the KES 12 rate exists for. They are deliberately NOT
traders: a trader is someone who runs P2P through SparkP2P, with a subscription,
a Binance connection, a Choice Bank rail, relay state and a place in every
dashboard we have. A bot-only user has none of that and never will. Making them
traders would put strangers into the trader list, the trader count, the churn
numbers and the enforcement sweep — "if it's separate, it's separate".

They live server-side (not on the merchant's PC) because they must be billable
and visible in the admin. An account that exists only on the machine it bills is
an account we cannot charge and cannot see.

ONE PERSON, ONE POPULATION:
    An email that already belongs to a trader may NOT open a bot-only account —
    that person signs in with "Continue with SparkP2P" and is billed on their
    plan (5/7/8/9) or their intro allowance (10). Otherwise a Gold merchant could
    open a bot-only account and we would bill the same human 12 while they pay us
    13,000/mo, and no one would ever notice. Registration checks traders first.

    The reverse — a bot-only user who later becomes a real SparkP2P client — is
    the outcome we WANT, so it is a link (linked_trader_id), not a block: their
    old charges stay bot-only history, and from then on they are billed as a
    trader. Their bot keeps working across the switch.
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, func, Index

from app.core.database import Base


class ImBotAccount(Base):
    __tablename__ = "im_bot_accounts"

    id = Column(Integer, primary_key=True, index=True)

    # ALWAYS stored lower-cased, and matched case-insensitively. Storing a
    # capitalised email once meant a user could never log in — and since three
    # failures lock the account for 24h, a phone keyboard's auto-capital locked
    # someone out of their own account. Normalise on the way in AND on the way
    # out; see the functional unique index below.
    email = Column(String(255), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)  # bcrypt — a human password

    full_name = Column(String(120), nullable=True)
    phone = Column(String(24), nullable=True)

    # Email is proved by OTP at sign-up, exactly as SparkP2P does it. Until this
    # is set the account exists but cannot sign in.
    email_verified_at = Column(DateTime(timezone=True), nullable=True)

    # Set if this person later becomes a real SparkP2P client. From that moment
    # they are billed as that trader, not at the bot-only rate.
    linked_trader_id = Column(Integer, ForeignKey("traders.id"), nullable=True, index=True)

    # "active" | "suspended" — an admin's off switch for a non-trader.
    status = Column(String(16), nullable=False, default="active", index=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    last_login_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def is_converted(self) -> bool:
        """True once they have become a SparkP2P client — they stop being a
        bot-only account for pricing, even though this row stays for history."""
        return self.linked_trader_id is not None


# Belt and braces on the email rule above: even if some future caller forgets to
# lower-case, the DATABASE refuses "Bob@x.com" once "bob@x.com" exists, rather
# than silently creating a second account nobody can log into.
Index("ix_im_bot_accounts_email_lower", func.lower(ImBotAccount.email), unique=True)
