import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.database import init_db, async_session
from app.api.routes import mpesa, traders, orders, admin, auth, subscriptions, chat, extension, browser, im_bank, support, survey, affiliates, telegram, choice_bank, kyc_flow, squads
from app.services.binance.poller import order_poller
from app.services.message_templates import seed_default_templates
from app.services import bot_monitor

logger = logging.getLogger(__name__)

BATCH_INTERVAL_SECONDS = 3600        # Close and sweep every hour
BATCH_STUCK_CHECK_SECONDS = 1800     # Check for stuck batches every 30 minutes
BATCH_STUCK_THRESHOLD_HOURS = 1      # Alert if batch stuck in sweeping/disbursing for 1+ hour
BATCH_ITEM_MAX_RETRIES = 3           # Max auto-retries for failed batch items


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


async def _alert_admin(subject: str, body_html: str, sms: str):
    """Send email + SMS alert to the admin trader."""
    from sqlalchemy import select
    from app.models.trader import Trader
    try:
        async with async_session() as db:
            result = await db.execute(select(Trader).where(Trader.is_admin == True).order_by(Trader.id.asc()).limit(1))
            admin_trader = result.scalar_one_or_none()
            if not admin_trader:
                return
            try:
                from app.services.sms import send_otp_sms
                send_otp_sms(admin_trader.phone, sms)
            except Exception as e:
                logger.warning(f"[BatchMonitor] SMS alert failed: {e}")
            try:
                from app.services.email import send_email
                send_email(admin_trader.email, subject, body_html)
            except Exception as e:
                logger.warning(f"[BatchMonitor] Email alert failed: {e}")
    except Exception as e:
        logger.error(f"[BatchMonitor] _alert_admin error: {e}")


