import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select, func, case, extract
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models import Trader, TraderStatus, Order, OrderStatus, Payment, PaymentDirection, PaymentStatus, ChatMessage
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.message_template import MessageTemplate
from app.api.deps import get_admin_trader, get_employee_or_admin, get_client_ip, write_audit_log
from app.services.message_templates import seed_default_templates, refresh_template_cache

logger = logging.getLogger(__name__)

router = APIRouter()


def mask_phone(phone: str) -> str:
    """Mask phone: 0712345678 → 07XX XXX 678"""
    if not phone or len(phone) < 7:
        return phone or "—"
    return phone[:2] + "XX XXX " + phone[-3:]


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

    # Today's completed/released orders only
    completed_statuses = [OrderStatus.RELEASED, OrderStatus.COMPLETED]
    result = await db.execute(
        select(
            func.count(Order.id),
            func.coalesce(func.sum(Order.fiat_amount), 0),
            func.coalesce(func.sum(Order.platform_fee), 0),
        ).where(
            func.date(Order.created_at) == today,
            Order.status.in_(completed_statuses),
        )
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

    # Completed orders today (subset of the above)
    completed_today = today_orders

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
    request: Request,
    status: TraderStatus = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all traders. Phones are masked for non-admin roles."""
    from fastapi import Request
    query = select(Trader)
    if status:
        query = query.where(Trader.status == status)
    query = query.order_by(Trader.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    traders = result.scalars().all()

    is_full_admin = admin.is_admin and admin.role == "admin"

    await write_audit_log(
        db, admin, "list_traders",
        ip_address=get_client_ip(request),
        detail=f"limit={limit} offset={offset} status={status}",
    )

    return [
        {
            "id": t.id,
            "full_name": t.full_name,
            "email": t.email,
            "phone": t.phone if is_full_admin else mask_phone(t.phone),
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


@router.get("/traders/{trader_id}/detail")
async def get_trader_detail(
    request: Request,
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get detailed trader info. Settlement details restricted to full admins only."""
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    is_full_admin = admin.is_admin and admin.role == "admin"

    await write_audit_log(
        db, admin, "view_trader_detail",
        ip_address=get_client_ip(request),
        target_trader_id=trader_id,
        detail=f"Viewed detail for {trader.full_name}",
    )

    return {
        "security_question": trader.security_question or "",
        "security_answer": (getattr(trader, 'security_answer_plain', '') or "") if is_full_admin else "— restricted —",
        "settlement_method": trader.settlement_method or "" if is_full_admin else "— restricted —",
        "settlement_phone": trader.settlement_phone or "" if is_full_admin else "— restricted —",
        "settlement_account": trader.settlement_account or "" if is_full_admin else "— restricted —",
        "settlement_paybill": getattr(trader, 'settlement_paybill', '') or "" if is_full_admin else "— restricted —",
        "settlement_destination": (trader.settlement_phone or trader.settlement_account or trader.phone or "") if is_full_admin else "— restricted —",
        "google_id": getattr(trader, 'google_id', '') or "",
        "binance_username": getattr(trader, 'binance_username', '') or "",
        "phone": trader.phone or "" if is_full_admin else mask_phone(trader.phone),
        "created_at": str(trader.created_at) if trader.created_at else "",
        "last_login": trader.last_login.isoformat() if trader.last_login else "",
        "total_trades": trader.total_trades or 0,
        "total_volume": float(trader.total_volume or 0),
    }


@router.get("/traders/{trader_id}/wallet")
async def get_trader_wallet(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get a trader's wallet balance and stats."""
    from app.models.wallet import Wallet, WalletTransaction
    result = await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))
    wallet = result.scalar_one_or_none()
    if not wallet:
        return {"balance": 0, "reserved": 0, "total_earned": 0, "total_withdrawn": 0, "total_fees_paid": 0}
    return {
        "balance": wallet.balance,
        "reserved": wallet.reserved,
        "total_earned": wallet.total_earned,
        "total_withdrawn": getattr(wallet, 'total_withdrawn', 0) or 0,
        "total_fees_paid": wallet.total_fees_paid,
    }


