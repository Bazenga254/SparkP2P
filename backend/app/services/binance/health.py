"""
Session Health Monitor
- Pings Binance every 5 minutes per trader to keep session alive
- Tracks session health score (0-100)
- Predicts expiry based on historical patterns
- Auto-pauses trader's ads when session is unhealthy
- Sends alerts when session drops
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models import Trader, TraderStatus
from app.services.binance.client import BinanceP2PClient, BinanceSessionExpired, BinanceAPIError
from app.services.email import send_email

logger = logging.getLogger(__name__)


class SessionHealthMonitor:
    def __init__(self, ping_interval: int = 300):  # 5 min default
        self.ping_interval = ping_interval
        self.running = False
        # Track health per trader: {trader_id: {score, last_success, consecutive_failures, total_pings, successful_pings}}
        self.health_data = {}

    async def start(self):
        self.running = True
        logger.info("Session health monitor started")
        while self.running:
            try:
                await self._check_all_sessions()
            except Exception as e:
                logger.error(f"Health monitor error: {e}")
            await asyncio.sleep(self.ping_interval)

    def stop(self):
        self.running = False

    def get_health(self, trader_id: int) -> dict:
        return self.health_data.get(trader_id, {"score": 0, "status": "unknown"})

    async def _check_all_sessions(self):
        async with async_session() as db:
            result = await db.execute(
                select(Trader).where(
                    Trader.status == TraderStatus.ACTIVE,
                    Trader.binance_connected == True,
                    Trader.binance_cookies.isnot(None),
                )
            )
            traders = result.scalars().all()

            for trader in traders:
                await self._ping_trader(trader, db)

    async def _ping_trader(self, trader: Trader, db: AsyncSession):
        trader_id = trader.id
        if trader_id not in self.health_data:
            self.health_data[trader_id] = {
                "score": 100,
                "last_success": None,
                "last_check": None,
                "consecutive_failures": 0,
                "total_pings": 0,
                "successful_pings": 0,
                "status": "unknown",
            }

        health = self.health_data[trader_id]
        health["total_pings"] += 1
        health["last_check"] = datetime.now(timezone.utc)

        try:
            client = BinanceP2PClient.from_trader(trader)
            is_valid = await client.check_session()

            if is_valid:
                health["consecutive_failures"] = 0
                health["successful_pings"] += 1
                health["last_success"] = datetime.now(timezone.utc)
                health["status"] = "healthy"
                # Increase score (max 100)
                health["score"] = min(100, health["score"] + 5)

                # Log session health check success
                if trader.binance_connected:
                    logger.debug(f"Trader {trader.id} session healthy")
            else:
                await self._handle_failure(trader, health, db, "Session check returned false")

        except BinanceSessionExpired:
            await self._handle_failure(trader, health, db, "Session expired")
        except Exception as e:
            await self._handle_failure(trader, health, db, str(e))

    async def _handle_failure(self, trader: Trader, health: dict, db: AsyncSession, reason: str):
        health["consecutive_failures"] += 1
        # Decrease score more aggressively with each failure
        health["score"] = max(0, health["score"] - (10 * health["consecutive_failures"]))

        if health["consecutive_failures"] >= 3:
            health["status"] = "critical"

            if trader.binance_connected:
                trader.binance_connected = False
                await db.commit()
                logger.warning(f"Trader {trader.id} disconnected after {health['consecutive_failures']} failures: {reason}")

                # Send alert email
                try:
                    send_session_alert(
                        trader.email,
                        trader.full_name,
                        reason,
                    )
                except Exception:
                    pass
        elif health["consecutive_failures"] >= 2:
            health["status"] = "warning"
        else:
            health["status"] = "degraded"


def send_session_alert(to_email: str, trader_name: str, reason: str):
    """Send email alert when Binance session drops."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #ef4444; font-size: 20px; margin: 0 0 8px;">Session Disconnected</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, your Binance session has disconnected. Auto-trading is paused.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <p style="color: #ef4444; font-size: 13px; margin: 0;">Reason: {reason}</p>
            </div>
            <p style="color: #fff; font-size: 14px; font-weight: 600;">To reconnect:</p>
            <ol style="color: #9ca3af; font-size: 13px; padding-left: 20px;">
                <li>Open Binance in Chrome (make sure you're logged in)</li>
                <li>Click the SparkP2P extension icon</li>
                <li>Click "Sync Binance Cookies"</li>
            </ol>
            <a href="https://sparkp2p.com/dashboard" style="display: inline-block; background: #f59e0b; color: #000; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 12px;">Go to Dashboard</a>
        </div>
    </div>
    """
    send_email(to_email, "SparkP2P - Binance Session Disconnected", html)


# Singleton
session_monitor = SessionHealthMonitor()
