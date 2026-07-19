"""
Read/write global platform toggles (the platform_settings KV table).

Kept deliberately tiny. Bools are stored as the strings 'true'/'false'. An absent
key returns the caller's default — so nothing needs seeding and a brand-new DB
behaves sensibly.
"""

from sqlalchemy import select

from app.models.platform_setting import PlatformSetting

# Known keys, so callers don't pass typo'd strings.
AFFILIATES_ENABLED = "affiliates_enabled"


async def get_bool(db, key: str, default: bool = False) -> bool:
    row = (await db.execute(
        select(PlatformSetting.value).where(PlatformSetting.key == key)
    )).scalar_one_or_none()
    if row is None:
        return default
    return str(row).strip().lower() in ("true", "1", "yes", "on")


async def set_bool(db, key: str, value: bool) -> bool:
    v = "true" if value else "false"
    row = (await db.execute(
        select(PlatformSetting).where(PlatformSetting.key == key)
    )).scalar_one_or_none()
    if row is None:
        db.add(PlatformSetting(key=key, value=v))
    else:
        row.value = v
    await db.commit()
    return value