@router.get("/traders/{trader_id}/transactions")
async def get_trader_transactions(
    trader_id: int,
    limit: int = 20,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get a trader's recent wallet transactions."""
    from app.models.wallet import WalletTransaction
    from sqlalchemy import desc
    result = await db.execute(
        select(WalletTransaction)
        .where(WalletTransaction.trader_id == trader_id)
        .order_by(desc(WalletTransaction.created_at))
        .limit(limit)
    )
    txns = result.scalars().all()
    return [
        {
            "id": t.id,
            "transaction_type": t.transaction_type.value if hasattr(t.transaction_type, 'value') else str(t.transaction_type),
            "direction": "inbound" if t.amount >= 0 else "outbound",
            "amount": abs(t.amount),
            "balance_after": t.balance_after,
            "description": t.description or "",
            "mpesa_transaction_id": getattr(t, 'mpesa_receipt', '') or "",
            "bill_ref_number": "",
            "status": t.status or "completed",
            "created_at": t.created_at.isoformat() if t.created_at else "",
        }
        for t in txns
    ]


@router.get("/traders/{trader_id}/orders")
async def get_trader_orders(
    trader_id: int,
    limit: int = 20,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get a trader's recent orders."""
    from sqlalchemy import desc
    result = await db.execute(
        select(Order)
        .where(Order.trader_id == trader_id)
        .order_by(desc(Order.created_at))
        .limit(limit)
    )
    orders = result.scalars().all()
    return [
        {
            "id": o.id,
            "side": o.side.value if hasattr(o.side, 'value') else str(o.side),
            "status": o.status.value if hasattr(o.status, 'value') else str(o.status),
            "fiat_amount": o.fiat_amount,
            "crypto_amount": o.crypto_amount,
            "asset": o.crypto_currency or "USDT",
            "price": o.exchange_rate,
            "counterparty": o.counterparty_name or "",
            "platform_fee": o.platform_fee or 0,
            "binance_order_number": o.binance_order_number or "",
            "created_at": o.created_at.isoformat() if o.created_at else "",
        }
        for o in orders
    ]


@router.post("/traders/{trader_id}/reset-password")
async def reset_trader_password(
    trader_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Reset trader password and send new one via SMS."""
    import secrets
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    new_password = secrets.token_urlsafe(8)
    from app.core.security import hash_password
    trader.password_hash = hash_password(new_password)
    await db.commit()

    # Send via SMS
    try:
        from app.services.sms import send_sms
        send_sms(trader.phone, f"SparkP2P: Your password has been reset. New password: {new_password}")
    except Exception:
        pass

    logger.info(f"Password reset for trader {trader.id} ({trader.full_name})")
    return {"status": "ok", "message": "Password reset and sent via SMS"}


# In-memory store for pending payment resolutions: {mpesa_ref: {trader_id, amount, status, message}}
_pending_resolutions: dict = {}


class ResolvePaymentRequest(BaseModel):
    mpesa_ref: str
    amount: float


@router.post("/traders/{trader_id}/resolve-payment")
async def resolve_payment(
    trader_id: int,
    req: ResolvePaymentRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Verify an M-Pesa transaction via Safaricom and credit trader wallet if valid."""
    mpesa_ref = req.mpesa_ref.strip().upper()
    amount = req.amount

    # 1. Duplicate check — has this receipt already been credited?
    existing = await db.execute(
        select(Payment).where(Payment.mpesa_transaction_id == mpesa_ref)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="This M-Pesa reference has already been credited.")

    # 2. Trader exists?
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    # 3. Store pending resolution and trigger Safaricom verification
    _pending_resolutions[mpesa_ref] = {
        "trader_id": trader_id,
        "amount": amount,
        "status": "verifying",
        "message": "Waiting for Safaricom to confirm transaction...",
    }

    try:
        from app.services.mpesa.client import mpesa_client
        await mpesa_client.query_transaction(mpesa_ref)
        logger.info(f"Resolve payment: queried Safaricom for {mpesa_ref} (trader {trader_id}, KES {amount})")
    except Exception as e:
        _pending_resolutions.pop(mpesa_ref, None)
        raise HTTPException(status_code=502, detail=f"Safaricom query failed: {e}")

    return {"status": "verifying", "mpesa_ref": mpesa_ref, "message": "Verification sent to Safaricom. Check status in a few seconds."}


@router.get("/traders/{trader_id}/resolve-payment/status")
async def resolve_payment_status(
    trader_id: int,
    mpesa_ref: str,
    admin: Trader = Depends(get_admin_trader),
):
    """Poll for the result of a pending payment resolution."""
    mpesa_ref = mpesa_ref.strip().upper()
    info = _pending_resolutions.get(mpesa_ref)
    if not info:
        # Check if already credited
        return {"status": "unknown", "message": "No pending resolution found for this reference."}
    return {
        "status": info["status"],
        "message": info["message"],
        "amount": info.get("credited_amount"),
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
            ~Payment.bill_ref_number.like("DEP-%"),
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


@router.get("/orders")
async def admin_orders(
    period: str = "today",
    search: str = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all Binance P2P orders with date filters and search."""
    start = _get_period_start(period)

    query = (
        select(Order, Trader.full_name.label("trader_name"))
        .join(Trader, Order.trader_id == Trader.id, isouter=True)
    )
    if start:
        query = query.where(Order.created_at >= start)

    if search and search.strip():
        s = f"%{search.strip()}%"
        query = query.where(
            (Order.binance_order_number.ilike(s)) |
            (Order.counterparty_name.ilike(s)) |
            (Trader.full_name.ilike(s))
        )

    query = query.order_by(Order.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(query)
    rows = result.all()

    count_query = select(func.count(Order.id))
    if start:
        count_query = count_query.where(Order.created_at >= start)
    if search and search.strip():
        s = f"%{search.strip()}%"
        count_query = count_query.join(Trader, Order.trader_id == Trader.id, isouter=True).where(
            (Order.binance_order_number.ilike(s)) |
            (Order.counterparty_name.ilike(s)) |
            (Trader.full_name.ilike(s))
        )
    total = (await db.execute(count_query)).scalar()

    return {
        "total": total,
        "orders": [
            {
                "id": o.id,
                "trader_name": trader_name or "Unknown",
                "binance_order_number": o.binance_order_number or "",
                "side": o.side.value if hasattr(o.side, 'value') else str(o.side),
                "status": o.status.value if hasattr(o.status, 'value') else str(o.status),
                "fiat_amount": o.fiat_amount,
                "crypto_amount": o.crypto_amount,
                "asset": o.crypto_currency or "USDT",
                "price": o.exchange_rate,
                "counterparty": o.counterparty_name or "—",
                "platform_fee": o.platform_fee or 0,
                "created_at": o.created_at.isoformat() if o.created_at else "",
            }
            for o, trader_name in rows
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
        .where(
            Order.created_at >= six_months_ago,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
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


@router.get("/support-tickets")
async def list_support_tickets(
    category: str = "open",   # "open" = OPEN+ESCALATED, "closed" = CLOSED+AI_RESOLVED
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, le=100),
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List support tickets with category filter and pagination."""
    from app.models.support_ticket import SupportTicket
    from sqlalchemy import desc, cast, String, func, or_

    if category == "closed":
        status_filter = or_(
            cast(SupportTicket.status, String).ilike("CLOSED"),
            cast(SupportTicket.status, String).ilike("AI_RESOLVED"),
        )
    else:  # open (default)
        status_filter = or_(
            cast(SupportTicket.status, String).ilike("OPEN"),
            cast(SupportTicket.status, String).ilike("ESCALATED"),
        )

    # Total count
    count_result = await db.execute(select(func.count()).select_from(SupportTicket).where(status_filter))
    total = count_result.scalar() or 0

    offset = (page - 1) * page_size
    result = await db.execute(
        select(SupportTicket)
        .where(status_filter)
        .order_by(desc(SupportTicket.updated_at))
        .limit(page_size)
        .offset(offset)
    )
    tickets = result.scalars().all()

    # Fetch trader names
    trader_ids = list({t.trader_id for t in tickets})
    traders_map = {}
    if trader_ids:
        traders_result = await db.execute(select(Trader).where(Trader.id.in_(trader_ids)))
        traders_map = {t.id: t for t in traders_result.scalars().all()}

    return {
        "tickets": [
            {
                "id": t.id,
                "trader_id": t.trader_id,
                "trader_name": traders_map[t.trader_id].full_name if t.trader_id in traders_map else "Unknown",
                "trader_phone": traders_map[t.trader_id].phone if t.trader_id in traders_map else "",
                "subject": t.subject,
                "status": next((s for s in ("escalated","closed","open","ai_resolved") if s in str(t.status).lower()), str(t.status).lower()),
                "messages": t.messages or [],
                "escalation_reason": t.escalation_reason,
                "created_at": t.created_at.isoformat() if t.created_at else "",
                "updated_at": t.updated_at.isoformat() if t.updated_at else "",
            }
            for t in tickets
        ],
        "total": total,
        "page": page,
        "pages": max(1, -(-total // page_size)),  # ceiling division
        "category": category,
    }


@router.post("/support-tickets/{ticket_id}/reply")
async def reply_support_ticket(
    ticket_id: int,
    data: dict,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Admin sends a reply message to the trader on a support ticket."""
    from app.models.support_ticket import SupportTicket
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    messages = list(ticket.messages or [])
    msg = {
        "role": "admin",
        "content": data.get("message", "").strip(),
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    if data.get("attachment_url"):
        msg["attachment_url"] = data["attachment_url"]
        msg["attachment_name"] = data.get("attachment_name", "file")
    messages.append(msg)
    ticket.messages = messages
    ticket.updated_at = datetime.now(timezone.utc)
    await db.commit()

    # Notify the trader
    from app.api.routes.traders import add_notification
    add_notification(
        ticket.trader_id,
        title="Support Reply",
        message=data.get("message", "").strip()[:120],
        notif_type="support",
    )

    return {"status": "ok", "ticket_id": ticket_id, "messages": messages}


@router.put("/support-tickets/{ticket_id}/close")
async def close_support_ticket(
    ticket_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Mark a support ticket as closed."""
    from app.models.support_ticket import SupportTicket, TicketStatus
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    ticket.status = TicketStatus.CLOSED
    await db.commit()
    return {"status": "closed", "ticket_id": ticket_id}


@router.get("/audit-logs")
async def get_audit_logs(
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """View audit logs of admin/employee access to sensitive data."""
    from app.models.audit_log import AuditLog
    from sqlalchemy import desc
    result = await db.execute(
        select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit).offset(offset)
    )
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "actor_id": l.actor_id,
            "actor_role": l.actor_role,
            "action": l.action,
            "target_trader_id": l.target_trader_id,
            "detail": l.detail,
            "ip_address": l.ip_address,
            "created_at": l.created_at.isoformat() if l.created_at else "",
        }
        for l in logs
    ]


# ═══════════════════════════════════════════════════════════
# WITHDRAWALS — Track M-Pesa and I&M Bank disbursements
# ═══════════════════════════════════════════════════════════

@router.get("/withdrawals")
async def get_withdrawals(
    method: str = Query(None),       # mpesa | bank_paybill | all
    status: str = Query(None),       # pending | completed | failed | all
    period: str = Query("all"),      # today | week | month | all
    page: int = Query(1, ge=1),
    limit: int = Query(30, le=100),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all withdrawal transactions with trader details."""
    from sqlalchemy import desc, and_

    q = (
        select(WalletTransaction, Trader)
        .join(Trader, Trader.id == WalletTransaction.trader_id)
        .where(WalletTransaction.transaction_type == TransactionType.WITHDRAWAL)
    )

    if method and method != "all":
        from sqlalchemy import or_
        if method == "mpesa":
            # NULLs are legacy rows created before the column existed — all were M-Pesa
            q = q.where(or_(WalletTransaction.settlement_method == "mpesa",
                            WalletTransaction.settlement_method.is_(None)))
        else:
            q = q.where(WalletTransaction.settlement_method == method)

    if status and status != "all":
        q = q.where(WalletTransaction.status == status)

    if period == "today":
        today = datetime.now(timezone.utc).date()
        q = q.where(func.date(WalletTransaction.created_at) == today)
    elif period == "week":
        q = q.where(WalletTransaction.created_at >= datetime.now(timezone.utc) - timedelta(days=7))
    elif period == "month":
        q = q.where(WalletTransaction.created_at >= datetime.now(timezone.utc) - timedelta(days=30))

    # Summary counts (before pagination)
    count_q = select(
        func.count(WalletTransaction.id).label("total"),
        func.sum(func.abs(WalletTransaction.amount)).label("total_amount"),
        func.count(
            case((WalletTransaction.status == "pending", WalletTransaction.id))
        ).label("pending_count"),
        func.sum(
            case((WalletTransaction.status == "pending", func.abs(WalletTransaction.amount)), else_=0)
        ).label("pending_amount"),
    ).select_from(WalletTransaction).where(
        WalletTransaction.transaction_type == TransactionType.WITHDRAWAL
    )
    summary_result = await db.execute(count_q)
    summary = summary_result.one()

    total = (await db.execute(
        select(func.count(WalletTransaction.id))
        .select_from(WalletTransaction)
        .join(Trader, Trader.id == WalletTransaction.trader_id)
        .where(WalletTransaction.transaction_type == TransactionType.WITHDRAWAL)
    )).scalar_one()

    q = q.order_by(desc(WalletTransaction.created_at)).offset((page - 1) * limit).limit(limit)
    result = await db.execute(q)
    rows = result.all()

    withdrawals = []
    for tx, trader in rows:
        # Resolve destination from stored field or trader's current settlement config
        dest = tx.destination or (
            trader.settlement_phone if (tx.settlement_method or "mpesa") == "mpesa"
            else f"{trader.settlement_paybill} / {trader.settlement_account or ''}"
        )
        method_label = tx.settlement_method or (
            trader.settlement_method.value if trader.settlement_method else "mpesa"
        )
        withdrawals.append({
            "id": tx.id,
            "trader_id": trader.id,
            "trader_name": trader.full_name,
            "trader_phone": trader.phone,
            "amount": abs(tx.amount),          # net amount sent
            "status": tx.status,               # pending | completed | failed
            "settlement_method": method_label,
            "destination": dest,
            "bank_name": trader.settlement_bank_name or "",
            "description": tx.description or "",
            "processed_by": tx.processed_by or None,
            "processed_at": tx.processed_at.isoformat() if tx.processed_at else None,
            "created_at": tx.created_at.isoformat() if tx.created_at else "",
        })

    return {
        "withdrawals": withdrawals,
        "total": total,
        "page": page,
        "pages": max(1, -(-total // limit)),
        "summary": {
            "total_count": summary.total or 0,
            "total_amount": float(summary.total_amount or 0),
            "pending_count": summary.pending_count or 0,
            "pending_amount": float(summary.pending_amount or 0),
        },
    }


@router.put("/withdrawals/{tx_id}/complete")
async def mark_withdrawal_complete(
    tx_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Mark an I&M Bank withdrawal as manually disbursed/completed."""
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.id == tx_id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
        )
    )
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(status_code=404, detail="Withdrawal not found")

    tx.status = "completed"
    tx.processed_by = admin.full_name
    tx.processed_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "completed", "processed_by": admin.full_name}


@router.put("/withdrawals/{tx_id}/pending")
async def mark_withdrawal_pending(
    tx_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Revert a withdrawal to pending (e.g. if disbursement failed)."""
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.id == tx_id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
        )
    )
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(status_code=404, detail="Withdrawal not found")

    tx.status = "pending"
    tx.processed_by = None
    tx.processed_at = None
    await db.commit()
    return {"status": "pending"}
