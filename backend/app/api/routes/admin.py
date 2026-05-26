import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select, func, case, extract
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.models import Trader, TraderStatus, Order, OrderStatus, Payment, PaymentDirection, PaymentStatus, ChatMessage
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.message_template import MessageTemplate
from app.models.trade_tokens import TradeTokenPurchase
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
        select(Trader).where(Trader.is_admin == True).order_by(Trader.id.asc()).limit(1)
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
    # Use Kenya time (EAT = UTC+3) so "today" matches the admin's local date
    EAT = timezone(timedelta(hours=3))
    now_eat = datetime.now(EAT)
    today_start = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

    # Total traders
    result = await db.execute(select(func.count(Trader.id)))
    total_traders = result.scalar()

    # Active traders
    result = await db.execute(
        select(func.count(Trader.id)).where(Trader.status == TraderStatus.ACTIVE)
    )
    active_traders = result.scalar()

    # All orders created today (any status)
    result = await db.execute(
        select(func.count(Order.id)).where(
            Order.created_at >= today_start,
        )
    )
    today_orders = result.scalar()

    # Completed orders today
    result = await db.execute(
        select(func.count(Order.id)).where(
            Order.created_at >= today_start,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )
    completed_today = result.scalar() or 0

    # Today's volume — all non-cancelled orders (buy + sell across all merchants)
    result = await db.execute(
        select(func.coalesce(func.sum(Order.fiat_amount), 0)).where(
            Order.created_at >= today_start,
            Order.status != OrderStatus.CANCELLED,
        )
    )
    today_volume = float(result.scalar() or 0)

    # Today's subscription revenue
    from app.models.subscription import Subscription as _Sub, SubscriptionStatus as _SubStatus
    result = await db.execute(
        select(func.coalesce(func.sum(_Sub.amount), 0)).where(
            _Sub.started_at >= today_start,
            _Sub.status == _SubStatus.ACTIVE,
        )
    )
    today_revenue = float(result.scalar() or 0)

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
            "tier": t.tier or "standard",
            "role": t.role or "trader",
            "total_trades": t.total_trades or 0,
            "total_volume": float(t.total_volume or 0),
            "created_at": t.created_at.isoformat() if t.created_at else "",
            "last_seen_at": t.last_extension_sync.isoformat() if t.last_extension_sync else None,
            "last_web_active": t.last_login.isoformat() if t.last_login else None,
            "choice_account_id": t.choice_account_id or None,
            "choice_account_number": t.choice_account_number or None,
            "choice_kyc_status": t.choice_kyc_status or None,
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

    DEFAULT_PERMISSIONS = {"disputes": True, "orders": True, "chat": True, "transactions": False, "withdrawals": False}
    employee = Trader(
        email=email,
        phone=phone,
        full_name=full_name,
        password_hash=hash_password(password),
        role="employee",
        is_admin=False,
        status=TraderStatus.ACTIVE,
        permissions=DEFAULT_PERMISSIONS,
    )
    db.add(employee)
    await db.commit()

    return {
        "status": "created",
        "employee_id": employee.id,
        "email": email,
        "full_name": full_name,
    }


@router.get("/employees")
async def list_employees(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Trader).where(Trader.role == "employee").order_by(Trader.created_at.asc()))
    employees = result.scalars().all()
    return [
        {
            "id": e.id,
            "full_name": e.full_name,
            "email": e.email,
            "phone": e.phone,
            "status": e.status.value if e.status else "active",
            "permissions": e.permissions or {"disputes": True, "orders": True, "chat": True, "transactions": False, "withdrawals": False},
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in employees
    ]


@router.put("/employees/{employee_id}/permissions")
async def update_employee_permissions(
    employee_id: int,
    permissions: dict,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Trader).where(Trader.id == employee_id, Trader.role == "employee"))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    employee.permissions = permissions
    await db.commit()
    return {"status": "updated", "permissions": permissions}


@router.delete("/employees/{employee_id}")
async def delete_employee(
    employee_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Trader).where(Trader.id == employee_id, Trader.role == "employee"))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    await db.delete(employee)
    await db.commit()
    return {"status": "deleted"}


