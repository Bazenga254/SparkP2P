import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.database import init_db, async_session
from app.api.routes import mpesa, traders, orders, admin, auth, subscriptions, chat, extension, browser, im_bank, support
from app.services.binance.poller import order_poller
from app.services.message_templates import seed_default_templates
from app.services import bot_monitor

logger = logging.getLogger(__name__)

BATCH_INTERVAL_SECONDS = 3600  # Close and sweep every hour


async def _close_collecting_batch():
    """
    Close the current collecting batch and create a pending M-PESA sweep
    for the combined total. The desktop bot picks it up on next poll.
    """
    from sqlalchemy import select
    from app.models.batch import WithdrawalBatch, BatchItem
    from app.models.im_sweep import ImSweep

    async with async_session() as db:
        try:
            # Find collecting batch with queued items
            batch_result = await db.execute(
                select(WithdrawalBatch).where(
                    WithdrawalBatch.status == "collecting"
                ).order_by(WithdrawalBatch.created_at.desc()).limit(1)
            )
            batch = batch_result.scalar_one_or_none()

            if not batch or batch.total_amount <= 0:
                logger.info("[BatchScheduler] No collecting batch with funds — skipping")
                return

            items_result = await db.execute(
                select(BatchItem).where(
                    BatchItem.batch_id == batch.id,
                    BatchItem.status == "queued",
                )
            )
            items = items_result.scalars().all()

            if not items:
                logger.info(f"[BatchScheduler] Batch {batch.id} empty — skipping")
                return

            # Close collecting batch, transition to sweeping
            batch.status = "sweeping"
            batch.closed_at = datetime.now(timezone.utc)

            # Create one ImSweep for the combined total
            sweep = ImSweep(
                trader_id=None,
                withdrawal_tx_id=None,
                amount=batch.total_amount,
                status="pending",
                batch_id=batch.id,
            )
            db.add(sweep)
            await db.commit()

            logger.info(
                f"[BatchScheduler] Batch {batch.id} closed: "
                f"KES {batch.total_amount:,.0f} across {len(items)} traders. "
                f"Sweep {sweep.id} queued."
            )
        except Exception as e:
            logger.error(f"[BatchScheduler] Error closing batch: {e}")


async def batch_scheduler():
    """Hourly loop: close collecting batches and queue M-PESA sweeps."""
    while True:
        await asyncio.sleep(BATCH_INTERVAL_SECONDS)
        await _close_collecting_batch()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    await seed_default_templates()
    # Start housekeeping poller (no longer polls Binance directly;
    # the Chrome extension handles all Binance API calls)
    poller_task = asyncio.create_task(order_poller.start())
    # Start bot offline monitor — alerts traders when their desktop app goes silent
    monitor_task = asyncio.create_task(bot_monitor.start())
    # Start hourly batch withdrawal scheduler
    batch_task = asyncio.create_task(batch_scheduler())
    yield
    # Shutdown
    order_poller.stop()
    poller_task.cancel()
    monitor_task.cancel()
    batch_task.cancel()


app = FastAPI(
    title=settings.APP_NAME,
    description="Automated Binance P2P Trading Platform",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Routes
app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(traders.router, prefix="/api/traders", tags=["Traders"])
app.include_router(orders.router, prefix="/api/orders", tags=["Orders"])
app.include_router(mpesa.router, prefix="/api/payment", tags=["M-Pesa"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(subscriptions.router, prefix="/api/subscriptions", tags=["Subscriptions"])
app.include_router(chat.router, prefix="/api/chat", tags=["Chat"])
app.include_router(extension.router, prefix="/api/ext", tags=["Extension"])
app.include_router(browser.router, prefix="/api/browser", tags=["Browser Automation"])
app.include_router(im_bank.router, prefix="/api/im", tags=["I&M Bank"])
app.include_router(support.router, prefix="/api", tags=["Support"])


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": settings.APP_NAME}


# Serve uploaded support attachments
_uploads_dir = os.path.join(os.path.dirname(__file__), "..", "uploads")
os.makedirs(os.path.join(_uploads_dir, "support"), exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_uploads_dir), name="uploads")
