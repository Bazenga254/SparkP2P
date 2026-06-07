from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    pool_size=20,          # was default 5 — headroom for concurrent requests
    max_overflow=30,       # was default 10 — burst capacity (50 total)
    pool_timeout=30,
    pool_pre_ping=True,    # drop dead connections instead of erroring
    pool_recycle=1800,     # recycle every 30 min to avoid stale server-side closes
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
