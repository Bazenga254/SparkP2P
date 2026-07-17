"""
Sign-in for BOT-ONLY accounts — people who use I&M Automation but are not
SparkP2P clients (billed KES 12).

Kept SEPARATE from /api/auth (which is for traders) on purpose: a bot-only
account has no subscription, no Binance link, no trader row, and must never be
mistaken for one. The two flows share the same SHAPE — email + password, an email
OTP to prove the address, three strikes then a 24h lock — because that shape is
where the security lives, but they resolve to different populations and bill at
different rates.

There is no JWT here. A bot-only account's credential IS the long-lived I&M Bot
API key: register/verify and login all hand back a key the desktop app stores,
exactly the credential /api/im-bot/report-payout authenticates with. That is why
these routes can mint a key directly, where a trader must first hold a JWT session
and then call /api/im-bot/keys.

Rules enforced (see app/services/im_bot_accounts for the why of each):
  1. Email normalised everywhere.
  2. A TRADER's email cannot register here — they are sent to "Continue with
     SparkP2P" so a paying merchant is never billed 12.
  3. We never reveal whether an email already exists.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_client_ip
from app.core.database import get_db
from app.services import im_bot_accounts as accounts
from app.services import api_keys as keysvc

logger = logging.getLogger(__name__)

router = APIRouter()

# Same minimum as the trader sign-up. A bank-payout tool is not the place for a
# four-character password.
MIN_PASSWORD = 8


class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: str | None = None
    phone: str | None = None


class VerifyRequest(BaseModel):
    email: str
    code: str


class LoginRequest(BaseModel):
    email: str
    password: str


def _key_payload(plaintext: str, row) -> dict:
    """The one and only time the plaintext key is returned. The app stores it and
    never asks again; we keep only its hash."""
    return {
        "api_key": plaintext,
        "prefix": row.key_prefix,
        "account_type": "bot_only",
    }


@router.post("/register")
async def register(data: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Start a bot-only sign-up: create an UNVERIFIED account and email an OTP.

    Answers the same way whether or not the email is new, so this cannot be used
    to discover who already has an account.
    """
    email = accounts.norm_email(data.email)
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if len(data.password or "") < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD} characters.")

    # Rule 2: a trader's email belongs to the trader flow, not here.
    if await accounts.email_belongs_to_trader(db, email):
        raise HTTPException(
            status_code=409,
            detail="This email already has a SparkP2P account. Use 'Continue with SparkP2P' instead.",
        )

    existing = await accounts.get_by_email(db, email)
    if existing is not None and existing.email_verified_at is not None:
        # Already a real, verified bot-only account. Don't say so out loud (rule
        # 3); send the same OTP so an honest owner re-verifying still works, and a
        # stranger learns nothing.
        code = accounts.issue_signup_code(email)
        _send_code(email, code)
        return {"otp_required": True, "message": "We've sent a code to your email."}

    if existing is None:
        await accounts.create_account(
            db, email=email, password=data.password,
            full_name=data.full_name, phone=data.phone,
        )
    else:
        # An unverified account being re-registered — update the password to what
        # they just typed (they may have mistyped last time) and re-send.
        from app.core.security import hash_password
        existing.password_hash = hash_password(data.password)
        if data.full_name:
            existing.full_name = data.full_name.strip() or None
        if data.phone:
            existing.phone = data.phone.strip() or None
        await db.commit()

    code = accounts.issue_signup_code(email)
    _send_code(email, code)
    return {"otp_required": True, "message": "We've sent a code to your email."}


@router.post("/verify")
async def verify(data: VerifyRequest, db: AsyncSession = Depends(get_db)):
    """Finish sign-up: check the OTP, mark the email verified, mint the app's key.

    On success the account is live AND linked in one step — the returned key is
    the credential the desktop app stores.
    """
    email = accounts.norm_email(data.email)
    if not accounts.check_signup_code(email, (data.code or "").strip()):
        raise HTTPException(status_code=400, detail="That code is invalid or has expired.")

    acct = await accounts.get_by_email(db, email)
    if acct is None:
        # The code was valid but the account is gone — should not happen; refuse
        # rather than mint a key for nothing.
        raise HTTPException(status_code=400, detail="Account not found. Please register again.")

    from datetime import datetime, timezone
    if acct.email_verified_at is None:
        acct.email_verified_at = datetime.now(timezone.utc)
        acct.last_login_at = datetime.now(timezone.utc)
        await db.commit()

    accounts.clear_failures(email)
    plaintext, row = await keysvc.create_key(
        bot_account_id=acct.id, name="I&M Automation (desktop app)",
    )
    logger.info("im-account: bot#%s verified and provisioned key %s…", acct.id, row.key_prefix)
    return _key_payload(plaintext, row)


@router.post("/login")
async def login(data: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Sign in an existing bot-only account and hand back a fresh app key.

    Three wrong passwords locks the email for 24 hours — same as the trader flow,
    since this credential can drive a bank payout. The lock is self-healing; no
    one has to unlock an account by hand.
    """
    email = accounts.norm_email(data.email)

    locked_until = accounts.is_locked(email)
    if locked_until is not None:
        raise HTTPException(
            status_code=423,
            detail={"message": "Too many failed attempts. Try again later.", "locked_until": locked_until.isoformat()},
        )

    acct = await accounts.authenticate(db, email, data.password)
    if acct is None:
        # One message for wrong-password, unknown-email, unverified and suspended
        # alike — never help a caller tell them apart (rule 3). Still count the
        # failure toward the lockout.
        until = accounts.record_failure(email)
        if until is not None:
            raise HTTPException(
                status_code=423,
                detail={"message": "Too many failed attempts. Locked for 24 hours.", "locked_until": until.isoformat()},
            )
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    accounts.clear_failures(email)
    from datetime import datetime, timezone
    acct.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    plaintext, row = await keysvc.create_key(
        bot_account_id=acct.id, name="I&M Automation (desktop app)",
    )
    logger.info("im-account: bot#%s logged in, minted key %s…", acct.id, row.key_prefix)
    return _key_payload(plaintext, row)


def _send_code(email: str, code: str) -> None:
    """Email the OTP. A send failure must not 500 the request — the code is
    already issued; the user can ask for another. Logged so we notice if the
    mailer is down."""
    try:
        from app.services.email import send_verification_code
        send_verification_code(email, code)
    except Exception as e:
        logger.warning("im-account: verification email to %s failed: %s", email, e)
