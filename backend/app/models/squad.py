"""Squad Mode — coordinated team-pricing models (see docs/squad-mode.md).

A squad is a group of verified merchants who opt in (invite + accept) to coordinate their
Binance P2P ad prices so the team holds the top-K contiguous slots, rotates #1 for fairness,
contests outsiders only when they out-volume the team, and never prices below the margin floor.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey
from app.core.database import Base


class Squad(Base):
    __tablename__ = "squads"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(80), nullable=False)
    captain_trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)

    mode = Column(String(10), default="off")          # 'off' | 'sim' | 'live'
    rotation_minutes = Column(Integer, default=15)     # how long each member holds #1
    rotation_anchor = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))  # rotation clock origin

    side_mode = Column(String(8), default="both")      # 'both' | 'sell' | 'buy'
    margin_min = Column(Float, default=0.0)            # KES/USDT — hard profit floor
    margin_max = Column(Float, default=0.0)            # KES/USDT — relax target when uncontested
    volume_gate_pct = Column(Float, default=1.10)      # contest an outsider only if its vol > team*this
    max_gap = Column(Float, default=0.08)              # KES — max randomized gap between adjacent slots

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class SquadMember(Base):
    __tablename__ = "squad_members"

    id = Column(Integer, primary_key=True, index=True)
    squad_id = Column(Integer, ForeignKey("squads.id"), nullable=False, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    status = Column(String(10), default="invited")     # 'invited' | 'active' | 'left'
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
