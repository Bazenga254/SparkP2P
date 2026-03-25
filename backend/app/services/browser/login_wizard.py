"""
Binance Login Wizard — step-by-step automated login.

Instead of streaming a full browser, we automate login steps:
1. User provides email/password via API
2. Playwright fills form and clicks login
3. If CAPTCHA → return screenshot of puzzle for user to solve
4. If 2FA → user provides code via API
5. Session saved → bot ready

Each step returns a status + optional screenshot for user action.
"""

import asyncio
import base64
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


class LoginWizardSession:
    """Automated Binance login with step-by-step user interaction."""

    def __init__(self, trader_id: int):
        self.trader_id = trader_id
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.step = "idle"  # idle, email, password, captcha, 2fa, logged_in, error
        self.error_message = None

    async def start(self) -> dict:
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

            await self.context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] });
            """)

            self.page = await self.context.new_page()
            await self.page.goto(BINANCE_LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)

            self.step = "email"
            logger.info(f"Login wizard started for trader {self.trader_id}")
            return {"step": "email", "message": "Enter your Binance email or phone number"}

        except Exception as e:
            logger.error(f"Login wizard start failed: {e}")
            self.step = "error"
            self.error_message = str(e)
            return {"step": "error", "message": f"Failed to launch browser: {e}"}

    async def submit_email(self, email: str) -> dict:
        """Type email and click Continue.
        Binance flow: Email → Continue → CAPTCHA → Password → 2FA
        After Continue, a CAPTCHA usually appears before the password field.
        """
        try:
            # Binance uses name="username" for the email/phone input
            email_input = self.page.locator('input[name="username"]')
            if await email_input.count() == 0:
                # Fallback selectors
                email_input = self.page.locator('input[type="text"]').first
            else:
                email_input = email_input.first

            await email_input.click()
            await email_input.fill("")
            await email_input.type(email, delay=30)
            await asyncio.sleep(0.5)

            # Click Continue using get_by_role (more reliable than has-text)
            await self.page.get_by_role("button", name="Continue", exact=True).click()
            await asyncio.sleep(4)

            # Detect what appeared next
            return await self._detect_next_step()

        except Exception as e:
            logger.error(f"Submit email failed: {e}")
            screenshot = await self._take_screenshot()
            return {"step": "email", "message": f"Error: {e}", "screenshot": screenshot}

    async def submit_password(self, password: str) -> dict:
        """Type password and click Log In."""
        try:
            # Wait for password field to be visible
            pw_input = self.page.locator('input[type="password"]').first
            await pw_input.wait_for(state="visible", timeout=10000)
            await pw_input.click()
            await pw_input.fill("")
            await pw_input.type(password, delay=30)
            await asyncio.sleep(0.5)

            # Click Log In using get_by_role
            try:
                await self.page.get_by_role("button", name="Log In").click()
            except Exception:
                # Fallback: try submit button
                try:
                    await self.page.locator('button[type="submit"]').first.click()
                except Exception:
                    # Last resort: press Enter
                    await self.page.keyboard.press("Enter")

            await asyncio.sleep(4)

            # Check what happened next
            return await self._detect_next_step()

        except Exception as e:
            logger.error(f"Submit password failed: {e}")
            screenshot = await self._take_screenshot()
            return {"step": "password", "message": f"Error: {e}", "screenshot": screenshot}

    async def solve_captcha_click(self, x: int, y: int) -> dict:
        """User clicked on the CAPTCHA — forward the click."""
        try:
            await self.page.mouse.click(x, y)
            await asyncio.sleep(1)
            return await self._detect_next_step()
        except Exception as e:
            screenshot = await self._take_screenshot()
            return {"step": "captcha", "message": f"Error: {e}", "screenshot": screenshot}

    async def solve_captcha_drag(self, start_x: int, start_y: int, end_x: int, end_y: int) -> dict:
        """User dragged the CAPTCHA slider — forward the drag."""
        try:
            # Human-like drag with slight variations
            await self.page.mouse.move(start_x, start_y)
            await asyncio.sleep(0.1)
            await self.page.mouse.down()

            # Move in small steps with slight y variation for human-like behavior
            steps = 20
            import random
            for i in range(1, steps + 1):
                progress = i / steps
                curr_x = start_x + (end_x - start_x) * progress
                curr_y = start_y + random.randint(-2, 2)
                await self.page.mouse.move(curr_x, curr_y, steps=1)
                await asyncio.sleep(random.uniform(0.01, 0.03))

            await self.page.mouse.up()
            await asyncio.sleep(2)

            return await self._detect_next_step()
        except Exception as e:
            screenshot = await self._take_screenshot()
            return {"step": "captcha", "message": f"Error: {e}", "screenshot": screenshot}

    async def submit_2fa(self, code: str) -> dict:
        """Submit 2FA verification code."""
        try:
            # Find 2FA input — could be multiple input boxes for each digit
            # or a single text input
            single_input = await self.page.locator('input[type="text"][maxlength="6"], input[type="tel"], input[placeholder*="code"], input[placeholder*="Code"]').count()

            if single_input > 0:
                input_el = self.page.locator('input[type="text"][maxlength="6"], input[type="tel"], input[placeholder*="code"], input[placeholder*="Code"]').first
                await input_el.click()
                await input_el.fill("")
                await input_el.type(code, delay=50)
            else:
                # Multiple single-digit inputs
                digit_inputs = self.page.locator('input[maxlength="1"]')
                count = await digit_inputs.count()
                if count >= 6:
                    for i, digit in enumerate(code[:count]):
                        await digit_inputs.nth(i).fill(digit)
                        await asyncio.sleep(0.05)
                else:
                    # Fallback: just type the code
                    await self.page.keyboard.type(code, delay=50)

            await asyncio.sleep(1)

            # Try clicking Submit/Verify button
            submit_btn = self.page.locator('button:has-text("Submit"), button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]')
            if await submit_btn.count() > 0:
                await submit_btn.first.click()

            await asyncio.sleep(3)
            return await self._detect_next_step()

        except Exception as e:
            logger.error(f"Submit 2FA failed: {e}")
            screenshot = await self._take_screenshot()
            return {"step": "2fa", "message": f"Error: {e}", "screenshot": screenshot}

    async def get_screenshot(self) -> dict:
        """Get current page screenshot."""
        screenshot = await self._take_screenshot()
        url = self.page.url if self.page else ""
        return {"screenshot": screenshot, "url": url, "step": self.step}

    async def save_session(self) -> dict:
        """Save cookies and session state."""
        if not self.context:
            return {"success": False, "message": "No browser session"}

        cookies = await self.context.cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}

        # Verify login
        if "p20t" not in cookie_dict and "logined" not in cookie_dict:
            return {"success": False, "message": "Not logged in yet", "cookies": []}

        logger.info(f"Login wizard saved {len(cookies)} cookies for trader {self.trader_id}")
        return {
            "success": True,
            "cookies": cookies,
            "cookie_dict": cookie_dict,
            "count": len(cookies),
        }

    async def _detect_next_step(self) -> dict:
        """Analyze the current page to determine what step we're at."""
        try:
            url = self.page.url
            await asyncio.sleep(1)

            # Check if logged in (redirected away from login page)
            cookies = await self.context.cookies()
            cookie_names = {c["name"] for c in cookies}

            if "p20t" in cookie_names or ("logined" in cookie_names):
                self.step = "logged_in"
                return {
                    "step": "logged_in",
                    "message": "Successfully logged into Binance!",
                    "cookie_count": len(cookies),
                }

            if "login" not in url and "accounts" not in url and "binance.com" in url:
                self.step = "logged_in"
                return {
                    "step": "logged_in",
                    "message": "Successfully logged into Binance!",
                    "cookie_count": len(cookies),
                }

            # Check for CAPTCHA (puzzle slider)
            page_html = await self.page.content()
            has_captcha = (
                "captcha" in page_html.lower()
                or await self.page.locator('[class*="captcha"], [id*="captcha"], .puzzle-piece, .slider-btn').count() > 0
            )
            if has_captcha:
                self.step = "captcha"
                screenshot = await self._take_screenshot()
                return {
                    "step": "captcha",
                    "message": "Solve the CAPTCHA puzzle. Drag the slider to complete.",
                    "screenshot": screenshot,
                }

            # Check for 2FA
            has_2fa = (
                "authenticator" in page_html.lower()
                or "verification" in page_html.lower()
                or "verify" in url.lower()
                or await self.page.locator('input[maxlength="6"], input[maxlength="1"]').count() > 0
            )
            if has_2fa:
                self.step = "2fa"
                screenshot = await self._take_screenshot()

                # Detect 2FA type
                fa_type = "code"
                if "authenticator" in page_html.lower() or "google" in page_html.lower():
                    fa_type = "authenticator"
                elif "sms" in page_html.lower() or "phone" in page_html.lower():
                    fa_type = "sms"
                elif "email" in page_html.lower():
                    fa_type = "email"

                return {
                    "step": "2fa",
                    "fa_type": fa_type,
                    "message": f"Enter your verification code ({fa_type})",
                    "screenshot": screenshot,
                }

            # Check for password field
            if await self.page.locator('input[type="password"]').count() > 0:
                self.step = "password"
                return {"step": "password", "message": "Enter your Binance password"}

            # Check for error messages on page
            error_text = ""
            for sel in ['.error-message', '[class*="error"]', '[class*="alert"]', '[class*="warning"]']:
                els = self.page.locator(sel)
                if await els.count() > 0:
                    error_text = await els.first.text_content()
                    break

            if error_text:
                screenshot = await self._take_screenshot()
                return {
                    "step": self.step,
                    "message": f"Error from Binance: {error_text.strip()[:200]}",
                    "screenshot": screenshot,
                }

            # Unknown state — return screenshot for debugging
            screenshot = await self._take_screenshot()
            return {
                "step": "unknown",
                "message": "Unexpected page state. See screenshot below.",
                "screenshot": screenshot,
                "url": url,
            }

        except Exception as e:
            logger.error(f"Detect next step failed: {e}")
            screenshot = await self._take_screenshot()
            return {"step": "error", "message": str(e), "screenshot": screenshot}

    async def _take_screenshot(self) -> str:
        """Take screenshot as base64 JPEG."""
        if not self.page:
            return ""
        try:
            data = await self.page.screenshot(type="jpeg", quality=80)
            return base64.b64encode(data).decode("utf-8")
        except Exception:
            return ""

    async def stop(self):
        """Close browser."""
        try:
            if self.context:
                await self.context.close()
            if self.browser:
                await self.browser.close()
            if self.playwright:
                await self.playwright.stop()
        except Exception as e:
            logger.warning(f"Error closing login wizard: {e}")
        logger.info(f"Login wizard closed for trader {self.trader_id}")


# Active sessions
_wizard_sessions: Dict[int, LoginWizardSession] = {}


def get_wizard(trader_id: int) -> Optional[LoginWizardSession]:
    return _wizard_sessions.get(trader_id)


def set_wizard(trader_id: int, session: LoginWizardSession):
    _wizard_sessions[trader_id] = session


async def remove_wizard(trader_id: int):
    session = _wizard_sessions.pop(trader_id, None)
    if session:
        await session.stop()
