"""Background KYC reconciliation poller.

Choice Bank KYC is asynchronous: an application often sits in Manual Review (status 9)
and is approved HOURS later by Choice's compliance team. The onboarding page only polls
while the trader is on it, so an approval that lands after they leave was never captured —
the account number + 'approved' status never reached our DB.

This poller re-checks Choice every few minutes for any trader stuck in pending/onboarding,
and when Choice reports Passed (status 3) it writes the account number + 'approved' (and
notifies the trader). That makes the approval reflect automatically on the merchant dashboard,
the admin trader detail, and the KYC Verification page — all of which read these trader fields.

Connection-safe: it never holds a DB session open across the (slow) Choice API calls.
"""
import asyncio
import logging
from sqlalchemy import select, or_

from app.core.database import async_session
from app.core.config import settings
from app.models import Trader
from app.services.choice_bank import client as choice

logger = logging.getLogger(__name__)

KYC_POLL_INTERVAL = 300  # seconds (every 5 min)


def _onboarding_id(ks: str) -> str:
    if not ks:
        return ""
    if ks.startswith("pending:"):
        return ks[len("pending:"):]
    if ks.startswith("onboarding:"):
        return ks[len("onboarding:"):]
    return ""


async def _notify_approved(trader, aid):
    paybill = getattr(settings, "CHOICE_BANK_PAYBILL", "") or ""
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(
            trader,
            "\U0001f389 Your Choice Bank account is approved!\n"
            "Account No: " + (aid or "—") + "\n"
            "Paybill: " + paybill + "\n"
            "You can now receive payments directly to your Choice Bank account.",
        )
    except Exception as e:
        logger.warning("[KYC-poller] telegram notify failed for %s: %s", trader.id, e)
    try:
        from app.services.sms import send_otp_sms
        await send_otp_sms(
            trader.phone,
            "SparkP2P: Choice Bank account approved! Acct: " + (aid or "N/A") + ". Paybill " + paybill + ".",
        )
    except Exception as e:
        logger.warning("[KYC-poller] sms notify failed for %s: %s", trader.id, e)


async def kyc_status_poller():
    await asyncio.sleep(20)
    logger.info("[KYC-poller] started (re-checks pending Choice KYC every %ds)", KYC_POLL_INTERVAL)
    while True:
        try:
            # 1) snapshot pending traders (short session, released before slow calls)
            async with async_session() as db:
                rows = (await db.execute(
                    select(Trader.id, Trader.choice_kyc_status).where(
                        or_(Trader.choice_kyc_status.like("pending:%"),
                            Trader.choice_kyc_status.like("onboarding:%"))
                    )
                )).all()
            pending = [(r[0], _onboarding_id(r[1])) for r in rows]
            pending = [(tid, oid) for tid, oid in pending if oid]

            for tid, oid in pending:
                # 2) slow Choice calls — NO DB session held here
                try:
                    kyc = await choice.get_user_kyc(oid)
                    kd = kyc.get("data") or kyc
                    status = int(kd.get("status") or 0)
                except Exception as e:
                    logger.warning("[KYC-poller] check failed for trader %s: %s", tid, e)
                    continue

                profile_check = int(kd.get("profileCheck") or 0)

                if status == 3:  # Passed
                    try:
                        st = await choice.get_onboarding_status(oid)
                        aid = ((st.get("data") or st).get("accountId")) or ""
                    except Exception:
                        aid = ""
                    # 3) short write session
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t and (t.choice_kyc_status or "") != "approved":
                            t.choice_account_id = aid or oid
                            t.choice_account_number = aid
                            t.choice_kyc_status = "approved"
                            await db.commit()
                            logger.info("[KYC-poller] trader %s APPROVED -> account %s", tid, aid)
                            await _notify_approved(t, aid)
                elif status == 4 or profile_check == 3:  # Rejected OR profile check Declined
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t and (t.choice_kyc_status or "") != "rejected":
                            t.choice_kyc_status = "rejected"
                            await db.commit()
                            logger.info("[KYC-poller] trader %s rejected (status=%s profileCheck=%s)", tid, status, profile_check)
                # status 1 (Submitted), 2 (Processing), 9 (Manual Review) -> stay pending

            # Backfill: a trader can be 'approved' yet still carry the ONBRD
            # onboarding-id placeholder in choice_account_id because Choice hadn't
            # finished creating the account at approval time (so accountId came back
            # empty). Once we're 'approved' the pending loop above ignores them, so
            # re-query here and fill in the real account number when it's ready.
            async with async_session() as db:
                broken = (await db.execute(
                    select(Trader.id, Trader.choice_account_id).where(
                        Trader.choice_kyc_status == "approved",
                        Trader.choice_account_id.like("ONBRD%"),
                    )
                )).all()
            for tid, cai in broken:
                try:
                    st = await choice.get_onboarding_status(cai)
                    aid = ((st.get("data") or st).get("accountId")) or ""
                except Exception as e:
                    logger.warning("[KYC-poller] backfill query failed for trader %s: %s", tid, e)
                    continue
                if aid:
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t:
                            t.choice_account_id = aid
                            t.choice_account_number = aid
                            await db.commit()
                            logger.info("[KYC-poller] backfilled account for trader %s -> %s", tid, aid)
        except Exception as e:
            logger.error("[KYC-poller] loop error: %s", e)
        await asyncio.sleep(KYC_POLL_INTERVAL)