async def _check_stuck_batches():
    """
    Alert admin if any batch has been stuck in 'sweeping' or 'disbursing'
    for more than BATCH_STUCK_THRESHOLD_HOURS hours.
    Retry failed batch items up to BATCH_ITEM_MAX_RETRIES times.
    """
    from sqlalchemy import select
    from app.models.batch import WithdrawalBatch, BatchItem

    async with async_session() as db:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=BATCH_STUCK_THRESHOLD_HOURS)

            # ── Case 1: Sweep submitted but I&M balance not yet confirmed ─────
            # swept_at is set (M-Pesa org portal done) but balance_verified is still False
            unverified_result = await db.execute(
                select(WithdrawalBatch).where(
                    WithdrawalBatch.status == "sweeping",
                    WithdrawalBatch.swept_at.isnot(None),
                    WithdrawalBatch.balance_verified == False,
                    WithdrawalBatch.swept_at <= cutoff,
                    WithdrawalBatch.alerted == False,
                )
            )
            for batch in unverified_result.scalars().all():
                age_hours = (datetime.now(timezone.utc) - batch.swept_at).total_seconds() / 3600
                logger.warning(
                    f"[BatchMonitor] Batch {batch.id}: sweep submitted {age_hours:.1f}h ago "
                    f"but KES {batch.total_amount:,.0f} not yet confirmed in I&M — alerting admin"
                )
                await _alert_admin(
                    subject=f"SparkP2P — Batch #{batch.id} Sweep Not Confirmed in I&M Bank",
                    sms=(
                        f"SparkP2P ALERT: KES {batch.total_amount:,.0f} was swept from M-Pesa "
                        f"{age_hours:.0f}h ago but has NOT been confirmed in the Spark Freelance "
                        f"Solutions I&M account. Check the account and the desktop bot urgently."
                    ),
                    body_html=f"""
                    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                      <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                        <h2 style="color:#ef4444;margin:0 0 16px;">🚨 I&amp;M Balance Not Confirmed</h2>
                        <p style="color:#d1d5db;font-size:14px;">
                          Batch <strong>#{batch.id}</strong> — the M-Pesa sweep was submitted
                          <strong>{age_hours:.1f} hours ago</strong> but the funds have
                          <strong style="color:#ef4444;">not been confirmed</strong> in the
                          Spark Freelance Solutions I&amp;M Bank account.
                        </p>
                        <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #ef4444;">
                          <p style="color:#9ca3af;font-size:13px;margin:0;">
                            Amount: <strong style="color:#fff;">KES {batch.total_amount:,.2f}</strong><br/>
                            Sweep submitted: {batch.swept_at.strftime('%Y-%m-%d %H:%M UTC') if batch.swept_at else 'Unknown'}<br/>
                            I&amp;M balance read: <strong style="color:#f59e0b;">{f"KES {batch.im_balance_after:,.2f}" if batch.im_balance_after else "Not yet read"}</strong>
                          </p>
                        </div>
                        <p style="color:#d1d5db;font-size:14px;">
                          <strong>Action required:</strong> Log into
                          <a href="https://digital.imbank.com" style="color:#f59e0b;">digital.imbank.com</a>
                          and verify the Spark Freelance Solutions account balance.
                          If the funds arrived, the disbursements to traders are still pending.
                          If not, check the M-Pesa org portal for the transaction status.
                        </p>
                      </div>
                    </div>
                    """,
                )
                batch.alerted = True
                await db.commit()

            # ── Case 2: Sweep not yet submitted (no swept_at) ─────────────────
            # Batch has been in sweeping since closed_at but bot never called mpesa-sweep-complete
            unsent_result = await db.execute(
                select(WithdrawalBatch).where(
                    WithdrawalBatch.status == "sweeping",
                    WithdrawalBatch.swept_at.is_(None),
                    WithdrawalBatch.closed_at <= cutoff,
                    WithdrawalBatch.alerted == False,
                )
            )
            for batch in unsent_result.scalars().all():
                age_hours = (datetime.now(timezone.utc) - batch.closed_at).total_seconds() / 3600
                logger.warning(
                    f"[BatchMonitor] Batch {batch.id} closed {age_hours:.1f}h ago "
                    f"but M-Pesa sweep never started — alerting admin"
                )
                await _alert_admin(
                    subject=f"SparkP2P — Batch #{batch.id} Sweep Not Started",
                    sms=(
                        f"SparkP2P ALERT: Withdrawal batch #{batch.id} "
                        f"(KES {batch.total_amount:,.0f}) closed {age_hours:.0f}h ago "
                        f"but the M-Pesa sweep has not started. Check the desktop bot."
                    ),
                    body_html=f"""
                    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                      <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                        <h2 style="color:#f59e0b;margin:0 0 16px;">⚠️ M-Pesa Sweep Not Started</h2>
                        <p style="color:#d1d5db;font-size:14px;">
                          Batch <strong>#{batch.id}</strong> closed <strong>{age_hours:.1f} hours ago</strong>
                          but the M-Pesa org portal sweep has not been executed yet.
                        </p>
                        <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b;">
                          <p style="color:#9ca3af;font-size:13px;margin:0;">
                            Amount: <strong style="color:#fff;">KES {batch.total_amount:,.2f}</strong><br/>
                            Closed at: {batch.closed_at.strftime('%Y-%m-%d %H:%M UTC')}
                          </p>
                        </div>
                        <p style="color:#d1d5db;font-size:14px;">
                          <strong>Action required:</strong> Ensure the SparkP2P desktop bot is
                          running and connected to the M-Pesa org portal.
                        </p>
                      </div>
                    </div>
                    """,
                )
                batch.alerted = True
                await db.commit()

            # ── Case 3: Stuck in disbursing ───────────────────────────────────
            disburse_result = await db.execute(
                select(WithdrawalBatch).where(
                    WithdrawalBatch.status == "disbursing",
                    WithdrawalBatch.swept_at <= cutoff,
                    WithdrawalBatch.alerted == False,
                )
            )
            for batch in disburse_result.scalars().all():
                age_hours = (datetime.now(timezone.utc) - batch.swept_at).total_seconds() / 3600
                logger.warning(
                    f"[BatchMonitor] Batch {batch.id} stuck in 'disbursing' "
                    f"for {age_hours:.1f}h — alerting admin"
                )
                await _alert_admin(
                    subject=f"SparkP2P — Batch #{batch.id} Disbursements Stuck",
                    sms=(
                        f"SparkP2P ALERT: Withdrawal batch #{batch.id} "
                        f"(KES {batch.total_amount:,.0f}) has been disbursing for {age_hours:.0f}h. "
                        f"Check the desktop bot and I&M Bank."
                    ),
                    body_html=f"""
                    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                      <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                        <h2 style="color:#f59e0b;margin:0 0 16px;">⚠️ Batch Disbursements Stuck</h2>
                        <p style="color:#d1d5db;font-size:14px;">
                          Batch <strong>#{batch.id}</strong> has been in
                          <strong style="color:#f59e0b;">'disbursing'</strong>
                          for <strong>{age_hours:.1f} hours</strong>.
                          The money is in I&amp;M Bank but individual transfers to traders are stalled.
                        </p>
                        <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b;">
                          <p style="color:#9ca3af;font-size:13px;margin:0;">
                            Amount: <strong style="color:#fff;">KES {batch.total_amount:,.2f}</strong><br/>
                            Swept at: {batch.swept_at.strftime('%Y-%m-%d %H:%M UTC') if batch.swept_at else 'Unknown'}
                          </p>
                        </div>
                        <p style="color:#d1d5db;font-size:14px;">
                          <strong>Action required:</strong> Ensure the desktop bot is running and
                          connected to I&amp;M internet banking. The bot will resume disbursements automatically.
                        </p>
                      </div>
                    </div>
                    """,
                )
                batch.alerted = True
                await db.commit()

            # ── Retry failed batch items ──────────────────────────────────────
            failed_result = await db.execute(
                select(BatchItem).where(
                    BatchItem.status == "failed",
                    BatchItem.retry_count < BATCH_ITEM_MAX_RETRIES,
                )
            )
            failed_items = failed_result.scalars().all()

            for item in failed_items:
                item.retry_count = (item.retry_count or 0) + 1
                item.status = "queued"
                logger.warning(
                    f"[BatchMonitor] Retrying batch item {item.id} "
                    f"(attempt {item.retry_count}/{BATCH_ITEM_MAX_RETRIES})"
                )

            if failed_items:
                await db.commit()
                logger.info(f"[BatchMonitor] Re-queued {len(failed_items)} failed batch items")

            # Alert admin when an item has exhausted all retries
            exhausted_result = await db.execute(
                select(BatchItem).where(
                    BatchItem.status == "failed",
                    BatchItem.retry_count >= BATCH_ITEM_MAX_RETRIES,
                    BatchItem.alerted == False,
                )
            )
            exhausted_items = exhausted_result.scalars().all()

            for item in exhausted_items:
                logger.error(
                    f"[BatchMonitor] Batch item {item.id} exhausted retries — "
                    f"manual intervention required"
                )
                await _alert_admin(
                    subject=f"SparkP2P — Batch Item #{item.id} Failed (manual action needed)",
                    sms=(
                        f"SparkP2P ALERT: Batch withdrawal item #{item.id} "
                        f"(KES {item.amount:,.0f} to {item.destination}) "
                        f"failed {BATCH_ITEM_MAX_RETRIES} times. Manual action required."
                    ),
                    body_html=f"""
                    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                      <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                        <h2 style="color:#ef4444;margin:0 0 16px;">❌ Batch Item Failed — Action Required</h2>
                        <p style="color:#d1d5db;font-size:14px;">
                          Batch item <strong>#{item.id}</strong> has failed
                          <strong>{BATCH_ITEM_MAX_RETRIES} times</strong> and cannot be retried automatically.
                        </p>
                        <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #ef4444;">
                          <p style="color:#9ca3af;font-size:13px;margin:0;">
                            Amount: <strong style="color:#fff;">KES {item.amount:,.2f}</strong><br/>
                            Destination: <strong style="color:#fff;">{item.destination}</strong><br/>
                            Retries: <strong style="color:#ef4444;">{item.retry_count}/{BATCH_ITEM_MAX_RETRIES}</strong>
                          </p>
                        </div>
                        <p style="color:#d1d5db;font-size:14px;">
                          Please log into the admin dashboard and process this withdrawal manually.
                        </p>
                      </div>
                    </div>
                    """,
                )
                item.alerted = True
                await db.commit()

        except Exception as e:
            logger.error(f"[BatchMonitor] Error in _check_stuck_batches: {e}")


