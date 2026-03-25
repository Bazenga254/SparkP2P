"""
Browser Automation API — Playwright session management.

Allows starting/stopping headless browser sessions for traders.
Each session uses cookies from the Chrome extension to maintain
an authenticated Binance session on the VPS.
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decrypt_data
from app.models import Trader
from app.api.deps import get_current_trader
from app.services.browser.engine import browser_engine

logger = logging.getLogger(__name__)

router = APIRouter()


class StartSessionRequest(BaseModel):
    trader_id: Optional[int] = None  # Admin can specify; trader uses own


@router.post("/start")
async def start_browser_session(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Start a Playwright browser session for a trader."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id

    # Load trader
    result = await db.execute(select(Trader).where(Trader.id == target_id))
    target_trader = result.scalar_one_or_none()
    if not target_trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    if not target_trader.binance_cookies:
        raise HTTPException(status_code=400, detail="No Binance cookies stored. Sync from extension first.")

    # Decrypt cookies
    cookies_dict = json.loads(decrypt_data(target_trader.binance_cookies))

    # Decrypt full cookies if available
    cookies_full = None
    if target_trader.binance_cookies_full:
        cookies_full = json.loads(decrypt_data(target_trader.binance_cookies_full))

    cookie_count = len(cookies_full) if cookies_full else len(cookies_dict)
    logger.info(f"Starting browser session for trader {target_id} with {cookie_count} cookies")

    success = await browser_engine.start_session(
        trader_id=target_id,
        trader_name=target_trader.full_name,
        cookies=cookies_dict,
        cookies_full=cookies_full,
    )

    if success:
        return {
            "status": "started",
            "trader_id": target_id,
            "cookies_loaded": cookie_count,
            "message": f"Browser session started for {target_trader.full_name}",
        }
    else:
        session = browser_engine.get_session(target_id)
        error = session.last_error if session else "Unknown error"
        raise HTTPException(status_code=500, detail=f"Failed to start session: {error}")


@router.post("/stop")
async def stop_browser_session(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
):
    """Stop a Playwright browser session."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id

    await browser_engine.stop_session(target_id)
    return {"status": "stopped", "trader_id": target_id}


@router.get("/status")
async def get_browser_status(
    trader: Trader = Depends(get_current_trader),
):
    """Get status of trader's browser session."""
    session = browser_engine.get_session(trader.id)
    if not session:
        return {"running": False, "trader_id": trader.id}
    return session.get_status()


@router.get("/status/all")
async def get_all_browser_status(
    trader: Trader = Depends(get_current_trader),
):
    """Get status of all browser sessions (admin only)."""
    if trader.role not in ("admin", "employee"):
        raise HTTPException(status_code=403, detail="Admin only")
    return {"sessions": browser_engine.get_all_status()}


@router.post("/poll/{trader_id}")
async def poll_trader_orders(
    trader_id: int,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Manually trigger a poll for a trader's orders (admin/debug)."""
    if trader.role not in ("admin", "employee"):
        raise HTTPException(status_code=403, detail="Admin only")

    session = browser_engine.get_session(trader_id)
    if not session or not session.running:
        raise HTTPException(status_code=400, detail="No active session for this trader")

    orders = await session.get_pending_orders()
    return {
        "trader_id": trader_id,
        "sell_orders": len(orders.get("sell", [])),
        "buy_orders": len(orders.get("buy", [])),
        "orders": orders,
    }
