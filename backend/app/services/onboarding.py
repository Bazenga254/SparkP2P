"""Onboarding readiness — the ONE place that decides which setup steps a merchant
has finished and whether they may submit for admin approval.

The flow the platform now enforces:

  in_progress  → merchant is still completing steps
  submitted    → every required step done; waiting for an admin to approve
  approved     → admin approved; merchant gets dashboard access
  rejected     → admin sent it back (with a reason); merchant fixes + resubmits

Required steps (all mandatory):
  1. Binance connected (API key / cookies)
  2. Settlement method saved
  3. Security question set
  4. 2FA / Google Authenticator (TOTP) set
  5. Choice Bank onboarding STARTED (KYC may still be pending — tracked separately)
  6. I&M Bot downloaded AND connected to SparkP2P (its key has checked in)
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import MerchantApiKey


# choice_kyc_status prefixes that mean "the merchant has STARTED Choice onboarding"
# (final approval can still be pending — that's the KYC section's job, and it does
# not block onboarding submission per the agreed flow).
_CHOICE_STARTED_PREFIXES = ("pending", "onboarding", "staging", "approved")


def _choice_submitted(trader) -> bool:
    cks = (getattr(trader, "choice_kyc_status", None) or "").lower()
    return cks.startswith(_CHOICE_STARTED_PREFIXES)


async def _im_connected(db: AsyncSession, trader_id: int) -> bool:
    """True only when the merchant's I&M Bot has actually CHECKED IN — an im_bot
    key exists AND has been used at least once (last_used_at set). A minted-but-
    never-run key does NOT count as connected."""
    last_used = (await db.execute(
        select(MerchantApiKey.last_used_at)
        .where(MerchantApiKey.trader_id == trader_id,
               MerchantApiKey.scope == "im_bot",
               MerchantApiKey.revoked_at.is_(None),
               MerchantApiKey.last_used_at.isnot(None))
        .limit(1)
    )).scalar_one_or_none()
    return last_used is not None


async def steps(db: AsyncSession, trader) -> dict:
    """Per-step booleans for the onboarding UI + review page."""
    return {
        "binance":  bool(getattr(trader, "binance_connected", False)
                         or getattr(trader, "binance_api_key", None)
                         or getattr(trader, "binance_cookies", None)),
        "settlement": getattr(trader, "settlement_method", None) is not None,
        "security_question": bool(getattr(trader, "security_question", None)),
        "totp": bool(getattr(trader, "totp_secret", None)),
        "choice_bank": _choice_submitted(trader),
        "im_bot": await _im_connected(db, trader.id),
    }


async def state(db: AsyncSession, trader) -> dict:
    """Full onboarding state for a trader — steps, whether everything is done, and
    the review status. This is what the profile endpoint and admin review use."""
    s = await steps(db, trader)
    all_done = all(s.values())
    return {
        "steps": s,
        "all_steps_done": all_done,
        "status": getattr(trader, "onboarding_status", None) or "in_progress",
        "reject_reason": getattr(trader, "onboarding_reject_reason", None),
    }


async def can_submit(db: AsyncSession, trader) -> bool:
    """A merchant may submit for review only when every required step is done."""
    s = await steps(db, trader)
    return all(s.values())
