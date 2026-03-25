"""
Browser Automation API — Playwright session management + remote login.

Two modes:
  1. Remote Login: Live browser stream via WebSocket — trader logs into
     Binance manually through the dashboard, bot saves session and takes over.
  2. Bot Mode: Headless polling using saved session cookies.
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, async_session
from app.core.security import decrypt_data, encrypt_data, decode_access_token
from app.models import Trader
from app.api.deps import get_current_trader
from app.services.browser.engine import browser_engine
from app.services.browser.remote_session import (
    RemoteBrowserSession, get_remote_session, set_remote_session, remove_remote_session,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ═══════════════════════════════════════════════════════════
# REMOTE LOGIN — WebSocket live browser stream
# ═══════════════════════════════════════════════════════════

@router.websocket("/login-stream")
async def login_stream(
    websocket: WebSocket,
    token: str = Query(default=None),
):
    """
    WebSocket endpoint for live browser login.

    Client connects with ?token=JWT
    Server streams screenshots, client sends mouse/keyboard events.

    Client → Server messages (JSON):
      {"type": "click", "x": 100, "y": 200}
      {"type": "type", "text": "hello"}
      {"type": "key", "key": "Enter"}
      {"type": "mousedown", "x": 100, "y": 200}
      {"type": "mousemove", "x": 150, "y": 200}
      {"type": "mouseup"}
      {"type": "scroll", "x": 640, "y": 400, "deltaY": -300}
      {"type": "save_session"}

    Server → Client messages (JSON):
      {"type": "screenshot", "data": "<base64 jpeg>", "url": "..."}
      {"type": "status", "logged_in": true, "url": "..."}
      {"type": "session_saved", "cookie_count": 27}
      {"type": "error", "message": "..."}
    """
    # Authenticate via token query param
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    try:
        payload = decode_access_token(token)
        trader_id = int(payload["sub"])
    except Exception:
        await websocket.close(code=4001, reason="Invalid token")
        return

    await websocket.accept()
    logger.info(f"Remote login WebSocket connected for trader {trader_id}")

    # Start remote browser session
    session = RemoteBrowserSession(trader_id)
    started = await session.start()

    if not started:
        await websocket.send_json({"type": "error", "message": "Failed to launch browser"})
        await websocket.close()
        return

    set_remote_session(trader_id, session)

    # Send initial screenshot
    screenshot = await session.take_screenshot()
    url = await session.get_current_url()
    await websocket.send_json({"type": "screenshot", "data": screenshot, "url": url})

    # Start streaming loop and input handler concurrently
    try:
        # Background task: stream screenshots
        async def stream_screenshots():
            while session.running:
                await asyncio.sleep(0.5)  # ~2 fps
                try:
                    screenshot = await session.take_screenshot()
                    if screenshot:
                        url = await session.get_current_url()
                        logged_in = await session.check_login_status()
                        await websocket.send_json({
                            "type": "screenshot",
                            "data": screenshot,
                            "url": url,
                            "logged_in": logged_in,
                        })

                        # Auto-notify when login detected
                        if logged_in and not session.streaming:
                            session.streaming = True  # flag to send only once
                            await websocket.send_json({
                                "type": "status",
                                "logged_in": True,
                                "url": url,
                                "message": "Login detected! Click 'Save & Start Bot' to activate.",
                            })
                except Exception as e:
                    if "close" in str(e).lower():
                        break
                    logger.warning(f"Screenshot stream error: {e}")

        stream_task = asyncio.create_task(stream_screenshots())

        # Main loop: handle user input
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=300)
                msg = json.loads(raw)
            except asyncio.TimeoutError:
                # 5 min timeout — close session
                await websocket.send_json({"type": "error", "message": "Session timed out"})
                break
            except WebSocketDisconnect:
                break
            except Exception:
                break

            msg_type = msg.get("type", "")

            if msg_type == "click":
                await session.click(msg["x"], msg["y"])

            elif msg_type == "dblclick":
                await session.click(msg["x"], msg["y"])
                await asyncio.sleep(0.05)
                await session.click(msg["x"], msg["y"])

            elif msg_type == "type":
                await session.type_text(msg["text"])

            elif msg_type == "key":
                await session.press_key(msg["key"])

            elif msg_type == "mousedown":
                await session.mouse_down(msg["x"], msg["y"])

            elif msg_type == "mousemove":
                await session.mouse_move(msg["x"], msg["y"])

            elif msg_type == "mouseup":
                await session.mouse_up()

            elif msg_type == "scroll":
                await session.scroll(
                    msg.get("x", 0), msg.get("y", 0),
                    msg.get("deltaX", 0), msg.get("deltaY", 0),
                )

            elif msg_type == "save_session":
                # Save session and store in DB
                session_data = await session.save_session()
                if session_data and session_data.get("cookies"):
                    cookies = session_data["cookies"]

                    # Save to DB
                    async with async_session() as db:
                        result = await db.execute(
                            select(Trader).where(Trader.id == trader_id)
                        )
                        trader = result.scalar_one_or_none()
                        if trader:
                            # Save full cookies (Playwright format)
                            trader.binance_cookies_full = encrypt_data(json.dumps(cookies))

                            # Also save legacy {name: value} format
                            cookie_dict = {c["name"]: c["value"] for c in cookies}
                            trader.binance_cookies = encrypt_data(json.dumps(cookie_dict))

                            # Save csrf token if found
                            csrf = cookie_dict.get("csrftoken", "")
                            if csrf:
                                trader.binance_csrf_token = encrypt_data(csrf)

                            bnc_uuid = cookie_dict.get("bnc-uuid", "")
                            if bnc_uuid:
                                trader.binance_bnc_uuid = encrypt_data(bnc_uuid)

                            trader.binance_connected = True
                            await db.commit()

                            logger.info(
                                f"Session saved for trader {trader_id}: "
                                f"{len(cookies)} cookies stored"
                            )

                    await websocket.send_json({
                        "type": "session_saved",
                        "cookie_count": len(cookies),
                        "message": f"Session saved! {len(cookies)} cookies stored. Bot is ready.",
                    })
                else:
                    await websocket.send_json({
                        "type": "error",
                        "message": "No session data to save. Please log in first.",
                    })

            elif msg_type == "close":
                break

            # Send fresh screenshot after each interaction
            await asyncio.sleep(0.3)

        # Cleanup
        stream_task.cancel()

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for trader {trader_id}")
    except Exception as e:
        logger.error(f"WebSocket error for trader {trader_id}: {e}")
    finally:
        await remove_remote_session(trader_id)
        logger.info(f"Remote login session ended for trader {trader_id}")


# ═══════════════════════════════════════════════════════════
# BOT MODE — headless session management
# ═══════════════════════════════════════════════════════════

class StartSessionRequest(BaseModel):
    trader_id: Optional[int] = None


@router.post("/start")
async def start_browser_session(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Start a headless Playwright bot session using saved cookies."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id

    result = await db.execute(select(Trader).where(Trader.id == target_id))
    target_trader = result.scalar_one_or_none()
    if not target_trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    if not target_trader.binance_cookies:
        raise HTTPException(
            status_code=400,
            detail="No Binance session. Use 'Connect Binance' to log in first.",
        )

    cookies_dict = json.loads(decrypt_data(target_trader.binance_cookies))
    cookies_full = None
    if target_trader.binance_cookies_full:
        cookies_full = json.loads(decrypt_data(target_trader.binance_cookies_full))

    cookie_count = len(cookies_full) if cookies_full else len(cookies_dict)

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
            "message": f"Bot started for {target_trader.full_name}",
        }
    else:
        session = browser_engine.get_session(target_id)
        error = session.last_error if session else "Unknown error"
        raise HTTPException(status_code=500, detail=f"Failed to start: {error}")


@router.post("/stop")
async def stop_browser_session(
    data: StartSessionRequest = None,
    trader: Trader = Depends(get_current_trader),
):
    """Stop a headless bot session."""
    target_id = trader.id
    if data and data.trader_id and trader.role in ("admin", "employee"):
        target_id = data.trader_id

    await browser_engine.stop_session(target_id)
    return {"status": "stopped", "trader_id": target_id}


@router.get("/status")
async def get_browser_status(trader: Trader = Depends(get_current_trader)):
    """Get status of trader's bot session."""
    session = browser_engine.get_session(trader.id)
    if not session:
        return {"running": False, "trader_id": trader.id}
    return session.get_status()


@router.get("/status/all")
async def get_all_browser_status(trader: Trader = Depends(get_current_trader)):
    """Get status of all bot sessions (admin only)."""
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
        raise HTTPException(status_code=400, detail="No active session")

    orders = await session.get_pending_orders()
    return {
        "trader_id": trader_id,
        "sell_orders": len(orders.get("sell", [])),
        "buy_orders": len(orders.get("buy", [])),
        "orders": orders,
    }
