"""
Browser Automation API — Playwright login wizard + bot management.

Login wizard: Step-by-step automated login via REST API.
  1. POST /login/start → launches browser, goes to Binance login
  2. POST /login/email → types email, clicks continue
  3. POST /login/password → types password, clicks login
  4. POST /login/captcha → forwards CAPTCHA solution
  5. POST /login/2fa → enters 2FA code
  6. POST /login/save → saves session cookies to DB
  7. GET  /login/screenshot → get current page screenshot

Bot mode: Headless trading using saved cookies via httpx.
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import encrypt_data
from app.models import Trader
from app.api.deps import get_current_trader
from app.services.browser.engine import browser_engine
from app.services.browser.login_wizard import (
    LoginWizardSession, get_wizard, set_wizard, remove_wizard,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ═══════════════════════════════════════════════════════════
# LOGIN WIZARD — step-by-step Binance login
# ═══════════════════════════════════════════════════════════

class EmailInput(BaseModel):
    email: str

class PasswordInput(BaseModel):
    password: str

class CaptchaClickInput(BaseModel):
    x: int
    y: int

class CaptchaDragInput(BaseModel):
    start_x: int
    start_y: int
    end_x: int
    end_y: int

class TwoFAInput(BaseModel):
    code: str


@router.post("/login/start")
async def login_start(trader: Trader = Depends(get_current_trader)):
    """Step 0: Launch browser and navigate to Binance login page."""
    # Clean up any existing session
    await remove_wizard(trader.id)

    session = LoginWizardSession(trader.id)
    result = await session.start()

    if result.get("step") == "error":
        await session.stop()
        raise HTTPException(status_code=500, detail=result["message"])

    set_wizard(trader.id, session)
    return result


@router.post("/login/email")
async def login_email(
    data: EmailInput,
    trader: Trader = Depends(get_current_trader),
):
    """Step 1: Submit email/phone number."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session. Call /login/start first.")
    return await session.submit_email(data.email)


@router.post("/login/password")
async def login_password(
    data: PasswordInput,
    trader: Trader = Depends(get_current_trader),
):
    """Step 2: Submit password."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")
    return await session.submit_password(data.password)


@router.post("/login/captcha/click")
async def login_captcha_click(
    data: CaptchaClickInput,
    trader: Trader = Depends(get_current_trader),
):
    """Step 3a: Click on CAPTCHA element."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")
    return await session.solve_captcha_click(data.x, data.y)


@router.post("/login/captcha/drag")
async def login_captcha_drag(
    data: CaptchaDragInput,
    trader: Trader = Depends(get_current_trader),
):
    """Step 3b: Drag CAPTCHA slider."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")
    return await session.solve_captcha_drag(data.start_x, data.start_y, data.end_x, data.end_y)


@router.post("/login/2fa")
async def login_2fa(
    data: TwoFAInput,
    trader: Trader = Depends(get_current_trader),
):
    """Step 4: Submit 2FA verification code."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")
    return await session.submit_2fa(data.code)


@router.get("/login/screenshot")
async def login_screenshot(trader: Trader = Depends(get_current_trader)):
    """Get current page screenshot (for debugging or CAPTCHA view)."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")
    return await session.get_screenshot()


@router.post("/login/save")
async def login_save(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Save session cookies to database and close browser."""
    session = get_wizard(trader.id)
    if not session:
        raise HTTPException(status_code=400, detail="No active login session.")

    result = await session.save_session()

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "Failed to save session"))

    cookies = result["cookies"]
    cookie_dict = result["cookie_dict"]

    # Save to DB
    trader.binance_cookies_full = encrypt_data(json.dumps(cookies))
    trader.binance_cookies = encrypt_data(json.dumps(cookie_dict))

    csrf = cookie_dict.get("csrftoken", "")
    if csrf:
        trader.binance_csrf_token = encrypt_data(csrf)

    bnc_uuid = cookie_dict.get("bnc-uuid", "")
    if bnc_uuid:
        trader.binance_bnc_uuid = encrypt_data(bnc_uuid)

    trader.binance_connected = True
    await db.commit()

    # Close browser — we don't need it anymore
    await remove_wizard(trader.id)

    logger.info(f"Login wizard complete for trader {trader.id}: {len(cookies)} cookies saved")

    return {
        "status": "connected",
        "message": f"Binance connected! {len(cookies)} cookies saved. Bot ready.",
        "cookie_count": len(cookies),
    }


@router.post("/login/cancel")
async def login_cancel(trader: Trader = Depends(get_current_trader)):
    """Cancel and close the login session."""
    await remove_wizard(trader.id)
    return {"status": "cancelled"}


# ═══════════════════════════════════════════════════════════
# BOT MODE — headless session management (uses saved cookies)
# ═══════════════════════════════════════════════════════════

class StartSessionRequest(BaseModel):
    trader_id: Optional[int] = None


@router.post("/bot/start")
async def start_bot(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Start headless bot using saved cookies (no browser UI needed)."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id

    result = await db.execute(select(Trader).where(Trader.id == target_id))
    target = result.scalar_one_or_none()
    if not target or not target.binance_cookies:
        raise HTTPException(status_code=400, detail="No Binance session. Connect Binance first.")

    from app.core.security import decrypt_data
    cookies = json.loads(decrypt_data(target.binance_cookies))
    cookies_full = None
    if target.binance_cookies_full:
        cookies_full = json.loads(decrypt_data(target.binance_cookies_full))

    success = await browser_engine.start_session(
        trader_id=target_id,
        trader_name=target.full_name,
        cookies=cookies,
        cookies_full=cookies_full,
    )

    if success:
        return {"status": "started", "trader_id": target_id}
    else:
        raise HTTPException(status_code=500, detail="Failed to start bot")


@router.post("/bot/stop")
async def stop_bot(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
):
    """Stop headless bot."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id
    await browser_engine.stop_session(target_id)
    return {"status": "stopped", "trader_id": target_id}


@router.get("/bot/status")
async def bot_status(trader: Trader = Depends(get_current_trader)):
    """Get bot status."""
    session = browser_engine.get_session(trader.id)
    if not session:
        return {"running": False, "trader_id": trader.id}
    return session.get_status()


@router.get("/bot/status/all")
async def all_bot_status(trader: Trader = Depends(get_current_trader)):
    """Get all bot sessions (admin only)."""
    if trader.role not in ("admin", "employee"):
        raise HTTPException(status_code=403, detail="Admin only")
    return {"sessions": browser_engine.get_all_status()}
