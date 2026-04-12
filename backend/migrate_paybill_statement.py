"""Migration: create paybill_statement table"""
import asyncio
from app.core.database import engine
from app.models.paybill_statement import PaybillStatement
from app.core.database import Base

async def migrate():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("paybill_statement table created (if not exists)")

if __name__ == "__main__":
    asyncio.run(migrate())
