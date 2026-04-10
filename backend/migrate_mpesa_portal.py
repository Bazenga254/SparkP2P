"""
Migration: add mpesa_portal_connected column to traders table.
Run once on the VPS:  cd /root/SparkP2P/backend && python migrate_mpesa_portal.py
"""
import asyncio
from sqlalchemy import text
from app.core.database import engine


async def run():
    async with engine.begin() as conn:
        await conn.execute(text("""
            ALTER TABLE traders
            ADD COLUMN IF NOT EXISTS mpesa_portal_connected BOOLEAN NOT NULL DEFAULT FALSE
        """))
        print("Added column: traders.mpesa_portal_connected")

asyncio.run(run())
