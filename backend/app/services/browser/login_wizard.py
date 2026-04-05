"""
Binance Login Wizard — step-by-step automated login.

Instead of streaming a full browser, we automate login steps:
1. User provides email/password via API
2. Playwright fills form and clicks login
3. If CAPTCHA → return screenshot of puzzle for user to solve
4. If 2FA (TOTP) → auto-generated via pyotp
5. If 2FA (email) → auto-scanned from open Gmail tab
6. Session saved → bot ready

Gmail OTP auto-scan: when Binance asks for email OTP, the bot
switches to an open Gmail tab, finds the latest Binance email,
extracts the 6-digit code, and fills it automatically.
"""

import asyncio
import base64
import logging
import re
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
GMAIL_URL = "https://mail.google.com"

# Binance sends OTP emails from these addresses
BINANCE_EMAIL_SENDERS = ["noreply@binance.com", "do-not-reply@binance.com", "support@binance.com"]


class LoginWizardSession:
    """Automated Binance login with step-by-step user interaction."""

    def __init__(self, trader_id: int):
        self.trader_id = trader_id
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None                  # Binance tab
        self.gmail_page: Optional[Page] = None            # Gmail tab
        self.gmail_email: Optional[str] = None
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

    # ─────────────────────────────────────────────────────────────
    # Gmail tab management
    # ─────────────────────────────────────────────────────────────

    async def open_gmail(self, gmail_email: str, gmail_password: str) -> dict:
        """
        Open Gmail in a new tab within the same browser context and log in.
        Must be called before Binance 2FA so the tab is ready.
        """
        try:
            self.gmail_email = gmail_email
            self.gmail_page = await self.context.new_page()
            await self.gmail_page.goto(GMAIL_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)

            current_url = self.gmail_page.url

            # Already logged in → inbox loaded
            if "mail.google.com/mail" in current_url:
                logger.info(f"Gmail already logged in for trader {self.trader_id}")
                # Bring Binance tab back to focus
                await self.page.bring_to_front()
                return {"success": True, "message": "Gmail ready (already logged in)"}

            # Need to log in via Google accounts
            if "accounts.google.com" in current_url or "google.com/signin" in current_url:
                result = await self._gmail_login(gmail_email, gmail_password)
                await self.page.bring_to_front()
                return result

            # Unknown state
            screenshot = await self._take_screenshot_of(self.gmail_page)
            await self.page.bring_to_front()
            return {"success": False, "message": "Gmail page in unexpected state", "screenshot": screenshot}

        except Exception as e:
            logger.error(f"open_gmail failed: {e}")
            await self.page.bring_to_front()
            return {"success": False, "message": f"Failed to open Gmail: {e}"}

    async def _gmail_login(self, email: str, password: str) -> dict:
        """Fill Google login form (email → Next → password → Next)."""
        try:
            # Step 1: Enter email
            email_input = self.gmail_page.locator('input[type="email"]').first
            await email_input.wait_for(state="visible", timeout=10000)
            await email_input.fill(email)
            await asyncio.sleep(0.3)
            await self.gmail_page.get_by_role("button", name="Next").click()
            await asyncio.sleep(3)

            # Step 2: Enter password
            pw_input = self.gmail_page.locator('input[type="password"]').first
            await pw_input.wait_for(state="visible", timeout=10000)
            await pw_input.fill(password)
            await asyncio.sleep(0.3)
            await self.gmail_page.get_by_role("button", name="Next").click()
            await asyncio.sleep(4)

            # Step 3: Handle "Stay signed in?" prompt if it appears
            try:
                stay_btn = self.gmail_page.get_by_role("button", name="Yes")
                if await stay_btn.count() > 0:
                    await stay_btn.click()
                    await asyncio.sleep(2)
            except Exception:
                pass

            # Verify we reached inbox
            await self.gmail_page.wait_for_url("**/mail.google.com/**", timeout=15000)
            logger.info(f"Gmail login successful for trader {self.trader_id}")
            return {"success": True, "message": "Gmail logged in successfully"}

        except Exception as e:
            logger.error(f"Gmail login failed: {e}")
            screenshot = await self._take_screenshot_of(self.gmail_page)
            return {"success": False, "message": f"Gmail login failed: {e}", "screenshot": screenshot}

    async def _snapshot_gmail_thread_ids(self) -> set:
        """
        Navigate to Binance email search results and return the set of
        currently visible thread IDs. Call this BEFORE Binance sends the OTP
        so we know which emails already existed.
        """
        try:
            search_url = "https://mail.google.com/mail/u/0/#search/from%3A(binance)"
            await self.gmail_page.goto(search_url, wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(2)
            rows = self.gmail_page.locator('tr.zA')
            count = await rows.count()
            ids = set()
            for i in range(count):
                tid = await rows.nth(i).get_attribute('id')
                if tid:
                    ids.add(tid)
            logger.info(f"Gmail snapshot: {len(ids)} existing Binance emails for trader {self.trader_id}")
            return ids
        except Exception as e:
            logger.warning(f"Gmail snapshot failed: {e}")
            return set()

    async def _scan_gmail_otp(self, max_wait: int = 60, known_ids: set = None) -> Optional[str]:
        """
        Switch to Gmail tab and wait for a NEW Binance email to appear
        (one whose thread ID was NOT in known_ids snapshot).
        Extracts and returns the 6-digit OTP code.

        Using known_ids prevents feeding an old OTP from a previous session
        even if there are many Binance emails already in the inbox.
        """
        if not self.gmail_page:
            logger.warning("No Gmail tab open — cannot auto-scan OTP")
            return None

        if known_ids is None:
            known_ids = set()

        try:
            await self.gmail_page.bring_to_front()
            search_url = "https://mail.google.com/mail/u/0/#search/from%3A(binance)"

            otp_code = None
            waited = 0
            poll_interval = 4

            while waited < max_wait:
                await self.gmail_page.goto(search_url, wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(2)

                rows = self.gmail_page.locator('tr.zA')
                count = await rows.count()

                for i in range(count):
                    row = rows.nth(i)
                    tid = await row.get_attribute('id')

                    # Skip emails that existed before this OTP request
                    if tid in known_ids:
                        continue

                    # New email found — open it
                    logger.info(f"New Binance email found (id={tid}) for trader {self.trader_id}")
                    await row.click()
                    await asyncio.sleep(2)

                    # Extract body text
                    body_text = ""
                    for selector in ['.a3s.aiL', '[data-message-id]', '.ii.gt']:
                        el = self.gmail_page.locator(selector).first
                        if await el.count() > 0:
                            body_text = await el.text_content() or ""
                            if body_text:
                                break

                    if body_text:
                        matches = re.findall(r'\b(\d{6})\b', body_text)
                        if matches:
                            otp_code = matches[0]
                            logger.info(f"OTP extracted for trader {self.trader_id}: {otp_code}")
                            break

                if otp_code:
                    break

                await asyncio.sleep(poll_interval)
                waited += poll_interval

            await self.page.bring_to_front()
            return otp_code

        except Exception as e:
            logger.error(f"Gmail OTP scan failed: {e}")
            try:
                await self.page.bring_to_front()
            except Exception:
                pass
            return None

    # ─────────────────────────────────────────────────────────────
    # Binance login steps
    # ─────────────────────────────────────────────────────────────

    async def submit_email(self, email: str) -> dict:
        """Type email and click Continue."""
        try:
            email_input = self.page.locator('input[name="username"]')
            if await email_input.count() == 0:
                email_input = self.page.locator('input[type="text"]').first
            else:
                email_input = email_input.first

            await email_input.click()
            await email_input.fill("")
            await email_input.type(email, delay=30)
            await asyncio.sleep(0.5)

            await self.page.get_by_role("button", name="Continue", exact=True).click()
            await asyncio.sleep(4)

            return await self._detect_next_step()

        except Exception as e:
            logger.error(f"Submit email failed: {e}")
            screenshot = await self._take_screenshot()
            return {"step": "email", "message": f"Error: {e}", "screenshot": screenshot}

    async def submit_password(self, password: str) -> dict:
        """Type password and click Log In."""
        try:
            pw_input = self.page.locator('input[type="password"]').first
            await pw_input.wait_for(state="visible", timeout=10000)
            await pw_input.click()
            await pw_input.fill("")
            await pw_input.type(password, delay=30)
            await asyncio.sleep(0.5)

            try:
                await self.page.get_by_role("button", name="Log In").click()
            except Exception:
                try:
                    await self.page.locator('button[type="submit"]').first.click()
                except Exception:
                    await self.page.keyboard.press("Enter")

            await asyncio.sleep(4)
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
            await self.page.mouse.move(start_x, start_y)
            await asyncio.sleep(0.1)
            await self.page.mouse.down()

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
        """Submit 2FA verification code (manual or auto-provided)."""
        try:
            single_input = await self.page.locator(
                'input[type="text"][maxlength="6"], input[type="tel"], '
                'input[placeholder*="code"], input[placeholder*="Code"]'
            ).count()

            if single_input > 0:
                input_el = self.page.locator(
                    'input[type="text"][maxlength="6"], input[type="tel"], '
                    'input[placeholder*="code"], input[placeholder*="Code"]'
                ).first
                await input_el.click()
                await input_el.fill("")
                await input_el.type(code, delay=50)
            else:
                digit_inputs = self.page.locator('input[maxlength="1"]')
                count = await digit_inputs.count()
                if count >= 6:
                    for i, digit in enumerate(code[:count]):
                        await digit_inputs.nth(i).fill(digit)
                        await asyncio.sleep(0.05)
                else:
                    await self.page.keyboard.type(code, delay=50)

            await asyncio.sleep(1)

            submit_btn = self.page.locator(
                'button:has-text("Submit"), button:has-text("Verify"), '
                'button:has-text("Confirm"), button[type="submit"]'
            )
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

        if "p20t" not in cookie_dict and "logined" not in cookie_dict:
            return {"success": False, "message": "Not logged in yet", "cookies": []}

        logger.info(f"Login wizard saved {len(cookies)} cookies for trader {self.trader_id}")
        return {
            "success": True,
            "cookies": cookies,
            "cookie_dict": cookie_dict,
            "count": len(cookies),
        }

    # ─────────────────────────────────────────────────────────────
    # Internal helpers
    # ─────────────────────────────────────────────────────────────

    async def _detect_next_step(self) -> dict:
        """Analyze the current Binance page and auto-handle 2FA where possible."""
        try:
            url = self.page.url
            await asyncio.sleep(1)

            # Check if logged in
            cookies = await self.context.cookies()
            cookie_names = {c["name"] for c in cookies}

            if "p20t" in cookie_names or "logined" in cookie_names:
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

            # Check for CAPTCHA
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

                # Detect 2FA type
                fa_type = "code"
                if "authenticator" in page_html.lower() or "google" in page_html.lower():
                    fa_type = "authenticator"
                elif "sms" in page_html.lower() or "phone" in page_html.lower():
                    fa_type = "sms"
                elif "email" in page_html.lower():
                    fa_type = "email"

                # Auto-scan Gmail if it's an email OTP and Gmail tab is open
                if fa_type == "email" and self.gmail_page:
                    logger.info(f"Email OTP detected — snapshotting Gmail then scanning for trader {self.trader_id}")
                    # Snapshot BEFORE Binance sends the email so we ignore all old OTPs
                    known_ids = await self._snapshot_gmail_thread_ids()
                    await self.page.bring_to_front()
                    otp = await self._scan_gmail_otp(max_wait=60, known_ids=known_ids)
                    if otp:
                        logger.info(f"Auto-filling email OTP {otp} for trader {self.trader_id}")
                        return await self.submit_2fa(otp)
                    else:
                        # Gmail scan failed — fall through to manual entry
                        logger.warning(f"Gmail OTP scan timed out for trader {self.trader_id}")
                        screenshot = await self._take_screenshot()
                        return {
                            "step": "2fa",
                            "fa_type": "email",
                            "message": "Could not find OTP in Gmail. Please enter it manually.",
                            "screenshot": screenshot,
                            "auto_scan_failed": True,
                        }

                screenshot = await self._take_screenshot()
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

            # Check for error messages
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

            # Unknown state
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
        """Take screenshot of Binance tab as base64 JPEG."""
        return await self._take_screenshot_of(self.page)

    async def _take_screenshot_of(self, page: Optional[Page]) -> str:
        """Take screenshot of any page as base64 JPEG."""
        if not page:
            return ""
        try:
            data = await page.screenshot(type="jpeg", quality=80)
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