@router.delete("/traders/{trader_id}")
async def delete_trader(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Permanently delete a trader account.
    Blocked if the trader has any orders — historical data must be preserved.
    Only allowed for traders with zero orders (new/test accounts).
    Cannot delete your own account.
    """
    if trader_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found.")

    # Block if they have orders
    order_count_result = await db.execute(
        select(func.count(Order.id)).where(Order.trader_id == trader_id)
    )
    order_count = order_count_result.scalar() or 0
    if order_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete: this trader has {order_count} order(s) on record. "
                   "Historical trade data must be preserved. Suspend the account instead."
        )

    # Safe to delete — remove related records in FK-safe order
    from app.models.wallet import Wallet, WalletTransaction
    from app.models.subscription import Subscription
    from app.models.affiliate import Affiliate, AffiliateEarning, AffiliatePayout
    from app.models.support_ticket import SupportTicket
    from app.models.chat import ChatMessage
    from app.models.im_sweep import ImSweep
    from sqlalchemy import text

    # 1. Null out trader_id on payments (they have nullable trader_id)
    await db.execute(
        Payment.__table__.update().where(Payment.trader_id == trader_id).values(trader_id=None)
    )
    # 2. Null out trader_id on im_sweeps
    await db.execute(
        ImSweep.__table__.update().where(ImSweep.trader_id == trader_id).values(trader_id=None)
    )
    # 3. Delete wallet transactions then wallet
    await db.execute(
        WalletTransaction.__table__.delete().where(WalletTransaction.trader_id == trader_id)
    )
    await db.execute(
        Wallet.__table__.delete().where(Wallet.trader_id == trader_id)
    )
    # 4. Affiliate earnings/payouts that reference this trader as a referred trader
    await db.execute(
        AffiliateEarning.__table__.delete().where(AffiliateEarning.referred_trader_id == trader_id)
    )
    # 5. If trader is an affiliate: delete their earnings and payouts first, then the affiliate row
    aff_result = await db.execute(
        select(Affiliate.id).where(Affiliate.trader_id == trader_id)
    )
    aff_id = aff_result.scalar_one_or_none()
    if aff_id:
        await db.execute(AffiliateEarning.__table__.delete().where(AffiliateEarning.affiliate_id == aff_id))
        await db.execute(AffiliatePayout.__table__.delete().where(AffiliatePayout.affiliate_id == aff_id))
        await db.execute(Affiliate.__table__.delete().where(Affiliate.id == aff_id))
    # 6. Subscription
    await db.execute(
        Subscription.__table__.delete().where(Subscription.trader_id == trader_id)
    )
    # 7. Support tickets
    await db.execute(
        SupportTicket.__table__.delete().where(SupportTicket.trader_id == trader_id)
    )
    # 8. Chat messages (null sender, or delete — sender_id is NOT NULL so we delete)
    await db.execute(
        ChatMessage.__table__.delete().where(ChatMessage.sender_id == trader_id)
    )

    await db.delete(trader)
    await db.commit()

    logger.info(f"[Admin] Trader {trader_id} ({trader.full_name}) deleted by admin {admin.id}")
    return {"deleted": True, "trader_id": trader_id, "name": trader.full_name}


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

    # Live counts from orders table — more accurate than stale model columns
    counts_r = await db.execute(
        select(
            func.count(Order.id).label("cnt"),
            func.coalesce(func.sum(Order.fiat_amount), 0).label("vol"),
        ).where(
            Order.trader_id == trader_id,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )
    counts_row = counts_r.one()
    live_trades = int(counts_row.cnt or 0)
    live_volume = float(counts_row.vol or 0)

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
        "last_seen_at": trader.last_extension_sync.isoformat() if trader.last_extension_sync else None,
        "total_trades": max(trader.total_trades or 0, live_trades),
        "total_volume": max(float(trader.total_volume or 0), live_volume),
        "choice_account_id": trader.choice_account_id or None,
        "choice_account_number": trader.choice_account_number or None,
        "choice_kyc_status": trader.choice_kyc_status or None,
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
        return {"balance": 0, "reserved": 0, "total_volume": 0, "total_withdrawn": 0, "total_fees_paid": 0}

    from app.models.order import Order, OrderStatus
    from sqlalchemy import func
    vol_r = await db.execute(
        select(func.coalesce(func.sum(Order.fiat_amount), 0)).where(
            Order.trader_id == trader_id,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
        )
    )
    total_volume = float(vol_r.scalar() or 0)

    return {
        "balance": wallet.balance,
        "reserved": wallet.reserved,
        "total_volume": total_volume,
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
    """Get a trader's recent activity: wallet transactions + P2P orders combined."""
    from app.models.wallet import WalletTransaction
    from sqlalchemy import desc

    wallet_result = await db.execute(
        select(WalletTransaction)
        .where(WalletTransaction.trader_id == trader_id)
        .order_by(desc(WalletTransaction.created_at))
        .limit(limit)
    )
    txns = wallet_result.scalars().all()

    orders_result = await db.execute(
        select(Order)
        .where(
            Order.trader_id == trader_id,
            Order.fiat_amount > 0,
        )
        .order_by(desc(Order.created_at))
        .limit(limit)
    )
    orders = orders_result.scalars().all()

    rows = []
    for t in txns:
        rows.append({
            "id": t.id,
            "record_type": "wallet",
            "transaction_type": t.transaction_type.value if hasattr(t.transaction_type, 'value') else str(t.transaction_type),
            "direction": "inbound" if t.amount >= 0 else "outbound",
            "amount": abs(t.amount),
            "balance_after": t.balance_after,
            "description": t.description or "",
            "mpesa_transaction_id": getattr(t, 'mpesa_receipt', '') or "",
            "bill_ref_number": "",
            "status": t.status or "completed",
            "created_at": t.created_at.isoformat() if t.created_at else "",
        })
    for o in orders:
        side = o.side.value if hasattr(o.side, 'value') else str(o.side)
        status = o.status.value if hasattr(o.status, 'value') else str(o.status)
        rows.append({
            "id": o.id,
            "record_type": "order",
            "transaction_type": f"p2p_{side}",
            "direction": "inbound" if side == "sell" else "outbound",
            "amount": o.fiat_amount,
            "balance_after": None,
            "description": f"P2P {side.upper()} — {o.counterparty_name or 'Unknown'} — {o.binance_order_number or ''}",
            "mpesa_transaction_id": "",
            "bill_ref_number": o.binance_order_number or "",
            "status": status,
            "created_at": o.created_at.isoformat() if o.created_at else "",
        })

    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return rows[:limit]


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


@router.put("/traders/{trader_id}/im-account")
async def update_trader_im_account(
    trader_id: int,
    account: str,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Set a trader's I&M Bank debit account number used by the bot to make payments."""
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    trader.settlement_account = account.strip() or None
    await db.commit()
    return {"status": "updated", "trader_id": trader_id, "im_account": trader.settlement_account}


class AdminAddTokensRequest(BaseModel):
    tokens: int
    note: Optional[str] = None


@router.post("/traders/{trader_id}/trade-tokens")
async def admin_add_trade_tokens(
    trader_id: int,
    data: AdminAddTokensRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Manually add permanent trade tokens to a trader's account."""
    if data.tokens <= 0:
        raise HTTPException(status_code=400, detail="tokens must be > 0")
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.trade_tokens = (trader.trade_tokens or 0) + data.tokens

    purchase = TradeTokenPurchase(
        trader_id=trader_id,
        amount_kes=0,
        tokens_granted=data.tokens,
        rate_per_token=0,
        source="admin",
    )
    db.add(purchase)
    await db.commit()

    # Notify the trader (in-app + SMS)
    from app.api.routes.traders import add_notification
    from app.services.sms import send_sms
    note_text = f" — {data.note}" if data.note else ""
    msg = f"SparkP2P: {data.tokens} trade token{'s' if data.tokens != 1 else ''} added to your account{note_text}. New balance: {trader.trade_tokens}."
    add_notification(trader_id, "Trade tokens added", msg, "info")
    try:
        send_sms(trader.phone, msg)
    except Exception as e:
        logger.warning(f"Token grant SMS failed for trader {trader_id}: {e}")

    return {
        "ok": True,
        "tokens_added": data.tokens,
        "new_balance": trader.trade_tokens,
        "note": data.note,
    }


class AdminRemoveTokensRequest(BaseModel):
    tokens: int
    note: Optional[str] = None


@router.delete("/traders/{trader_id}/trade-tokens")
async def admin_remove_trade_tokens(
    trader_id: int,
    data: AdminRemoveTokensRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Subtract trade tokens from a trader's account (permanent first, then expiring)."""
    if data.tokens <= 0:
        raise HTTPException(status_code=400, detail="tokens must be > 0")
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    total = (trader.trade_tokens or 0) + (trader.trade_tokens_expiring or 0)
    to_remove = min(data.tokens, total)

    # Deduct from permanent first, then expiring
    perm = trader.trade_tokens or 0
    if to_remove <= perm:
        trader.trade_tokens = perm - to_remove
    else:
        trader.trade_tokens = 0
        trader.trade_tokens_expiring = max(0, (trader.trade_tokens_expiring or 0) - (to_remove - perm))

    await db.commit()

    # Notify the trader (in-app + SMS)
    from app.api.routes.traders import add_notification
    from app.services.sms import send_sms
    note_text = f" — {data.note}" if data.note else ""
    new_total = (trader.trade_tokens or 0) + (trader.trade_tokens_expiring or 0)
    msg = f"SparkP2P: {to_remove} trade token{'s' if to_remove != 1 else ''} removed from your account{note_text}. Remaining balance: {new_total}."
    add_notification(trader_id, "Trade tokens removed", msg, "warning")
    try:
        send_sms(trader.phone, msg)
    except Exception as e:
        logger.warning(f"Token removal SMS failed for trader {trader_id}: {e}")

    return {
        "ok": True,
        "tokens_removed": to_remove,
        "new_balance": new_total,
        "note": data.note,
    }


@router.get("/traders/{trader_id}/trade-tokens")
async def admin_get_trade_tokens(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get a trader's token balance and full purchase/grant history."""
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    hist_result = await db.execute(
        select(TradeTokenPurchase)
        .where(TradeTokenPurchase.trader_id == trader_id)
        .order_by(TradeTokenPurchase.created_at.desc())
        .limit(100)
    )
    history = hist_result.scalars().all()

    return {
        "trade_tokens": trader.trade_tokens or 0,
        "trade_tokens_expiring": trader.trade_tokens_expiring or 0,
        "total": (trader.trade_tokens or 0) + (trader.trade_tokens_expiring or 0),
        "history": [
            {
                "id": p.id,
                "amount_kes": p.amount_kes,
                "tokens_granted": p.tokens_granted,
                "rate_per_token": p.rate_per_token,
                "source": p.source,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in history
        ],
    }


@router.get("/orders/disputed")
async def list_disputed_orders(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all disputed orders that need manual review."""
    result = await db.execute(
        select(Order, Trader.full_name.label("trader_name"))
        .join(Trader, Trader.id == Order.trader_id, isouter=True)
        .where(Order.status == OrderStatus.DISPUTED)
        .order_by(Order.created_at.desc())
    )
    rows = result.all()

    return [
        {
            "id": o.id,
            "trader_id": o.trader_id,
            "trader_name": trader_name or f"Trader #{o.trader_id}",
            "binance_order_number": o.binance_order_number,
            "side": o.side.value,
            "fiat_amount": o.fiat_amount,
            "crypto_amount": o.crypto_amount,
            "status": o.status.value,
            "risk_score": o.risk_score,
            "created_at": o.created_at.isoformat() if o.created_at else "",
        }
        for o, trader_name in rows
    ]


@router.get("/payments/unmatched")
async def list_unmatched_payments(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Unmatched deposits (inbound with no order) and unmatched withdrawals
    (outbound with no order, no destination, or failed status)."""

    # ── Unmatched Deposits: inbound C2B payments with no linked order
    #    These are payments to our paybill where the account reference didn't
    #    match any registered trader or active order.
    dep_result = await db.execute(
        select(Payment)
        .where(
            Payment.order_id.is_(None),
            Payment.direction == PaymentDirection.INBOUND,
            ~Payment.bill_ref_number.like("DEP-%"),
        )
        .order_by(Payment.created_at.desc())
    )
    deposits = dep_result.scalars().all()

    # ── Unmatched Withdrawals: outbound disbursements that have no destination
    #    and no linked order — i.e. truly unrouted payments.
    #    Reversed/failed withdrawals are NOT unmatched — they have a known
    #    destination and order, they just failed to process.
    wd_result = await db.execute(
        select(Payment)
        .where(
            Payment.direction == PaymentDirection.OUTBOUND,
            Payment.destination.is_(None),
            Payment.order_id.is_(None),
        )
        .order_by(Payment.created_at.desc())
        .limit(100)
    )
    withdrawals = wd_result.scalars().all()

    def fmt(p, kind):
        return {
            "id": p.id,
            "kind": kind,
            "amount": p.amount,
            "phone": p.phone,
            "sender_name": p.sender_name,
            "bill_ref_number": p.bill_ref_number,
            "mpesa_transaction_id": p.mpesa_receipt_number or p.mpesa_transaction_id,
            "destination": p.destination,
            "destination_type": p.destination_type,
            "transaction_type": p.transaction_type,
            "status": p.status.value if p.status else None,
            "remarks": p.remarks,
            "created_at": p.created_at.isoformat() if p.created_at else "",
        }

    return {
        "deposits": [fmt(p, "deposit") for p in deposits],
        "withdrawals": [fmt(p, "withdrawal") for p in withdrawals],
    }


def _get_period_start(period: str):
    """Return the start datetime for a given period filter (Kenya timezone for 'today')."""
    now = datetime.now(timezone.utc)
    if period == "today":
        EAT = timezone(timedelta(hours=3))
        now_eat = now.astimezone(EAT)
        return now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
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
    category: str = None,   # "choice" → filter CHOICE_INBOUND/OUTBOUND only
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List payments with date filters and optional category filter.
    category=choice returns only Choice Bank inbound/outbound transactions.
    Search by: TX ID, phone number, trader name, or sender name.
    """
    start = _get_period_start(period)

    query = (
        select(Payment, Trader.full_name.label("trader_name"), Trader.phone.label("trader_phone"))
        .join(Trader, Payment.trader_id == Trader.id, isouter=True)
    )
    if start:
        query = query.where(Payment.created_at >= start)

    # Category filter
    if category == "choice":
        query = query.where(Payment.transaction_type.in_(["CHOICE_INBOUND", "CHOICE_OUTBOUND", "CHOICE_DEPOSIT"]))

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
    if category == "choice":
        count_query = count_query.where(Payment.transaction_type.in_(["CHOICE_INBOUND", "CHOICE_OUTBOUND", "CHOICE_DEPOSIT"]))
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
    EAT = timezone(timedelta(hours=3))  # Africa/Nairobi = UTC+3
    now = datetime.now(timezone.utc)
    now_eat = now.astimezone(EAT)
    today_start = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)
    year_start = now - timedelta(days=365)

    async def _revenue_for_period(start):
        """Sum subscription payments received in the period (primary income source)."""
        from app.models.subscription import Subscription as _Sub2, SubscriptionStatus as _SubSt
        where = [_Sub2.status == _SubSt.ACTIVE]
        if start is not None:
            where.append(_Sub2.started_at >= start)
        q = select(func.coalesce(func.sum(_Sub2.amount), 0)).where(*where)
        return float((await db.execute(q)).scalar() or 0)

    today_revenue = await _revenue_for_period(today_start)
    week_revenue = await _revenue_for_period(week_start)
    month_revenue = await _revenue_for_period(month_start)
    year_revenue = await _revenue_for_period(year_start)

    # Total platform profit (all time) = withdrawal fees only
    platform_profit = await _revenue_for_period(None)

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

    # Top 5 traders by volume — computed from actual completed orders
    from sqlalchemy import and_ as sql_and
    top_q = (
        select(
            Trader.full_name,
            func.count(Order.id).label("trades"),
            func.coalesce(func.sum(Order.fiat_amount), 0).label("volume"),
        )
        .join(Order, sql_and(Order.trader_id == Trader.id, Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED])), isouter=True)
        .group_by(Trader.id, Trader.full_name)
        .order_by(func.coalesce(func.sum(Order.fiat_amount), 0).desc())
        .limit(5)
    )
    r = await db.execute(top_q)
    top_traders = [
        {
            "name": row.full_name,
            "trades": int(row.trades),
            "volume": float(row.volume),
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

    # Expenses totals
    from app.models.expense import Expense as _Exp
    _exp_total = float((await db.execute(
        select(func.coalesce(func.sum(_Exp.amount), 0))
    )).scalar() or 0)
    _exp_month = float((await db.execute(
        select(func.coalesce(func.sum(_Exp.amount), 0)).where(
            _Exp.expense_date >= month_start.date()
        )
    )).scalar() or 0)

    return {
        "platform_profit": round(platform_profit - _exp_total, 2),
        "sub_revenue_total": platform_profit,
        "expenses": {"total": _exp_total, "month": _exp_month},
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
        EAT = timezone(timedelta(hours=3))
        now_eat = datetime.now(timezone.utc).astimezone(EAT)
        today_start = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
        q = q.where(WalletTransaction.created_at >= today_start)
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


@router.delete("/withdrawals/{tx_id}")
async def delete_withdrawal(
    tx_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a withdrawal record (for removing duplicates/stuck pending).
    Also cancels the paired PLATFORM_FEE so it is excluded from revenue calculations."""
    result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.id == tx_id,
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
        )
    )
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(status_code=404, detail="Withdrawal not found")

    # Cancel the paired PLATFORM_FEE (same trader, same second) so it no longer counts as revenue
    fee_result = await db.execute(
        select(WalletTransaction).where(
            WalletTransaction.trader_id == tx.trader_id,
            WalletTransaction.transaction_type == TransactionType.PLATFORM_FEE,
            func.date_trunc("second", WalletTransaction.created_at) == func.date_trunc("second", tx.created_at),
            WalletTransaction.status != "cancelled",
        )
    )
    paired_fee = fee_result.scalar_one_or_none()
    if paired_fee:
        paired_fee.status = "cancelled"
        paired_fee.description = (paired_fee.description or "") + " [CANCELLED - withdrawal deleted]"

    await db.delete(tx)
    await db.commit()
    return {"deleted": tx_id}


# ── Revenue Breakdown ──────────────────────────────────────────────────────────

@router.get("/revenue/breakdown")
async def revenue_breakdown(
    period: str = Query("all"),   # today | week | month | all
    method: str = Query("all"),   # mpesa | bank | all
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Per-transaction fee breakdown with M-Pesa vs I&M Bank split."""
    from sqlalchemy import case as sa_case, text as sa_text

    now = datetime.now(timezone.utc)
    EAT = timezone(timedelta(hours=3))
    now_eat = now.astimezone(EAT)
    today_start_utc = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    period_starts = {
        "today": today_start_utc,
        "week":  now - timedelta(days=7),
        "month": now - timedelta(days=30),
    }
    start = period_starts.get(period)

    # Base filter: only completed fee charges (not cancelled/pending)
    base_where = [
        WalletTransaction.transaction_type == TransactionType.PLATFORM_FEE,
        WalletTransaction.amount < 0,
        WalletTransaction.status == "completed",
    ]
    if start:
        base_where.append(WalletTransaction.created_at >= start)

    # Alias for the paired WITHDRAWAL transaction (same trader, same second)
    W = aliased(WalletTransaction)

    # Join PLATFORM_FEE to its paired WITHDRAWAL via trader_id + timestamp match
    q = (
        select(
            WalletTransaction.id,
            WalletTransaction.created_at,
            WalletTransaction.amount.label("fee"),
            WalletTransaction.description,
            Trader.full_name.label("trader_name"),
            Trader.phone.label("trader_phone"),
            W.amount.label("withdrawal_amount"),
            W.settlement_method.label("method"),
            W.destination.label("destination"),
        )
        .join(Trader, Trader.id == WalletTransaction.trader_id)
        .join(
            W,
            (W.trader_id == WalletTransaction.trader_id)
            & (W.transaction_type == TransactionType.WITHDRAWAL)
            & (func.date_trunc("second", W.created_at) == func.date_trunc("second", WalletTransaction.created_at)),
        )
        .where(*base_where)
    )

    if method != "all":
        if method == "mpesa":
            q = q.where(W.settlement_method == "mpesa")
        else:
            q = q.where(W.settlement_method.in_(["bank", "bank_paybill"]))

    # Totals query (same filters, no pagination)
    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    # Summary by method
    summary_q = (
        select(
            W.settlement_method,
            func.count(WalletTransaction.id).label("count"),
            func.sum(-WalletTransaction.amount).label("total_fee"),
        )
        .join(Trader, Trader.id == WalletTransaction.trader_id)
        .join(
            W,
            (W.trader_id == WalletTransaction.trader_id)
            & (W.transaction_type == TransactionType.WITHDRAWAL)
            & (func.date_trunc("second", W.created_at) == func.date_trunc("second", WalletTransaction.created_at)),
        )
        .where(*base_where)
        .group_by(W.settlement_method)
    )
    summary_rows = (await db.execute(summary_q)).all()

    mpesa_total = 0.0
    bank_total = 0.0
    for row in summary_rows:
        m = (row.settlement_method or "").lower()
        val = float(row.total_fee or 0)
        if m == "mpesa":
            mpesa_total = val
        elif m in ("bank", "bank_paybill"):
            bank_total = val

    # Paginate
    q = q.order_by(WalletTransaction.created_at.desc()).offset((page - 1) * limit).limit(limit)
    rows = (await db.execute(q)).all()

    transactions = []
    for row in rows:
        m = (row.method or "").lower()
        method_label = "M-Pesa" if m == "mpesa" else "I&M Bank" if m in ("bank", "bank_paybill") else "Unknown"
        transactions.append({
            "id": row.id,
            "date": row.created_at.isoformat() if row.created_at else "",
            "trader_name": row.trader_name or "—",
            "trader_phone": row.trader_phone or "",
            "method": method_label,
            "withdrawal_amount": abs(float(row.withdrawal_amount or 0)),
            "fee": abs(float(row.fee or 0)),
            "description": row.description or "",
            "destination": row.destination or "",
        })

    return {
        "transactions": transactions,
        "total": total,
        "page": page,
        "pages": max(1, -(-total // limit)),
        "summary": {
            "total": round(mpesa_total + bank_total, 2),
            "mpesa": round(mpesa_total, 2),
            "bank": round(bank_total, 2),
        },
    }



# ── Subscription Revenue ───────────────────────────────────────────────────────

@router.get("/revenue/subscriptions")
async def revenue_subscriptions(
    period: str = Query("all"),   # today | week | month | all
    plan: str = Query("all"),     # starter | pro | all
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Subscription payment revenue — primary income source."""
    from app.models.subscription import Subscription, SubscriptionPlan, SubscriptionStatus

    now = datetime.now(timezone.utc)
    EAT = timezone(timedelta(hours=3))
    now_eat = now.astimezone(EAT)
    today_start_utc = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    period_starts = {
        "today": today_start_utc,
        "week":  now - timedelta(days=7),
        "month": now - timedelta(days=30),
    }
    start = period_starts.get(period)

    # Only count paid (active) subscriptions
    base_where = [Subscription.status == SubscriptionStatus.ACTIVE]
    if start:
        base_where.append(Subscription.started_at >= start)
    if plan != "all":
        try:
            base_where.append(Subscription.plan == SubscriptionPlan(plan))
        except ValueError:
            pass

    # Summary by plan
    summary_q = (
        select(
            Subscription.plan,
            func.count(Subscription.id).label("count"),
            func.sum(Subscription.amount).label("total"),
        )
        .where(*base_where)
        .group_by(Subscription.plan)
    )
    summary_rows = (await db.execute(summary_q)).all()
    summary = {"total": 0.0, "starter": 0.0, "pro": 0.0, "starter_count": 0, "pro_count": 0}
    for row in summary_rows:
        pv = row.plan.value if hasattr(row.plan, "value") else str(row.plan)
        summary[pv] = round(float(row.total or 0), 2)
        summary[f"{pv}_count"] = int(row.count or 0)
        summary["total"] = round(summary["total"] + float(row.total or 0), 2)

    # Total count for pagination
    total_count = (
        await db.execute(
            select(func.count()).select_from(Subscription).where(*base_where)
        )
    ).scalar_one()

    # Paginated transactions
    txns_q = (
        select(
            Subscription.id,
            Subscription.plan,
            Subscription.amount,
            Subscription.mpesa_transaction_id,
            Subscription.started_at,
            Subscription.expires_at,
            Trader.full_name.label("trader_name"),
            Trader.phone.label("trader_phone"),
        )
        .join(Trader, Trader.id == Subscription.trader_id)
        .where(*base_where)
        .order_by(Subscription.started_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    txns = (await db.execute(txns_q)).all()

    return {
        "summary": summary,
        "total": total_count,
        "pages": max(1, -(-total_count // limit)),
        "page": page,
        "transactions": [
            {
                "id": t.id,
                "plan": t.plan.value if hasattr(t.plan, "value") else str(t.plan),
                "amount": float(t.amount),
                "mpesa_transaction_id": t.mpesa_transaction_id,
                "started_at": t.started_at.isoformat() if t.started_at else None,
                "expires_at": t.expires_at.isoformat() if t.expires_at else None,
                "trader_name": t.trader_name,
                "trader_phone": t.trader_phone,
            }
            for t in txns
        ],
    }


# ── Auto-Sweep History ─────────────────────────────────────────────────────────

@router.get("/sweeps")
async def get_sweeps(
    limit: int = Query(default=50, le=200),
    status: str = Query(default=None),  # pending | completed | failed
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Return the auto-sweep history (M-Pesa paybill → I&M Bank)."""
    from app.models.im_sweep import ImSweep

    q = select(ImSweep).order_by(ImSweep.created_at.desc()).limit(limit)
    if status:
        q = q.where(ImSweep.status == status)

    result = await db.execute(q)
    sweeps = result.scalars().all()

    return [
        {
            "id": s.id,
            "trader_id": s.trader_id,
            "amount": s.amount,
            "status": s.status,
            "sweep_paybill": s.sweep_paybill,
            "sweep_account": s.sweep_account,
            "mpesa_conversation_id": s.mpesa_conversation_id,
            "failure_reason": s.failure_reason,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "completed_at": s.completed_at.isoformat() if s.completed_at else None,
        }
        for s in sweeps
    ]


@router.post("/sweeps/{sweep_id}/retry")
async def retry_sweep(
    sweep_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Manually retry a failed sweep."""
    from app.models.im_sweep import ImSweep
    from app.services.sweep_service import trigger_im_sweep

    q = await db.execute(select(ImSweep).where(ImSweep.id == sweep_id))
    sweep = q.scalar_one_or_none()
    if not sweep:
        raise HTTPException(status_code=404, detail="Sweep not found")
    if sweep.status == "completed":
        raise HTTPException(status_code=400, detail="Sweep already completed")

    result = await trigger_im_sweep(
        amount=sweep.amount,
        trader_id=sweep.trader_id,
        withdrawal_tx_id=sweep.withdrawal_tx_id,
        reference=f"RETRY-{sweep_id}",
        db=db,
    )
    return result


# ═══════════════════════════════════════════════════════════
# PAYBILL TRANSACTIONS — Merged: webhook payments + portal scrape
# ═══════════════════════════════════════════════════════════

def _apply_period(q, model_col, period, now):
    EAT = timezone(timedelta(hours=3))
    if period == "today":
        now_eat = now.astimezone(EAT)
        today_start = now_eat.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
        return q.where(model_col >= today_start)
    elif period == "week":
        return q.where(model_col >= now - timedelta(days=7))
    elif period == "month":
        return q.where(model_col >= now - timedelta(days=30))
    elif period == "year":
        return q.where(model_col >= now - timedelta(days=365))
    return q


@router.get("/traders/{trader_id}/bot-logs")
async def get_trader_bot_logs(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
):
    """Return the most recent bot activity logs for a trader (newest first)."""
    from app.api.routes.extension import _trader_bot_logs
    logs = list(_trader_bot_logs.get(trader_id, []))
    return list(reversed(logs))


@router.get("/traders/{trader_id}/pnl")
async def get_trader_pnl(
    trader_id: int,
    period: str = Query("today"),   # today | week | month
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """P&L breakdown for a trader: daily revenue, fees, and net profit."""
    now = datetime.now(timezone.utc)
    EAT = timezone(timedelta(hours=3))
    now_eat = now.astimezone(EAT)

    if period == "today":
        since_eat = now_eat.replace(hour=0, minute=0, second=0, microsecond=0)
        days = 1
    elif period == "week":
        since_eat = (now_eat - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        days = 7
    elif period == "month":
        since_eat = (now_eat - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
        days = 30
    else:
        since_eat = now_eat.replace(hour=0, minute=0, second=0, microsecond=0)
        days = 1

    since = since_eat.astimezone(timezone.utc)

    # Fetch all wallet transactions for trader in period (for revenue and fees)
    result = await db.execute(
        select(WalletTransaction)
        .where(
            WalletTransaction.trader_id == trader_id,
            WalletTransaction.created_at >= since,
            WalletTransaction.status == "completed",
        )
        .order_by(WalletTransaction.created_at)
    )
    txns = result.scalars().all()

    # Fetch completed sell orders in period — used for trade counts so they are
    # always accurate even when wallet SELL_CREDIT transactions are missing.
    orders_result = await db.execute(
        select(Order).where(
            Order.trader_id == trader_id,
            Order.status == OrderStatus.RELEASED,
            Order.created_at >= since,
        )
    )
    sell_orders = orders_result.scalars().all()

    from collections import defaultdict

    # Per-day sell order counts keyed by Kenya date
    order_buckets: dict = defaultdict(int)
    for o in sell_orders:
        day_key = o.created_at.astimezone(EAT).strftime("%Y-%m-%d")
        order_buckets[day_key] += 1

    # Build per-day revenue/fee buckets (keyed by Kenya date)
    buckets: dict = defaultdict(lambda: {"revenue": 0.0, "fees": 0.0})

    REVENUE_TYPES = {TransactionType.SELL_CREDIT}
    FEE_TYPES = {TransactionType.PLATFORM_FEE, TransactionType.SETTLEMENT_FEE, TransactionType.DAILY_VOLUME_FEE}

    for t in txns:
        day_key = t.created_at.astimezone(EAT).strftime("%Y-%m-%d")
        if t.transaction_type in REVENUE_TYPES:
            buckets[day_key]["revenue"] += t.amount
        elif t.transaction_type in FEE_TYPES and not (t.description or "").startswith("[CANCELLED"):
            buckets[day_key]["fees"] += abs(t.amount)

    # Generate ordered day list (Kenya dates)
    daily = []
    for i in range(days):
        d = (since_eat + timedelta(days=i)).strftime("%Y-%m-%d")
        b = buckets.get(d, {"revenue": 0.0, "fees": 0.0})
        net = round(b["revenue"] - b["fees"], 2)
        daily.append({
            "date": d,
            "revenue": round(b["revenue"], 2),
            "fees": round(b["fees"], 2),
            "net": net,
            "trades": order_buckets.get(d, 0),
        })

    total_revenue = round(sum(d["revenue"] for d in daily), 2)
    total_fees = round(sum(d["fees"] for d in daily), 2)
    total_net = round(total_revenue - total_fees, 2)
    total_trades = sum(d["trades"] for d in daily)

    return {
        "period": period,
        "daily": daily,
        "summary": {
            "revenue": total_revenue,
            "fees": total_fees,
            "net": total_net,
            "trades": total_trades,
        },
    }


@router.get("/paybill-transactions")
async def get_paybill_transactions(
    period: str = Query("today"),   # today | week | month | year | all
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=100),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """All paybill movements: webhook C2B/B2C payments + portal-scraped statement rows."""
    from sqlalchemy import desc
    from app.models.paybill_statement import PaybillStatement

    now = datetime.now(timezone.utc)

    # ── Source 1: payments table (webhook / bot-initiated) ──
    pq = _apply_period(
        select(Payment, Trader).outerjoin(Trader, Trader.id == Payment.trader_id),
        Payment.created_at, period, now
    )
    payment_rows = (await db.execute(pq)).all()

    webhook_refs = set()
    rows_combined = []
    for payment, trader in payment_rows:
        ref = payment.mpesa_receipt_number or payment.mpesa_transaction_id or ''
        webhook_refs.add(ref)
        ts = payment.created_at
        rows_combined.append({
            "id": f"p-{payment.id}",
            "source": "system",
            "direction": payment.direction.value if payment.direction else "inbound",
            "transaction_type": payment.transaction_type,
            "amount": payment.amount,
            "mpesa_receipt": ref or None,
            "phone": payment.phone,
            "sender_name": payment.sender_name,
            "destination": payment.destination,
            "remarks": payment.remarks,
            "status": payment.status.value if payment.status else None,
            "bill_ref": payment.bill_ref_number,
            "trader_name": trader.full_name if trader else None,
            "balance_after": None,
            "created_at": ts.isoformat() if ts else None,
            "_sort_ts": ts,
        })

    # ── Source 2: paybill_statement (portal scrape) ──
    sq = _apply_period(
        select(PaybillStatement),
        PaybillStatement.transaction_at, period, now
    )
    stmt_rows = (await db.execute(sq)).scalars().all()

    for s in stmt_rows:
        # Skip if already captured by webhook (same ref)
        if s.mpesa_ref and s.mpesa_ref in webhook_refs:
            continue
        ts = s.transaction_at or s.synced_at
        rows_combined.append({
            "id": f"s-{s.id}",
            "source": "portal",
            "direction": s.direction,
            "transaction_type": s.transaction_type,
            "amount": s.amount,
            "mpesa_receipt": s.mpesa_ref,
            "phone": s.phone,
            "sender_name": s.counterparty_name,
            "destination": s.phone if s.direction == "outbound" else None,
            "remarks": s.remarks,
            "status": "completed",
            "bill_ref": None,
            "trader_name": None,
            "balance_after": s.balance_after,
            "created_at": ts.isoformat() if ts else None,
            "_sort_ts": ts,
        })

    # ── Sort all combined by timestamp desc ──
    rows_combined.sort(key=lambda r: (r["_sort_ts"] or datetime.min.replace(tzinfo=timezone.utc)), reverse=True)

    # ── Summary ──
    total_in = sum(r["amount"] for r in rows_combined if r["direction"] == "inbound")
    total_out = sum(r["amount"] for r in rows_combined if r["direction"] == "outbound")
    count_in = sum(1 for r in rows_combined if r["direction"] == "inbound")
    count_out = sum(1 for r in rows_combined if r["direction"] == "outbound")
    total = len(rows_combined)

    # ── Paginate ──
    start = (page - 1) * limit
    page_rows = rows_combined[start:start + limit]
    for r in page_rows:
        r.pop("_sort_ts", None)

    return {
        "transactions": page_rows,
        "total": total,
        "pages": max(1, (total + limit - 1) // limit),
        "page": page,
        "summary": {
            "total": total,
            "total_in": round(total_in, 2),
            "total_out": round(total_out, 2),
            "count_in": count_in,
            "count_out": count_out,
        },
    }


# ── Bot → Admin alert ─────────────────────────────────────────────────────────

class BotAlertRequest(BaseModel):
    message: str


@router.post("/alert")
async def bot_alert(
    data: BotAlertRequest,
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Desktop bot calls this to send an urgent SMS alert to the admin trader.
    Used for I&M portal issues (session expired, portal down, wrong page).
    """
    result = await db.execute(
        select(Trader).where(Trader.is_admin == True).order_by(Trader.id.asc()).limit(1)
    )
    admin_trader = result.scalar_one_or_none()
    if not admin_trader:
        return {"status": "no admin found"}

    sms = f"SparkP2P BOT ALERT: {data.message[:140]}"
    try:
        from app.services.sms import send_otp_sms
        send_otp_sms(admin_trader.phone, sms)
        logger.warning(f"[BotAlert] SMS sent to {admin_trader.phone}: {data.message[:80]}")
    except Exception as e:
        logger.error(f"[BotAlert] SMS failed: {e}")

    return {"status": "ok"}


# ── Dev/Debug: Raw Binance order detail inspector ─────────────────

class OrderInspectRequest(BaseModel):
    order_number: str
    trader_id: Optional[int] = None  # defaults to first active trader with Binance session


@router.post("/inspect-order-detail")
async def inspect_order_detail(
    data: OrderInspectRequest,
    db: AsyncSession = Depends(get_db),
    _: Trader = Depends(get_admin_trader),
):
    """
    Fetch raw Binance order detail for any order number using a trader's live session.
    Used to discover what counterparty fields Binance returns (completion rate, trade count, etc.)
    """
    from app.services.binance.client import BinanceP2PClient
    from app.core.security import decrypt_data

    # Pick trader with active Binance session
    if data.trader_id:
        result = await db.execute(select(Trader).where(Trader.id == data.trader_id))
    else:
        result = await db.execute(
            select(Trader).where(Trader.binance_cookies.isnot(None)).limit(1)
        )
    trader = result.scalar_one_or_none()
    if not trader or not trader.binance_cookies:
        raise HTTPException(status_code=404, detail="No trader with active Binance session found")

    try:
        cookies = json.loads(decrypt_data(trader.binance_cookies))
        csrf = trader.binance_csrf_token or ""
        uuid = trader.binance_bnc_uuid or ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to decrypt session: {e}")

    client = BinanceP2PClient(cookies=cookies, csrf_token=csrf, bnc_uuid=uuid)

    try:
        raw = await client.get_order_detail(data.order_number)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Binance API error: {e}")

    return {"order_number": data.order_number, "trader_id": trader.id, "raw": raw}

# ── KYC Admin Routes — append to admin.py ─────────────────────────────────────

@router.get("/kyc/traders")
async def admin_list_kyc_traders(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all traders and their Choice Bank KYC status from DB."""
    result = await db.execute(select(Trader).order_by(Trader.id))
    traders = result.scalars().all()

    data = []
    for t in traders:
        onboarding_id = None
        ks = t.choice_kyc_status or ""
        if ks.startswith("pending:"):
            onboarding_id = ks[len("pending:"):]
        elif ks.startswith("onboarding:"):
            onboarding_id = ks[len("onboarding:"):]

        data.append({
            "id": t.id,
            "full_name": t.full_name,
            "email": t.email,
            "phone": t.phone,
            "choice_kyc_status": ks,
            "choice_account_id": t.choice_account_id,
            "choice_account_number": t.choice_account_number,
            "onboarding_id": onboarding_id,
        })

    return {"traders": data}


@router.get("/kyc/status/{trader_id}")
async def admin_get_kyc_live_status(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Query live KYC status from Choice Bank API for a specific trader."""
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    ks = trader.choice_kyc_status or ""
    onboarding_id = None
    if ks.startswith("pending:"):
        onboarding_id = ks[len("pending:"):]
    elif ks.startswith("onboarding:"):
        onboarding_id = ks[len("onboarding:"):]

    if not onboarding_id:
        raise HTTPException(status_code=404, detail="No pending onboarding ID for this trader")

    from app.services.choice_bank import client as choice

    kyc_result = await choice.get_user_kyc(onboarding_id)
    status_result = await choice.get_onboarding_status(onboarding_id)

    kyc_data = kyc_result.get("data") or {}
    status_data = status_result.get("data") or {}

    STATUS_LABELS = {
        1: "Submitted", 2: "Processing", 3: "Passed",
        4: "Rejected", 5: "Account Closed", 9: "Manual Review",
    }
    PROFILE_LABELS = {
        0: "Not Checked", 1: "Submitted", 2: "Validated",
        3: "Declined", 4: "Processing",
    }

    status_int = kyc_data.get("status")
    profile_int = kyc_data.get("profileCheck")

    try:
        status_int = int(status_int) if status_int is not None else None
        profile_int = int(profile_int) if profile_int is not None else None
    except (ValueError, TypeError):
        pass

    return {
        "trader_id": trader_id,
        "trader_name": trader.full_name,
        "onboarding_id": onboarding_id,
        "kyc": {
            "status": status_int,
            "status_label": STATUS_LABELS.get(status_int, f"Unknown ({status_int})"),
            "profile_check": profile_int,
            "profile_check_label": PROFILE_LABELS.get(profile_int, f"Unknown ({profile_int})"),
            "profile_check_result_text": kyc_data.get("profileCheckResultText"),
            "profile_check_result_code": kyc_data.get("profileCheckResultCode"),
            "full_name": kyc_data.get("fullName"),
            "id_number": kyc_data.get("idNumber"),
            "kra_pin": kyc_data.get("kraPin"),
            "mobile": kyc_data.get("mobile"),
            "email": kyc_data.get("email"),
            "employment_status": kyc_data.get("employmentStatus"),
            "create_time": kyc_data.get("createTime"),
            "update_time": kyc_data.get("updateTime"),
        },
        "onboarding": {
            "onboarding_status": status_data.get("onboardingStatus"),
            "account_id": status_data.get("accountId"),
            "account_type": status_data.get("accountType"),
            "rejection_reason_ids": status_data.get("rejectionReasonIds"),
            "rejection_reason_msgs": status_data.get("rejectionReasonMsgs") or [],
        },
    }

@router.get("/traders/{trader_id}/choice-balance")
async def admin_get_trader_choice_balance(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Return live Choice Bank balance for a trader (admin only)."""
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if not trader.choice_account_id:
        raise HTTPException(status_code=404, detail="Trader has no Choice Bank account")

    from app.services.choice_bank import client as choice

    result = await choice.get_account_details(trader.choice_account_id)
    data = result.get("data") or {}

    ACCOUNT_STATUS = {0: "Normal", 1: "Locked", 2: "Closed"}
    DORMANT_STATUS = {0: "Normal", 1: "Dormant"}
    FREEZE_STATUS = {0: "Normal", 1: "Frozen"}

    return {
        "trader_id": trader_id,
        "trader_name": trader.full_name,
        "account_id": trader.choice_account_id,
        "balance": data.get("balance"),
        "currency": data.get("currency", "KES"),
        "account_name": data.get("accountName"),
        "account_status": ACCOUNT_STATUS.get(data.get("accountStatus"), str(data.get("accountStatus"))),
        "dormant_status": DORMANT_STATUS.get(data.get("dormantStatus"), str(data.get("dormantStatus"))),
        "freeze_status": FREEZE_STATUS.get(data.get("freezeStatus"), str(data.get("freezeStatus"))),
        "short_code": data.get("shortCode"),
    }


# ── Choice Bank Platform Float ─────────────────────────────────────────────────
import asyncio as _asyncio
import time as _time
_choice_float_cache: dict = {}


@router.get("/choice/platform-float")
async def admin_choice_platform_float(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Aggregate live Choice Bank sub-account balances for all approved merchants."""
    from app.services.choice_bank import client as _cb

    now = _time.time()
    if _choice_float_cache.get("at") and (now - _choice_float_cache["at"]) < 300:
        return {
            "total": _choice_float_cache["value"],
            "trader_count": _choice_float_cache.get("trader_count", 0),
            "cached": True,
        }

    result = await db.execute(
        select(Trader.id, Trader.choice_account_id).where(
            Trader.choice_account_id.isnot(None)
        )
    )
    traders_with_cb = result.all()

    async def _fetch_one(account_id: str) -> float:
        try:
            r = await _cb.get_account_details(account_id)
            data = r.get("data") or {}
            return float(data.get("balance") or 0)
        except Exception:
            return 0.0

    balances = await _asyncio.gather(*[_fetch_one(t.choice_account_id) for t in traders_with_cb])
    total = round(sum(balances), 2)

    _choice_float_cache["value"] = total
    _choice_float_cache["at"] = now
    _choice_float_cache["trader_count"] = len(traders_with_cb)

    return {"total": total, "trader_count": len(traders_with_cb), "cached": False}


# ── Expenses CRUD ──────────────────────────────────────────────────────────────
class ExpenseCreate(BaseModel):
    description: str
    amount: float
    category: str = "general"
    expense_date: str  # ISO date e.g. "2026-05-26"


@router.get("/expenses")
async def list_expenses(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    from app.models.expense import Expense
    result = await db.execute(
        select(Expense).order_by(Expense.expense_date.desc(), Expense.created_at.desc()).limit(500)
    )
    expenses = result.scalars().all()
    return {
        "expenses": [
            {
                "id": e.id,
                "description": e.description,
                "amount": e.amount,
                "category": e.category,
                "expense_date": e.expense_date.isoformat() if e.expense_date else None,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in expenses
        ],
        "total": round(sum(e.amount for e in expenses), 2),
    }


@router.post("/expenses")
async def create_expense(
    body: ExpenseCreate,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    from app.models.expense import Expense
    from datetime import date as _dt_date
    try:
        expense_date = _dt_date.fromisoformat(body.expense_date)
    except (ValueError, AttributeError):
        expense_date = _dt_date.today()
    e = Expense(
        description=body.description,
        amount=body.amount,
        category=body.category,
        expense_date=expense_date,
    )
    db.add(e)
    await db.commit()
    await db.refresh(e)
    return {
        "id": e.id,
        "description": e.description,
        "amount": e.amount,
        "category": e.category,
        "expense_date": e.expense_date.isoformat(),
    }


@router.delete("/expenses/{expense_id}")
async def delete_expense(
    expense_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    from app.models.expense import Expense
    e = await db.get(Expense, expense_id)
    if not e:
        raise HTTPException(status_code=404, detail="Expense not found")
    await db.delete(e)
    await db.commit()
    return {"deleted": True}
