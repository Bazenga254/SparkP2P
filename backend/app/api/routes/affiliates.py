import logging
import secrets
import string
from datetime import datetime, timezone, date, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Trader
from app.models.affiliate import Affiliate, AffiliateEarning, AffiliatePayout, AffiliateStatus, AffiliatePayoutStatus
from app.api.deps import get_current_trader, get_admin_trader

logger = logging.getLogger(__name__)

router = APIRouter()

COMMISSION_RATE = 0.15          # 15% of subscription price goes to affiliate
MIN_PAYOUT_BALANCE = 1.0       # KES — any positive balance is paid on the 2nd


# ── Helpers ───────────────────────────────────────────────────────────────────

def _month_start(d: date = None) -> date:
    """First day of the month containing d (or today). Commissions accrue per
    calendar month and are paid/reset on the 2nd of the following month."""
    d = d or datetime.now(timezone.utc).date()
    return d.replace(day=1)


def _prev_month_range(d: date = None) -> tuple:
    """(first, last) day of the month BEFORE d — the period a 2nd-of-month payout
    settles."""
    d = d or datetime.now(timezone.utc).date()
    first_this = d.replace(day=1)
    last_prev = first_this - timedelta(days=1)
    return last_prev.replace(day=1), last_prev


# Kept so any old caller/import still resolves; period is now the month.
def _week_start(d: date = None) -> date:
    return _month_start(d)


def _generate_referral_code(full_name: str) -> str:
    """Generate a short referral code like JOHN-AB3X."""
    first = (full_name or "USER").split()[0][:4].upper()
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    return f"{first}-{suffix}"


# ── Public endpoint ────────────────────────────────────────────────────────────