async def batch_scheduler():
    """Close collecting batch at :55 of each wall-clock hour (East Africa Time)."""
    EAT = timezone(timedelta(hours=3))
    while True:
        now = datetime.now(EAT)
        # Next :55:00 mark in EAT
        target = now.replace(minute=55, second=0, microsecond=0)
        if now >= target:
            target += timedelta(hours=1)
        sleep_secs = (target - now).total_seconds()
        logger.info(
            f"[BatchScheduler] Next batch sweep at {target.strftime('%I:%M %p EAT')} "
            f"(in {sleep_secs / 60:.1f} min)"
        )
        await asyncio.sleep(sleep_secs)
        await _close_collecting_batch()


async def batch_monitor():
    """Every 30 min: alert on stuck batches and retry failed items."""
    while True:
        await asyncio.sleep(BATCH_STUCK_CHECK_SECONDS)
        await _check_stuck_batches()



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
    # Start batch stuck-alert + retry monitor (every 30 min)
    batch_monitor_task = asyncio.create_task(batch_monitor())
    # Start while-online order tracking poller (every 30s, all online traders)
    from app.services.tracking import tracking_poller
    tracking_task = asyncio.create_task(tracking_poller())
    # Start KYC reconciliation poller — auto-captures Choice Bank approvals that land
    # after the trader leaves the onboarding page (every 5 min).
    from app.services.kyc_poller import kyc_status_poller
    kyc_task = asyncio.create_task(kyc_status_poller())
    # Re-push counterparty filters that never synced (relay was down at save) + self-heal the
    # Gold Merchant badge — only when the trader's relay is up (every 5 min).
    from app.services.filter_poller import filter_sync_poller
    filter_task = asyncio.create_task(filter_sync_poller())
    # Price Monitor — relay-free rank alerts (every 3 min).
    from app.services import price_monitor
    price_monitor_task = asyncio.create_task(price_monitor.start())
    # Auto-pricing (Live) — relay-gated, moves real ad prices within the margin band (every 2 min).
    from app.services import autoprice
    autoprice_task = asyncio.create_task(autoprice.start())
    # Market history — periodic board snapshots for the Price Tracker trend sparklines (every 1 min).
    from app.services import market_history
    market_history_task = asyncio.create_task(market_history.start())
    # Market flow — 24h estimated trading volume from order-book depletion (every 1 min).
    from app.services import market_flow
    market_flow_task = asyncio.create_task(market_flow.start())
    # Squad Mode — live coordinated team pricing (relay-gated, every 90s).
    from app.services import squad_pricing
    squad_pricing_task = asyncio.create_task(squad_pricing.start())
    # Subscription enforcer — lock + wipe config when a plan expires (every 5 min).
    from app.services.subscription_enforcer import subscription_enforcer
    enforcer_task = asyncio.create_task(subscription_enforcer())
    # Subscription reminders — 5-day / 3-day pre-expiry SMS (hourly).
    from app.services.subscription_reminder import subscription_reminder
    reminder_task = asyncio.create_task(subscription_reminder())
    yield
    # Shutdown
    order_poller.stop()
    poller_task.cancel()
    monitor_task.cancel()
    batch_task.cancel()
    batch_monitor_task.cancel()
    tracking_task.cancel()
    kyc_task.cancel()
    filter_task.cancel()
    price_monitor_task.cancel()
    enforcer_task.cancel()
    reminder_task.cancel()
    autoprice_task.cancel()
    market_history_task.cancel()
    market_flow_task.cancel()
    squad_pricing_task.cancel()


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
app.include_router(survey.router, prefix="/api/survey", tags=["Survey"])
app.include_router(affiliates.router, prefix="/api/affiliates", tags=["Affiliates"])
app.include_router(telegram.router, prefix="/api/telegram", tags=["Telegram"])
app.include_router(choice_bank.router, prefix="/api", tags=["Choice Bank"])
app.include_router(kyc_flow.router, prefix="/api", tags=["KYC Flow"])
app.include_router(squads.router, prefix="/api/squads", tags=["Squad Mode"])

