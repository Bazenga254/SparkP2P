"""
Per-ad automation config — which of a merchant's Binance ads the bot runs, and
on which side.

A merchant can run many ads. By default the bot automates them ALL, using the
trader's global bot_trade_mode. This table is the OVERRIDE: a row here pins one
specific ad (by advNo) to a mode:

    both        automate buy AND sell orders on this ad
    buy_only    automate only buy orders
    sell_only   automate only sell orders
    off         don't automate this ad at all

THE SAFE DEFAULT IS THE ABSENCE OF A ROW. An ad with no row here is NOT disabled
— it falls back to the trader's global mode, i.e. exactly today's behaviour. So a
trader who never opens the Ads page keeps automating everything, and this feature
can't silently switch anyone off.

One row per (trader, advNo) — a merchant sets each ad once.
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint, Index

from app.core.database import Base

AD_MODES = ("both", "buy_only", "sell_only", "off")


class AdAutomation(Base):
    __tablename__ = "ad_automation"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    # Binance ad number (advNo). Kept as a string — it's an opaque id from Binance.
    adv_no = Column(String(64), nullable=False)
    mode = Column(String(16), nullable=False, default="both")  # AD_MODES

    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        # One config per ad per trader — setting an ad again updates, not stacks.
        UniqueConstraint("trader_id", "adv_no", name="uq_ad_automation_trader_ad"),
    )


# Resolving an order's mode looks up (trader, advNo) — index it that way.
Index("ix_ad_automation_trader_ad", AdAutomation.trader_id, AdAutomation.adv_no)
