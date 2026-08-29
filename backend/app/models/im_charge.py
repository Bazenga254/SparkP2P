"""
The I&M Automation charge ledger — one row per payout we billed for.

This table IS the bill. Revenue, the intro-allowance counter, and what a merchant
owes are all derived by reading it, never by trusting a running total kept
somewhere else. A counter that can drift from the ledger is a counter that will:
we have already had a payment double-counted here by two callbacks racing, and
the fix was to make the ledger the only truth.

Rows are written ONLY after money has actually left the bank (outcome PAID).
A FAILED payout, a payout refused for zero balance, and an UNKNOWN one all write
nothing — see im_pricing.should_bill().

WHY rate AND amount ARE COPIED IN, not looked up:
    A charge is a historical fact. If we re-derived the rate at read time, then a
    trader upgrading Gold -> B2C would silently rewrite every payout they ever
    made from 7 to 5, and last month's revenue would change. The rate that was
    charged is the rate that was charged.

WHY order_id IS UNIQUE:
    It is the only thing standing between us and billing a merchant twice for one
    payout. Retries, redeliveries and races are normal here; a UNIQUE constraint
    is the one defence that holds even when the code above it is wrong.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, Numeric, String, DateTime, ForeignKey, Index, CheckConstraint,
)

from app.core.database import Base


class ImCharge(Base):
    __tablename__ = "im_charges"

    id = Column(Integer, primary_key=True, index=True)

    # Exactly ONE of these is set — enforced by a CHECK below, not by hope.
    # A SparkP2P trader (rates 5/7/8/9/10/12)...
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=True, index=True)
    # ...or a bot-only account, someone who was never a SparkP2P client (12).
    bot_account_id = Column(Integer, ForeignKey("im_bot_accounts.id"), nullable=True, index=True)

    # "sparkp2p" | "bot_only" — im_pricing.ACCOUNT_*. Denormalised so the admin
    # can split revenue by population without a join, and so a bot-only account
    # that later becomes a trader does not rewrite its own history.
    account_type = Column(String(16), nullable=False, index=True)

    # The Binance order this payout settled. UNIQUE: bill each payout once, ever.
    order_id = Column(String(64), nullable=False, unique=True, index=True)

    # NUMERIC, not Integer: rates may be fractional (Silver = KES 3.5 per payout).
    rate = Column(Numeric(6, 2), nullable=False)     # KES charged for this payout
    payout_amount = Column(Integer, nullable=False)  # KES that left the bank
    # The plan in force AT THE TIME, or NULL if unsubscribed. Explains the rate
    # to a merchant disputing a line ("you were Bronze on the 4th").
    plan = Column(String(32), nullable=True)

    # The bank's own reference for the payout. Our audit trail back to I&M, and
    # how a human reconciles a disputed line against the bank statement.
    bank_ref = Column(String(64), nullable=True)

    charged_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

    __table_args__ = (
        CheckConstraint(
            "(trader_id IS NOT NULL AND bot_account_id IS NULL) OR "
            "(trader_id IS NULL AND bot_account_id IS NOT NULL)",
            name="ck_im_charges_one_owner",
        ),
        # A charge with a rate we do not offer is a bug that must not reach the
        # ledger. 3.5/4/5/7/10/12 are the per-payout rates (Silver is 3.5; 8/9 are
        # legacy Silver/Bronze rows still on the ledger); 0 is a payout on the
        # weekly unlimited plan (covered by the flat weekly fee, so no per-payout
        # charge) — it still lands on the ledger so payouts/volume keep counting.
        CheckConstraint("rate IN (0, 3.5, 4, 5, 7, 8, 9, 10, 12)", name="ck_im_charges_known_rate"),
        CheckConstraint("payout_amount > 0", name="ck_im_charges_positive_payout"),
    )


# Revenue is read as "this owner, over this period" — index it that way.
Index("ix_im_charges_trader_time", ImCharge.trader_id, ImCharge.charged_at)
Index("ix_im_charges_bot_time", ImCharge.bot_account_id, ImCharge.charged_at)
# The intro-allowance count: this trader's rows at the intro rate.
Index("ix_im_charges_trader_rate", ImCharge.trader_id, ImCharge.rate)