@router.get("/validate/{code}")
async def validate_referral_code(code: str, db: AsyncSession = Depends(get_db)):
    """Check whether a referral code is valid (used on onboarding page)."""
    result = await db.execute(
        select(Affiliate, Trader)
        .join(Trader, Trader.id == Affiliate.trader_id)
        .where(
            Affiliate.referral_code == code.upper(),
            Affiliate.status == AffiliateStatus.APPROVED,
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Invalid or inactive referral code")
    aff, trader = row
    return {"valid": True, "affiliate_name": trader.full_name.split()[0].title()}


@router.get("/enabled")
async def affiliates_enabled_flag(db: AsyncSession = Depends(get_db)):
    """Whether the merchant-facing Affiliates program is switched on. Read by the
    merchant dashboard to show/hide the tab. Just a UI visibility flag, so no auth."""
    from app.services import platform_settings as ps
    return {"enabled": await ps.get_bool(db, ps.AFFILIATES_ENABLED, default=False)}


# ── Trader-facing endpoints ───────────────────────────────────────────────────

class ApplyRequest(BaseModel):
    message: Optional[str] = None   # Optional note from the trader


@router.post("/apply")
async def apply_for_affiliate(
    data: ApplyRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Trader applies to become an affiliate."""
    existing = await db.execute(
        select(Affiliate).where(Affiliate.trader_id == trader.id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="You have already applied")

    # visible=True so the applicant keeps seeing their affiliate section (pending status,
    # then their code once approved). The admin can still flip visible off as a per-merchant
    # kill switch. (Default is False on the column; applying is an explicit opt-in.)
    aff = Affiliate(trader_id=trader.id, status=AffiliateStatus.PENDING, visible=True)
    db.add(aff)
    await db.commit()
    return {"message": "Application submitted. We will review and respond shortly."}


@router.get("/me")
async def get_my_affiliate(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get the current trader's affiliate status and summary stats."""
    result = await db.execute(
        select(Affiliate).where(Affiliate.trader_id == trader.id)
    )
    aff = result.scalar_one_or_none()
    if not aff:
        return {"affiliate": None}

    # Count referrals
    ref_count_result = await db.execute(
        select(func.count(Trader.id)).where(Trader.referred_by_code == aff.referral_code)
    )
    referral_count = ref_count_result.scalar() or 0

    return {
        "affiliate": {
            "id": aff.id,
            "status": aff.status,
            "visible": bool(aff.visible),   # admin's per-merchant switch
            "referral_code": aff.referral_code,
            "referral_link": f"https://sparkp2p.com/login?ref={aff.referral_code}" if aff.referral_code else None,
            "pending_balance": aff.pending_balance,
            "total_earned": aff.total_earned,
            "total_paid_out": aff.total_paid_out,
            "referral_count": referral_count,
            "commission_rate_pct": int(COMMISSION_RATE * 100),
            "applied_at": aff.applied_at.isoformat() if aff.applied_at else None,
            "approved_at": aff.approved_at.isoformat() if aff.approved_at else None,
        }
    }


@router.get("/me/referrals")
async def get_my_referrals(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get list of referred traders with weekly earnings breakdown."""
    result = await db.execute(
        select(Affiliate).where(Affiliate.trader_id == trader.id, Affiliate.status == AffiliateStatus.APPROVED)
    )
    aff = result.scalar_one_or_none()
    if not aff:
        raise HTTPException(status_code=404, detail="You are not an approved affiliate")

    from app.models.subscription import Subscription, SubscriptionStatus

    # Get all referred traders
    refs_result = await db.execute(
        select(Trader).where(Trader.referred_by_code == aff.referral_code)
    )
    referred_traders = refs_result.scalars().all()

    month_start = _month_start()

    referrals = []
    for rt in referred_traders:
        # Commission from this referee — lifetime and THIS month (the accruing pot).
        totals = (await db.execute(
            select(
                func.coalesce(func.sum(AffiliateEarning.commission), 0).label("total"),
                func.coalesce(func.sum(
                    case((AffiliateEarning.week_start == month_start, AffiliateEarning.commission), else_=0)
                ), 0).label("this_month"),
            ).where(
                AffiliateEarning.affiliate_id == aff.id,
                AffiliateEarning.referred_trader_id == rt.id,
            )
        )).one()

        # Has this referred merchant PAID for a subscription? (active, not an admin grant)
        sub = (await db.execute(
            select(Subscription)
            .where(Subscription.trader_id == rt.id,
                   Subscription.status == SubscriptionStatus.ACTIVE,
                   Subscription.mpesa_transaction_id != 'ADMIN_GRANT',
                   Subscription.mpesa_transaction_id.isnot(None))
            .order_by(Subscription.started_at.desc())
            .limit(1)
        )).scalar_one_or_none()

        referrals.append({
            "trader_name": rt.full_name,
            "trader_email": rt.email,
            "joined_at": rt.created_at.isoformat() if rt.created_at else None,
            "subscribed": bool(sub),
            "subscription_plan": (sub.plan.value if sub and hasattr(sub.plan, "value") else (str(sub.plan) if sub else None)),
            "this_month_commission": round(float(totals.this_month or 0), 2),
            "total_earned": round(float(totals.total or 0), 2),
        })

    # Sort: paying referrals first, then by this-month commission.
    referrals.sort(key=lambda r: (r["subscribed"], r["this_month_commission"]), reverse=True)

    # This month's accruing total across all referrals.
    this_month_earnings = (await db.execute(
        select(func.coalesce(func.sum(AffiliateEarning.commission), 0))
        .where(AffiliateEarning.affiliate_id == aff.id,
               AffiliateEarning.week_start == month_start)
    )).scalar() or 0.0

    return {
        "referrals": referrals,
        "summary": {
            "total_referrals": len(referred_traders),
            "subscribed_referrals": sum(1 for r in referrals if r["subscribed"]),
            "this_month_earnings": round(float(this_month_earnings), 2),
            "pending_balance": round(aff.pending_balance, 2),
            "total_earned": round(aff.total_earned, 2),
            "commission_rate_pct": int(COMMISSION_RATE * 100),
            "next_payout_note": "Commissions accumulate through the month and are paid out on the 2nd.",
        },
    }


@router.get("/me/payouts")
async def get_my_payouts(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get payout history."""
    result = await db.execute(
        select(Affiliate).where(Affiliate.trader_id == trader.id)
    )
    aff = result.scalar_one_or_none()
    if not aff:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    payouts_result = await db.execute(
        select(AffiliatePayout)
        .where(AffiliatePayout.affiliate_id == aff.id)
        .order_by(AffiliatePayout.created_at.desc())
    )
    payouts = payouts_result.scalars().all()
    return {
        "payouts": [
            {
                "id": p.id,
                "amount": p.amount,
                "week_start": p.week_start.isoformat(),
                "week_end": p.week_end.isoformat(),
                "status": p.status,
                "paid_at": p.paid_at.isoformat() if p.paid_at else None,
            }
            for p in payouts
        ]
    }


# ── Admin endpoints ────────────────────────────────────────────────────────────

@router.get("/admin/list")
async def admin_list_affiliates(
    status_filter: Optional[str] = Query(None, alias="status"),
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all affiliates with their stats."""
    q = select(Affiliate, Trader).join(Trader, Trader.id == Affiliate.trader_id)
    if status_filter:
        q = q.where(Affiliate.status == status_filter)
    q = q.order_by(Affiliate.applied_at.desc())

    result = await db.execute(q)
    rows = result.all()

    affiliates = []
    for aff, trader in rows:
        ref_count_result = await db.execute(
            select(func.count(Trader.id)).where(Trader.referred_by_code == aff.referral_code)
        )
        referral_count = ref_count_result.scalar() or 0

        affiliates.append({
            "id": aff.id,
            "trader_id": trader.id,
            "trader_name": trader.full_name,
            "trader_email": trader.email,
            "status": aff.status,
            "visible": bool(aff.visible),   # per-merchant switch
            "referral_code": aff.referral_code,
            "referral_count": referral_count,
            "pending_balance": round(aff.pending_balance, 2),
            "total_earned": round(aff.total_earned, 2),
            "total_paid_out": round(aff.total_paid_out, 2),
            "applied_at": aff.applied_at.isoformat() if aff.applied_at else None,
            "approved_at": aff.approved_at.isoformat() if aff.approved_at else None,
        })

    return {"affiliates": affiliates}


class RejectRequest(BaseModel):
    reason: Optional[str] = None


@router.post("/admin/{affiliate_id}/approve")
async def admin_approve_affiliate(
    affiliate_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Approve an affiliate application and generate their referral code."""
    result = await db.execute(
        select(Affiliate, Trader)
        .join(Trader, Trader.id == Affiliate.trader_id)
        .where(Affiliate.id == affiliate_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    aff, trader = row

    if aff.status == AffiliateStatus.APPROVED:
        raise HTTPException(status_code=400, detail="Already approved")

    # Generate a unique referral code
    for _ in range(10):
        code = _generate_referral_code(trader.full_name)
        existing = await db.execute(select(Affiliate).where(Affiliate.referral_code == code))
        if not existing.scalar_one_or_none():
            break

    aff.status = AffiliateStatus.APPROVED
    aff.referral_code = code
    aff.approved_at = datetime.now(timezone.utc)
    aff.rejected_at = None
    aff.rejection_reason = None

    await db.commit()
    return {"message": f"Approved. Referral code: {code}", "referral_code": code}


@router.post("/admin/{affiliate_id}/reject")
async def admin_reject_affiliate(
    affiliate_id: int,
    data: RejectRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Reject an affiliate application."""
    result = await db.execute(select(Affiliate).where(Affiliate.id == affiliate_id))
    aff = result.scalar_one_or_none()
    if not aff:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    if aff.status == AffiliateStatus.REJECTED:
        raise HTTPException(status_code=400, detail="Already rejected")

    aff.status = AffiliateStatus.REJECTED
    aff.rejected_at = datetime.now(timezone.utc)
    aff.rejection_reason = data.reason
    await db.commit()
    return {"message": "Rejected"}


class VisibleToggle(BaseModel):
    visible: bool


@router.put("/admin/{affiliate_id}/visible")
async def admin_set_affiliate_visible(
    affiliate_id: int,
    data: VisibleToggle,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Per-merchant switch: whether THIS approved affiliate sees their affiliate
    dashboard. Gated under the master AFFILIATES_ENABLED flag — both must be on
    for the merchant to see it. Balances/records untouched either way."""
    aff = (await db.execute(select(Affiliate).where(Affiliate.id == affiliate_id))).scalar_one_or_none()
    if not aff:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    aff.visible = bool(data.visible)
    await db.commit()
    logger.info("admin %s set affiliate %s visible=%s", admin.id, affiliate_id, data.visible)
    return {"id": aff.id, "visible": bool(aff.visible)}


class AddReferralRequest(BaseModel):
    email: Optional[str] = None       # the referred merchant's email
    trader_id: Optional[int] = None   # …or their id


@router.post("/admin/{affiliate_id}/add-referral")
async def admin_add_referral(
    affiliate_id: int,
    data: AddReferralRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Manually attribute a merchant to an affiliate — for when a referral was
    missed at sign-up. Sets the referred merchant's referred_by_code to this
    affiliate's code, so they appear in the affiliate's list and earn commission
    on their NEXT subscription payment. Does not retro-credit past payments."""
    aff = (await db.execute(select(Affiliate).where(Affiliate.id == affiliate_id))).scalar_one_or_none()
    if not aff or not aff.referral_code:
        raise HTTPException(status_code=404, detail="Affiliate not found or not approved")

    q = select(Trader)
    if data.trader_id:
        q = q.where(Trader.id == data.trader_id)
    elif data.email:
        q = q.where(func.lower(Trader.email) == data.email.strip().lower())
    else:
        raise HTTPException(status_code=400, detail="Provide the merchant's email or id.")
    referred = (await db.execute(q)).scalar_one_or_none()
    if not referred:
        raise HTTPException(status_code=404, detail="No merchant found with that email/id.")
    if referred.id == aff.trader_id:
        raise HTTPException(status_code=400, detail="A merchant cannot be their own referral.")
    if referred.referred_by_code and referred.referred_by_code != aff.referral_code:
        raise HTTPException(status_code=409,
                            detail=f"{referred.full_name} is already referred by {referred.referred_by_code}.")

    referred.referred_by_code = aff.referral_code
    await db.commit()
    logger.info("admin %s attributed trader %s to affiliate %s (%s)", admin.id, referred.id, affiliate_id, aff.referral_code)
    return {"message": f"{referred.full_name} added to {aff.referral_code}'s referrals.",
            "trader_name": referred.full_name, "trader_email": referred.email}


@router.get("/admin/{affiliate_id}/referrals")
async def admin_affiliate_referrals(
    affiliate_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Every merchant this affiliate referred — name, email, whether they've PAID a
    subscription, and the commission earned from them (this month + lifetime).
    Powers the expandable dropdown on the admin Affiliates list."""
    from app.models.subscription import Subscription, SubscriptionStatus

    aff = (await db.execute(select(Affiliate).where(Affiliate.id == affiliate_id))).scalar_one_or_none()
    if not aff:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    if not aff.referral_code:
        return {"referrals": []}

    referred = (await db.execute(
        select(Trader).where(Trader.referred_by_code == aff.referral_code)
    )).scalars().all()

    month_start = _month_start()
    out = []
    for rt in referred:
        totals = (await db.execute(
            select(
                func.coalesce(func.sum(AffiliateEarning.commission), 0).label("total"),
                func.coalesce(func.sum(
                    case((AffiliateEarning.week_start == month_start, AffiliateEarning.commission), else_=0)
                ), 0).label("this_month"),
            ).where(AffiliateEarning.affiliate_id == aff.id,
                    AffiliateEarning.referred_trader_id == rt.id)
        )).one()
        sub = (await db.execute(
            select(Subscription).where(
                Subscription.trader_id == rt.id,
                Subscription.status == SubscriptionStatus.ACTIVE,
                Subscription.mpesa_transaction_id != 'ADMIN_GRANT',
                Subscription.mpesa_transaction_id.isnot(None),
            ).order_by(Subscription.started_at.desc()).limit(1)
        )).scalar_one_or_none()
        out.append({
            "trader_id": rt.id,
            "trader_name": rt.full_name,
            "trader_email": rt.email,
            "joined_at": rt.created_at.isoformat() if rt.created_at else None,
            "subscribed": bool(sub),
            "subscription_plan": (sub.plan.value if sub and hasattr(sub.plan, "value") else (str(sub.plan) if sub else None)),
            "this_month_commission": round(float(totals.this_month or 0), 2),
            "total_earned": round(float(totals.total or 0), 2),
        })
    out.sort(key=lambda r: (r["subscribed"], r["this_month_commission"]), reverse=True)
    return {"referrals": out, "count": len(out)}


@router.get("/admin/stats")
async def admin_affiliate_stats(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Summary stats for the admin affiliates overview."""
    total = await db.execute(select(func.count(Affiliate.id)))
    pending = await db.execute(select(func.count(Affiliate.id)).where(Affiliate.status == AffiliateStatus.PENDING))
    approved = await db.execute(select(func.count(Affiliate.id)).where(Affiliate.status == AffiliateStatus.APPROVED))
    total_owed = await db.execute(select(func.sum(Affiliate.pending_balance)).where(Affiliate.status == AffiliateStatus.APPROVED))

    from app.services import platform_settings as ps
    return {
        "total": total.scalar() or 0,
        "pending": pending.scalar() or 0,
        "approved": approved.scalar() or 0,
        "total_owed": round(total_owed.scalar() or 0.0, 2),
        # Whether merchants currently see the Affiliates tab (admin-controlled).
        "affiliates_enabled": await ps.get_bool(db, ps.AFFILIATES_ENABLED, default=False),
    }


class AffiliatesToggle(BaseModel):
    enabled: bool


@router.put("/admin/enabled")
async def admin_set_affiliates_enabled(
    data: AffiliatesToggle,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Turn the merchant-facing Affiliates program on or off, platform-wide.

    Visibility only: OFF hides the tab, the earnings card and the sidebar link
    from every merchant. Affiliate records, statuses and accrued balances are all
    untouched — flipping it back ON restores exactly what was there."""
    from app.services import platform_settings as ps
    await ps.set_bool(db, ps.AFFILIATES_ENABLED, bool(data.enabled))
    logger.info("admin %s set affiliates_enabled=%s", admin.id, data.enabled)
    return {"affiliates_enabled": bool(data.enabled)}


# ── Commission crediting (called by billing engine on subscription activation) ─

async def credit_affiliate_commission(
    db: AsyncSession,
    trader_id: int,
    referred_by_code: Optional[str],
    subscription_price: float,
    plan_label: str = "",
):
    """Credit 15% of subscription price to the referring affiliate.
    Called when a referred trader activates or renews a paid plan.
    Safe to call even if there is no referrer. Earnings accrue into the current
    calendar month and are paid out on the 2nd of the next month."""
    if not referred_by_code:
        return
    if subscription_price <= 0:
        return

    aff_result = await db.execute(
        select(Affiliate).where(
            Affiliate.referral_code == referred_by_code,
            Affiliate.status == AffiliateStatus.APPROVED,
        )
    )
    aff = aff_result.scalar_one_or_none()
    if not aff:
        return

    commission = round(subscription_price * COMMISSION_RATE, 2)
    week_start = _month_start()   # period column now holds the month's first day

    earning = AffiliateEarning(
        affiliate_id=aff.id,
        referred_trader_id=trader_id,
        order_id=None,
        order_fee=round(subscription_price, 2),
        commission=commission,
        week_start=week_start,
    )
    db.add(earning)

    aff.pending_balance = round(aff.pending_balance + commission, 2)
    aff.total_earned = round(aff.total_earned + commission, 2)

    logger.info(
        f"[Affiliate] Credited KES {commission} to affiliate {aff.referral_code} "
        f"for {plan_label} subscription by trader {trader_id} (price={subscription_price})"
    )


# ── Monthly payout processing (2nd of every month) ────────────────────────────

async def process_monthly_payouts(db: AsyncSession):
    """
    On the 2nd of each month, settle the PREVIOUS month's accrued commissions:
    create a payout record for every approved affiliate with a positive balance,
    mark their earnings paid, and reset pending_balance to 0 for the new month.
    Does NOT send money — the admin pays and marks each payout paid.
    """
    period_start, period_end = _prev_month_range()

    result = await db.execute(
        select(Affiliate).where(
            Affiliate.status == AffiliateStatus.APPROVED,
            Affiliate.pending_balance >= MIN_PAYOUT_BALANCE,
        )
    )
    affiliates = result.scalars().all()

    created = 0
    for aff in affiliates:
        payout = AffiliatePayout(
            affiliate_id=aff.id,
            amount=aff.pending_balance,
            week_start=period_start,   # columns repurposed to hold the month range
            week_end=period_end,
            status=AffiliatePayoutStatus.PENDING,
        )
        db.add(payout)

        # Mark all unpaid earnings as paid
        unpaid = await db.execute(
            select(AffiliateEarning).where(
                AffiliateEarning.affiliate_id == aff.id,
                AffiliateEarning.paid_out == False,
            )
        )
        for e in unpaid.scalars().all():
            e.paid_out = True

        aff.total_paid_out = round(aff.total_paid_out + aff.pending_balance, 2)
        aff.pending_balance = 0.0
        created += 1

    if created:
        await db.commit()
        logger.info(f"[Affiliate] Created {created} monthly payout records for {period_start:%B %Y}")


# Back-compat alias so any old import keeps resolving.
process_friday_payouts = process_monthly_payouts
