"""
Bot-only accounts: register, verify, sign in.

These are people who use I&M Automation but are not SparkP2P clients (KES 12).
Everything here is deliberately the SAME shape as the trader flow in
app/api/routes/auth.py — email + password, OTP to prove the email, lockout after
repeated failures — because a second, subtly different auth flow is how you end
up with a second, subtly different set of auth bugs.

The three rules this module holds:

1. NORMALISE THE EMAIL, ALWAYS. Store lower, look up lower, key OTPs on lower.
   Not doing this locked a real person out of their own account: a phone keyboard
   capitalises the first letter, the lookup missed, three misses locked it for 24
   hours. The database has a unique index on LOWER(email) as a backstop.

2. A TRADER'S EMAIL CANNOT OPEN A BOT-ONLY ACCOUNT. Checked before anything is
   created. Without it, a Gold merchant paying 13,000/mo could register here and
   be billed 12/payout instead of 7 — and nothing would ever surface it. They are
   sent to "Continue with SparkP2P" instead.

3. NEVER SAY WHETHER AN EMAIL EXISTS. Register and login both answer the same way
   for an unknown email as for a known one where it matters. This app pays real
   money out of a real bank; the account list is not public.
"""

import logging
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.core.security import hash_password, verify_password
from app.models.im_bot_account import ImBotAccount
from app.models.trader import Trader

logger = logging.getLogger(__name__)

# email (normalised) -> (code, expires_at). In-process, exactly like the trader
# flow's _login_otp_codes: a restart drops pending codes, and the user asks for
# another. Fine for a code that lives five minutes; not worth a table.
_signup_codes: dict[str, tuple[str, datetime]] = {}

OTP_TTL = timedelta(minutes=10)
MAX_FAILED_LOGINS = 3
LOCKOUT = timedelta(hours=24)

# Failed sign-ins, in-process. Same reasoning as the codes above.
_failed: dict[str, tuple[int, datetime | None]] = {}

# A REAL bcrypt hash of a random string, computed once at import, that no
# password can ever match. Used to spend the same time on an unknown email as on
# a real one — see authenticate(). It must be a genuine hash: a hand-built
# look-alike ("$2b$12$" + "x"*53) is structurally plausible but raises
# ValueError: Invalid salt, which would turn "no such account" into a 500 and
# leak the very thing the dummy exists to hide.
_DUMMY_HASH = hash_password(__import__("secrets").token_urlsafe(16))


def norm_email(value) -> str:
    """The one way an email is written down. See rule 1 at the top."""
    return (value or "").strip().lower()


async def email_belongs_to_trader(db, email: str) -> bool:
    """Rule 2. Case-insensitive, like every other email comparison we make."""
    return (await db.execute(
        select(Trader.id).where(func.lower(Trader.email) == norm_email(email)).limit(1)
    )).scalar_one_or_none() is not None


async def get_by_email(db, email: str) -> ImBotAccount | None:
    return (await db.execute(
        select(ImBotAccount).where(func.lower(ImBotAccount.email) == norm_email(email))
    )).scalar_one_or_none()


def issue_signup_code(email: str) -> str:
    code = str(random.randint(100000, 999999))
    _signup_codes[norm_email(email)] = (code, datetime.now(timezone.utc) + OTP_TTL)
    return code


def check_signup_code(email: str, code: str) -> bool:
    """One-shot: a correct code is consumed, so it cannot be replayed."""
    entry = _signup_codes.get(norm_email(email))
    if not entry:
        return False
    stored, expires = entry
    if datetime.now(timezone.utc) > expires:
        _signup_codes.pop(norm_email(email), None)
        return False
    if stored != code:
        return False
    _signup_codes.pop(norm_email(email), None)
    return True


def is_locked(email: str) -> datetime | None:
    """Returns when the lock lifts, or None. Self-healing: an expired lock clears
    itself, so nobody has to be unlocked by hand (I have had to do that once)."""
    count, until = _failed.get(norm_email(email), (0, None))
    if until and datetime.now(timezone.utc) < until:
        return until
    if until:
        _failed.pop(norm_email(email), None)
    return None


def record_failure(email: str) -> datetime | None:
    key = norm_email(email)
    count, _ = _failed.get(key, (0, None))
    count += 1
    until = datetime.now(timezone.utc) + LOCKOUT if count >= MAX_FAILED_LOGINS else None
    _failed[key] = (count, until)
    return until


def clear_failures(email: str) -> None:
    _failed.pop(norm_email(email), None)


async def create_account(db, *, email: str, password: str, full_name=None, phone=None) -> ImBotAccount:
    """Create an UNVERIFIED bot-only account. Callers MUST have checked
    email_belongs_to_trader() first — rule 2.

    The account cannot sign in until email_verified_at is set, so a wrong email
    typed at sign-up creates a dead row, not a live account someone else's
    address is attached to.
    """
    acct = ImBotAccount(
        email=norm_email(email),
        password_hash=hash_password(password),
        full_name=(full_name or "").strip() or None,
        phone=(phone or "").strip() or None,
    )
    db.add(acct)
    await db.commit()
    await db.refresh(acct)
    logger.info("im_bot_account created id=%s", acct.id)
    return acct


async def authenticate(db, email: str, password: str) -> ImBotAccount | None:
    """Password check only — the caller still owns the lockout and OTP steps.

    Returns None for "no such account", "wrong password" and "not verified"
    alike. The caller must not tell them apart out loud (rule 3).
    """
    acct = await get_by_email(db, email)
    if not acct:
        # Hash anyway. Returning early on an unknown email makes the response
        # measurably faster, which is a way to ask us "is this address one of
        # yours?" and get an answer. Cheap to close, so close it.
        verify_password(password, _DUMMY_HASH)
        return None
    if acct.status != "active":
        return None
    if acct.email_verified_at is None:
        return None
    if not verify_password(password, acct.password_hash):
        return None
    return acct
