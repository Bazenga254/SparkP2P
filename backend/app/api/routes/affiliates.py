import logging
import secrets
import string
from datetime import datetime, timezone, date, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Trader
from app.models.affiliate import Affiliate, AffiliateEarning, AffiliatePayout, AffiliateStatus, AffiliatePayoutStatus
from app.api.deps import get_current_trader, get_admin_trader

logger = logging.getLogger(__name__)

router = APIRouter()

COMMISSION_RATE = 0.10          # 10% of order fee goes to affiliate
MIN_PAYOUT_BALANCE = 5000.0    # KES — minimum to trigger Friday payout


# ── Helpers ───────────────────────────────────────────────────────────────────

def _week_start(d: date = None) -> date:
    """Return the Monday of the week containing d (or today)."""
    d = d or datetime.now(timezone.utc).date()
    return d - timedelta(days=d.weekday())


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

    aff = Affiliate(trader_id=trader.id, status=AffiliateStatus.PENDING)
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
            "referral_code": aff.referral_code,
            "referral_link": f"https://sparkp2p.com/login?ref={aff.referral_code}" if aff.referral_code else None,
            "pending_balance": aff.pending_balance,
            "total_earned": aff.total_earned,
            "total_paid_out": aff.total_paid_out,
            "referral_count": referral_count,
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

    # Get all referred traders
    refs_result = await db.execute(
        select(Trader).where(Trader.referred_by_code == aff.referral_code)
    )
    referred_traders = refs_result.scalars().all()

    referrals = []
    for rt in referred_traders:
        # Earnings from this specific referee
        earnings_result = await db.execute(
            select(
                AffiliateEarning.week_start,
                func.sum(AffiliateEarning.commission).label("weekly_commission"),
                func.count(AffiliateEarning.id).label("order_count"),
            )
            .where(
                AffiliateEarning.affiliate_id == aff.id,
                AffiliateEarning.referred_trader_id == rt.id,
            )
            .group_by(AffiliateEarning.week_start)
            .order_by(AffiliateEarning.week_start.desc())
        )
        weekly_rows = earnings_result.all()

        total_earned_from = sum(r.weekly_commission for r in weekly_rows)

        referrals.append({
            "trader_name": rt.full_name,
            "joined_at": rt.created_at.isoformat() if rt.created_at else None,
            "total_earned": round(total_earned_from, 2),
            "weekly_breakdown": [
                {
                    "week_start": r.week_start.isoformat(),
                    "commission": round(r.weekly_commission, 2),
                    "order_count": r.order_count,
                }
                for r in weekly_rows
            ],
        })

    # Current week summary
    week_start = _week_start()
    this_week_result = await db.execute(
        select(func.sum(AffiliateEarning.commission))
        .where(
            AffiliateEarning.affiliate_id == aff.id,
            AffiliateEarning.week_start == week_start,
        )
    )
    this_week_earnings = this_week_result.scalar() or 0.0

    return {
        "referrals": referrals,
        "summary": {
            "total_referrals": len(referred_traders),
            "this_week_earnings": round(this_week_earnings, 2),
            "pending_balance": round(aff.pending_balance, 2),
            "total_earned": round(aff.total_earned, 2),
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

    return {
        "total": total.scalar() or 0,
        "pending": pending.scalar() or 0,
        "approved": approved.scalar() or 0,
        "total_owed": round(total_owed.scalar() or 0.0, 2),
    }


# ── Commission crediting (called by settlement engine) ────────────────────────

async def credit_affiliate_commission(
    db: AsyncSession,
    order_id: int,
    trader_id: int,
    referred_by_code: Optional[str],
    platform_fee: float,
    settlement_fee: float,
):
    """Credit 10% of total order fees to the referring affiliate. Safe to call even if no referrer."""
    if not referred_by_code:
        return
    total_fee = platform_fee + settlement_fee
    if total_fee <= 0:
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

    commission = round(total_fee * COMMISSION_RATE, 2)
    week_start = _week_start()

    earning = AffiliateEarning(
        affiliate_id=aff.id,
        referred_trader_id=trader_id,
        order_id=order_id,
        order_fee=round(total_fee, 2),
        commission=commission,
        week_start=week_start,
    )
    db.add(earning)

    aff.pending_balance = round(aff.pending_balance + commission, 2)
    aff.total_earned = round(aff.total_earned + commission, 2)

    logger.info(
        f"[Affiliate] Credited KES {commission} to affiliate {aff.referral_code} "
        f"for order {order_id} (fee={total_fee})"
    )


# ── Friday payout processing (called by housekeeping scheduler) ───────────────

async def process_friday_payouts(db: AsyncSession):
    """
    Create payout records for all approved affiliates whose pending_balance >= KES 5,000.
    Called every Friday by the background scheduler. Does NOT send money — admin handles that.
    """
    today = datetime.now(timezone.utc).date()
    week_start = _week_start(today)
    week_end = week_start + timedelta(days=6)

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
            week_start=week_start,
            week_end=week_end,
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
        logger.info(f"[Affiliate] Created {created} Friday payout records")
