"""
Platform settings — a tiny key/value store for GLOBAL toggles an admin flips at
runtime (as opposed to .env flags, which need a redeploy).

First use: 'affiliates_enabled' — whether merchants see the Affiliates tab. More
switches can share this table without a migration each.

Values are stored as text; helpers in services/platform_settings.py coerce
bools. Absent key -> the caller's default, so a fresh install behaves predictably
without seeding rows.
"""

from datetime import datetime, timezone

from sqlalchemy import Column, String, DateTime

from app.core.database import Base


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key = Column(String(64), primary_key=True)
    value = Column(String(255), nullable=False)
    updated_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
