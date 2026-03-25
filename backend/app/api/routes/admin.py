import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, case, extract
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models import Trader, TraderStatus, Order, OrderStatus, Payment, PaymentDirection, PaymentStatus, ChatMessage
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.message_template import MessageTemplate
from app.api.deps import get_admin_trader, get_employee_or_admin
from app.services.message_templates import seed_default_templates, refresh_template_cache

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
    today_orders, today_volume, today_order_revenue = result.one()

    # Today's wallet fees (settlement markup)
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(
            func.coalesce(func.sum(func.abs(WalletTransaction.amount)), 0),
        ).where(
            WalletTransaction.created_at >= today_start,
            WalletTransaction.transaction_type.in_([
                TransactionType.PLATFORM_FEE,
                TransactionType.DAILY_VOLUME_FEE,
            ]),
        )
    )
    today_wallet_fees = float(result.scalar() or 0)
    today_revenue = float(today_order_revenue) + today_wallet_fees

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

    # Internal transfers today
    result = await db.execute(
        select(
            func.count(WalletTransaction.id),
            func.coalesce(func.sum(WalletTransaction.amount), 0),
        ).where(
            WalletTransaction.created_at >= today_start,
            WalletTransaction.transaction_type == TransactionType.INTERNAL_TRANSFER_IN,
        )
    )
    internal_count, internal_volume = result.one()

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
        "internal_transfers": {
            "today_count": internal_count,
            "today_volume": float(internal_volume),
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
            "role": t.role or "trader",
            "total_trades": t.total_trades,
            "total_volume": t.total_volume,
            "created_at": t.created_at.isoformat() if t.created_at else "",
        }
        for t in traders
    ]


