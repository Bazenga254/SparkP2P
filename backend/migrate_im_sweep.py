"""
Migration: create im_sweeps table + add 'im_sweep' to transactiontype enum.
Run once on the VPS:  cd /root/SparkP2P/backend && python migrate_im_sweep.py
"""
import asyncio
from sqlalchemy import text
from app.core.database import engine


async def run():
    async with engine.begin() as conn:
        # 1. Add new enum value to PostgreSQL native type
        try:
            await conn.execute(text("ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'im_sweep'"))
            print("Added enum value: im_sweep")
        except Exception as e:
            print(f"Enum: {e}")

        # 2. Create im_sweeps table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS im_sweeps (
                id                    SERIAL PRIMARY KEY,
                trader_id             INTEGER REFERENCES traders(id),
                withdrawal_tx_id      INTEGER REFERENCES wallet_transactions(id),
                amount                FLOAT NOT NULL,
                mpesa_conversation_id VARCHAR(100),
                mpesa_originator_id   VARCHAR(100),
                status                VARCHAR(20) NOT NULL DEFAULT 'pending',
                failure_reason        VARCHAR(500),
                sweep_paybill         VARCHAR(20),
                sweep_account         VARCHAR(50),
                created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                completed_at          TIMESTAMP WITH TIME ZONE
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_im_sweeps_status ON im_sweeps(status)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_im_sweeps_trader_id ON im_sweeps(trader_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_im_sweeps_conversation_id ON im_sweeps(mpesa_conversation_id)"
        ))
        print("Created table: im_sweeps")

asyncio.run(run())
