"""Add cancelled_at column to orders table."""
import asyncio
from sqlalchemy import text
from app.core.database import engine


async def migrate():
    async with engine.begin() as conn:
        try:
            await conn.execute(text(
                "ALTER TABLE orders ADD COLUMN cancelled_at TIMESTAMP WITH TIME ZONE"
            ))
            print("✅ Added cancelled_at column to orders table")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                print("ℹ️  cancelled_at column already exists — skipping")
            else:
                raise


if __name__ == "__main__":
    asyncio.run(migrate())
