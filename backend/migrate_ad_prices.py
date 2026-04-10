"""Add ad_buy_price, ad_sell_price, ad_prices_updated_at to traders table."""
import asyncio
from sqlalchemy import text
from app.core.database import engine


async def run():
    async with engine.begin() as conn:
        for col, typ in [
            ("ad_buy_price", "FLOAT"),
            ("ad_sell_price", "FLOAT"),
            ("ad_prices_updated_at", "TIMESTAMP WITH TIME ZONE"),
        ]:
            try:
                await conn.execute(text(f"ALTER TABLE traders ADD COLUMN {col} {typ}"))
                print(f"Added column: {col}")
            except Exception as e:
                if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                    print(f"Column {col} already exists — skipping")
                else:
                    print(f"Error adding {col}: {e}")

asyncio.run(run())
