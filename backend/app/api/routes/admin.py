import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models import Trader, TraderStatus, Order, OrderStatus, Payment
from app.models.wallet import Wallet
from app.api.deps import get_admin_trader

logger = logging.getLogger(__name__)

router = APIRouter()


class AdminLoginRequest(BaseModel):
    password: str


@router.post("/login")
async def admin_login(data: AdminLoginRequest, db: AsyncSession = Depends(get_db)):
    """Login as admin with master password. Creates admin account if needed."""
    if data.password != settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid admin password")

    # Find or create admin account
    result = await db.execute(
        select(Trader).where(Trader.is_admin == True)
    )
    admin = result.scalar_one_or_none()

    if not admin:
        # Create admin account
        from app.core.security import hash_password
        admin = Trader(
            email="admin@sparkp2p.com",
            phone="0000000000",
            full_name="SparkP2P Admin",
            password_hash=hash_password(data.password),
            is_admin=True,
            status=TraderStatus.ACTIVE,
        )
        db.add(admin)
        await db.commit()
        await db.refresh(admin)

    token = create_access_token({"sub": str(admin.id), "email": admin.email})

    return {
        "access_token": token,
        "token_type": "bearer",
        "trader_id": admin.id,
        "full_name": admin.full_name,
        "is_admin": True,
    }


@router.get("/dashboard")
async def admin_dashboard(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get admin dashboard overview."""
    today = func.current_date()

    # Total traders
    result = await db.execute(select(func.count(Trader.id)))
    total_traders = result.scalar()

    # Active traders
    result = await db.execute(
        select(func.count(Trader.id)).where(Trader.status == TraderStatus.ACTIVE)
    )
    active_traders = result.scalar()

    # Today's orders
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.platform_fee), 0),
        ).where(func.date(Order.created_at) == today)
    )
    today_orders, today_volume, today_revenue = result.one()

    # Completed orders today
    result = await db.execute(
        select(func.count(Order.id)).where(
            func.date(Order.created_at) == today,
            Order.status == OrderStatus.COMPLETED,
        )
    )
    completed_today = result.scalar()

    # Disputed orders
    result = await db.execute(
        select(func.count(Order.id)).where(Order.status == OrderStatus.DISPUTED)
    )
    disputed_count = result.scalar()

    # Total platform float (sum of all wallet balances)
    result = await db.execute(
        select(func.coalesce(func.sum(Wallet.balance), 0))
    )
    total_float = result.scalar()

    return {
        "traders": {
            "total": total_traders,
            "active": active_traders,
        },
        "today": {
            "orders": today_orders,
            "completed": completed_today,
            "volume": float(today_volume),
            "revenue": float(today_revenue),
        },
        "alerts": {
            "disputed_orders": disputed_count,
        },
        "platform": {
            "total_float": float(total_float),
        },
    }


@router.get("/traders")
async def list_traders(
    status: TraderStatus = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all traders."""
    query = select(Trader)
    if status:
        query = query.where(Trader.status == status)
    query = query.order_by(Trader.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    traders = result.scalars().all()

    return [
        {
            "id": t.id,
            "full_name": t.full_name,
            "email": t.email,
            "phone": t.phone,
            "status": t.status.value,
            "binance_connected": t.binance_connected,
            "tier": t.tier,
            "total_trades": t.total_trades,
            "total_volume": t.total_volume,
            "created_at": t.created_at.isoformat() if t.created_at else "",
        }
        for t in traders
    ]


@router.put("/traders/{trader_id}/status")
async def update_trader_status(
    trader_id: int,
    new_status: TraderStatus,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Activate, pause, or suspend a trader."""
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.status = new_status
    await db.commit()

    return {"status": "updated", "trader_id": trader_id, "new_status": new_status.value}


@router.put("/traders/{trader_id}/tier")
async def update_trader_tier(
    trader_id: int,
    tier: str,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trader's pricing tier."""
    if tier not in ("standard", "silver", "gold"):
        raise HTTPException(status_code=400, detail="Invalid tier")

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.tier = tier
    await db.commit()

    return {"status": "updated", "trader_id": trader_id, "tier": tier}


@router.get("/orders/disputed")
async def list_disputed_orders(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all disputed orders that need manual review."""
    result = await db.execute(
        select(Order)
        .where(Order.status == OrderStatus.DISPUTED)
        .order_by(Order.created_at.desc())
    )
    orders = result.scalars().all()

    return [
        {
            "id": o.id,
            "trader_id": o.trader_id,
            "binance_order_number": o.binance_order_number,
            "side": o.side.value,
            "fiat_amount": o.fiat_amount,
            "crypto_amount": o.crypto_amount,
            "status": o.status.value,
            "risk_score": o.risk_score,
            "created_at": o.created_at.isoformat() if o.created_at else "",
        }
        for o in orders
    ]


@router.get("/payments/unmatched")
async def list_unmatched_payments(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List payments that couldn't be matched to an order."""
    result = await db.execute(
        select(Payment)
        .where(Payment.order_id.is_(None))
        .order_by(Payment.created_at.desc())
    )
    payments = result.scalars().all()

    return [
        {
            "id": p.id,
            "amount": p.amount,
            "phone": p.phone,
            "sender_name": p.sender_name,
            "bill_ref_number": p.bill_ref_number,
            "mpesa_transaction_id": p.mpesa_transaction_id,
            "created_at": p.created_at.isoformat() if p.created_at else "",
        }
        for p in payments
    ]