@app.get("/api/health")
async def api_health_check():
    return {"status": "ok", "service": settings.APP_NAME}


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": settings.APP_NAME}


# ── Latest release download endpoints ─────────────────────────────────────────
import time as _time
import httpx as _httpx
from fastapi.responses import RedirectResponse

_release_cache: dict = {}
_GITHUB_REPO = "Bazenga254/SparkP2P-releases"
_CACHE_TTL = 300  # 5 minutes


async def _fetch_latest_release() -> dict:
    now = _time.time()
    if _release_cache.get("cached_at") and now - _release_cache["cached_at"] < _CACHE_TTL:
        return _release_cache
    async with _httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.github.com/repos/{_GITHUB_REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    exe = next((a for a in data.get("assets", []) if a["name"].endswith(".exe")), None)
    _release_cache.update({
        "version": data.get("tag_name", "").lstrip("v"),
        "url": exe["browser_download_url"] if exe else None,
        "cached_at": now,
    })
    return _release_cache


@app.get("/api/download/version")
async def get_latest_version():
    from fastapi import HTTPException
    try:
        info = await _fetch_latest_release()
        return {"version": info["version"], "url": info["url"]}
    except Exception:
        raise HTTPException(status_code=502, detail="Could not fetch latest release")


@app.get("/api/download/latest")
async def download_latest():
    from fastapi import HTTPException
    try:
        info = await _fetch_latest_release()
        if not info.get("url"):
            raise HTTPException(status_code=404, detail="No .exe asset found in latest release")
        return RedirectResponse(info["url"], status_code=302)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Could not fetch latest release")


# Android app (sideload APK hosted on the VPS, served for download from sparkp2p.com)
from fastapi.responses import FileResponse
_APK_PATH = os.path.join(os.path.dirname(__file__), "..", "static", "sparkp2p.apk")


@app.get("/api/download/android")
async def download_android():
    from fastapi import HTTPException
    if not os.path.exists(_APK_PATH):
        raise HTTPException(status_code=404, detail="Android app isn't available yet.")
    return FileResponse(_APK_PATH, media_type="application/vnd.android.package-archive", filename="SparkP2P.apk")


# Serve uploaded support attachments
_uploads_dir = os.path.join(os.path.dirname(__file__), "..", "uploads")
os.makedirs(os.path.join(_uploads_dir, "support"), exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_uploads_dir), name="uploads")
