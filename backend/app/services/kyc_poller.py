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


def _extract_choice_name(resp: dict) -> str:
    """Pull the KYC-verified account holder name out of a Choice onboarding/account response,
    trying the several field shapes Choice uses (getOnboardingStatus / getAccountDetails)."""
    if not resp:
        return ""
    d = resp.get("data") or resp
    if not isinstance(d, dict):
        return ""
    name = (d.get("accountName") or d.get("customerName") or d.get("accountTitle") or d.get("name") or "")
    if not name:
        parts = [d.get("firstName"), d.get("middleName"), d.get("lastName")]
        name = " ".join(p for p in parts if p)
    return " ".join(str(name).split()).strip()


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
                    st = {}
                    try:
                        st = await choice.get_onboarding_status(oid)
                        aid = ((st.get("data") or st).get("accountId")) or ""
                    except Exception:
                        aid = ""
                    # The Choice KYC-verified legal name is authoritative — always adopt it,
                    # replacing a Google/self-entered display name. Try the onboarding response
                    # first, then the account details.
                    official = _extract_choice_name(st)
                    if not official and aid:
                        try:
                            official = _extract_choice_name(await choice.get_account_details(aid))
                        except Exception:
                            official = ""
                    # 3) short write session
                    async with async_session() as db:
                        t = await db.get(Trader, tid)
                        if t and (t.choice_kyc_status or "") != "approved":
                            t.choice_account_id = aid or oid
                            t.choice_account_number = aid
                            t.choice_kyc_status = "approved"
                            if official and official.upper() != (t.full_name or "").strip().upper():
                                logger.info("[KYC-poller] trader %s name '%s' -> '%s' (Choice KYC)",
                                            tid, t.full_name, official.upper())
                                t.full_name = official.upper()
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

            # Stale KYC-submission cleanup: when a trader has a LATER approved submission,
            # any older non-terminal submissions (e.g. an abandoned 'otp_pending' first attempt)
            # are auto-marked 'superseded' so they stop cluttering the admin pending-review list.
            try:
                from sqlalchemy import text
                async with async_session() as db:
                    res = await db.execute(text(
                        "UPDATE kyc_submissions s SET status='superseded', updated_at=now(), "
                        "admin_notes = COALESCE(s.admin_notes,'') || ' [auto-superseded by a later approved submission]' "
                        "WHERE s.status NOT IN ('approved','rejected','superseded') "
                        "AND EXISTS (SELECT 1 FROM kyc_submissions a "
                        "WHERE a.trader_id = s.trader_id AND a.status='approved' AND a.id > s.id)"
                    ))
                    await db.commit()
                    if res.rowcount:
                        logger.info("[KYC-poller] auto-superseded %d stale KYC submission(s)", res.rowcount)
            except Exception as e:
                logger.error("[KYC-poller] stale-submission cleanup error: %s", e)

            # SME onboarding reconciliation (multi-account): approve pending SME registry rows
            # whose approval landed after the trader left the wizard (webhook backstop).
            try:
                from app.models.choice_account import ChoiceAccount
                async with async_session() as db:
                    sme_rows = (await db.execute(
                        select(ChoiceAccount.id, ChoiceAccount.trader_id, ChoiceAccount.onboarding_request_id).where(
                            ChoiceAccount.account_type == "sme",
                            ChoiceAccount.onboarding_status.in_(("in_progress", "submitted")),
                            ChoiceAccount.onboarding_request_id.isnot(None),
                        )
                    )).all()
                for _rid, _tid, _oid in sme_rows:
                    if not _oid:
                        continue
                    try:
                        resp = await choice.get_business_onboarding_status(onboarding_request_id=_oid)
                        d = resp.get("data") or {}
                        s = d.get("onboardingStatus", d.get("status"))
                    except Exception as e:
                        logger.warning("[KYC-poller] SME check failed for trader %s: %s", _tid, e)
                        continue
                    if str(s) in ("3", "7") and d.get("accountId"):
                        from app.api.routes.choice_bank import _complete_sme_onboarding
                        async with async_session() as db:
                            await _complete_sme_onboarding(db, _tid, _oid, d)
                        logger.info("[KYC-poller] SME account approved for trader %s (oid=%s)", _tid, _oid)
                    elif str(s) in ("4",):
                        async with async_session() as db:
                            r2 = await db.get(ChoiceAccount, _rid)
                            if r2 and r2.onboarding_status != "rejected":
                                r2.onboarding_status = "rejected"
                                r2.kyc_status = "rejected"
                                await db.commit()
            except Exception as e:
                logger.error("[KYC-poller] SME reconcile error: %s", e)
        except Exception as e:
            logger.error("[KYC-poller] loop error: %s", e)
        await asyncio.sleep(KYC_POLL_INTERVAL)
