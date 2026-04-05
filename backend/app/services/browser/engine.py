"""
SparkP2P Browser Automation Engine (v3)

Uses Playwright to run a real headless browser on the VPS.
Each trader gets their own browser instance that:
- Logs into Binance P2P
- Monitors orders in real-time
- Auto-releases crypto (sell side)
- Auto-pays sellers (buy side)
- Runs 24/7 without user's PC

This replaces the Chrome extension approach entirely.
"""

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Optional, Dict

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

logger = logging.getLogger(__name__)

# Stealth settings to avoid bot detection
STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor",
]

BINANCE_P2P_URL = "https://c2c.binance.com/en/trade/all-payments/USDT?fiat=KES"
BINANCE_ORDERS_URL = "https://c2c.binance.com/en/fiatOrder"


class BinanceBrowserSession:
    """A single trader's Binance browser session."""

    def __init__(self, trader_id: int, trader_name: str):
        self.trader_id = trader_id
        self.trader_name = trader_name
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.running = False
        self.last_poll = None
        self.poll_count = 0
        self.error_count = 0
        self.last_error = None
        self.connected = False

    async def start(self, cookies: list = None, storage_state: dict = None):
        """Start the browser session."""
        try:
            playwright = await async_playwright().start()

            self.browser = await playwright.chromium.launch(
                headless=True,
                args=STEALTH_ARGS,
            )

            # Create context with stealth settings
            context_options = {
                "viewport": {"width": 1920, "height": 1080},
                "user_agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/146.0.0.0 Safari/537.36"
                ),
                "locale": "en-GB",
                "timezone_id": "Africa/Nairobi",
            }

            # Load saved state if available
            if storage_state:
                context_options["storage_state"] = storage_state

            self.context = await self.browser.new_context(**context_options)

            # Add cookies if provided
            if cookies:
                await self.context.add_cookies(cookies)

            # Inject stealth scripts
            await self.context.add_init_script("""
                // Override navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                // Override chrome.runtime
                window.chrome = { runtime: {} };

                // Override permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
                );

                // Override plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });

                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-GB', 'en-US', 'en'],
                });
            """)

            self.page = await self.context.new_page()
            self.running = True
            self.connected = True

            logger.info(f"Browser session started for trader {self.trader_id} ({self.trader_name})")
            return True

        except Exception as e:
            logger.error(f"Failed to start browser for trader {self.trader_id}: {e}")
            self.last_error = str(e)
            return False

    async def stop(self):
        """Stop the browser session."""
        self.running = False
        self.connected = False
        try:
            if self.context:
                await self.context.close()
            if self.browser:
                await self.browser.close()
        except Exception as e:
            logger.warning(f"Error closing browser for trader {self.trader_id}: {e}")
        logger.info(f"Browser session stopped for trader {self.trader_id}")

    async def save_state(self) -> Optional[dict]:
        """Save browser state (cookies + storage) for persistence."""
        try:
            if self.context:
                return await self.context.storage_state()
        except Exception as e:
            logger.warning(f"Failed to save state for trader {self.trader_id}: {e}")
        return None

    async def login_with_cookies(self, cookie_dict: dict, cookies_full: list = None) -> bool:
        """Login to Binance using cookies from the Chrome extension.

        Args:
            cookie_dict: Legacy {name: value} cookies (fallback)
            cookies_full: Full cookie objects from extension [{name, value, domain, path, secure, httpOnly, sameSite}, ...]
        """
        try:
            pw_cookies = []

            if cookies_full:
                # Use full cookie objects — preserves all attributes
                for c in cookies_full:
                    # Map Chrome extension sameSite values to Playwright values
                    same_site = c.get("sameSite", "no_restriction")
                    if same_site == "no_restriction":
                        same_site = "None"
                    elif same_site == "lax":
                        same_site = "Lax"
                    elif same_site == "strict":
                        same_site = "Strict"
                    else:
                        same_site = "None"

                    pw_cookie = {
                        "name": c["name"],
                        "value": c["value"],
                        "domain": c.get("domain", ".binance.com"),
                        "path": c.get("path", "/"),
                    }
                    # Playwright requires secure=True when sameSite=None
                    if same_site == "None":
                        pw_cookie["secure"] = True
                        pw_cookie["sameSite"] = "None"
                    else:
                        pw_cookie["secure"] = c.get("secure", False)
                        pw_cookie["sameSite"] = same_site

                    if c.get("httpOnly"):
                        pw_cookie["httpOnly"] = True

                    # Convert expirationDate (Unix seconds) to expires (Unix seconds)
                    if c.get("expirationDate"):
                        pw_cookie["expires"] = c["expirationDate"]

                    pw_cookies.append(pw_cookie)

                logger.info(f"Trader {self.trader_id}: loading {len(pw_cookies)} full cookies into Playwright")
            else:
                # Fallback: legacy {name: value} format
                for name, value in cookie_dict.items():
                    pw_cookies.append({
                        "name": name,
                        "value": value,
                        "domain": ".binance.com",
                        "path": "/",
                        "secure": True,
                        "sameSite": "None",
                    })
                logger.info(f"Trader {self.trader_id}: loading {len(pw_cookies)} legacy cookies into Playwright")

            await self.context.add_cookies(pw_cookies)

            # Navigate to Binance to verify login
            await self.page.goto("https://www.binance.com/en", wait_until="networkidle", timeout=30000)

            # Check if logged in
            await asyncio.sleep(2)
            logged_in = await self.page.evaluate("() => document.cookie.includes('logined=y')")

            if logged_in:
                logger.info(f"Trader {self.trader_id} logged into Binance successfully")
                self.connected = True
                return True
            else:
                logger.warning(f"Trader {self.trader_id} cookie login failed — not logged in")
                return False

        except Exception as e:
            logger.error(f"Cookie login failed for trader {self.trader_id}: {e}")
            self.last_error = str(e)
            return False

    async def navigate_to_orders(self):
        """Navigate to the P2P orders page."""
        try:
            await self.page.goto(BINANCE_ORDERS_URL, wait_until="networkidle", timeout=30000)
            await asyncio.sleep(random.uniform(1, 3))
        except Exception as e:
            logger.error(f"Failed to navigate to orders: {e}")

    async def get_pending_orders(self) -> list:
        """Get pending P2P orders by intercepting API responses."""
        orders = []
        try:
            # Use Playwright's route interception to capture API responses
            sell_orders = []
            buy_orders = []

            async def handle_response(response):
                if "order-match/order-list" in response.url:
                    try:
                        data = await response.json()
                        if data.get("code") == "000000" and data.get("data"):
                            for order in data["data"]:
                                orders.append(order)
                    except Exception:
                        pass

            self.page.on("response", handle_response)

            # Make API calls by navigating/refreshing
            # Call the API directly from the page context
            result = await self.page.evaluate("""
                async () => {
                    const results = { sell: [], buy: [] };

                    try {
                        // Get sell orders
                        const sellResp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [1, 2, 3] }),
                            credentials: 'include',
                        });
                        const sellData = await sellResp.json();
                        if (sellData.code === '000000') results.sell = sellData.data || [];

                        // Get buy orders
                        const buyResp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [1, 2, 3] }),
                            credentials: 'include',
                        });
                        const buyData = await buyResp.json();
                        if (buyData.code === '000000') results.buy = buyData.data || [];
                    } catch (e) {
                        results.error = e.message;
                    }

                    return results;
                }
            """)

            self.page.remove_listener("response", handle_response)

            self.last_poll = datetime.now(timezone.utc)
            self.poll_count += 1

            sell_orders = result.get("sell", [])
            buy_orders = result.get("buy", [])

            if result.get("error"):
                logger.warning(f"Order fetch error for trader {self.trader_id}: {result['error']}")
                self.error_count += 1
                self.last_error = result["error"]

            logger.debug(
                f"Trader {self.trader_id}: {len(sell_orders)} sell, {len(buy_orders)} buy orders"
            )

            return {"sell": sell_orders, "buy": buy_orders}

        except Exception as e:
            logger.error(f"get_pending_orders failed for trader {self.trader_id}: {e}")
            self.error_count += 1
            self.last_error = str(e)
            return {"sell": [], "buy": []}

    async def release_order(self, order_number: str) -> bool:
        """Release crypto for a sell order."""
        try:
            result = await self.page.evaluate(f"""
                async () => {{
                    try {{
                        const resp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/confirm-order', {{
                            method: 'POST',
                            headers: {{ 'Content-Type': 'application/json' }},
                            body: JSON.stringify({{ orderNumber: '{order_number}' }}),
                            credentials: 'include',
                        }});
                        const data = await resp.json();
                        return {{ success: data.code === '000000', code: data.code, message: data.message }};
                    }} catch (e) {{
                        return {{ success: false, error: e.message }};
                    }}
                }}
            """)

            if result.get("success"):
                logger.info(f"Released order {order_number} for trader {self.trader_id}")
                return True
            else:
                logger.error(f"Release failed for {order_number}: {result}")
                return False

        except Exception as e:
            logger.error(f"release_order failed: {e}")
            return False

    async def mark_as_paid(self, order_number: str) -> bool:
        """Mark a buy order as paid."""
        try:
            result = await self.page.evaluate(f"""
                async () => {{
                    try {{
                        const resp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/buyer-confirm-pay', {{
                            method: 'POST',
                            headers: {{ 'Content-Type': 'application/json' }},
                            body: JSON.stringify({{ orderNumber: '{order_number}' }}),
                            credentials: 'include',
                        }});
                        const data = await resp.json();
                        return {{ success: data.code === '000000', code: data.code, message: data.message }};
                    }} catch (e) {{
                        return {{ success: false, error: e.message }};
                    }}
                }}
            """)

            if result.get("success"):
                logger.info(f"Marked order {order_number} as paid for trader {self.trader_id}")
                return True
            else:
                logger.error(f"Mark as paid failed for {order_number}: {result}")
                return False

        except Exception as e:
            logger.error(f"mark_as_paid failed: {e}")
            return False

    async def send_chat_message(self, order_number: str, message: str) -> bool:
        """Send a chat message on a P2P order."""
        try:
            result = await self.page.evaluate(f"""
                async () => {{
                    try {{
                        const resp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/chat/send-message', {{
                            method: 'POST',
                            headers: {{ 'Content-Type': 'application/json' }},
                            body: JSON.stringify({{ orderNumber: '{order_number}', message: `{message}`, msgType: 1 }}),
                            credentials: 'include',
                        }});
                        const data = await resp.json();
                        return {{ success: data.code === '000000' }};
                    }} catch (e) {{
                        return {{ success: false, error: e.message }};
                    }}
                }}
            """)
            return result.get("success", False)
        except Exception:
            return False

    async def get_completed_orders(self, limit: int = 10) -> list:
        """Get completed order history."""
        try:
            result = await self.page.evaluate(f"""
                async () => {{
                    try {{
                        const resp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {{
                            method: 'POST',
                            headers: {{ 'Content-Type': 'application/json' }},
                            body: JSON.stringify({{ page: 1, rows: {limit}, tradeType: 'SELL', orderStatusList: [4] }}),
                            credentials: 'include',
                        }});
                        const data = await resp.json();
                        return data.code === '000000' ? (data.data || []) : [];
                    }} catch (e) {{
                        return [];
                    }}
                }}
            """)
            return result
        except Exception:
            return []

    async def release_with_vision(
        self,
        order_number: str,
        totp_secret: Optional[str] = None,
        gmail_page=None,
        api_key: str = None,
        known_gmail_ids: set = None,
    ) -> dict:
        """
        Navigate to an order page and release it using Claude Vision at each step.

        Instead of fragile CSS selectors, Claude reads each screenshot like a human
        and returns the exact screen state + correct next action. Prevents misreads
        like "7 USDT" being parsed as "7,000 USDT".

        Steps handled automatically:
          1. awaiting_payment   → wait + poll
          2. verify_payment     → click Payment Received
          3. confirm_release_modal → tick checkbox → click Confirm Release
          4. passkey_failed     → click My Passkeys Are Not Available
          5. security_verification → click Authenticator App → then Email
          6. totp_input         → generate code via pyotp → fill + submit
          7. email_otp_input    → scan Gmail → fill + submit
          8. order_complete     → done ✓
        """
        import base64
        import pyotp
        from app.services.binance.vision import analyze_page

        if not api_key:
            from app.core.config import settings
            api_key = settings.ANTHROPIC_API_KEY

        try:
            order_url = f"https://p2p.binance.com/en/fiatOrderDetail?orderNo={order_number}"
            await self.page.goto(order_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)

            MAX_STEPS = 20
            step = 0
            last_screen = "unknown"

            while step < MAX_STEPS:
                step += 1

                # Screenshot → Claude Vision
                raw = await self.page.screenshot(type="jpeg", quality=85)
                b64 = base64.b64encode(raw).decode("utf-8")
                info = await analyze_page(b64, api_key)
                screen = info.get("screen", "unknown")
                last_screen = screen

                logger.info(
                    f"[Vision] Trader {self.trader_id} | Order {order_number} | "
                    f"Step {step} | Screen: {screen} | "
                    f"USDT: {info.get('usdt_amount')} | KES: {info.get('fiat_amount_kes')}"
                )

                # ── Order complete ──────────────────────────────────────────
                if screen == "order_complete" or info.get("sale_successful"):
                    logger.info(f"[Vision] Order {order_number} released successfully!")
                    return {
                        "success": True,
                        "screen": screen,
                        "usdt_amount": info.get("usdt_amount"),
                        "fiat_amount_kes": info.get("fiat_amount_kes"),
                        "buyer_name": info.get("buyer_name"),
                    }

                # ── Awaiting payment — poll until buyer pays ────────────────
                if screen == "awaiting_payment":
                    await asyncio.sleep(15)
                    await self.page.reload(wait_until="domcontentloaded")
                    await asyncio.sleep(3)
                    continue

                # ── Verify payment — click Payment Received ─────────────────
                if screen == "verify_payment":
                    clicked = False
                    for selector in [
                        'button:has-text("Payment Received")',
                        'button:has-text("payment received")',
                    ]:
                        btn = self.page.locator(selector)
                        if await btn.count() > 0:
                            await btn.first.click()
                            clicked = True
                            break
                    if not clicked:
                        await self.page.get_by_role("button", name="Payment Received").click()
                    await asyncio.sleep(2)
                    continue

                # ── Confirm release modal — checkbox + Confirm Release ───────
                if screen == "confirm_release_modal":
                    if info.get("checkbox_visible") and not info.get("checkbox_checked"):
                        cb = self.page.locator('input[type="checkbox"]').first
                        if await cb.count() > 0:
                            await cb.click()
                            await asyncio.sleep(1)
                    for selector in [
                        'button:has-text("Confirm Release")',
                        'button:has-text("confirm release")',
                    ]:
                        btn = self.page.locator(selector)
                        if await btn.count() > 0:
                            await btn.first.click()
                            break
                    await asyncio.sleep(2)
                    continue

                # ── Passkey failed — click "My Passkeys Are Not Available" ──
                if screen == "passkey_failed":
                    for selector in [
                        'text="My Passkeys Are Not Available"',
                        ':has-text("My Passkeys Are Not Available")',
                        'a:has-text("Passkeys")',
                    ]:
                        link = self.page.locator(selector).first
                        if await link.count() > 0:
                            await link.click()
                            break
                    await asyncio.sleep(2)
                    continue

                # ── Security verification 0/2 or 1/2 ───────────────────────
                if screen == "security_verification":
                    pending = info.get("pending_verifications", [])
                    completed = info.get("completed_verifications", [])

                    if "Authenticator App" in pending:
                        for selector in [
                            'text="Authenticator App"',
                            ':has-text("Authenticator App")',
                        ]:
                            btn = self.page.locator(selector).first
                            if await btn.count() > 0:
                                await btn.click()
                                break
                        await asyncio.sleep(2)
                        continue

                    if "Email" in pending and "Authenticator App" in completed:
                        for selector in ['text="Email"', ':has-text("Email")']:
                            btn = self.page.locator(selector).first
                            if await btn.count() > 0:
                                await btn.click()
                                break
                        await asyncio.sleep(2)
                        continue

                # ── TOTP input — generate via pyotp ────────────────────────
                if screen == "totp_input":
                    if not totp_secret:
                        logger.error(f"TOTP required but not configured for trader {self.trader_id}")
                        return {"success": False, "error": "TOTP required but not configured"}
                    code = pyotp.TOTP(totp_secret).now()
                    logger.info(f"[Vision] Auto-filling TOTP for trader {self.trader_id}")
                    inp = self.page.locator(
                        'input[maxlength="6"], input[type="tel"], '
                        'input[placeholder*="code"], input[placeholder*="Code"]'
                    ).first
                    if await inp.count() > 0:
                        await inp.fill(code)
                        await asyncio.sleep(0.5)
                    for selector in [
                        'button:has-text("Confirm")',
                        'button:has-text("Submit")',
                        'button:has-text("Verify")',
                        'button[type="submit"]',
                    ]:
                        btn = self.page.locator(selector).first
                        if await btn.count() > 0:
                            await btn.click()
                            break
                    await asyncio.sleep(2)
                    continue

                # ── Email OTP — scan Gmail tab ──────────────────────────────
                if screen == "email_otp_input":
                    if not gmail_page:
                        logger.error(f"Email OTP required but no Gmail tab for trader {self.trader_id}")
                        return {"success": False, "error": "Email OTP required but Gmail not connected"}

                    otp = await self._scan_gmail_for_otp(gmail_page, known_ids=known_gmail_ids or set())
                    if not otp:
                        logger.error(f"Gmail OTP scan timed out for trader {self.trader_id}")
                        return {"success": False, "error": "Email OTP not found in Gmail"}

                    logger.info(f"[Vision] Auto-filling email OTP for trader {self.trader_id}")
                    inp = self.page.locator(
                        'input[maxlength="6"], input[type="tel"], '
                        'input[placeholder*="code"], input[placeholder*="Code"]'
                    ).first
                    if await inp.count() > 0:
                        await inp.fill(otp)
                        await asyncio.sleep(0.5)
                    for selector in [
                        'button:has-text("Confirm")',
                        'button:has-text("Submit")',
                        'button:has-text("Verify")',
                        'button[type="submit"]',
                    ]:
                        btn = self.page.locator(selector).first
                        if await btn.count() > 0:
                            await btn.click()
                            break
                    await asyncio.sleep(2)
                    continue

                # ── Unknown — wait and retry ────────────────────────────────
                logger.warning(f"[Vision] Unknown screen for order {order_number}, retrying...")
                await asyncio.sleep(5)
                await self.page.reload(wait_until="domcontentloaded")
                await asyncio.sleep(3)

            logger.error(f"[Vision] Order {order_number} exceeded {MAX_STEPS} steps")
            return {"success": False, "error": f"Exceeded {MAX_STEPS} steps", "last_screen": last_screen}

        except Exception as e:
            logger.error(f"[Vision] release_with_vision failed for {order_number}: {e}")
            return {"success": False, "error": str(e)}

    async def _scan_gmail_for_otp(self, gmail_page, known_ids: set = None, max_wait: int = 60) -> Optional[str]:
        """Scan an open Gmail tab for a new Binance OTP email and extract the 6-digit code."""
        import re as re_mod
        if known_ids is None:
            known_ids = set()
        try:
            await gmail_page.bring_to_front()
            search_url = "https://mail.google.com/mail/u/0/#search/from%3A(binance)"
            waited = 0
            while waited < max_wait:
                await gmail_page.goto(search_url, wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(2)
                rows = gmail_page.locator("tr.zA")
                count = await rows.count()
                for i in range(count):
                    row = rows.nth(i)
                    tid = await row.get_attribute("id")
                    if tid in known_ids:
                        continue
                    await row.click()
                    await asyncio.sleep(2)
                    body = ""
                    for sel in [".a3s.aiL", "[data-message-id]", ".ii.gt"]:
                        el = gmail_page.locator(sel).first
                        if await el.count() > 0:
                            body = await el.text_content() or ""
                            if body:
                                break
                    matches = re_mod.findall(r"\b(\d{6})\b", body)
                    if matches:
                        await self.page.bring_to_front()
                        return matches[0]
                await asyncio.sleep(4)
                waited += 4
            await self.page.bring_to_front()
            return None
        except Exception as e:
            logger.error(f"Gmail OTP scan failed: {e}")
            await self.page.bring_to_front()
            return None

    def get_status(self) -> dict:
        """Get session status."""
        return {
            "trader_id": self.trader_id,
            "trader_name": self.trader_name,
            "running": self.running,
            "connected": self.connected,
            "last_poll": self.last_poll.isoformat() if self.last_poll else None,
            "poll_count": self.poll_count,
            "error_count": self.error_count,
            "last_error": self.last_error,
        }


class BrowserAutomationEngine:
    """
    Manages browser sessions for all active traders.
    Each trader gets their own headless browser instance.
    """

    def __init__(self):
        self.sessions: Dict[int, BinanceBrowserSession] = {}
        self.running = False

    async def start_session(self, trader_id: int, trader_name: str, cookies: dict, cookies_full: list = None) -> bool:
        """Start a browser session for a trader."""
        if trader_id in self.sessions and self.sessions[trader_id].running:
            logger.info(f"Session already running for trader {trader_id}")
            return True

        session = BinanceBrowserSession(trader_id, trader_name)
        success = await session.start()

        if success:
            # Login with cookies (prefer full cookies for Playwright)
            logged_in = await session.login_with_cookies(cookies, cookies_full=cookies_full)
            if logged_in:
                self.sessions[trader_id] = session
                # Navigate to Binance P2P
                await session.page.goto(
                    "https://c2c.binance.com/en/trade/all-payments/USDT?fiat=KES",
                    wait_until="networkidle",
                    timeout=30000,
                )
                logger.info(f"Browser session ready for trader {trader_id}")
                return True
            else:
                await session.stop()
                return False
        return False

    async def stop_session(self, trader_id: int):
        """Stop a trader's browser session."""
        if trader_id in self.sessions:
            await self.sessions[trader_id].stop()
            del self.sessions[trader_id]

    async def stop_all(self):
        """Stop all sessions."""
        self.running = False
        for trader_id in list(self.sessions.keys()):
            await self.stop_session(trader_id)

    def get_session(self, trader_id: int) -> Optional[BinanceBrowserSession]:
        """Get a trader's session."""
        return self.sessions.get(trader_id)

    def get_all_status(self) -> list:
        """Get status of all sessions."""
        return [s.get_status() for s in self.sessions.values()]

    async def poll_all_traders(self):
        """Poll orders for all active sessions and process them."""
        for trader_id, session in list(self.sessions.items()):
            if not session.running:
                continue
            try:
                orders = await session.get_pending_orders()
                # Return orders for VPS processing
                yield trader_id, orders
            except Exception as e:
                logger.error(f"Poll failed for trader {trader_id}: {e}")
                session.error_count += 1
                session.last_error = str(e)


# Singleton
browser_engine = BrowserAutomationEngine()