@router.post("/employees/create")
async def create_employee(
    full_name: str,
    email: str,
    password: str,
    phone: str = "0000000000",
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Admin creates an employee account manually."""
    from app.core.security import hash_password

    # Check if email already exists
    result = await db.execute(select(Trader).where(Trader.email == email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    employee = Trader(
        email=email,
        phone=phone,
        full_name=full_name,
        password_hash=hash_password(password),
        role="employee",
        is_admin=False,
        status=TraderStatus.ACTIVE,
    )
    db.add(employee)
    await db.commit()

    return {
        "status": "created",
        "employee_id": employee.id,
        "email": email,
        "full_name": full_name,
    }


@router.put("/traders/{trader_id}/role")
async def update_trader_role(
    trader_id: int,
    role: str,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trader's role (trader, employee, admin)."""
    if role not in ("trader", "employee", "admin"):
        raise HTTPException(status_code=400, detail="Invalid role")

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.role = role
    if role == "admin":
        trader.is_admin = True
    elif role != "admin" and trader.is_admin:
        trader.is_admin = False

    await db.commit()

    return {"status": "updated", "trader_id": trader_id, "role": role}


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
    """Update trader's subscription tier. Creates/updates subscription accordingly."""
    from app.models.subscription import Subscription, SubscriptionPlan, SubscriptionStatus
    from datetime import timedelta

    if tier not in ("standard", "starter", "pro"):
        raise HTTPException(status_code=400, detail="Invalid tier")

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.tier = tier

    if tier in ("starter", "pro"):
        # Check for existing active subscription
        sub_result = await db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader_id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            )
        )
        existing_sub = sub_result.scalar_one_or_none()

        now = datetime.now(timezone.utc)

        if existing_sub:
            # Update existing subscription
            existing_sub.plan = SubscriptionPlan(tier)
            existing_sub.amount = 5000 if tier == "starter" else 10000
            # Extend expiry if not set or already expired
            if not existing_sub.expires_at or existing_sub.expires_at < now:
                existing_sub.started_at = now
                existing_sub.expires_at = now + timedelta(days=30)
        else:
            # Create new subscription (admin-granted)
            sub = Subscription(
                trader_id=trader_id,
                plan=SubscriptionPlan(tier),
                status=SubscriptionStatus.ACTIVE,
                amount=5000 if tier == "starter" else 10000,
                started_at=now,
                expires_at=now + timedelta(days=30),
                mpesa_transaction_id="ADMIN_GRANT",
            )
            db.add(sub)

        # Send notification email
        from app.services.email import send_subscription_activated
        send_subscription_activated(
            trader.email, trader.full_name, tier,
            (now + timedelta(days=30)).strftime("%B %d, %Y"),
        )
    else:
        # Downgrade to free — expire any active subscription
        sub_result = await db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader_id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            )
        )
        existing_sub = sub_result.scalar_one_or_none()
        if existing_sub:
            existing_sub.status = SubscriptionStatus.EXPIRED

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
    """List INBOUND payments that couldn't be matched to an order.
    Excludes outbound (withdrawals, B2C settlements)."""
    result = await db.execute(
        select(Payment)
        .where(
            Payment.order_id.is_(None),
            Payment.direction == PaymentDirection.INBOUND,
        )
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


def _get_period_start(period: str):
    """Return the start datetime for a given period filter."""
    now = datetime.now(timezone.utc)
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        return now - timedelta(days=7)
    elif period == "month":
        return now - timedelta(days=30)
    elif period == "year":
        return now - timedelta(days=365)
    else:
        return None


@router.get("/transactions")
async def admin_transactions(
    period: str = "today",
    search: str = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all payments with date filters and search.
    Search by: M-Pesa code, phone number, trader name, or sender name.
    """
    start = _get_period_start(period)

    query = (
        select(Payment, Trader.full_name.label("trader_name"), Trader.phone.label("trader_phone"))
        .join(Trader, Payment.trader_id == Trader.id, isouter=True)
    )
    if start:
        query = query.where(Payment.created_at >= start)

    # Search filter
    if search and search.strip():
        s = f"%{search.strip()}%"
        query = query.where(
            (Payment.mpesa_transaction_id.ilike(s)) |
            (Payment.phone.ilike(s)) |
            (Payment.sender_name.ilike(s)) |
            (Payment.destination.ilike(s)) |
            (Trader.full_name.ilike(s)) |
            (Trader.phone.ilike(s))
        )

    query = query.order_by(Payment.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(query)
    rows = result.all()

    # Count total
    count_query = select(func.count(Payment.id))
    if start:
        count_query = count_query.where(Payment.created_at >= start)
    if search and search.strip():
        s = f"%{search.strip()}%"
        count_query = count_query.join(Trader, Payment.trader_id == Trader.id, isouter=True).where(
            (Payment.mpesa_transaction_id.ilike(s)) |
            (Payment.phone.ilike(s)) |
            (Payment.sender_name.ilike(s)) |
            (Payment.destination.ilike(s)) |
            (Trader.full_name.ilike(s))
        )
    total = (await db.execute(count_query)).scalar()

    return {
        "total": total,
        "transactions": [
            {
                "id": p.id,
                "trader_name": trader_name or "Unknown",
                "trader_phone": trader_phone or "-",
                "direction": p.direction.value if p.direction else "unknown",
                "transaction_type": p.transaction_type or "unknown",
                "amount": p.amount,
                "phone": p.phone or "-",
                "sender_name": p.sender_name or "-",
                "destination": p.destination or "-",
                "destination_type": p.destination_type or "-",
                "remarks": p.remarks or "-",
                "bill_ref_number": p.bill_ref_number or "-",
                "status": p.status.value if p.status else "unknown",
                "mpesa_transaction_id": p.mpesa_transaction_id or "-",
                "created_at": p.created_at.isoformat() if p.created_at else "",
            }
            for p, trader_name, trader_phone in rows
        ],
    }


@router.get("/analytics")
async def admin_analytics(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Comprehensive platform analytics."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)
    year_start = now - timedelta(days=365)

    async def _revenue_for_period(start):
        """Sum ALL platform revenue for a period:
        1. Order fees (platform_fee + settlement_fee from orders)
        2. Wallet fees (PLATFORM_FEE transactions = settlement markup KES 25)
        """
        # From orders
        q1 = select(
            func.coalesce(func.sum(Order.platform_fee), 0),
            func.coalesce(func.sum(Order.settlement_fee), 0),
        ).where(Order.created_at >= start)
        r1 = await db.execute(q1)
        order_pf, order_sf = r1.one()

        # From wallet transactions (settlement markup = PLATFORM_FEE + DAILY_VOLUME_FEE)
        q2 = select(
            func.coalesce(func.sum(func.abs(WalletTransaction.amount)), 0),
        ).where(
            WalletTransaction.created_at >= start,
            WalletTransaction.transaction_type.in_([
                TransactionType.PLATFORM_FEE,
                TransactionType.DAILY_VOLUME_FEE,
            ]),
        )
        r2 = await db.execute(q2)
        wallet_fees = float(r2.scalar() or 0)

        return float(order_pf) + float(order_sf) + wallet_fees

    today_revenue = await _revenue_for_period(today_start)
    week_revenue = await _revenue_for_period(week_start)
    month_revenue = await _revenue_for_period(month_start)
    year_revenue = await _revenue_for_period(year_start)

    # Total platform profit (all time)
    r = await db.execute(
        select(
            func.coalesce(func.sum(Order.platform_fee), 0),
            func.coalesce(func.sum(Order.settlement_fee), 0),
        )
    )
    total_pf, total_sf = r.one()

    # Add wallet platform fees (all time) — includes daily volume fees
    r_wf = await db.execute(
        select(
            func.coalesce(func.sum(func.abs(WalletTransaction.amount)), 0),
        ).where(
            WalletTransaction.transaction_type.in_([
                TransactionType.PLATFORM_FEE,
                TransactionType.DAILY_VOLUME_FEE,
            ])
        )
    )
    total_wallet_fees = float(r_wf.scalar() or 0)

    platform_profit = float(total_pf) + float(total_sf) + total_wallet_fees

    # Monthly volumes - last 6 months
    six_months_ago = now - timedelta(days=180)
    monthly_q = (
        select(
            extract("year", Order.created_at).label("yr"),
            extract("month", Order.created_at).label("mo"),
            func.sum(case((Order.side == "sell", Order.fiat_amount), else_=0)).label("sell_volume"),
            func.sum(case((Order.side == "buy", Order.fiat_amount), else_=0)).label("buy_volume"),
            func.sum(Order.fiat_amount).label("total_volume"),
            func.sum(Order.platform_fee + Order.settlement_fee).label("profit"),
            func.count(Order.id).label("trades"),
        )
        .where(Order.created_at >= six_months_ago)
        .group_by("yr", "mo")
        .order_by("yr", "mo")
    )
    r = await db.execute(monthly_q)
    monthly_rows = r.all()

    month_names = [
        "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    monthly_volumes = [
        {
            "month": f"{month_names[int(row.mo)]} {int(row.yr)}",
            "buy_volume": float(row.buy_volume or 0),
            "sell_volume": float(row.sell_volume or 0),
            "total_volume": float(row.total_volume or 0),
            "profit": float(row.profit or 0),
            "trades": row.trades,
        }
        for row in monthly_rows
    ]

    # Online traders (binance_connected + active)
    r = await db.execute(
        select(func.count(Trader.id)).where(
            Trader.binance_connected == True,
            Trader.status == TraderStatus.ACTIVE,
        )
    )
    online_traders = r.scalar()

    # Top 5 traders by volume
    top_q = (
        select(
            Trader.full_name,
            Trader.total_trades,
            Trader.total_volume,
        )
        .where(Trader.is_admin == False)
        .order_by(Trader.total_volume.desc())
        .limit(5)
    )
    r = await db.execute(top_q)
    top_traders = [
        {
            "name": row.full_name,
            "trades": row.total_trades,
            "volume": float(row.total_volume),
        }
        for row in r.all()
    ]

    # Internal transfer stats
    async def _internal_transfers_for_period(start):
        q = select(
            func.count(WalletTransaction.id),
            func.coalesce(func.sum(WalletTransaction.amount), 0),
        ).where(
            WalletTransaction.created_at >= start,
            WalletTransaction.transaction_type == TransactionType.INTERNAL_TRANSFER_IN,
        )
        r = await db.execute(q)
        cnt, vol = r.one()
        return int(cnt), float(vol)

    it_today_count, it_today_vol = await _internal_transfers_for_period(today_start)
    it_month_count, it_month_vol = await _internal_transfers_for_period(month_start)

    return {
        "platform_profit": platform_profit,
        "revenue": {
            "today": today_revenue,
            "week": week_revenue,
            "month": month_revenue,
            "year": year_revenue,
        },
        "monthly_volumes": monthly_volumes,
        "online_traders": online_traders,
        "top_traders": top_traders,
        "internal_transfers": {
            "today_count": it_today_count,
            "today_volume": it_today_vol,
            "month_count": it_month_count,
            "month_volume": it_month_vol,
        },
    }


@router.get("/online-traders")
async def admin_online_traders(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Return traders where binance_connected=True and status=active."""
    result = await db.execute(
        select(Trader).where(
            Trader.binance_connected == True,
            Trader.status == TraderStatus.ACTIVE,
        ).order_by(Trader.total_volume.desc())
    )
    traders = result.scalars().all()

    return [
        {
            "id": t.id,
            "full_name": t.full_name,
            "email": t.email,
            "phone": t.phone,
            "total_trades": t.total_trades,
            "total_volume": float(t.total_volume),
            "binance_uid": t.binance_uid,
            "updated_at": t.updated_at.isoformat() if t.updated_at else "",
        }
        for t in traders
    ]


# ==================== DISPUTE MANAGEMENT (Employee + Admin) ====================


class ResolveDisputeRequest(BaseModel):
    resolution: str
    action: str  # "refund", "release", "cancel"


@router.put("/disputes/{order_id}/assign")
async def assign_dispute(
    order_id: int,
    employee: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Assign a dispute to the current employee."""
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status != OrderStatus.DISPUTED:
        raise HTTPException(status_code=400, detail="Order is not in disputed status")

    # Store assignment in fraud_check_result JSON
    existing = order.fraud_check_result or {}
    existing["assigned_to"] = employee.id
    existing["assigned_name"] = employee.full_name
    existing["assigned_at"] = datetime.now(timezone.utc).isoformat()
    order.fraud_check_result = existing

    await db.commit()

    return {"status": "assigned", "order_id": order_id, "assigned_to": employee.full_name}


@router.put("/disputes/{order_id}/resolve")
async def resolve_dispute(
    order_id: int,
    data: ResolveDisputeRequest,
    employee: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Resolve a dispute with a resolution note and action."""
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.status != OrderStatus.DISPUTED:
        raise HTTPException(status_code=400, detail="Order is not in disputed status")

    if data.action not in ("refund", "release", "cancel"):
        raise HTTPException(status_code=400, detail="Invalid action. Use: refund, release, cancel")

    # Update order status based on action
    if data.action == "release":
        order.status = OrderStatus.COMPLETED
    elif data.action == "refund":
        order.status = OrderStatus.CANCELLED
    elif data.action == "cancel":
        order.status = OrderStatus.CANCELLED

    # Store resolution details
    existing = order.fraud_check_result or {}
    existing["resolution"] = data.resolution
    existing["resolution_action"] = data.action
    existing["resolved_by"] = employee.id
    existing["resolved_by_name"] = employee.full_name
    existing["resolved_at"] = datetime.now(timezone.utc).isoformat()
    order.fraud_check_result = existing

    await db.commit()

    return {
        "status": "resolved",
        "order_id": order_id,
        "action": data.action,
        "new_status": order.status.value,
    }


@router.get("/disputes/{order_id}/details")
async def get_dispute_details(
    order_id: int,
    employee: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get full dispute details including order info, trader info, payments, and chat history."""
    # Get order
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    # Get trader
    result = await db.execute(select(Trader).where(Trader.id == order.trader_id))
    trader = result.scalar_one_or_none()

    # Get payments
    result = await db.execute(
        select(Payment).where(Payment.order_id == order_id).order_by(Payment.created_at.desc())
    )
    payments = result.scalars().all()

    # Get chat messages
    result = await db.execute(
        select(ChatMessage, Trader.full_name.label("sender_name"))
        .join(Trader, ChatMessage.sender_id == Trader.id)
        .where(ChatMessage.order_id == order_id)
        .order_by(ChatMessage.created_at.asc())
    )
    chat_rows = result.all()

    return {
        "order": {
            "id": order.id,
            "binance_order_number": order.binance_order_number,
            "side": order.side.value,
            "crypto_amount": order.crypto_amount,
            "crypto_currency": order.crypto_currency,
            "fiat_amount": order.fiat_amount,
            "exchange_rate": order.exchange_rate,
            "status": order.status.value,
            "risk_score": order.risk_score,
            "counterparty_name": order.counterparty_name,
            "counterparty_phone": order.counterparty_phone,
            "created_at": order.created_at.isoformat() if order.created_at else "",
            "assigned_to": (order.fraud_check_result or {}).get("assigned_name"),
            "resolution": (order.fraud_check_result or {}).get("resolution"),
            "resolution_action": (order.fraud_check_result or {}).get("resolution_action"),
        },
        "trader": {
            "id": trader.id,
            "full_name": trader.full_name,
            "email": trader.email,
            "phone": trader.phone,
            "trust_score": trader.trust_score,
            "total_trades": trader.total_trades,
        } if trader else None,
        "payments": [
            {
                "id": p.id,
                "amount": p.amount,
                "phone": p.phone,
                "sender_name": p.sender_name,
                "mpesa_transaction_id": p.mpesa_transaction_id,
                "status": p.status.value if p.status else "unknown",
                "direction": p.direction.value if p.direction else "unknown",
                "created_at": p.created_at.isoformat() if p.created_at else "",
            }
            for p in payments
        ],
        "chat": [
            {
                "id": msg.id,
                "sender_id": msg.sender_id,
                "sender_name": sender_name,
                "sender_role": msg.sender_role,
                "message": msg.message,
                "created_at": msg.created_at.isoformat() if msg.created_at else "",
            }
            for msg, sender_name in chat_rows
        ],
    }


# ==================== MESSAGE TEMPLATES ====================


class UpdateTemplateRequest(BaseModel):
    body: str
    subject: str | None = None


@router.get("/templates")
async def list_templates(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all message templates."""
    result = await db.execute(
        select(MessageTemplate).order_by(MessageTemplate.channel, MessageTemplate.key)
    )
    templates = result.scalars().all()

    return [
        {
            "id": t.id,
            "key": t.key,
            "name": t.name,
            "channel": t.channel,
            "subject": t.subject,
            "body": t.body,
            "variables": t.variables,
            "updated_at": t.updated_at.isoformat() if t.updated_at else "",
        }
        for t in templates
    ]


@router.put("/templates/{template_key}")
async def update_template(
    template_key: str,
    data: UpdateTemplateRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update a message template's body (and subject for email)."""
    result = await db.execute(
        select(MessageTemplate).where(MessageTemplate.key == template_key)
    )
    template = result.scalar_one_or_none()

    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    template.body = data.body
    if data.subject is not None and template.channel == "email":
        template.subject = data.subject
    template.updated_at = datetime.now(timezone.utc)

    await db.commit()

    # Refresh the in-memory cache so SMS service picks up changes immediately
    await refresh_template_cache()

    return {"status": "updated", "key": template_key}


@router.post("/templates/seed")
async def seed_templates(
    force: bool = Query(default=False),
    admin: Trader = Depends(get_admin_trader),
):
    """Seed default message templates. Use force=true to reset all to defaults."""
    await seed_default_templates(force=force)
    return {"status": "seeded", "force": force}
