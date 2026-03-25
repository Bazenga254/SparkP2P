"""
Remote Browser Session — live browser streaming via WebSocket.

Allows traders to log into Binance through a live browser view
rendered on the SparkP2P dashboard. Once logged in, the session
is saved and the bot takes over.

Flow:
  1. WebSocket connects → Playwright browser launches
  2. Screenshots streamed to client as base64 JPEG (~2 fps)
  3. Client sends mouse/keyboard events → forwarded to Playwright
  4. Login detected → session state saved → headless takeover
"""

import asyncio
import base64
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Dict

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

logger = logging.getLogger(__name__)

STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=VizDisplayCompositor",
]

BINANCE_LOGIN_URL = "https://accounts.binance.com/en/login"


class RemoteBrowserSession:
    """A live browser session that streams to the user's dashboard."""

    def __init__(self, trader_id: int):
        self.trader_id = trader_id
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.running = False
        self.logged_in = False
        self.streaming = False

    async def start(self):
        """Launch browser and navigate to Binance login."""
        try:
            self.playwright = await async_playwright().start()

            self.browser = await self.playwright.chromium.launch(
                headless=True,
                args=STEALTH_ARGS,
            )

            self.context = await self.browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/146.0.0.0 Safari/537.36"
                ),
                locale="en-GB",
                timezone_id="Africa/Nairobi",
            )

            # Stealth injections
            await self.context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
                );
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-GB', 'en-US', 'en'],
                });
            """)

            self.page = await self.context.new_page()
            self.running = True

            # Navigate to Binance login
            await self.page.goto(BINANCE_LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(1)

            logger.info(f"Remote browser session started for trader {self.trader_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to start remote session for trader {self.trader_id}: {e}")
            return False

    async def take_screenshot(self) -> str:
        """Take a screenshot and return as base64 JPEG."""
        if not self.page:
            return ""
        try:
            screenshot_bytes = await self.page.screenshot(
                type="jpeg",
                quality=70,
            )
            return base64.b64encode(screenshot_bytes).decode("utf-8")
        except Exception as e:
            logger.warning(f"Screenshot failed: {e}")
            return ""

    async def click(self, x: int, y: int):
        """Click at the given coordinates."""
        if not self.page:
            return
        try:
            await self.page.mouse.click(x, y)
            await asyncio.sleep(0.1)
        except Exception as e:
            logger.warning(f"Click failed at ({x}, {y}): {e}")

    async def type_text(self, text: str):
        """Type text into the currently focused element."""
        if not self.page:
            return
        try:
            await self.page.keyboard.type(text, delay=50)
        except Exception as e:
            logger.warning(f"Type failed: {e}")

    async def press_key(self, key: str):
        """Press a keyboard key (Enter, Tab, Backspace, etc.)."""
        if not self.page:
            return
        try:
            await self.page.keyboard.press(key)
        except Exception as e:
            logger.warning(f"Key press failed ({key}): {e}")

    async def mouse_down(self, x: int, y: int):
        """Mouse down at coordinates (for drag operations like CAPTCHA slider)."""
        if not self.page:
            return
        try:
            await self.page.mouse.move(x, y)
            await self.page.mouse.down()
        except Exception as e:
            logger.warning(f"Mouse down failed: {e}")

    async def mouse_move(self, x: int, y: int):
        """Move mouse to coordinates."""
        if not self.page:
            return
        try:
            await self.page.mouse.move(x, y, steps=3)
        except Exception as e:
            logger.warning(f"Mouse move failed: {e}")

    async def mouse_up(self):
        """Release mouse button."""
        if not self.page:
            return
        try:
            await self.page.mouse.up()
        except Exception as e:
            logger.warning(f"Mouse up failed: {e}")

    async def scroll(self, x: int, y: int, delta_x: int = 0, delta_y: int = 0):
        """Scroll at coordinates."""
        if not self.page:
            return
        try:
            await self.page.mouse.wheel(delta_x, delta_y)
        except Exception as e:
            logger.warning(f"Scroll failed: {e}")

    async def check_login_status(self) -> bool:
        """Check if user is now logged into Binance."""
        if not self.page:
            return False
        try:
            # Check for login cookie
            cookies = await self.context.cookies()
            cookie_names = {c["name"] for c in cookies}

            # Binance sets these cookies when logged in
            if "p20t" in cookie_names or "logined" in cookie_names:
                self.logged_in = True
                return True

            # Also check URL — logged in users get redirected away from login page
            url = self.page.url
            if "login" not in url and "binance.com" in url:
                self.logged_in = True
                return True

            return False
        except Exception:
            return False

    async def save_session(self) -> dict:
        """Save the full browser session state (cookies + localStorage)."""
        if not self.context:
            return {}
        try:
            state = await self.context.storage_state()
            cookies = await self.context.cookies()

            logger.info(
                f"Saved session for trader {self.trader_id}: "
                f"{len(cookies)} cookies, {len(state.get('origins', []))} origins"
            )

            return {
                "storage_state": state,
                "cookies": cookies,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            logger.error(f"Failed to save session: {e}")
            return {}

    async def get_current_url(self) -> str:
        """Get current page URL."""
        if not self.page:
            return ""
        return self.page.url

    async def stop(self):
        """Close the browser session."""
        self.running = False
        self.streaming = False
        try:
            if self.context:
                await self.context.close()
            if self.browser:
                await self.browser.close()
            if self.playwright:
                await self.playwright.stop()
        except Exception as e:
            logger.warning(f"Error closing remote session: {e}")
        logger.info(f"Remote browser session stopped for trader {self.trader_id}")


# Active remote sessions (trader_id -> session)
_remote_sessions: Dict[int, RemoteBrowserSession] = {}


def get_remote_session(trader_id: int) -> Optional[RemoteBrowserSession]:
    return _remote_sessions.get(trader_id)


def set_remote_session(trader_id: int, session: RemoteBrowserSession):
    _remote_sessions[trader_id] = session


async def remove_remote_session(trader_id: int):
    session = _remote_sessions.pop(trader_id, None)
    if session:
        await session.stop()
