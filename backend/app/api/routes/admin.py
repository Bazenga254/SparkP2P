import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select, func, case, extract, or_, and_
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import create_access_token
from app.core.trading_day import trading_day_start, trading_month_start, trading_day_key, now_utc
from app.models import Trader, TraderStatus, Order, OrderStatus, Payment, PaymentDirection, PaymentStatus, ChatMessage
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.models.message_template import MessageTemplate
from app.api.deps import get_admin_trader, get_employee_or_admin, get_client_ip, write_audit_log
from app.services.message_templates import seed_default_templates, refresh_template_cache
from app.services.billing import account_number

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
async def admin_login(data: AdminLoginRequest, request: Request = None, db: AsyncSession = Depends(get_db)):
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

    await write_audit_log(db, admin, "admin_login", ip_address=get_client_ip(request) if request else "", detail=f"{admin.email} signed in to the admin dashboard")

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
    # Trading day resets at 00:00 UTC (= 03:00 EAT) to match Binance — central source of truth.
    today_start = trading_day_start()

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

    # KYC pending — includes staging submissions awaiting admin review + Choice Bank onboarding
    result = await db.execute(
        select(func.count(Trader.id)).where(
            or_(
                Trader.choice_kyc_status.like('pending%'),
                Trader.choice_kyc_status.like('onboarding%'),
                Trader.choice_kyc_status.like('staging%'),
            )
        )
    )
    kyc_pending = result.scalar() or 0

    return {
        "traders": {
            "total": total_traders,
            "active": active_traders,
            "total_unverified": kyc_pending,
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

    # Current-month volume + trades per trader from the central Orders table, so the list matches
    # the Top Traders panel and resets at the start of each trading month (00:00 UTC = 03:00 EAT).
    _month_start = trading_month_start()
    _agg = (await db.execute(
        select(
            Order.trader_id,
            func.count(Order.id).label("trades"),
            func.coalesce(func.sum(Order.fiat_amount), 0).label("volume"),
        ).where(
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
            Order.created_at >= _month_start,
        ).group_by(Order.trader_id)
    )).all()
    _month = {row.trader_id: (int(row.trades), float(row.volume)) for row in _agg}

    is_full_admin = admin.is_admin and admin.role == "admin"

    from app.services.binance import relay_router as _relay  # per-trader relay presence (v1.9.2+)

    # NOTE: viewing the traders list is not audited — the dashboard auto-polls it every ~30s, which
    # used to flood the audit log. Only meaningful actions (logins, changes, denials, etc.) are kept.

    return [
        {
            "id": t.id,
            "full_name": t.full_name,
            "email": t.email,
            "phone": t.phone if is_full_admin else mask_phone(t.phone),
            "status": t.status.value,
            "binance_connected": t.binance_connected,
            "binance_api_key_invalid": bool(t.binance_api_key_invalid),
            "binance_merchant_tier": (t.binance_merchant_tier or None),
            "binance_p2p_tier": (t.binance_p2p_tier or None),
            "binance_api_key_saved": bool(t.binance_api_key),
            "tier": t.tier or "standard",
            "role": t.role or "trader",
            "total_trades": _month.get(t.id, (0, 0.0))[0],
            "total_volume": _month.get(t.id, (0, 0.0))[1],
            "created_at": t.created_at.isoformat() if t.created_at else "",
            "last_seen_at": t.last_extension_sync.isoformat() if t.last_extension_sync else None,
            "last_web_active": (t.last_web_active or t.last_login).isoformat() if (t.last_web_active or t.last_login) else None,
            "choice_account_id": t.choice_account_id or None,
            "choice_account_number": t.choice_account_number or None,
            "choice_kyc_status": t.choice_kyc_status or None,
            "relay_connected": _relay.is_connected(t.id),
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

    # Subscription plan + per-tier daily limits (trades + Telegram) and today's usage.
    from app.services.plans import active_plan, plan_label
    from app.services.rate_limits import trade_rate_status, tg_rate_status
    from app.models.subscription import Subscription, SubscriptionStatus
    from app.services.binance import relay_router as _relaymod
    _plan = await active_plan(db, trader_id)
    _trades = await trade_rate_status(db, trader)
    _tg = tg_rate_status(_plan, trader)
    _expires = _trades.get("reset_at")
    try:
        _sub = (await db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader_id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            ).order_by(Subscription.expires_at.desc())
        )).scalars().first()
        _sub_expires = _sub.expires_at.isoformat() if (_sub and _sub.expires_at) else None
        # How did they get this plan? ADMIN_GRANT = we gave it (no money); anything else = a real
        # M-Pesa payment. Lets the admin tell "extended by us" apart from "actually paid".
        _sub_source = ("grant" if (_sub and _sub.mpesa_transaction_id == "ADMIN_GRANT")
                       else "paid" if _sub else None)
    except Exception:
        _sub_expires = None
        _sub_source = None

    # I&M Automation: is this trader's downloadable bot connected (an un-revoked
    # im_bot key), and what has it billed? Like the Telegram ✓, this is a STATUS —
    # a live key is the bot's heartbeat (it authenticates on every poll).
    from app.models.api_key import MerchantApiKey
    from app.models.im_charge import ImCharge
    _im_key = (await db.execute(
        select(MerchantApiKey.last_used_at)
        .where(MerchantApiKey.trader_id == trader_id,
               MerchantApiKey.scope == "im_bot",
               MerchantApiKey.revoked_at.is_(None))
        .order_by(MerchantApiKey.last_used_at.desc().nullslast())
        .limit(1)
    )).scalar_one_or_none()
    _im_connected = _im_key is not None or (await db.execute(
        select(func.count()).select_from(MerchantApiKey)
        .where(MerchantApiKey.trader_id == trader_id,
               MerchantApiKey.scope == "im_bot",
               MerchantApiKey.revoked_at.is_(None))
    )).scalar_one() > 0
    _im_stats = (await db.execute(
        select(func.count(ImCharge.id), func.coalesce(func.sum(ImCharge.rate), 0),
               func.coalesce(func.sum(ImCharge.payout_amount), 0))
        .where(ImCharge.trader_id == trader_id)
    )).one()

    return {
        "plan": _plan.value if _plan else None,
        "plan_label": plan_label(_plan),
        "plan_source": _sub_source,   # 'paid' | 'grant' | None
        "subscription_expires_at": _sub_expires,
        "daily_trade_limit": _trades["limit"],
        "daily_trade_used": _trades["used"],
        "daily_trade_unlimited": _trades["unlimited"],
        "daily_tg_limit": _tg["limit"],
        "daily_tg_used": _tg["used"],
        "daily_tg_unlimited": _tg["unlimited"],
        "limits_reset_at": _trades["reset_at"],
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
        "binance_api_key_invalid": bool(trader.binance_api_key_invalid),
        "binance_merchant_tier": (trader.binance_merchant_tier or None),
        "binance_p2p_tier": (trader.binance_p2p_tier or None),
        "account_number": account_number(trader.id),   # SPK<id> — Paybill account for subscriptions
        "subscription_balance": float(trader.subscription_balance or 0),
        "binance_api_key_saved": bool(trader.binance_api_key),
        "price_tracker_enabled": bool(getattr(trader, "price_tracker_enabled", False)),
        "b2c_own_paybill_enabled": bool(getattr(trader, "b2c_own_paybill_enabled", False)),
        "buy_payout_via_im": bool(getattr(trader, "buy_payout_via_im", False)),
        # I&M billing: on_demand credits vs the weekly unlimited package (+ live status).
        "im_billing_mode": getattr(trader, "im_billing_mode", "on_demand"),
        "im_weekly": __import__("app.services.im_weekly_plan", fromlist=["status"]).status(trader),
        # The ONE buy-order payout rail (choice_bank | im_bot | own_paybill),
        # derived from the two flags above so the admin has a single control.
        "payout_rail": payout_rail_of(trader),
        "b2c_credits": int(getattr(trader, "b2c_credits", 0) or 0),
        "telegram_connected": bool(trader.telegram_chat_id),
        "telegram_notify_scope": trader.telegram_notify_scope or 'both',
        # I&M Automation connection + what its bot has billed this trader.
        "im_bot_connected": bool(_im_connected),
        "im_bot_last_seen": _im_key.isoformat() if _im_key else None,
        "im_bot_payouts": int(_im_stats[0] or 0),
        "im_bot_revenue": int(_im_stats[1] or 0),
        "im_bot_volume": int(_im_stats[2] or 0),
        "relay_connected": _relaymod.is_connected(trader.id),
        "relay_ip": _relaymod.last_ip(trader.id),
        "pending_orders_count": int(getattr(trader, "pending_orders_count", 0) or 0),
        "last_web_active": (trader.last_web_active or trader.last_login).isoformat() if (trader.last_web_active or trader.last_login) else None,
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
    admin: Trader = Depends(get_admin_trader),
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

    from app.api.deps import log_event
    await write_audit_log(db, admin, "reset_trader_password", target_trader_id=trader_id, detail=f"reset password for {trader.full_name}")
    await log_event(db, trader_id, f"Password reset by support ({admin.full_name})", "warning")

    logger.info(f"Password reset for trader {trader.id} ({trader.full_name})")
    return {"status": "ok", "message": "Password reset and sent via SMS"}


class ChoiceVerifyEmailIn(BaseModel):
    document_number: str
    personal_id_type: str = "101"  # 101=National ID, 102=Alien ID, 103=Passport


class ChoiceConfirmEmailOtpIn(BaseModel):
    application_id: str
    otp: str


@router.post("/traders/{trader_id}/choice-verify-email")
async def admin_choice_verify_email(
    trader_id: int,
    body: ChoiceVerifyEmailIn,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Trigger email OTP verification for a trader's Choice Bank account."""
    from app.services.choice_bank import client as _cb
    result = await _cb.verify_email_address(body.document_number, body.personal_id_type)
    if result.get("code") != "00000":
        raise HTTPException(status_code=502, detail=result.get("msg") or "Choice Bank error")
    application_id = (result.get("data") or {}).get("applicationId") or result.get("applicationId") or ""
    return {"ok": True, "application_id": application_id}


@router.post("/traders/{trader_id}/choice-confirm-email-otp")
async def admin_choice_confirm_email_otp(
    trader_id: int,
    body: ChoiceConfirmEmailOtpIn,
    admin: Trader = Depends(get_admin_trader),
):
    """Confirm the email verification OTP for a trader's Choice Bank account."""
    from app.services.choice_bank import client as _cb
    result = await _cb.confirm_otp(body.application_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(status_code=502, detail=result.get("msg") or "OTP confirmation failed")
    return {"ok": True}


@router.post("/traders/{trader_id}/send-test-email")
async def admin_send_test_email(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send a test verification email to the trader's registered email address."""
    from app.services.email import send_verification_code
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    ok = send_verification_code(trader.email, "TEST-OK")
    return {"ok": ok, "email": trader.email}


@router.post("/traders/{trader_id}/backfill-today")
async def backfill_trader_today(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Import this trader's COMPLETED Binance orders from 03:00 EAT today (00:00 UTC) to now,
    so their P&L/volume for the day reflects trades made before the bot was connected. Idempotent.
    Requires the trader's relay to be online (Binance is geo-blocked from the VPS)."""
    from datetime import datetime, timezone
    from app.core.security import decrypt_data
    from app.services.binance.sapi_client import relay_trader
    from app.services.binance import relay_router
    from app.services.tracking import _backfill_orders

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if not trader.binance_api_key or not trader.binance_api_secret:
        raise HTTPException(status_code=400, detail="Trader has no Binance API key connected.")
    if not relay_router.is_connected(trader_id):
        raise HTTPException(status_code=400, detail="Trader's relay is offline — open their app so the relay is online, then retry.")

    relay_trader.set(trader_id)   # route the Binance calls via this trader's relay
    day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    floor_ms = int(day_start.timestamp() * 1000)
    try:
        inserted = await _backfill_orders(
            trader_id,
            decrypt_data(trader.binance_api_key),
            decrypt_data(trader.binance_api_secret),
            connect_floor_ms=floor_ms,
            force=True,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Backfill failed: {e}")

    logger.info("Admin %s backfilled trader %s today: %d orders", admin.id, trader_id, inserted)
    return {"status": "ok", "inserted": inserted, "since": day_start.isoformat()}


# In-memory store for async Safaricom-verified resolutions
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
    """
    Resolve an unmatched payment and credit the trader wallet.

    Fast path: if the payment is already in our DB (Choice Bank webhook arrived),
    link it to the trader and credit immediately — no external API call needed.

    Slow path: payment not in DB — trigger Safaricom transaction query (async callback).
    """
    from sqlalchemy import or_
    mpesa_ref = req.mpesa_ref.strip().upper()
    amount = req.amount

    # 1. Trader exists?
    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    # 2. Full duplicate check — covers both internal txId AND real M-Pesa receipt
    already_r = await db.execute(
        select(Payment).where(
            or_(
                Payment.mpesa_transaction_id == mpesa_ref,
                Payment.mpesa_receipt_number == mpesa_ref,
            ),
            Payment.trader_id.isnot(None),
            Payment.status == PaymentStatus.COMPLETED,
        )
    )
    if already_r.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="This reference has already been credited to a trader.")

    # 3. Fast path — payment already in our DB from a Choice Bank webhook (unmatched)
    unmatched_r = await db.execute(
        select(Payment).where(
            or_(
                Payment.mpesa_transaction_id == mpesa_ref,
                Payment.mpesa_receipt_number == mpesa_ref,
            )
        ).order_by(Payment.id.desc()).limit(1)
    )
    existing_pmt = unmatched_r.scalar_one_or_none()

    if existing_pmt:
        # Verify amount matches (±5 KES tolerance for rounding)
        if abs(float(existing_pmt.amount) - amount) > 5:
            raise HTTPException(
                status_code=400,
                detail=f"Amount mismatch: payment record shows KES {existing_pmt.amount:,.0f} but you entered KES {amount:,.0f}"
            )
        # Link payment to trader and mark completed
        existing_pmt.trader_id = trader_id
        existing_pmt.status = PaymentStatus.COMPLETED

        # Credit wallet
        wallet_r = await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))
        wallet = wallet_r.scalar_one_or_none()
        if not wallet:
            wallet = Wallet(trader_id=trader_id, balance=0, reserved=0)
            db.add(wallet)
            await db.flush()

        credit_amount = float(existing_pmt.amount)
        wallet.balance      += credit_amount
        wallet.total_earned += credit_amount

        db.add(WalletTransaction(
            trader_id=trader_id,
            wallet_id=wallet.id,
            transaction_type=TransactionType.DEPOSIT,
            amount=credit_amount,
            balance_after=wallet.balance,
            description=f"Resolved unmatched deposit — ref {mpesa_ref}",
            mpesa_receipt=mpesa_ref,
            status="completed",
        ))
        await db.commit()

        try:
            from app.api.routes.traders import add_notification
            add_notification(trader_id, f"Deposit Resolved: KES {credit_amount:,.0f}",
                             f"Your wallet has been credited. Receipt: {mpesa_ref}", "payment")
        except Exception:
            pass

        from app.api.deps import log_event
        await write_audit_log(db, admin, "resolve_payment", target_trader_id=trader_id, detail=f"credited KES {credit_amount:,.0f} (ref {mpesa_ref})")
        await log_event(db, trader_id, f"Payment resolved by support: KES {credit_amount:,.0f} credited (ref {mpesa_ref})", "success")
        logger.info(f"Resolved existing unmatched payment {mpesa_ref}: KES {credit_amount} credited to trader {trader_id}")
        return {
            "status": "credited",
            "mpesa_ref": mpesa_ref,
            "amount": credit_amount,
            "message": f"KES {credit_amount:,.0f} credited to wallet.",
        }

    # 4. Slow path — not in DB, verify via Safaricom async callback
    _pending_resolutions[mpesa_ref] = {
        "trader_id": trader_id,
        "amount": amount,
        "status": "verifying",
        "message": "Payment not in our records. Querying Safaricom to verify...",
    }
    try:
        from app.services.mpesa.client import mpesa_client
        await mpesa_client.query_transaction(mpesa_ref)
        logger.info(f"Resolve (slow path): queried Safaricom for {mpesa_ref} (trader {trader_id}, KES {amount})")
    except Exception as e:
        _pending_resolutions.pop(mpesa_ref, None)
        raise HTTPException(status_code=502, detail=f"Payment not in our records and Safaricom query failed: {e}")

    return {"status": "verifying", "mpesa_ref": mpesa_ref, "message": "Payment not found in our records. Verification request sent to Safaricom — check status in a few seconds."}


@router.get("/traders/{trader_id}/resolve-payment/status")
async def resolve_payment_status(
    trader_id: int,
    mpesa_ref: str,
    admin: Trader = Depends(get_admin_trader),
):
    """Poll for the result of a pending Safaricom-verified resolution."""
    mpesa_ref = mpesa_ref.strip().upper()
    info = _pending_resolutions.get(mpesa_ref)
    if not info:
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

    old_role = trader.role or "trader"
    trader.role = role
    if role == "admin":
        trader.is_admin = True
    elif role != "admin" and trader.is_admin:
        trader.is_admin = False

    await db.commit()
    await write_audit_log(db, admin, "change_role", target_trader_id=trader_id, detail=f"{trader.full_name}: role {old_role} → {role}")

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

    old_status = trader.status.value if trader.status else "?"
    trader.status = new_status
    await db.commit()
    await write_audit_log(db, admin, "change_status", target_trader_id=trader_id, detail=f"{trader.full_name}: status {old_status} → {new_status.value}")

    return {"status": "updated", "trader_id": trader_id, "new_status": new_status.value}


@router.put("/traders/{trader_id}/price-tracker")
async def update_trader_price_tracker(
    trader_id: int,
    enabled: bool,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Enable/disable the live Binance P2P price tracker for a trader (admin-gated feature)."""
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    trader.price_tracker_enabled = bool(enabled)
    await db.commit()
    await write_audit_log(db, admin, "toggle_price_tracker", target_trader_id=trader_id, detail=f"{trader.full_name}: price tracker {'enabled' if enabled else 'disabled'}")
    return {"status": "updated", "trader_id": trader_id, "price_tracker_enabled": bool(enabled)}


@router.put("/traders/{trader_id}/im-billing-mode")
async def update_trader_im_billing_mode(
    trader_id: int,
    mode: str,   # 'on_demand' | 'weekly'
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Put a merchant on the I&M WEEKLY package (flat tier fee, unlimited payouts)
    or back on ON-DEMAND credits. Switching to weekly does NOT activate a week —
    the merchant pays the tier price to start one. Switching back to on-demand
    keeps any rolled-over plan balance and their on-demand credit balance."""
    from app.services import im_weekly_plan as weekly
    mode = (mode or "").strip().lower()
    if mode not in ("on_demand", "weekly"):
        raise HTTPException(status_code=400, detail="mode must be 'on_demand' or 'weekly'")
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if mode == "weekly" and not weekly.weekly_price(trader):
        raise HTTPException(status_code=400,
                            detail="This merchant has no detected Binance tier — set their tier before the weekly plan.")
    trader.im_billing_mode = mode
    await db.commit()
    await write_audit_log(db, admin, "change_im_billing_mode", target_trader_id=trader_id,
                          detail=f"{trader.full_name}: I&M billing -> {mode}")
    return {"status": "updated", "trader_id": trader_id, "im_billing_mode": mode,
            "weekly": weekly.status(trader)}


@router.put("/traders/{trader_id}/b2c-paybill")
async def update_trader_b2c_paybill(
    trader_id: int,
    enabled: bool,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Enable/disable B2C-via-own-paybill for a client. When enabled the trader is moved to the
    hidden B2C plan (ADVANCED, KES 15,000/mo) and can't downgrade; they pre-pay a KES 8 credit per
    M-Pesa payout from their own paybill. Disabling only lifts the flag (support handles plan change)."""
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    # Own-paybill and I&M are two rails for the SAME thing (buy-order payouts):
    # a trader can only be on one. Turning own-paybill ON clears the I&M flag so
    # the two can never both claim the payout (the conflict we are fixing).
    trader.b2c_own_paybill_enabled = bool(enabled)
    if enabled:
        trader.buy_payout_via_im = False
    await db.commit()
    await write_audit_log(db, admin, "toggle_b2c_paybill", target_trader_id=trader_id, detail=f"{trader.full_name}: B2C own-paybill {'enabled' if enabled else 'disabled'}")
    return {"status": "updated", "trader_id": trader_id, "b2c_own_paybill_enabled": bool(enabled)}


# The buy-order payout rail is ONE choice with three mutually-exclusive values —
# never two overlapping booleans. This is the single source of truth; both flags
# are derived from it so a contradictory state (own-paybill AND I&M at once) is
# structurally impossible.
PAYOUT_RAILS = ("choice_bank", "im_bot", "own_paybill")


def payout_rail_of(trader) -> str:
    """The trader's current rail, derived from the two flags. own_paybill wins if
    both are somehow set (legacy rows) — but set_payout_rail never lets that happen."""
    if getattr(trader, "b2c_own_paybill_enabled", False):
        return "own_paybill"
    if getattr(trader, "buy_payout_via_im", False):
        return "im_bot"
    return "choice_bank"


def set_payout_rail(trader, rail: str) -> None:
    """Set the rail by setting BOTH flags together — exactly one can be true."""
    trader.buy_payout_via_im = (rail == "im_bot")
    trader.b2c_own_paybill_enabled = (rail == "own_paybill")


@router.put("/traders/{trader_id}/payout-rail")
async def update_trader_payout_rail(
    trader_id: int,
    rail: str,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Choose the ONE rail that pays this trader's BUY orders:
        choice_bank  — the platform pays from their Choice Bank balance (default)
        im_bot       — their own downloadable I&M Bot pays from their I&M account
        own_paybill  — their own M-Pesa Paybill (B2C plan)
    Sells always stay on Choice Bank.

    This replaces the old two-switch design (B2C Route + Buy Payout), which could
    be set to contradictory values. Setting a rail here sets both underlying flags
    together, so exactly one is ever active. It redirects real money on the next
    buy order; admin can pick any rail (no bot-configured gate — a pre-armed
    trader's orders simply wait for the bot to poll)."""
    if rail not in PAYOUT_RAILS:
        raise HTTPException(status_code=400, detail=f"rail must be one of {PAYOUT_RAILS}")
    trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    set_payout_rail(trader, rail)
    await db.commit()
    labels = {"choice_bank": "Choice Bank", "im_bot": "I&M Bot", "own_paybill": "Own Paybill (B2C)"}
    await write_audit_log(db, admin, "set_payout_rail", target_trader_id=trader_id,
                          detail=f"{trader.full_name}: buy payouts via {labels[rail]}")
    return {
        "status": "updated", "trader_id": trader_id, "payout_rail": rail,
        "buy_payout_via_im": trader.buy_payout_via_im,
        "b2c_own_paybill_enabled": trader.b2c_own_paybill_enabled,
    }


@router.put("/traders/{trader_id}/tier")
async def update_trader_tier(
    trader_id: int,
    tier: str,
    expires_at: str = "",   # optional ISO 8601 expiry (e.g. 2026-12-31T20:00:00Z). Default: +30 days.
    credits: int = 0,       # B2C ('advanced') grants only: credits to add (0 -> default 2,000).
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Update trader's subscription tier. Creates/updates subscription accordingly.
    Admins may grant any duration by passing expires_at (date + time the plan should lapse).
    Granting 'advanced' (B2C) also enables B2C-via-own-paybill and adds credits (default 2,000)."""
    from app.models.subscription import Subscription, SubscriptionPlan, SubscriptionStatus
    from app.services.plans import plan_price
    from datetime import timedelta

    if tier not in ("standard", "starter", "pro", "pro_max", "advanced"):
        raise HTTPException(status_code=400, detail="Invalid tier")
    _granted_credits = 0

    # Resolve the requested expiry (admin can grant 1mo / 3mo / 1yr / any date+time).
    _custom_exp = None
    if expires_at.strip():
        try:
            _custom_exp = datetime.fromisoformat(expires_at.strip().replace("Z", "+00:00"))
            if _custom_exp.tzinfo is None:
                _custom_exp = _custom_exp.replace(tzinfo=timezone.utc)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid expires_at — use ISO 8601 (YYYY-MM-DDTHH:MM:SSZ)")
        if _custom_exp <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Expiry must be in the future")

    result = await db.execute(select(Trader).where(Trader.id == trader_id))
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    trader.tier = tier

    if tier in ("starter", "pro", "pro_max", "advanced"):
        # Check for existing active subscription
        sub_result = await db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader_id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            )
        )
        existing_sub = sub_result.scalar_one_or_none()

        now = datetime.now(timezone.utc)
        plan_amount = plan_price(SubscriptionPlan(tier))   # central config (3k/5k/10k)
        exp = _custom_exp or (now + timedelta(days=30))

        if existing_sub:
            # Update existing subscription. Mark as ADMIN_GRANT so an admin tier change NEVER
            # counts as subscription revenue (revenue excludes ADMIN_GRANT).
            existing_sub.plan = SubscriptionPlan(tier)
            existing_sub.amount = plan_amount
            existing_sub.status = SubscriptionStatus.ACTIVE   # re-activate if it had lapsed
            existing_sub.mpesa_transaction_id = "ADMIN_GRANT"
            existing_sub.started_at = now
            existing_sub.expires_at = exp
        else:
            # Create new subscription (admin-granted — excluded from revenue).
            sub = Subscription(
                trader_id=trader_id,
                plan=SubscriptionPlan(tier),
                status=SubscriptionStatus.ACTIVE,
                amount=plan_amount,
                started_at=now,
                expires_at=exp,
                mpesa_transaction_id="ADMIN_GRANT",
            )
            db.add(sub)

        # B2C plan: enable own-paybill. NO free credits by default — everyone
        # starts at 0 and buys their own (the admin may still gift some by passing
        # an explicit `credits` amount, but the default is none).
        if tier == "advanced":
            trader.b2c_own_paybill_enabled = True
            _granted_credits = int(credits or 0)
            if _granted_credits > 0:
                trader.b2c_credits = int(trader.b2c_credits or 0) + _granted_credits

        # Send notification email
        from app.services.email import send_subscription_activated
        send_subscription_activated(
            trader.email, trader.full_name, tier,
            exp.strftime("%B %d, %Y"),
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
    _detail = f"{trader.full_name}: subscription set to {tier}" + (f" + {_granted_credits} B2C credits granted" if _granted_credits else "")
    await write_audit_log(db, admin, "change_subscription", target_trader_id=trader_id, detail=_detail)

    return {"status": "updated", "trader_id": trader_id, "tier": tier, "credits_granted": _granted_credits}


@router.post("/test-b2c")
async def test_b2c(
    phone: str,
    amount: float = 10,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: fire a REAL B2C payout from the SparkP2P paybill (4041355) to validate the B2C
    engine end-to-end. Sends real money — use a small amount to your own number. Result arrives
    async in the logs via /payment/b2c/result."""
    from app.services.mpesa.client import mpesa_client
    try:
        result = await mpesa_client.send_b2c(phone=phone, amount=amount, remarks="SparkP2P B2C test")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"B2C send failed: {e}")
    await write_audit_log(db, admin, "test_b2c", detail=f"B2C test: KES {amount} to {phone} — {result.get('ResponseDescription', result)}")
    return {"status": "sent", "response": result}


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


class AdminSmsRequest(BaseModel):
    message: str
    trader_id: int | None = None
    broadcast: bool = False


@router.post("/sms/send")
async def admin_send_sms(
    data: AdminSmsRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send a custom SMS to one trader (trader_id) or to all traders (broadcast=true) — outages,
    payment details, announcements. Uses the same Advanta sender as the rest of the app."""
    from app.services.sms import send_sms
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Message is required")
    if len(msg) > 800:
        raise HTTPException(status_code=400, detail="Message is too long (max 800 chars)")

    if data.broadcast:
        traders = (await db.execute(
            select(Trader).where(Trader.phone.isnot(None), Trader.phone != "")
        )).scalars().all()
        targets = [t.phone for t in traders if t.phone]
    elif data.trader_id:
        t = (await db.execute(select(Trader).where(Trader.id == data.trader_id))).scalar_one_or_none()
        if not t or not t.phone:
            raise HTTPException(status_code=400, detail="Trader not found or has no phone number")
        targets = [t.phone]
    else:
        raise HTTPException(status_code=400, detail="Specify a trader_id or set broadcast=true")

    sent = failed = 0
    for ph in targets:
        try:
            if send_sms(ph, msg):
                sent += 1
            else:
                failed += 1
        except Exception:
            failed += 1
    try:
        await write_audit_log(db, admin, "send_sms",
                              detail=f"custom SMS — sent={sent} failed={failed} broadcast={data.broadcast}")
    except Exception:
        pass
    return {"sent": sent, "failed": failed, "total": len(targets)}


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
            # Exclude payments already resolved: credited to a trader and marked completed
            ~(
                (Payment.status == PaymentStatus.COMPLETED) &
                (Payment.trader_id.isnot(None))
            ),
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



@router.delete("/payments/unmatched/{payment_id}")
async def resolve_unmatched_payment(
    payment_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Resolve (delete) an unmatched payment record by its ID."""
    from app.models.payment import Payment
    pmt = (await db.execute(select(Payment).where(Payment.id == payment_id))).scalar_one_or_none()
    if not pmt:
        raise HTTPException(status_code=404, detail="Payment not found")
    await db.delete(pmt)
    await db.commit()
    return {"resolved": payment_id}


def _get_period_start(period: str):
    """Return the start datetime for a given period filter (trading day for 'today')."""
    now = datetime.now(timezone.utc)
    if period == "today":
        return trading_day_start(now)
    elif period == "week":
        return now - timedelta(days=7)
    elif period == "month":
        return trading_month_start(now)   # calendar month, resets on the 1st
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

    # Search filter — include mpesa_receipt_number (the externalTxId / M-Pesa code
    # the bank portal shows as "Reference Number") and bill_ref_number, so a code
    # like UGP5N0ICZ3 actually finds its transaction.
    if search and search.strip():
        s = f"%{search.strip()}%"
        query = query.where(
            (Payment.mpesa_transaction_id.ilike(s)) |
            (Payment.mpesa_receipt_number.ilike(s)) |
            (Payment.bill_ref_number.ilike(s)) |
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
            (Payment.mpesa_receipt_number.ilike(s)) |
            (Payment.bill_ref_number.ilike(s)) |
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
                "reference": p.mpesa_receipt_number or "-",   # externalTxId / M-Pesa code
                "created_at": p.created_at.isoformat() if p.created_at else "",
            }
            for p, trader_name, trader_phone in rows
        ],
    }


# Choice BaaS status codes → words (getTransResult txStatus).
_CB_TX_STATUS = {-1: "Timeout", 1: "Pending", 2: "Processing", 4: "Failed", 8: "Success"}


@router.get("/transactions/choice-detail")
async def admin_transaction_choice_detail(
    tx_id: str = Query(..., description="Choice txId (UTRANS…) — the transaction's mpesa_transaction_id"),
    admin: Trader = Depends(get_admin_trader),
):
    """Live Choice Bank BaaS detail for one transaction, so the admin can read the
    failure reason (errorCode/errorMsg), fee, channel and counterparty WITHOUT
    logging into the Choice BaaS portal. Fetched on demand from /query/getTransResult."""
    from app.services.choice_bank import client as choice

    tx_id = (tx_id or "").strip()
    if not tx_id or tx_id == "-":
        raise HTTPException(status_code=400, detail="No Choice transaction id on this row.")
    try:
        r = await choice.get_transaction_result(tx_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Choice lookup failed: {e}")
    if (r or {}).get("code") != "00000":
        raise HTTPException(status_code=502, detail=(r or {}).get("msg", "Choice returned no detail"))

    d = (r.get("data") or {})
    ext = (d.get("extInfo") or {})
    status_word = _CB_TX_STATUS.get(d.get("txStatus"), str(d.get("txStatus")))
    err_code = d.get("errorCode")
    err_msg = d.get("errorMsg")
    return {
        "tx_id": d.get("txId"),
        "status": status_word,
        "success": d.get("txStatus") == 8,
        # The whole point: the bank's own reason a transfer failed.
        "failure_reason": (f"{err_msg} ({err_code})" if err_code and status_word != "Success" else (err_msg or None)),
        "error_code": err_code,
        "error_msg": err_msg,
        "amount": d.get("amount"),
        "fee": d.get("feeAmount"),
        "currency": d.get("currency"),
        "channel": d.get("paymentChannel"),
        "tx_type": d.get("txType"),
        "counterparty_name": d.get("oppoAccountName") or ext.get("counterpartyName"),
        "counterparty_account": d.get("oppoAccountId"),
        "counterparty_bank": d.get("oppoBankName"),
        "narrative": ext.get("transactionNarrative") or None,
        "external_tx_id": d.get("externalTxId"),
        "created_time": d.get("createTime"),
        "updated_time": d.get("updateTime"),
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
    today_start = trading_day_start(now)
    week_start = now - timedelta(days=7)
    month_start = trading_month_start(now)   # calendar month, resets on the 1st
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
            func.sum(Order.platform_fee + Order.settlement_fee + Order.choice_fee).label("profit"),
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

    # Online traders = bot active (<3 min) OR web-active (<5 min) — matches the All Traders view
    _bot_cutoff = datetime.now(timezone.utc) - timedelta(seconds=180)
    _web_cutoff = datetime.now(timezone.utc) - timedelta(seconds=300)
    r = await db.execute(
        select(func.count(Trader.id)).where(
            or_(
                and_(Trader.last_extension_sync.isnot(None), Trader.last_extension_sync >= _bot_cutoff),
                and_(Trader.last_web_active.isnot(None), Trader.last_web_active >= _web_cutoff),
                and_(Trader.last_login.isnot(None), Trader.last_login >= _web_cutoff),
            )
        )
    )
    online_traders = r.scalar()

    # Top 5 traders by CURRENT-MONTH volume — same source as the All Traders list,
    # resets at the start of each trading month (00:00 UTC = 03:00 EAT).
    from sqlalchemy import and_ as sql_and
    _top_month_start = trading_month_start(now)
    top_q = (
        select(
            Trader.full_name,
            func.count(Order.id).label("trades"),
            func.coalesce(func.sum(Order.fiat_amount), 0).label("volume"),
        )
        .join(Order, sql_and(
            Order.trader_id == Trader.id,
            Order.status.in_([OrderStatus.RELEASED, OrderStatus.COMPLETED]),
            Order.created_at >= _top_month_start,
        ), isouter=True)
        .group_by(Trader.id, Trader.full_name)
        .having(func.count(Order.id) > 0)
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
    trader_id: int = 0,   # optional: only actions performed ON this trader's account
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """View audit logs of admin/employee actions. Pass trader_id to scope to one trader."""
    from app.models.audit_log import AuditLog
    from sqlalchemy import desc
    q = select(AuditLog).order_by(desc(AuditLog.created_at))
    if trader_id:
        q = q.where(AuditLog.target_trader_id == trader_id)
    result = await db.execute(q.limit(limit).offset(offset))
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


@router.get("/audit-notifications")
async def audit_notifications(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Unread sensitive staff actions (by others) for the super-admin bell badge."""
    from app.models.audit_log import AuditLog
    from app.api.deps import SENSITIVE_AUDIT_ACTIONS
    from sqlalchemy import desc, func
    base = [AuditLog.action.in_(list(SENSITIVE_AUDIT_ACTIONS)), AuditLog.actor_id != admin.id]
    if admin.audit_seen_at is not None:
        base.append(AuditLog.created_at > admin.audit_seen_at)
    count = (await db.execute(select(func.count()).select_from(AuditLog).where(*base))).scalar() or 0
    rows = (await db.execute(select(AuditLog).where(*base).order_by(desc(AuditLog.created_at)).limit(30))).scalars().all()
    return {
        "count": int(count),
        "items": [{
            "id": r.id, "actor_id": r.actor_id, "actor_role": r.actor_role, "action": r.action,
            "target_trader_id": r.target_trader_id, "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else "",
        } for r in rows],
    }


@router.post("/audit-notifications/seen")
async def audit_notifications_seen(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Mark the audit alerts as seen (clears the bell badge)."""
    from datetime import datetime, timezone
    admin.audit_seen_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# WITHDRAWALS — Track M-Pesa and I&M Bank disbursements
# ═══════════════════════════════════════════════════════════

@router.get("/withdrawals")
async def get_withdrawals(
    status: str = Query(None),       # completed | failed | pending | all
    period: str = Query("all"),      # today | week | month | all
    page:   int = Query(1, ge=1),
    limit:  int = Query(30, le=100),
    admin:  Trader = Depends(get_employee_or_admin),
    db:     AsyncSession = Depends(get_db),
):
    """List all Choice Bank → External Bank withdrawal transfers by traders."""
    from app.models.payment import Payment, PaymentStatus as PStatus

    filters = [Payment.transaction_type == "CHOICE_OUTBOUND"]

    if status and status != "all":
        try:
            filters.append(Payment.status == PStatus(status))
        except ValueError:
            pass

    now = datetime.now(timezone.utc)
    today_start = trading_day_start(now)
    if period == "today":
        filters.append(Payment.created_at >= today_start)
    elif period == "week":
        filters.append(Payment.created_at >= now - timedelta(days=7))
    elif period == "month":
        filters.append(Payment.created_at >= trading_month_start(now))

    # Summary
    summary_q = select(
        func.count(Payment.id).label("total"),
        func.coalesce(func.sum(case((Payment.status == PStatus.COMPLETED, Payment.amount), else_=0)), 0).label("total_amount"),
        func.count(case((Payment.status == PStatus.COMPLETED, Payment.id))).label("completed_count"),
        func.count(case((Payment.status == PStatus.FAILED,    Payment.id))).label("failed_count"),
    ).select_from(Payment).where(*filters)
    summary = (await db.execute(summary_q)).one()

    total = (await db.execute(
        select(func.count(Payment.id)).select_from(Payment).where(*filters)
    )).scalar_one()

    rows_q = (
        select(Payment, Trader)
        .join(Trader, Trader.id == Payment.trader_id)
        .where(*filters)
        .order_by(Payment.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    rows = (await db.execute(rows_q)).all()

    withdrawals = []
    for pmt, trader in rows:
        withdrawals.append({
            "id":            pmt.id,
            "trader_id":     trader.id,
            "trader_name":   trader.full_name,
            "trader_phone":  trader.phone,
            "from_account":  trader.choice_account_id or "—",
            "to_bank":       pmt.destination_type or "—",
            "to_account":    pmt.destination or "—",
            "beneficiary":   pmt.sender_name or "—",
            "amount":        float(pmt.amount),
            "status":        pmt.status.value if hasattr(pmt.status, "value") else str(pmt.status),
            "reference":     pmt.mpesa_transaction_id or "—",
            "remarks":       pmt.remarks or "",
            "created_at":    pmt.created_at.isoformat() if pmt.created_at else "",
        })

    return {
        "withdrawals": withdrawals,
        "total": total,
        "page": page,
        "pages": max(1, -(-total // limit)),
        "summary": {
            "total_count":     int(summary.total or 0),
            "total_amount":    float(summary.total_amount or 0),
            "completed_count": int(summary.completed_count or 0),
            "failed_count":    int(summary.failed_count or 0),
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
    today_start_utc = trading_day_start(now)
    period_starts = {
        "today": today_start_utc,
        "week":  now - timedelta(days=7),
        "month": trading_month_start(now),   # calendar month, resets on the 1st
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

async def _compute_outbound_breakdown(db, start=None, end=None):
    """Per-product outbound revenue: count, volume, CB fee, our markup, and total charged."""
    from app.services.outbound_fees import categorize, product_markup, product_cb_fee, PRODUCTS
    from app.models.order import OrderSide as _OS
    prods = {k: {"count": 0, "volume": 0.0, "cb_fee": 0.0, "markup": 0.0} for k in PRODUCTS}

    # coalesce() so NULL remarks are '' (a NULL would make ~ilike() NULL and drop
    # the row from the WHERE by accident).
    _rem = func.coalesce(Payment.remarks, "")
    pw = [
        Payment.direction == PaymentDirection.OUTBOUND,
        Payment.status != PaymentStatus.FAILED,
        # Seller payouts (remarks "BUY <order>: name") are counted from the Orders
        # loop below via order.choice_fee. Counting them here too double-counted
        # every Choice-settled buy order — 57 of 58 live orders were in both.
        # This is the ONLY exclusion: merchant WITHDRAWALS stay in, because Choice
        # withholds a real fee on each one and remits us a markup — they are
        # genuine outbound revenue (a bank withdrawal lands under PesaLink / Bank,
        # an M-Pesa one under B2C, by rail). Excluding them undercounted the page.
        ~_rem.ilike("BUY %"),
    ]
    if start: pw.append(Payment.created_at >= start)
    if end:   pw.append(Payment.created_at < end)
    for p in (await db.execute(
        select(Payment.amount, Payment.fee, Payment.transaction_type, Payment.destination_type).where(*pw)
    )).all():
        prod = categorize(p.transaction_type, p.destination_type)
        if prod not in prods:
            continue
        amt = abs(float(p.amount or 0))
        d = prods[prod]; d["count"] += 1; d["volume"] += amt
        d["cb_fee"] += product_cb_fee(prod, amt); d["markup"] += product_markup(prod, amt)

    ow = [Order.side == _OS.BUY, Order.choice_fee > 0]
    if start: ow.append(Order.created_at >= start)
    if end:   ow.append(Order.created_at < end)
    for o in (await db.execute(
        select(Order.fiat_amount, Order.choice_fee, Order.seller_payment_method).where(*ow)
    )).all():
        prod = categorize("", "", o.seller_payment_method)
        if prod not in prods:
            continue
        amt = abs(float(o.fiat_amount or 0))
        d = prods[prod]; d["count"] += 1; d["volume"] += amt
        d["cb_fee"] += product_cb_fee(prod, amt); d["markup"] += product_markup(prod, amt)

    rows = []; tot = {"count": 0, "volume": 0.0, "cb_fee": 0.0, "markup": 0.0}
    for k, label in PRODUCTS.items():
        d = prods[k]
        cb = round(d["cb_fee"], 2); mk = round(d["markup"], 2)
        rows.append({"key": k, "label": label, "count": d["count"], "volume": round(d["volume"], 2),
                     "cb_fee": cb, "markup": mk, "total_fee": round(cb + mk, 2)})
        for f in ("count", "volume", "cb_fee", "markup"): tot[f] += d[f]
    tot = {f: round(v, 2) for f, v in tot.items()}
    tot["total_fee"] = round(tot["cb_fee"] + tot["markup"], 2)
    return {"products": rows, "total": tot}


def _month_range(month_str):
    y, m = map(int, month_str.split("-")[:2])
    start = datetime(y, m, 1, tzinfo=timezone.utc)
    end = datetime(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1, tzinfo=timezone.utc)
    return start, end


@router.get("/revenue/outbound-breakdown")
async def outbound_revenue_breakdown(
    period: str = Query("all"),   # today | week | month | all
    month: str = Query(""),        # YYYY-MM (overrides period — used by the invoice)
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Per-product outbound-fee revenue breakdown (our markup), for the Expenses → Revenue table."""
    now = datetime.now(timezone.utc)
    if month.strip():
        start, end = _month_range(month.strip())
        label = start.strftime("%B %Y")
    else:
        start = {"today": trading_day_start(now), "week": now - timedelta(days=7),
                 "month": trading_month_start(now)}.get(period)
        end = None; label = {"today": "Today", "week": "Last 7 days", "month": "This month"}.get(period, "All time")
    data = await _compute_outbound_breakdown(db, start, end)
    return {**data, "period": period, "month": month or None, "label": label}


@router.get("/invoice/choice")
async def choice_bank_invoice(
    month: str = Query(default=""),        # YYYY-MM  (full-month mode)
    start_date: str = Query(default=""),   # YYYY-MM-DD (custom range mode)
    end_date: str = Query(default=""),     # YYYY-MM-DD (inclusive)
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Generate a branded PDF invoice to Choice Microfinance Bank for the period's markup revenue.
    Supports two modes: month=YYYY-MM (full calendar month) or start_date+end_date=YYYY-MM-DD range."""
    import io
    from pathlib import Path
    from fastapi import Response
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT, TA_LEFT

    if start_date and end_date:
        # Custom date range: start is 00:00:00 UTC on start_date, end is 23:59:59 UTC on end_date
        try:
            start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
        except ValueError:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        period_label = f"{datetime.strptime(start_date, '%Y-%m-%d').strftime('%d %b %Y')} – {datetime.strptime(end_date, '%Y-%m-%d').strftime('%d %b %Y')}"
        inv_no = f"SFS-{start_date.replace('-', '')}-{end_date.replace('-', '')}"
    elif month:
        start, end = _month_range(month)
        period_label = start.strftime("%B %Y")
        inv_no = f"SFS-{start.strftime('%Y%m')}"
    else:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Provide either 'month' (YYYY-MM) or 'start_date'+'end_date' (YYYY-MM-DD).")

    data = await _compute_outbound_breakdown(db, start, end)
    today = datetime.now(timezone.utc).strftime("%d %b %Y")

    BRAND = colors.HexColor("#1F3864"); AMBER = colors.HexColor("#f59e0b")
    GREY = colors.HexColor("#6b7280"); LIGHT = colors.HexColor("#F2F5FA")
    ss = getSampleStyleSheet()
    h_company = ParagraphStyle("co", parent=ss["Normal"], fontName="Helvetica-Bold", fontSize=15, textColor=BRAND, leading=20, spaceAfter=2)
    small = ParagraphStyle("sm", parent=ss["Normal"], fontSize=8.5, textColor=GREY, leading=12)
    lbl = ParagraphStyle("lbl", parent=ss["Normal"], fontName="Helvetica-Bold", fontSize=8.5, textColor=GREY)
    body = ParagraphStyle("bd", parent=ss["Normal"], fontSize=9.5, leading=13)
    inv_title = ParagraphStyle("it", parent=ss["Normal"], fontName="Helvetica-Bold", fontSize=26, textColor=BRAND, alignment=TA_RIGHT)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=16*mm, bottomMargin=16*mm)
    story = []
    logo_path = Path(__file__).resolve().parents[2] / "static" / "spark_freelance_logo.png"
    logo = Image(str(logo_path), width=26*mm, height=26*mm) if logo_path.exists() else Paragraph("", body)
    head = Table([[logo, Paragraph("INVOICE", inv_title)]], colWidths=[28*mm, None])
    head.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "MIDDLE")]))
    story += [head, Spacer(1, 4)]
    story += [Paragraph("SPARK FREELANCE SOLUTIONS", h_company),
              Paragraph("Outbound transaction-fee markup remittance", small), Spacer(1, 10)]

    meta = Table([
        [Paragraph("BILL TO", lbl), Paragraph("INVOICE NO.", lbl), Paragraph("INVOICE DATE", lbl), Paragraph("BILLING PERIOD", lbl)],
        [Paragraph("Choice Microfinance Bank", body), Paragraph(inv_no, body), Paragraph(today, body), Paragraph(period_label, body)],
    ], colWidths=[None, 32*mm, 32*mm, 36*mm])
    meta.setStyle(TableStyle([("BOTTOMPADDING",(0,0),(-1,0),2), ("TOPPADDING",(0,1),(-1,1),0)]))
    story += [meta, Spacer(1, 14)]

    rows = [["#", "Product / Channel", "Transactions", "Volume (KES)", "Amount Due (KES)"]]
    i = 0
    for p in data["products"]:
        if p["count"] == 0 and p["markup"] == 0:
            continue
        i += 1
        rows.append([str(i), p["label"], f"{p['count']:,}", f"{p['volume']:,.0f}", f"{p['markup']:,.2f}"])
    if i == 0:
        rows.append(["", "No outbound transactions in this period", "", "", "0.00"])
    total = data["total"]["markup"]
    rows.append(["", "", "", "TOTAL DUE", f"KES {total:,.2f}"])

    tbl = Table(rows, colWidths=[10*mm, None, 28*mm, 32*mm, 36*mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), BRAND), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"), ("FONTSIZE", (0,0), (-1,-1), 9),
        ("ALIGN", (2,0), (-1,-1), "RIGHT"), ("ALIGN", (0,0), (0,-1), "CENTER"),
        ("ROWBACKGROUNDS", (0,1), (-1,-2), [colors.white, LIGHT]),
        ("LINEBELOW", (0,0), (-1,-2), 0.4, colors.HexColor("#D9E1F2")),
        ("BACKGROUND", (0,-1), (-1,-1), colors.HexColor("#E2EFDA")),
        ("FONTNAME", (3,-1), (-1,-1), "Helvetica-Bold"), ("TEXTCOLOR", (4,-1), (4,-1), BRAND),
        ("FONTSIZE", (4,-1), (4,-1), 11), ("TOPPADDING", (0,0), (-1,-1), 6), ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]))
    story += [tbl, Spacer(1, 16)]

    remit = Table([
        [Paragraph("REMIT PAYMENT TO", lbl)],
        [Paragraph("Account Name: <b>SPARK FREELANCE SOLUTIONS</b><br/>"
                   "Bank: Choice Microfinance Bank &nbsp;·&nbsp; Branch: Riverside Square<br/>"
                   "Account No.: <b>46011000015688-KES</b>", body)],
    ], colWidths=[None])
    remit.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),LIGHT), ("BOX",(0,0),(-1,-1),0.5,colors.HexColor("#D9E1F2")),
                               ("LEFTPADDING",(0,0),(-1,-1),10),("RIGHTPADDING",(0,0),(-1,-1),10),
                               ("TOPPADDING",(0,0),(-1,-1),8),("BOTTOMPADDING",(0,0),(-1,-1),8)]))
    story += [remit, Spacer(1, 14)]
    story += [Paragraph("This invoice covers the markup portion of outbound transaction fees collected by Choice "
                        "Microfinance Bank on behalf of Spark Freelance Solutions during the billing period, "
                        "remitted monthly per the BaaS agreement. Generated by SparkP2P.", small)]
    doc.build(story)
    buf.seek(0)
    return Response(content=buf.read(), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{inv_no}_ChoiceBank_Invoice.pdf"'})


@router.get("/revenue/subscriptions")
async def revenue_subscriptions(
    period: str = Query("all"),   # today | week | month | all
    month: str = Query(""),        # YYYY-MM — a specific past month (overrides period)
    plan: str = Query("all"),     # starter | pro | all
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Subscription payment revenue — primary income source."""
    from app.models.subscription import Subscription, SubscriptionPlan, SubscriptionStatus

    now = datetime.now(timezone.utc)
    today_start_utc = trading_day_start(now)
    period_starts = {
        "today": today_start_utc,
        "week":  now - timedelta(days=7),
        "month": trading_month_start(now),   # calendar month, resets on the 1st
    }
    start = period_starts.get(period)
    end = None
    if month.strip():   # explicit month picker → bounded [start, end)
        start, end = _month_range(month.strip())

    # Only count paid (active) subscriptions — exclude admin grants (no real payment)
    base_where = [
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.mpesa_transaction_id != 'ADMIN_GRANT',
        Subscription.mpesa_transaction_id.isnot(None),
    ]
    if start:
        base_where.append(Subscription.started_at >= start)
    if end:
        base_where.append(Subscription.started_at < end)
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
    summary = {"total": 0.0, "starter": 0.0, "pro": 0.0, "pro_max": 0.0, "advanced": 0.0, "starter_count": 0, "pro_count": 0, "pro_max_count": 0, "advanced_count": 0}
    for row in summary_rows:
        pv = row.plan.value if hasattr(row.plan, "value") else str(row.plan)
        summary[pv] = round(float(row.total or 0), 2)
        summary[f"{pv}_count"] = int(row.count or 0)
        summary["total"] = round(summary["total"] + float(row.total or 0), 2)

    # ── Outbound transaction-fee revenue (our markup) ──────────────────────────
    # Choice Bank withholds the full fee on each outbound transfer and remits OUR markup monthly.
    # Revenue = sum of markups across withdrawals (payments) + buy-order seller payments (orders).
    # 'gross' is the full fee traders paid (incl. Choice Bank's own cost) — shown for reference.
    from app.services.outbound_fees import outbound_markup
    from app.models.order import OrderSide as _OrderSide
    _ob_markup = 0.0
    _ob_gross = 0.0
    # Only count transactions that actually recorded a fee under the new model (fee > 0) — this
    # excludes old/test withdrawals from before fee recording (which would otherwise add phantom
    # markup recomputed from their amount).
    _pay_where = [Payment.transaction_type == "CHOICE_OUTBOUND", Payment.status != PaymentStatus.FAILED,
                  Payment.fee > 0]
    if start:
        _pay_where.append(Payment.created_at >= start)
    if end:
        _pay_where.append(Payment.created_at < end)
    for _p in (await db.execute(
        select(Payment.amount, Payment.fee, Payment.destination_type).where(*_pay_where)
    )).all():
        _ch = "MPESA" if "M-PESA" in (_p.destination_type or "").upper() or "MPESA" in (_p.destination_type or "").upper() else "BANK"
        _ob_markup += outbound_markup(_ch, _p.amount or 0)
        _ob_gross += float(_p.fee or 0)
    _ord_where = [Order.side == _OrderSide.BUY, Order.choice_fee > 0]
    if start:
        _ord_where.append(Order.created_at >= start)
    if end:
        _ord_where.append(Order.created_at < end)
    for _o in (await db.execute(
        select(Order.fiat_amount, Order.choice_fee, Order.seller_payment_method).where(*_ord_where)
    )).all():
        _ch = "MPESA" if (_o.seller_payment_method or "").lower() in ("mpesa", "m-pesa") else "BANK"
        _ob_markup += outbound_markup(_ch, _o.fiat_amount or 0)
        _ob_gross += float(_o.choice_fee or 0)
    summary["outbound_markup"] = round(_ob_markup, 2)   # our revenue (remitted monthly by Choice Bank)
    summary["outbound_gross"] = round(_ob_gross, 2)     # total fees traders paid (for reference)

    # Prepaid subscription balances — real M-Pesa money received via PARTIAL Paybill payments that
    # haven't yet covered a plan price (so it isn't subscription revenue yet, but it IS money we
    # hold). Makes "merchant paid part of their plan" visible instead of silently sitting per-trader.
    _prepaid = (await db.execute(
        select(func.coalesce(func.sum(Trader.subscription_balance), 0)).where(Trader.subscription_balance > 0)
    )).scalar_one()
    summary["prepaid_held"] = round(float(_prepaid or 0), 2)

    # The B2C/VIP plan (ADVANCED) is hidden from the public plan catalogue, so the
    # frontend's `plans` list has no card for it — but the admin revenue page must
    # still track it. Surface its price + label from PLAN_CONFIG (never hardcode a
    # plan price in the frontend) so the B2C card can render server-sourced values.
    from app.services.plans import plan_price, plan_label
    summary["advanced_price"] = plan_price(SubscriptionPlan.ADVANCED)
    summary["advanced_label"] = plan_label(SubscriptionPlan.ADVANCED)

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
            Trader.id.label("trader_id"),
            Trader.full_name.label("trader_name"),
            Trader.email.label("trader_email"),
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
                "trader_id": t.trader_id,
                "plan": t.plan.value if hasattr(t.plan, "value") else str(t.plan),
                "amount": float(t.amount),
                "mpesa_transaction_id": t.mpesa_transaction_id,
                "started_at": t.started_at.isoformat() if t.started_at else None,
                "expires_at": t.expires_at.isoformat() if t.expires_at else None,
                "trader_name": t.trader_name,
                "trader_email": t.trader_email,
                "trader_phone": t.trader_phone,
            }
            for t in txns
        ],
    }


# ── I&M Automation ───────────────────────────────────────────────────────────

@router.get("/im/revenue")
async def im_revenue(
    period: str = Query("all"),   # today | week | month | all
    month: str = Query(""),        # YYYY-MM — a specific past month (overrides period)
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """I&M Automation revenue, split by the two populations that pay it:
    SparkP2P traders (5/7/8/9/10) and bot-only accounts (12).

    Read straight off the charge ledger — im_charges IS the bill, so this can
    never disagree with what was actually charged. Revenue = sum(rate); it is one
    row per payout, each row the KES we took for it."""
    from app.models.im_charge import ImCharge

    now = datetime.now(timezone.utc)
    period_starts = {
        "today": trading_day_start(now),
        "week":  now - timedelta(days=7),
        "month": trading_month_start(now),   # calendar month, resets on the 1st
    }
    start = period_starts.get(period)
    end = None
    if month.strip():   # explicit month picker → bounded [start, end)
        start, end = _month_range(month.strip())
    where = [ImCharge.charged_at >= start] if start else []
    if end:
        where.append(ImCharge.charged_at < end)

    rows = (await db.execute(
        select(
            ImCharge.account_type,
            func.count(ImCharge.id),
            func.coalesce(func.sum(ImCharge.rate), 0),
            func.coalesce(func.sum(ImCharge.payout_amount), 0),
        ).where(*where).group_by(ImCharge.account_type)
    )).all()

    by_pop = {r[0]: {"payouts": int(r[1]), "revenue": int(r[2]), "volume": int(r[3])} for r in rows}
    sparkp2p = by_pop.get("sparkp2p", {"payouts": 0, "revenue": 0, "volume": 0})
    bot_only = by_pop.get("bot_only", {"payouts": 0, "revenue": 0, "volume": 0})

    # DEPOSITS: the KES merchants actually PAID to buy credits (completed
    # CreditPurchase). This is money in the door — it lands at purchase, whereas
    # "revenue" above is only recognised as payouts consume credits. A trader who
    # tops up KES 1,000 but hasn't paid anyone yet shows deposits 1,000, revenue 0.
    from app.models.subscription import CreditPurchase
    dep_where = [CreditPurchase.status == "completed"]
    if start:
        dep_where.append(CreditPurchase.created_at >= start)
    if end:
        dep_where.append(CreditPurchase.created_at < end)
    dep_trader = int((await db.execute(
        select(func.coalesce(func.sum(CreditPurchase.amount), 0))
        .where(*dep_where, CreditPurchase.trader_id.isnot(None))
    )).scalar_one() or 0)
    dep_bot = int((await db.execute(
        select(func.coalesce(func.sum(CreditPurchase.amount), 0))
        .where(*dep_where, CreditPurchase.bot_account_id.isnot(None))
    )).scalar_one() or 0)
    sparkp2p["deposits"] = dep_trader
    bot_only["deposits"] = dep_bot

    return {
        "period": period,
        "sparkp2p": sparkp2p,
        "bot_only": bot_only,
        "total": {
            "payouts": sparkp2p["payouts"] + bot_only["payouts"],
            "revenue": sparkp2p["revenue"] + bot_only["revenue"],
            "volume": sparkp2p["volume"] + bot_only["volume"],
            "deposits": dep_trader + dep_bot,
        },
    }


@router.get("/im/charges")
async def im_charges_list(
    period: str = Query("all"),   # today | week | month | year | all
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """The I&M charge ledger, one row per billed payout — for the Transactions
    tab. Joins each charge to whoever it billed (a trader by name, or a bot-only
    account by email) so the admin sees who paid without a second lookup."""
    from app.models.im_charge import ImCharge
    from app.models.im_bot_account import ImBotAccount

    now = datetime.now(timezone.utc)
    period_starts = {
        "today": trading_day_start(now),
        "week":  now - timedelta(days=7),
        "month": trading_month_start(now),   # calendar month, resets on the 1st
        "year":  now - timedelta(days=365),
    }
    start = period_starts.get(period)
    where = [ImCharge.charged_at >= start] if start else []

    total = (await db.execute(select(func.count()).select_from(ImCharge).where(*where))).scalar_one()

    # Left-join both possible owners; exactly one is set per row.
    rows = (await db.execute(
        select(ImCharge, Trader.full_name, ImBotAccount.email)
        .outerjoin(Trader, Trader.id == ImCharge.trader_id)
        .outerjoin(ImBotAccount, ImBotAccount.id == ImCharge.bot_account_id)
        .where(*where)
        .order_by(ImCharge.charged_at.desc())
        .offset((page - 1) * limit).limit(limit)
    )).all()

    charges = []
    for c, trader_name, bot_email in rows:
        charges.append({
            "id": c.id,
            "order_id": c.order_id,
            "account_type": c.account_type,
            "who": trader_name if c.account_type == "sparkp2p" else (bot_email or "bot-only"),
            "rate": c.rate,
            "payout_amount": c.payout_amount,
            "plan": c.plan,
            "bank_ref": c.bank_ref,
            "charged_at": c.charged_at.isoformat() if c.charged_at else None,
            "status": "completed",
            "channel": None,
            "detail": None,
        })

    # FAILED / PENDING payouts have NO charge row — we only bill a success — so
    # they were structurally invisible here: an admin could not see that a
    # client's payouts were failing at all (a client hit 26 failures before
    # anyone noticed). Merge them in from the im_payouts ledger, billed at 0 and
    # tagged with the reason, so this tab shows what actually happened, not just
    # what earned revenue.
    from app.models.im_payout import ImPayout
    pay_where = [ImPayout.status != "completed"]
    if start:
        pay_where.append(ImPayout.created_at >= start)
    prows = (await db.execute(
        select(ImPayout, Trader.full_name)
        .outerjoin(Trader, Trader.id == ImPayout.trader_id)
        .where(*pay_where)
        .order_by(ImPayout.created_at.desc())
        .limit(limit)
    )).all()
    failed_total = (await db.execute(
        select(func.count()).select_from(ImPayout).where(*pay_where)
    )).scalar_one()

    for p, trader_name in prows:
        charges.append({
            "id": f"p{p.id}",
            "order_id": p.binance_order_number,
            "account_type": "sparkp2p",
            "who": trader_name or "—",
            "rate": 0,                       # a failure is never billed
            "payout_amount": p.amount,
            "plan": None,
            "bank_ref": p.bank_ref,
            "charged_at": p.created_at.isoformat() if p.created_at else None,
            "status": p.status,              # failed | pending
            "channel": p.channel,            # MPESA | BANK
            "detail": ((p.detail or "").replace("\n", " ").replace("\x1b", "")[:160] or None),
        })

    # One time-ordered feed, newest first, so a failure sits next to the payouts
    # around it instead of in a separate list.
    charges.sort(key=lambda c: c.get("charged_at") or "", reverse=True)

    return {
        "total": total,
        "failed_total": failed_total,
        "page": page,
        "limit": limit,
        "charges": charges,
    }


@router.get("/im/accounts")
async def im_bot_accounts(
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """Bot-only registrants — people who use I&M Automation but are NOT SparkP2P
    clients. Kept SEPARATE from the trader list on purpose: they are a different
    population, billed 12, and must not pad the trader counts.

    Each row carries what its bot has billed so an admin can see who is active.
    A row with linked_trader_id has since become a real SparkP2P client — shown
    so a support query is answerable, but they now bill as that trader."""
    from app.models.im_bot_account import ImBotAccount
    from app.models.im_charge import ImCharge
    from app.models.api_key import MerchantApiKey

    total = (await db.execute(select(func.count()).select_from(ImBotAccount))).scalar_one()

    accts = (await db.execute(
        select(ImBotAccount)
        .order_by(ImBotAccount.created_at.desc())
        .offset((page - 1) * limit).limit(limit)
    )).scalars().all()

    out = []
    for a in accts:
        stats = (await db.execute(
            select(func.count(ImCharge.id), func.coalesce(func.sum(ImCharge.rate), 0),
                   func.coalesce(func.sum(ImCharge.payout_amount), 0))
            .where(ImCharge.bot_account_id == a.id)
        )).one()
        from app.models.subscription import CreditPurchase
        deposited = int((await db.execute(
            select(func.coalesce(func.sum(CreditPurchase.amount), 0))
            .where(CreditPurchase.bot_account_id == a.id, CreditPurchase.status == "completed")
        )).scalar_one() or 0)
        last_seen = (await db.execute(
            select(func.max(MerchantApiKey.last_used_at))
            .where(MerchantApiKey.bot_account_id == a.id, MerchantApiKey.revoked_at.is_(None))
        )).scalar_one_or_none()
        out.append({
            "id": a.id,
            "email": a.email,
            "full_name": a.full_name,
            "phone": a.phone,
            "status": a.status,
            "verified": a.email_verified_at is not None,
            "linked_trader_id": a.linked_trader_id,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "last_login_at": a.last_login_at.isoformat() if a.last_login_at else None,
            "last_seen": last_seen.isoformat() if last_seen else None,
            "credits": int(getattr(a, "credits", 0) or 0),
            "deposited": deposited,
            "payouts": int(stats[0] or 0),
            "revenue": int(stats[1] or 0),
            "volume": int(stats[2] or 0),
            "rate": 12,   # bot-only is always 12
        })
    return {"total": total, "page": page, "limit": limit, "accounts": out}


@router.get("/im/traders")
async def im_configured_traders(
    period: str = Query("all"),   # today | week | month | all
    admin: Trader = Depends(get_employee_or_admin),
    db: AsyncSession = Depends(get_db),
):
    """SparkP2P clients who have configured I&M Automation — i.e. they hold a live
    im_bot key, minted from their own Settings. Separate from the bot-only list:
    these ARE traders, and they bill at their PLAN rate, not the flat 12.

    Each row carries the rate resolved from their REAL subscription state
    (rate_for_trader → active_plan, never billing_active), so the admin sees
    exactly what a Bronze merchant pays (4), Silver (5), Gold (7), a B2C/VIP
    client (5), and an unsubscribed trader on the intro allowance (10 → 12)."""
    from app.models.api_key import MerchantApiKey
    from app.models.im_charge import ImCharge
    from app.services import im_pricing as pricing
    from app.services.api_keys import as_utc

    # Traders with at least one un-revoked im_bot key = "configured I&M".
    trader_ids = (await db.execute(
        select(MerchantApiKey.trader_id)
        .where(MerchantApiKey.trader_id.isnot(None),
               MerchantApiKey.scope == "im_bot",
               MerchantApiKey.revoked_at.is_(None))
        .distinct()
    )).scalars().all()

    if not trader_ids:
        return {"total": 0, "traders": [], "period": period}

    out = []
    now = datetime.now(timezone.utc)
    # Same window the revenue cards use, so the per-trader table agrees with the
    # totals above it. payouts/used/volume/deposited become period-scoped; the
    # bot's current credit balance / online / last-seen stay "now" facts.
    period_starts = {
        "today": trading_day_start(now),
        "week":  now - timedelta(days=7),
        "month": trading_month_start(now),   # calendar month, resets on the 1st
    }
    start = period_starts.get(period)

    from app.models.subscription import CreditPurchase

    # ── Batched aggregates ────────────────────────────────────────────────────
    # This table used to run ~5 sequential DB queries PER trader (an N+1 loop),
    # which is why the admin I&M dashboard felt slow to refresh. Do each lookup
    # ONCE across all traders with GROUP BY, then assemble in Python — so the
    # query count no longer grows with the number of merchants.
    traders_by_id = {
        t.id: t for t in (await db.execute(
            select(Trader).where(Trader.id.in_(trader_ids))
        )).scalars().all()
    }

    _cw = [ImCharge.trader_id.in_(trader_ids)]
    if start:
        _cw.append(ImCharge.charged_at >= start)
    charge_by_id = {
        row.trader_id: (int(row.n or 0), int(row.rev or 0), int(row.vol or 0))
        for row in (await db.execute(
            select(ImCharge.trader_id,
                   func.count(ImCharge.id).label("n"),
                   func.coalesce(func.sum(ImCharge.rate), 0).label("rev"),
                   func.coalesce(func.sum(ImCharge.payout_amount), 0).label("vol"))
            .where(*_cw).group_by(ImCharge.trader_id)
        )).all()
    }

    # What each trader PAID to buy credits (completed top-ups) in the window.
    _dw = [CreditPurchase.trader_id.in_(trader_ids), CreditPurchase.status == "completed"]
    if start:
        _dw.append(CreditPurchase.created_at >= start)
    dep_by_id = {
        row.trader_id: int(row.dep or 0)
        for row in (await db.execute(
            select(CreditPurchase.trader_id,
                   func.coalesce(func.sum(CreditPurchase.amount), 0).label("dep"))
            .where(*_dw).group_by(CreditPurchase.trader_id)
        )).all()
    }

    seen_by_id = {
        row.trader_id: row.seen
        for row in (await db.execute(
            select(MerchantApiKey.trader_id, func.max(MerchantApiKey.last_used_at).label("seen"))
            .where(MerchantApiKey.trader_id.in_(trader_ids),
                   MerchantApiKey.scope == "im_bot",
                   MerchantApiKey.revoked_at.is_(None))
            .group_by(MerchantApiKey.trader_id)
        )).all()
    }

    for tid in trader_ids:
        trader = traders_by_id.get(tid)
        if not trader:
            continue
        # Rate from their real plan (5/7/8/9, or the 10→12 intro allowance).
        # Kept per-trader — it resolves live subscription state.
        info = await pricing.rate_for_trader(db, tid)
        _n, _rev, _vol = charge_by_id.get(tid, (0, 0, 0))
        stats = (_n, _rev, _vol)
        deposited = dep_by_id.get(tid, 0)
        last_seen = seen_by_id.get(tid)
        # Online = the bot polled within the last 3 minutes (its heartbeat).
        online = bool(last_seen and (now - as_utc(last_seen)).total_seconds() < 180) if last_seen else False
        out.append({
            "id": trader.id,
            "full_name": trader.full_name,
            "email": trader.email,
            "phone": trader.phone,
            "plan": info.get("plan"),               # 'pro_max' | 'pro' | 'starter' | 'advanced' | None
            "plan_label": info.get("label"),        # 'Gold' | 'Silver' | 'Bronze' | 'B2C' | 'No subscription…'
            "rate": info.get("rate"),               # 7 | 8 | 9 | 5 | 10 | 12
            "intro_remaining": info.get("intro_remaining", 0),
            "payout_rail": ("own_paybill" if getattr(trader, "b2c_own_paybill_enabled", False)
                            else "im_bot" if getattr(trader, "buy_payout_via_im", False)
                            else "choice_bank"),
            "online": online,
            "last_seen": last_seen.isoformat() if last_seen else None,
            "credits": int(getattr(trader, "b2c_credits", 0) or 0),
            "deposited": deposited,
            "payouts": int(stats[0] or 0),
            "revenue": int(stats[1] or 0),
            "volume": int(stats[2] or 0),
        })

    # Busiest first — most payouts billed.
    out.sort(key=lambda r: r["payouts"], reverse=True)
    return {"total": len(out), "traders": out, "period": period}


# ── Credit / Trade Token Purchases ───────────────────────────────────────────

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
    if period == "today":
        return q.where(model_col >= trading_day_start(now))
    elif period == "week":
        return q.where(model_col >= now - timedelta(days=7))
    elif period == "month":
        return q.where(model_col >= trading_month_start(now))
    elif period == "year":
        return q.where(model_col >= now - timedelta(days=365))
    return q


@router.get("/traders/{trader_id}/bot-logs")
async def get_trader_bot_logs(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Return the most recent bot activity logs for a trader (newest first), from the DB so they
    persist across backend restarts."""
    from app.models.bot_log import BotLog
    rows = (await db.execute(
        select(BotLog).where(BotLog.trader_id == trader_id)
        .order_by(BotLog.created_at.desc()).limit(200)
    )).scalars().all()
    return [{"level": r.level, "message": r.message, "time": r.time} for r in rows]


@router.get("/traders/{trader_id}/pnl")
async def get_trader_pnl(
    trader_id: int,
    period: str = Query("today"),   # today | week | month
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """P&L breakdown for a trader: daily revenue, fees, and net profit."""
    # Trading day boundary is 00:00 UTC (= 03:00 EAT) to match Binance and compute_pnl_daily.
    now = datetime.now(timezone.utc)

    if period == "week":
        since_day = trading_day_start(now - timedelta(days=6))
        days = 7
    elif period == "month":
        since_day = trading_day_start(now - timedelta(days=29))
        days = 30
    else:   # today (and any unknown period)
        since_day = trading_day_start(now)
        days = 1

    # Use the EXACT same per-day calc as the merchant Profit page (compute_pnl_daily over the
    # trader's FULL completed history), then slice out the requested period — so admin figures
    # match the merchant's to the cent. (Previously admin used compute_pnl per-day, a different
    # cost-basis method, which diverged.)
    from app.services.tracking import compute_pnl_daily
    # Use the trader's own configured Binance fee so admin figures match the merchant Profit page.
    _t = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
    _fee = (_t.binance_fee_per_usdt if _t and _t.binance_fee_per_usdt is not None else 0.25)
    orders_result = await db.execute(
        select(Order).where(
            Order.trader_id == trader_id,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
        ).order_by(Order.created_at)
    )
    all_orders = orders_result.scalars().all()
    daily_map = compute_pnl_daily(all_orders, fee_per_usdt=_fee)   # {'YYYY-MM-DD': {gross,fees,net,volume,trades}}

    daily = []
    for i in range(days):
        d = (since_day + timedelta(days=i)).strftime("%Y-%m-%d")
        m = daily_map.get(d, {"gross": 0.0, "fees": 0.0, "net": 0.0, "trades": 0})
        daily.append({
            "date": d,
            "revenue": m["gross"],
            "fees": m["fees"],
            "net": m["net"],
            "trades": m["trades"],
        })

    total_revenue = round(sum(d["revenue"] for d in daily), 2)
    total_fees = round(sum(d["fees"] for d in daily), 2)
    total_net = round(total_revenue - total_fees, 2)
    total_trades = sum(d["trades"] for d in daily)

    # Completed-order counts split by side, over the SAME window the daily slice covers.
    from app.models.order import OrderSide
    period_end = since_day + timedelta(days=days)

    def _in_period(o):
        ca = o.created_at
        if ca is not None and ca.tzinfo is None:
            ca = ca.replace(tzinfo=timezone.utc)
        return ca is not None and since_day <= ca < period_end

    period_orders = [o for o in all_orders if _in_period(o)]
    buy_orders = sum(1 for o in period_orders if o.side == OrderSide.BUY)
    sell_orders = sum(1 for o in period_orders if o.side == OrderSide.SELL)

    return {
        "period": period,
        "daily": daily,
        "summary": {
            "revenue": total_revenue,
            "fees": total_fees,
            "net": total_net,
            "trades": total_trades,
            "buy_orders": buy_orders,
            "sell_orders": sell_orders,
            "completed_orders": len(period_orders),
        },
    }


MPESA_TX_CAP = 250000   # M-Pesa caps a single transaction at KES 250,000 — above that must use a bank/Pesalink

@router.get("/traders/{trader_id}/revenue-sim")
async def get_trader_revenue_sim(
    trader_id: int,
    period: str = Query("today"),   # today | week | month
    method: str = Query("auto"),    # auto (infer by amount) | mpesa | pesalink
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Outbound-fee revenue simulation for a trader, from their completed BUY orders.

    On a buy order WE send KES to the seller out of the trader's Choice Bank account, so that is
    where the outbound fee (and our markup) is earned. For each order:
      merchant_charged = outbound_fee   (Choice base cost + our markup, debited from the trader)
      choice_keeps     = outbound_fee - outbound_markup   (Choice Bank's tariff — see charges PDF)
      our_profit       = outbound_markup (the portion Choice remits to us monthly)

    The seller's payout rail is NOT recorded on historical orders (SparkP2P didn't execute these
    payouts — the merchant did them on Binance), so the rail is INFERRED:
      - method=auto / mpesa: amount <= 250,000 -> M-Pesa, above -> Pesalink (M-Pesa can't exceed the cap)
      - method=pesalink: everything via Pesalink (conservative / flat-fee scenario)
    """
    from app.models.order import OrderSide
    from app.services.outbound_fees import outbound_fee, outbound_markup

    now = datetime.now(timezone.utc)
    if period == "week":
        since_day = trading_day_start(now - timedelta(days=6)); days = 7
    elif period == "month":
        since_day = trading_day_start(now - timedelta(days=29)); days = 30
    else:
        since_day = trading_day_start(now); days = 1
    period_end = since_day + timedelta(days=days)

    # Only orders the bot actually paid out THROUGH Choice Bank carry a real fee (Order.choice_fee,
    # set at payout time in the extension route). Those are the transactions the merchant was
    # genuinely charged for — orders paid any other way have choice_fee == 0 and are excluded.
    rows = (await db.execute(
        select(Order).where(
            Order.trader_id == trader_id,
            Order.side == OrderSide.BUY,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
            Order.choice_fee > 0,
            Order.created_at >= since_day,
            Order.created_at < period_end,
        )
    )).scalars().all()

    def rail_of(o) -> str:
        # The rail the bot actually used for the seller payout, recorded on the order.
        sm = (o.seller_payment_method or "").lower()
        return "MPESA" if ("mpesa" in sm or "safaricom" in sm) else "PESALINK"

    def _blank():
        return {"count": 0, "volume": 0.0, "merchant_charged": 0, "choice_keeps": 0, "our_profit": 0}

    channels = {"MPESA": _blank(), "PESALINK": _blank()}

    for o in rows:
        rail = rail_of(o)
        # The method segment filters to one rail; 'auto' shows both.
        if method in ("mpesa", "pesalink") and rail != method.upper():
            continue
        amt = float(o.fiat_amount or 0)
        fee = float(o.choice_fee or 0)          # ACTUAL KES withheld by Choice Bank on this payout
        markup = outbound_markup(rail, amt)     # our tariff portion (remitted to us monthly)
        c = channels[rail]
        c["count"] += 1
        c["volume"] += amt
        c["merchant_charged"] += fee
        c["our_profit"] += markup
        c["choice_keeps"] += max(fee - markup, 0)

    total = _blank()
    for c in channels.values():
        for k in total:
            total[k] += c[k]
    for c in list(channels.values()) + [total]:
        c["volume"] = round(c["volume"], 2)

    return {"period": period, "method": method, "inferred": False, "channels": channels, "total": total}


@router.get("/traders/{trader_id}/revenue-detail")
async def get_trader_revenue_detail(
    trader_id: int,
    period: str = Query("today"),   # today | week | month
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Everything this trader has earned us, in four segments:

      choice_bank   — outbound Choice Bank fees, broken down by PRODUCT (only the
                      products they actually used appear), INCLUDING withdrawals of
                      their own float. charged / choice_keeps / our_profit.
      credits       — I&M Automation credits they consumed (KES of credit spent).
      subscriptions — their subscription payment ledger (recent).
      im            — their I&M credit top-ups: KES deposited + credits bought.

    choice_bank and credits are scoped to the period; subscriptions and im are
    infrequent ledgers, shown as recent history regardless of period.
    """
    from app.models.order import OrderSide
    from app.models import Payment, PaymentDirection, PaymentStatus
    from app.models.subscription import CreditPurchase, Subscription
    from app.models.im_charge import ImCharge
    from app.services.outbound_fees import (
        categorize, product_cb_fee, product_markup, product_total_fee,
        outbound_markup, PRODUCTS,
    )
    from app.services.plans import plan_label as _plan_label

    now = datetime.now(timezone.utc)
    if period == "week":
        start = trading_day_start(now - timedelta(days=6)); days = 7
    elif period == "month":
        start = trading_day_start(now - timedelta(days=29)); days = 30
    else:
        start = trading_day_start(now); days = 1
    end = start + timedelta(days=days)

    # ── 1. Choice Bank outbound fees, by product ─────────────────────────────
    prods: dict[str, dict] = {}
    def _bump(prod, count, volume, charged, keeps, profit):
        d = prods.setdefault(prod, {"count": 0, "volume": 0.0, "charged": 0.0, "keeps": 0.0, "profit": 0.0})
        d["count"] += count; d["volume"] += volume
        d["charged"] += charged; d["keeps"] += keeps; d["profit"] += profit

    # Seller payouts come from the orders (order.choice_fee is the ACTUAL fee).
    rail_product = {"MPESA": "B2C", "PESALINK": "PESALINK"}
    buy_rows = (await db.execute(
        select(Order.fiat_amount, Order.choice_fee, Order.seller_payment_method).where(
            Order.trader_id == trader_id, Order.side == OrderSide.BUY,
            Order.choice_fee > 0, Order.created_at >= start, Order.created_at < end,
        )
    )).all()
    for amt, fee, sm in buy_rows:
        amt = float(amt or 0); fee = float(fee or 0)
        rail = "MPESA" if ("mpesa" in (sm or "").lower() or "safaricom" in (sm or "").lower()) else "PESALINK"
        markup = outbound_markup(rail, amt)
        _bump(rail_product[rail], 1, amt, fee, max(fee - markup, 0), markup)

    # Everything else outbound (withdrawals, paybill, manual send-money) from the
    # Payment ledger — categorised by product. BUY seller-payout rows are already
    # counted above, so exclude them; withdrawals STAY (we earn a markup on them).
    _rem = func.coalesce(Payment.remarks, "")
    pay_rows = (await db.execute(
        select(Payment.amount, Payment.transaction_type, Payment.destination_type).where(
            Payment.trader_id == trader_id,
            Payment.direction == PaymentDirection.OUTBOUND,
            Payment.status != PaymentStatus.FAILED,
            ~_rem.ilike("BUY %"),
            Payment.created_at >= start, Payment.created_at < end,
        )
    )).all()
    for amt, tt, dt in pay_rows:
        prod = categorize(tt, dt)
        if prod not in PRODUCTS:
            continue
        amt = abs(float(amt or 0))
        cb = product_cb_fee(prod, amt); mk = product_markup(prod, amt)
        _bump(prod, 1, amt, cb + mk, cb, mk)

    products = []
    cb_total = {"count": 0, "volume": 0.0, "charged": 0.0, "keeps": 0.0, "profit": 0.0}
    for key, d in prods.items():
        if d["count"] == 0:
            continue
        products.append({
            "key": key, "label": PRODUCTS.get(key, key),
            "count": d["count"], "volume": round(d["volume"], 2),
            "charged": round(d["charged"]), "keeps": round(d["keeps"]), "profit": round(d["profit"]),
        })
        for k in cb_total: cb_total[k] += d[k]
    products.sort(key=lambda p: p["profit"], reverse=True)
    cb_total = {k: (round(v, 2) if k == "volume" else round(v)) for k, v in cb_total.items()}

    # ── 2. I&M credits consumed (period) ─────────────────────────────────────
    cr = (await db.execute(
        select(func.count(ImCharge.id), func.coalesce(func.sum(ImCharge.rate), 0),
               func.coalesce(func.sum(ImCharge.payout_amount), 0))
        .where(ImCharge.trader_id == trader_id, ImCharge.charged_at >= start, ImCharge.charged_at < end)
    )).one()
    credits = {"used_kes": int(cr[1] or 0), "payouts": int(cr[0] or 0), "volume": int(cr[2] or 0)}

    # ── 3. Subscription payments — REAL, successful, deduped ──────────────────
    # A single M-Pesa payment can spawn several subscription rows (a plan switch
    # leaves a cancelled + an active row on the SAME receipt), and admin-granted
    # plans carry a placeholder ref "ADMIN_GRANT" — no money changed hands. So a
    # "payment" is a row with a genuine M-Pesa code, deduped by that code, kept
    # only when it actually took (active / expired). That strips the noise the
    # admin was seeing (cancelled, cancelled, cancelled) down to what was paid.
    _status_rank = {"active": 3, "expired": 2, "pending": 1, "cancelled": 0}
    def _sval(s):
        return (s.status.value if hasattr(s.status, "value") else str(s.status)).lower()
    all_subs = (await db.execute(
        select(Subscription).where(Subscription.trader_id == trader_id)
        .order_by(Subscription.created_at.desc())
    )).scalars().all()
    by_ref: dict[str, object] = {}
    for s in all_subs:
        ref = (s.mpesa_transaction_id or "").strip()
        if not ref or ref.upper() == "ADMIN_GRANT":
            continue                      # not a real money payment
        cur = by_ref.get(ref)
        if cur is None or _status_rank.get(_sval(s), 0) > _status_rank.get(_sval(cur), 0):
            by_ref[ref] = s               # keep the best-status row for this receipt
    paid_subs = [s for s in by_ref.values() if _sval(s) in ("active", "expired")]
    paid_subs.sort(key=lambda s: (s.started_at or s.created_at or now), reverse=True)

    subscriptions = [{
        "plan": (s.plan.value if hasattr(s.plan, "value") else str(s.plan)),
        "label": _plan_label(s.plan),
        "amount": int(s.amount or 0),
        "status": _sval(s),
        "ref": (s.mpesa_transaction_id or "").strip(),
        "date": (s.started_at or s.created_at).isoformat() if (s.started_at or s.created_at) else None,
        "expires": s.expires_at.isoformat() if s.expires_at else None,
    } for s in paid_subs]

    # Subscription revenue that lands IN the period (counted on the pay date).
    sub_period = 0
    for s in paid_subs:
        when = s.started_at or s.created_at
        if when and start <= when < end:
            sub_period += int(s.amount or 0)

    # ── 4. I&M credit top-ups ────────────────────────────────────────────────
    tops = (await db.execute(
        select(CreditPurchase).where(
            CreditPurchase.trader_id == trader_id, CreditPurchase.status == "completed")
        .order_by(CreditPurchase.created_at.desc()).limit(12)
    )).scalars().all()
    im_purchases = [{
        "amount": int(p.amount or 0), "credits": int(p.credits or 0),
        "ref": (p.mpesa_receipt or "").strip(),      # M-Pesa code the deposit came in on
        "date": p.created_at.isoformat() if p.created_at else None,
    } for p in tops]
    im = {
        "deposited": sum(p["amount"] for p in im_purchases),
        "credits_purchased": sum(p["credits"] for p in im_purchases),
        "purchases": im_purchases,
    }
    # I&M deposits that land IN the period (for the revenue total).
    im_period = int((await db.execute(
        select(func.coalesce(func.sum(CreditPurchase.amount), 0)).where(
            CreditPurchase.trader_id == trader_id, CreditPurchase.status == "completed",
            CreditPurchase.created_at >= start, CreditPurchase.created_at < end)
    )).scalar_one() or 0)

    # ── Total revenue this period ────────────────────────────────────────────
    # subscription paid + our Choice Bank profit + I&M money deposited. Credits
    # are NOT added — they are prepaid via the I&M deposit already counted here;
    # the credits segment only breaks down how that prepaid balance is spent.
    total_revenue = {
        "subscription": sub_period,
        "choice_bank": int(cb_total["profit"]),
        "im": im_period,
        "total": sub_period + int(cb_total["profit"]) + im_period,
    }

    return {
        "period": period,
        "total_revenue": total_revenue,
        "choice_bank": {"products": products, "total": cb_total},
        "credits": credits,
        "subscriptions": subscriptions,
        "im": im,
    }


@router.get("/traders/{trader_id}/activity")
async def get_trader_activity(
    trader_id: int,
    period: str = Query("24h"),   # 24h | 7d | 30d
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Completed-trade count + KES volume for a trader over a rolling window (for the trader-detail
    Total Trades / Volume filter). 'Lifetime' is shown from the trader's own totals on the client."""
    from sqlalchemy import func
    now = datetime.now(timezone.utc)
    # Trading day resets at 00:00 UTC (= 03:00 EAT), matching Binance / the daily trade counter.
    # So "24h" means "today since the reset" (not a rolling 24h window that bleeds into yesterday),
    # and 7d/30d are the last N calendar days aligned to that same daily boundary.
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "7d":
        since = today_start - timedelta(days=6)
    elif period == "30d":
        since = today_start - timedelta(days=29)
    else:  # "24h" → today
        since = today_start

    row = (await db.execute(
        select(func.count(Order.id), func.coalesce(func.sum(Order.fiat_amount), 0)).where(
            Order.trader_id == trader_id,
            Order.status.in_([OrderStatus.COMPLETED, OrderStatus.RELEASED]),
            Order.created_at >= since,
        )
    )).one()

    return {"period": period, "trades": int(row[0] or 0), "volume": float(row[1] or 0)}


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

# ── Diagnostics: does the relay forward the Cookie header? ─────────────────────

@router.post("/diag/relay-echo")
async def diag_relay_echo(body: dict, admin: Trader = Depends(get_admin_trader)):
    """Relay a GET to httpbin.org/headers with a test Cookie, through the trader's device, to see
    whether the Cookie header survives the relay agent's HTTP client (Electron fetch may strip it)."""
    from app.services.binance import relay_router
    tid = int(body.get("trader_id", 1))
    try:
        r = await relay_router.execute(tid, "/headers", {}, None,
                                       {"Cookie": "sparktest=HELLO123", "X-Probe": "yes"},
                                       method="GET", host="https://httpbin.org")
        if isinstance(r, dict):
            echoed = r.get("headers", {})
            return {"type": "dict", "cookie_seen": echoed.get("Cookie", "*** STRIPPED ***"),
                    "xprobe_seen": echoed.get("X-Probe", "absent")}
        return {"type": type(r).__name__, "raw": str(r)[:600]}
    except Exception as e:
        return {"error": str(e)}


# ── Diagnostics: cookie-hybrid chat send ──────────────────────────────────────

class ChatSendProbeRequest(BaseModel):
    trader_id: int
    order_number: str
    message: str = "Test message from SparkP2P"


@router.post("/diag/chat-send")
async def diag_chat_send(
    body: ChatSendProbeRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Cookie-hybrid probe: send a chat message to a Binance order using the trader's STORED cookies,
    routed through their device's relay. Confirms the one thing the API can't do works end-to-end."""
    from app.services.binance.sapi_client import send_chat_via_relay
    trader = (await db.execute(select(Trader).where(Trader.id == body.trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(404, "Trader not found")
    out = {"trader_id": trader.id, "order_number": body.order_number}
    try:
        out["result"] = await send_chat_via_relay(trader, body.order_number, body.message)
    except Exception as e:
        out["error"] = str(e)
    return out


# ── Diagnostics: can we release crypto via the official API? ───────────────────

class ReleaseProbeRequest(BaseModel):
    trader_id: int
    order_number: str
    # action: "check" (read-only EP-12, default), "release" (EP-20, moves crypto),
    #         "mark_paid" (EP-17), "cancel" (EP-9). Anything other than "check" is a REAL action.
    action: str = "check"
    auth_type: str = None   # for release, if 2FA is required (e.g. Binance's authType value)
    code: str = None        # for release, an explicit 2FA code (overrides use_totp)
    use_totp: bool = False  # for release, auto-generate the code from the trader's stored TOTP secret


@router.post("/diag/c2c-release-check")
async def diag_c2c_release_check(
    body: ReleaseProbeRequest,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Phase-1 probe harness for the official Binance order-action endpoints, routed via the trader's
    relay. action='check' (default) runs EP-12 checkIfCanReleaseCoin (READ-ONLY); 'release' (EP-20),
    'mark_paid' (EP-17) and 'cancel' (EP-9) perform the REAL action. Returns the raw Binance envelope
    so we can see whether the family works for this account and what (if any) 2FA it demands."""
    from app.core.security import decrypt_data
    from app.services.binance import sapi_client as S
    from app.services.binance.sapi_client import relay_trader

    trader = (await db.execute(select(Trader).where(Trader.id == body.trader_id))).scalar_one_or_none()
    if not trader:
        raise HTTPException(404, "Trader not found")
    if not trader.binance_api_key or not trader.binance_api_secret:
        raise HTTPException(400, "Trader has no Binance API key/secret on file")

    relay_trader.set(trader.id)   # route via this trader's desktop/phone (per_trader mode)
    api_key = decrypt_data(trader.binance_api_key)
    api_secret = decrypt_data(trader.binance_api_secret)
    ono = body.order_number
    out = {"trader_id": trader.id, "order_number": ono, "action": body.action}
    try:
        # The read-only eligibility check is always safe and informative — run it every time.
        out["check_if_can_release"] = await S.check_if_can_release(api_key, api_secret, ono)
        if body.action == "release":
            code = body.code
            if body.use_totp and not code:
                import pyotp
                sec = None
                for f in ("binance_2fa_secret", "totp_secret"):
                    v = getattr(trader, f, None)
                    if v:
                        try:
                            sec = decrypt_data(v)
                            out["totp_source"] = f
                            break
                        except Exception:
                            pass
                if sec:
                    code = pyotp.TOTP(sec).now()
                    out["totp_used"] = True
                else:
                    out["totp_used"] = False
            out["release_coin"] = await S.release_coin(api_key, api_secret, ono, auth_type=body.auth_type, code=code)
        elif body.action == "mark_paid":
            out["mark_order_as_paid"] = await S.mark_order_as_paid(api_key, api_secret, ono)
        elif body.action == "cancel":
            out["cancel_order"] = await S.cancel_order(api_key, api_secret, ono)
    except Exception as e:
        out["error"] = str(e)
    return out


# ── KYC Admin Routes — append to admin.py ─────────────────────────────────────

@router.get("/kyc/traders")
async def admin_list_kyc_traders(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all traders and their Choice Bank KYC status from DB."""
    from app.models.kyc_submission import KycSubmission

    result = await db.execute(select(Trader).order_by(Trader.id))
    traders = result.scalars().all()

    # Pre-fetch onboarding IDs for staging:otp_pending traders (stored in kyc_submissions, not trader row)
    staging_ids = [t.id for t in traders if (t.choice_kyc_status or "") == "staging:otp_pending"]
    staging_onboarding = {}
    if staging_ids:
        sub_res = await db.execute(
            select(KycSubmission.trader_id, KycSubmission.choice_onboarding_id)
            .where(KycSubmission.trader_id.in_(staging_ids))
            .where(KycSubmission.choice_onboarding_id.isnot(None))
            .order_by(KycSubmission.id.desc())
        )
        for row in sub_res.all():
            if row.trader_id not in staging_onboarding:
                staging_onboarding[row.trader_id] = row.choice_onboarding_id

    data = []
    for t in traders:
        onboarding_id = None
        ks = t.choice_kyc_status or ""
        if ks.startswith("pending:"):
            onboarding_id = ks[len("pending:"):]
        elif ks.startswith("onboarding:"):
            onboarding_id = ks[len("onboarding:"):]
        elif ks == "staging:otp_pending":
            onboarding_id = staging_onboarding.get(t.id)

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

    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice

    ks = trader.choice_kyc_status or ""
    onboarding_id = None
    if ks.startswith("pending:"):
        onboarding_id = ks[len("pending:"):]
    elif ks.startswith("onboarding:"):
        onboarding_id = ks[len("onboarding:"):]
    elif ks == "staging:otp_pending":
        # Onboarding ID lives in kyc_submissions for this state
        sub_res = await db.execute(
            select(KycSubmission)
            .where(KycSubmission.trader_id == trader_id)
            .where(KycSubmission.choice_onboarding_id.isnot(None))
            .order_by(KycSubmission.id.desc())
            .limit(1)
        )
        _sub = sub_res.scalar_one_or_none()
        if _sub:
            onboarding_id = _sub.choice_onboarding_id

    if not onboarding_id:
        raise HTTPException(status_code=404, detail="No pending onboarding ID for this trader")

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

    # Auto-update DB when live check reveals a terminal state so badge refreshes immediately.
    if status_int == 3:  # Passed → approved
        aid = status_data.get("accountId") or ""
        was_approved = (trader.choice_kyc_status or "") == "approved"
        if not was_approved:
            trader.choice_account_id = aid or onboarding_id
            trader.choice_account_number = aid
            trader.choice_kyc_status = "approved"
            # Update the matching submission too
            sub_res2 = await db.execute(
                select(KycSubmission)
                .where(KycSubmission.trader_id == trader_id)
                .where(KycSubmission.choice_onboarding_id == onboarding_id)
                .limit(1)
            )
            _sub2 = sub_res2.scalar_one_or_none()
            if _sub2:
                _sub2.status = "approved"
            await db.commit()
            # Notify trader via Telegram, email and SMS
            try:
                from app.api.routes.telegram import notify_trader
                from app.core.config import settings as _s
                _tg = (
                    "\U0001f389 Your Choice Bank account is approved!" + chr(10) +
                    "Account ID: " + (aid or "—") + chr(10) +
                    "Paybill: " + _s.CHOICE_BANK_PAYBILL + " | Account No: " + (aid or "—") + chr(10) +
                    "You can now receive payments directly to your Choice Bank account."
                )
                await notify_trader(trader, _tg)
            except Exception as _e:
                logger.warning(f"[Admin KYC Sync] Telegram notify failed: {_e}")
            try:
                from app.services.email import send_email
                from app.core.config import settings as _s
                _html = (
                    "<h2>\U0001f389 Choice Bank Account Approved!</h2>"
                    "<p>Hi " + (trader.full_name or "Trader") + ",</p>"
                    "<p>Your <strong>Choice Bank account</strong> has been approved on SparkP2P.</p>"
                    "<table style='border-collapse:collapse'>"
                    "<tr><td style='padding:6px 12px;color:#6b7280'>Account ID</td>"
                    "<td style='padding:6px 12px;font-weight:700'>" + (aid or "—") + "</td></tr>"
                    "<tr><td style='padding:6px 12px;color:#6b7280'>Paybill</td>"
                    "<td style='padding:6px 12px;font-weight:700'>" + _s.CHOICE_BANK_PAYBILL + "</td></tr>"
                    "<tr><td style='padding:6px 12px;color:#6b7280'>Account No</td>"
                    "<td style='padding:6px 12px;font-weight:700'>" + (aid or "—") + "</td></tr>"
                    "</table>"
                    "<p>Log in to SparkP2P to view your account details.</p>"
                )
                await send_email(trader.email, "Choice Bank Account Approved — SparkP2P", _html)
            except Exception as _e:
                logger.warning(f"[Admin KYC Sync] Email notify failed: {_e}")
            try:
                from app.services.sms import send_otp_sms
                from app.core.config import settings as _s
                _sms = "SparkP2P: Choice Bank account approved! Acct: " + (aid or "N/A") + ". Paybill " + _s.CHOICE_BANK_PAYBILL + "."
                await send_otp_sms(trader.phone, _sms)
            except Exception as _e:
                logger.warning(f"[Admin KYC Sync] SMS notify failed: {_e}")
    elif status_int == 4 or profile_int == 3:  # Rejected or profile check Declined
        if (trader.choice_kyc_status or "") != "rejected":
            trader.choice_kyc_status = "rejected"
            await db.commit()

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


@router.post("/kyc/reset/{trader_id}")
async def admin_reset_kyc(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Reset a trader's KYC status to null so they can re-apply via the mobile KYC flow."""
    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Trader already has an approved Choice Bank account — cannot reset")
    old_status = trader.choice_kyc_status
    trader.choice_kyc_status = None
    await db.commit()
    await write_audit_log(db, admin, "reset_kyc", target_trader_id=trader_id, detail=f"reset choice_kyc_status from '{old_status}' to null for {trader.full_name}")
    logger.warning(f"[Admin] KYC reset for trader {trader_id} ({trader.full_name}) by {admin.full_name} — was: {old_status}")
    return {"status": "ok", "trader_id": trader_id, "trader_name": trader.full_name, "previous_status": old_status}


# ── KYC Contact Verification (post-approval) ──────────────────────────────────

class VerifyContactBody(BaseModel):
    verify_type: str  # "email" or "mobile"


@router.post("/kyc/traders/{trader_id}/verify-contact")
async def admin_verify_trader_contact(
    trader_id: int,
    body: VerifyContactBody,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Trigger Choice Bank contact verification for an approved trader.
    Sends an OTP to their email or phone — confirm with /confirm-contact-verify."""
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice

    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    # Get ID number from latest submission
    sub_res = await db.execute(
        select(KycSubmission)
        .where(KycSubmission.trader_id == trader_id)
        .order_by(KycSubmission.id.desc())
        .limit(1)
    )
    sub = sub_res.scalar_one_or_none()
    if not sub or not sub.id_number:
        raise HTTPException(status_code=400, detail="No KYC submission with ID number found for this trader")

    if body.verify_type == "email":
        result = await choice.verify_email_address(document_number=sub.id_number)
    elif body.verify_type == "mobile":
        result = await choice.verify_mobile_number(document_number=sub.id_number)
    else:
        raise HTTPException(status_code=400, detail="verify_type must be 'email' or 'mobile'")

    if result.get("code") not in ("00000", None) and result.get("code") != "00000":
        code = result.get("code", "")
        msg = result.get("msg", "Verification request failed")
        if code:
            raise HTTPException(status_code=400, detail=f"Choice Bank error {code}: {msg}")

    application_id = (result.get("data") or {}).get("applicationId") or result.get("applicationId") or ""
    logger.warning(f"[Admin] Contact verify triggered for trader {trader_id} ({trader.full_name}) type={body.verify_type} appId={application_id} code={result.get('code')}")
    return {
        "status": "otp_sent",
        "verify_type": body.verify_type,
        "application_id": application_id,
        "trader_name": trader.full_name,
        "choice_response": result,
    }


class ConfirmContactVerifyBody(BaseModel):
    application_id: str
    otp: str


@router.post("/kyc/traders/{trader_id}/confirm-contact-verify")
async def admin_confirm_trader_contact_verify(
    trader_id: int,
    body: ConfirmContactVerifyBody,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Confirm the OTP sent by /verify-contact to mark email/mobile as verified."""
    from app.services.choice_bank import client as choice

    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    result = await choice.confirm_contact_verify(body.application_id.strip(), body.otp.strip())
    code = result.get("code", "")
    if code != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", f"OTP confirmation failed (code {code})"))

    logger.warning(f"[Admin] Contact verify confirmed for trader {trader_id} ({trader.full_name}) appId={body.application_id}")
    return {"status": "verified", "trader_name": trader.full_name}


# ── OTP Email Setup: change all Choice Bank sub-account emails to otp+LAST4@otp.sparkp2p.com ──

OTP_EMAIL_DOMAIN = "otp.sparkp2p.com"

# Tracks pending email-change applications awaiting admin OTP entry.
# Choice Bank sends the OTP to the OLD email, so the admin must enter it manually.
# trader_id -> {application_id, new_email, account_last_4}
_email_change_apps: dict[int, dict] = {}


@router.post("/choice/traders/{trader_id}/initiate-email-change")
async def admin_initiate_email_change(
    trader_id: int,
    body: dict = {},
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 1 of 2: Tell Choice Bank to change a trader's email to otp+LAST4@otp.sparkp2p.com.
    Choice Bank sends the verification OTP to the trader's OLD email.
    Returns the new email and the old email so the admin knows where to look.
    Body: { id_number?: string }  — optional override when KYC submission has no ID on file.
    Call confirm-email-change with the OTP to complete.
    """
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice

    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Trader has no Choice Bank account")

    # Use explicitly provided ID number, or fall back to KYC submission
    id_number = str(body.get("id_number") or "").strip() if body else ""
    if not id_number:
        sub_res = await db.execute(
            select(KycSubmission)
            .where(KycSubmission.trader_id == trader_id)
            .order_by(KycSubmission.id.desc())
            .limit(1)
        )
        sub = sub_res.scalar_one_or_none()
        id_number = (sub.id_number or "").strip() if sub else ""
    if not id_number:
        raise HTTPException(status_code=400, detail="No KYC submission with ID number for this trader. Provide id_number in request body.")

    account_last_4 = str(trader.choice_account_id)[-4:]
    new_email = f"otp+{account_last_4}@{OTP_EMAIL_DOMAIN}"

    result = await choice.add_or_update_email(document_number=id_number, email=new_email)
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "addOrUpdateEmail failed"))

    application_id = (result.get("data") or {}).get("applicationId") or ""
    _email_change_apps[trader_id] = {
        "application_id": application_id,
        "new_email": new_email,
        "account_last_4": account_last_4,
    }
    logger.warning(
        f"[Admin] Email-change initiated for trader {trader_id} ({trader.full_name}) "
        f"→ {new_email} | appId={application_id} | OTP sent to phone {trader.phone}"
    )
    return {
        "application_id": application_id,
        "new_email": new_email,
        "old_email": trader.email or "(unknown)",
        "phone": trader.phone or "(unknown)",
    }


@router.post("/choice/traders/{trader_id}/confirm-email-change")
async def admin_confirm_email_change(
    trader_id: int,
    body: dict,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 2 of 2: Admin enters the OTP the trader received in their old email.
    Confirms the email change with Choice Bank and clears the pending application.
    """
    from app.services.choice_bank import client as choice

    otp = str(body.get("otp") or "").strip()
    if not otp:
        raise HTTPException(status_code=400, detail="otp is required")

    # Frontend sends back application_id it received from initiate step (survives backend restarts)
    application_id = str(body.get("application_id") or "").strip()
    new_email = str(body.get("new_email") or "").strip()

    # Fall back to in-memory store if frontend didn't send it
    if not application_id:
        app_entry = _email_change_apps.get(trader_id)
        if not app_entry:
            raise HTTPException(
                status_code=400,
                detail="No pending email-change application for this trader. Run initiate-email-change first.",
            )
        application_id = app_entry["application_id"]
        new_email = app_entry.get("new_email", "")

    # Try /common/confirmOperation first (used for most OTP flows),
    # fall back to /common/confirmOtp (used by verifyEmailOrMobile) if it fails.
    confirm = await choice.confirm_otp(application_id, otp)
    if confirm.get("code") != "00000":
        confirm = await choice.confirm_contact_verify(application_id, otp)
    if confirm.get("code") != "00000":
        raise HTTPException(status_code=400, detail=confirm.get("msg", "Email verification failed"))

    _email_change_apps.pop(trader_id, None)
    trader = await db.get(Trader, trader_id)
    logger.warning(
        f"[Admin] Email-change confirmed for trader {trader_id} ({trader.full_name if trader else ''}) → {new_email}"
    )
    return {"ok": True, "new_email": new_email}


@router.post("/choice/traders/{trader_id}/setup-otp-email")
async def admin_setup_otp_email(
    trader_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Change a trader's Choice Bank registered email to otp+LAST4@otp.sparkp2p.com,
    then automatically confirm the verification OTP that Choice Bank sends to that email
    (received via Mailgun webhook). The full flow completes in one API call (~10–20s).
    """
    import asyncio
    from app.api.routes.webhooks import pending_email_verifications
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice

    trader = await db.get(Trader, trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Trader has no Choice Bank account")

    sub_res = await db.execute(
        select(KycSubmission)
        .where(KycSubmission.trader_id == trader_id)
        .order_by(KycSubmission.id.desc())
        .limit(1)
    )
    sub = sub_res.scalar_one_or_none()
    if not sub or not sub.id_number:
        raise HTTPException(status_code=400, detail="No KYC submission with ID number for this trader")

    account_last_4 = str(trader.choice_account_id)[-4:]
    new_email = f"otp+{account_last_4}@{OTP_EMAIL_DOMAIN}"

    # Step 1: tell Choice Bank to change the email
    result = await choice.add_or_update_email(
        document_number=sub.id_number,
        email=new_email,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "addOrUpdateEmail failed"))

    application_id = (result.get("data") or {}).get("applicationId") or ""
    logger.warning(f"[Admin] OTP email change initiated for trader {trader_id} → {new_email} appId={application_id}")

    # Step 2: wait for Choice Bank verification OTP to arrive via Mailgun webhook
    event = asyncio.Event()
    pending_email_verifications[account_last_4] = {"event": event, "otp": None}
    try:
        try:
            await asyncio.wait_for(event.wait(), timeout=60.0)
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=408,
                detail=f"Verification email did not arrive within 60s at {new_email}. "
                       f"Check Mailgun is receiving emails for otp.sparkp2p.com.",
            )

        otp = (pending_email_verifications.get(account_last_4) or {}).get("otp")
        if not otp:
            raise HTTPException(status_code=500, detail="Email event fired but no OTP was captured")

        # Step 3: confirm the verification OTP
        confirm = await choice.confirm_contact_verify(application_id, otp)
        if confirm.get("code") != "00000":
            raise HTTPException(status_code=400, detail=confirm.get("msg", "Email verification failed"))

        logger.warning(f"[Admin] OTP email verified for trader {trader_id} ({trader.full_name}) → {new_email}")
        return {
            "ok": True,
            "trader_id": trader_id,
            "trader_name": trader.full_name,
            "email": new_email,
            "account_last_4": account_last_4,
        }
    finally:
        pending_email_verifications.pop(account_last_4, None)


@router.post("/choice/bulk-setup-otp-emails")
async def admin_bulk_setup_otp_emails(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """
    Run setup-otp-email for ALL traders who have a Choice Bank account and a KYC submission.
    Processes one trader at a time. Returns a per-trader result list.
    """
    import asyncio
    from app.api.routes.webhooks import pending_email_verifications
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice

    traders_res = await db.execute(
        select(Trader).where(Trader.choice_account_id.isnot(None))
    )
    traders = traders_res.scalars().all()

    results = []
    for trader in traders:
        account_last_4 = str(trader.choice_account_id)[-4:]
        new_email = f"otp+{account_last_4}@{OTP_EMAIL_DOMAIN}"

        sub_res = await db.execute(
            select(KycSubmission)
            .where(KycSubmission.trader_id == trader.id)
            .order_by(KycSubmission.id.desc())
            .limit(1)
        )
        sub = sub_res.scalar_one_or_none()
        if not sub or not sub.id_number:
            results.append({"trader_id": trader.id, "status": "skipped", "reason": "no KYC ID number"})
            continue

        try:
            result = await choice.add_or_update_email(document_number=sub.id_number, email=new_email)
            if result.get("code") != "00000":
                results.append({"trader_id": trader.id, "status": "error", "reason": result.get("msg")})
                continue

            application_id = (result.get("data") or {}).get("applicationId") or ""
            event = asyncio.Event()
            pending_email_verifications[account_last_4] = {"event": event, "otp": None}

            try:
                await asyncio.wait_for(event.wait(), timeout=60.0)
            except asyncio.TimeoutError:
                results.append({"trader_id": trader.id, "email": new_email, "status": "error", "reason": "verification email timeout"})
                continue
            finally:
                pending_email_verifications.pop(account_last_4, None)

            otp = (pending_email_verifications.get(account_last_4) or {}).get("otp")
            if not otp:
                results.append({"trader_id": trader.id, "status": "error", "reason": "OTP not captured"})
                continue

            confirm = await choice.confirm_contact_verify(application_id, otp)
            if confirm.get("code") != "00000":
                results.append({"trader_id": trader.id, "email": new_email, "status": "error", "reason": confirm.get("msg")})
                continue

            results.append({"trader_id": trader.id, "email": new_email, "status": "ok"})
            logger.warning(f"[Admin] Bulk OTP email setup: trader {trader.id} → {new_email} ✓")

        except Exception as exc:
            results.append({"trader_id": trader.id, "status": "error", "reason": str(exc)})

    return {"results": results}


# ── KYC Staging Submission Admin Routes ────────────────────────────────────────

@router.get("/kyc/submissions")
async def admin_list_kyc_submissions(
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """List all KYC staging submissions (without large image fields)."""
    from app.models.kyc_submission import KycSubmission
    result = await db.execute(
        select(KycSubmission, Trader)
        .join(Trader, KycSubmission.trader_id == Trader.id)
        .order_by(
            # pending_review first, then by newest
            KycSubmission.status.asc(),
            KycSubmission.created_at.desc(),
        )
    )
    rows = result.all()
    return {
        "submissions": [
            {
                "id": sub.id,
                "trader_id": sub.trader_id,
                "trader_name": trader.full_name,
                "trader_phone": trader.phone or "",
                "status": sub.status,
                "first_name": sub.first_name,
                "last_name": sub.last_name,
                "email": sub.email,
                "id_number": sub.id_number,
                "admin_notes": sub.admin_notes or "",
                "created_at": sub.created_at.isoformat() if sub.created_at else None,
                "reviewed_at": sub.reviewed_at.isoformat() if sub.reviewed_at else None,
                "choice_onboarding_id": sub.choice_onboarding_id or "",
                "has_front": bool(sub.front_photo_b64),
                "has_back": bool(sub.back_photo_b64),
                "has_selfie": bool(sub.selfie_b64),
                "has_kra": bool(sub.kra_cert_b64),
            }
            for sub, trader in rows
        ]
    }


@router.get("/kyc/submission/{submission_id}")
async def admin_get_kyc_submission(
    submission_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get full KYC submission including base64 images for admin preview."""
    from app.models.kyc_submission import KycSubmission
    sub = await db.get(KycSubmission, submission_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")
    trader = await db.get(Trader, sub.trader_id)
    return {
        "id": sub.id,
        "trader_id": sub.trader_id,
        "trader_name": trader.full_name if trader else "",
        "trader_phone": trader.phone if trader else "",
        "status": sub.status,
        "first_name": sub.first_name,
        "last_name": sub.last_name,
        "middle_name": sub.middle_name or "",
        "mobile": sub.mobile,
        "id_number": sub.id_number,
        "birthday": sub.birthday,
        "gender": sub.gender,
        "email": sub.email,
        "address": sub.address,
        "kra_pin": sub.kra_pin,
        "employment_status": sub.employment_status,
        "monthly_income": sub.monthly_income,
        "front_photo_b64": sub.front_photo_b64 or "",
        "back_photo_b64": sub.back_photo_b64 or "",
        "selfie_b64": sub.selfie_b64 or "",
        "kra_cert_b64": sub.kra_cert_b64 or "",
        "kra_cert_content_type": sub.kra_cert_content_type or "image",
        "admin_notes": sub.admin_notes or "",
        "choice_onboarding_id": sub.choice_onboarding_id or "",
        "created_at": sub.created_at.isoformat() if sub.created_at else None,
        "reviewed_at": sub.reviewed_at.isoformat() if sub.reviewed_at else None,
    }


class KycRejectBody(BaseModel):
    notes: str = ""


@router.post("/kyc/submission/{submission_id}/reject")
async def admin_reject_kyc_submission(
    submission_id: int,
    body: KycRejectBody,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Reject a KYC submission. Sends email + in-app notification to trader with admin notes."""
    from datetime import datetime
    from app.models.kyc_submission import KycSubmission
    from app.api.deps import log_event
    sub = await db.get(KycSubmission, submission_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")
    trader = await db.get(Trader, sub.trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")

    notes = (body.notes or "").strip() or "Please review and correct your submission."
    sub.status = "rejected"
    sub.admin_notes = notes
    sub.reviewed_at = datetime.utcnow()
    trader.choice_kyc_status = "rejected_admin:" + notes[:200]
    await db.commit()

    await write_audit_log(db, admin, "reject_kyc_submission", target_trader_id=trader.id,
                          detail=f"Rejected KYC sub #{submission_id} for {trader.full_name}. Notes: {notes}")
    logger.warning(f"[Admin] KYC sub #{submission_id} REJECTED for trader {trader.id} ({trader.full_name}) by {admin.full_name}")

    try:
        from app.services.email import send_kyc_rejection_email
        send_kyc_rejection_email(trader.email, trader.full_name, notes)
    except Exception as _e:
        logger.warning(f"[KYC] Rejection email failed: {_e}")

    try:
        await log_event(db, trader.id,
                        f"KYC submission rejected: {notes}. Please log in and resubmit via the Choice Bank setup link.", "warning")
    except Exception as _e:
        logger.warning(f"[KYC] In-app notify failed: {_e}")

    return {"status": "ok", "submission_id": submission_id}


@router.post("/kyc/submission/{submission_id}/approve")
async def admin_approve_kyc_submission(
    submission_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Approve a KYC staging submission: creates Choice Bank account, sends OTP to trader.
    Trader then opens KYC link, enters OTP, and images are uploaded from DB automatically."""
    from datetime import datetime
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice
    sub = await db.get(KycSubmission, submission_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")
    if sub.status not in ("pending_review", "rejected"):
        raise HTTPException(status_code=400, detail=f"Submission is already {sub.status}")
    trader = await db.get(Trader, sub.trader_id)
    if not trader:
        raise HTTPException(status_code=404, detail="Trader not found")
    if trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Trader already has an approved Choice Bank account")

    # 1. Create Current Account via submitOnboardingRequest (includes KRA PIN, employment, income).
    result = await choice.create_current_account(
        user_id=str(trader.id),
        first_name=sub.first_name,
        last_name=sub.last_name,
        middle_name=sub.middle_name or "",
        mobile=sub.mobile,
        id_number=sub.id_number,
        birthday=sub.birthday,
        gender=sub.gender,
        kra_pin=sub.kra_pin or "",
        employment_status=sub.employment_status or "F",
        monthly_income=sub.monthly_income or "A",
        email=sub.email,
        address=sub.address,
    )
    logger.warning(f"[Admin] KYC approve sub#{submission_id}: create_current_account code={result.get('code')} msg={result.get('msg')}")

    if result.get("code") == "13203":
        raise HTTPException(400, "This ID is already registered with Choice Bank. Use 'Reset KYC' and advise the trader to contact support.")
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg", "Choice Bank onboarding request failed"))

    onboarding_id = (
        result.get("onboardingRequestId")
        or (result.get("data") or {}).get("onboardingRequestId")
        or ""
    )
    if not onboarding_id:
        raise HTTPException(500, "Choice Bank did not return an onboarding ID")

    # 2. Persist onboarding ID immediately so it is not lost if later steps fail.
    sub.choice_onboarding_id = onboarding_id
    trader.choice_kyc_status = "staging:otp_pending"
    await db.commit()

    # 3. Upload KYC media server-side right now — before OTP so documents reach Choice Bank
    #    regardless of whether/when the OTP is confirmed.
    for media_type, b64 in [
        ("KYCF00001", sub.front_photo_b64 or ""),
        ("KYCF00002", sub.back_photo_b64 or ""),
        ("KYCF00006", sub.selfie_b64 or ""),
    ]:
        if not b64:
            logger.warning(f"[Admin] KYC approve sub#{submission_id}: skipping {media_type} — no image stored")
            continue
        upload_res = await choice.upload_kyc_media(onboarding_id, media_type, b64, "image")
        logger.warning(f"[Admin] KYC approve sub#{submission_id}: uploadMedia {media_type} -> code={upload_res.get('code')} msg={upload_res.get('msg') or upload_res.get('message')}")
        if upload_res.get("code") != "00000":
            logger.warning(f"[Admin] KYC approve sub#{submission_id}: {media_type} upload failed but continuing — {upload_res}")

    # 4. Send OTP — both EMAIL and SMS for maximum deliverability.
    email_res = await choice.send_otp(onboarding_id, "EMAIL")
    logger.warning(f"[Admin] KYC approve sendOtp(EMAIL) -> code={email_res.get('code')}")
    sms_res = await choice.send_otp(onboarding_id, "SMS")
    logger.warning(f"[Admin] KYC approve sendOtp(SMS) -> code={sms_res.get('code')}")
    if email_res.get("code") != "00000" and sms_res.get("code") != "00000":
        raise HTTPException(400, "Choice Bank account created but OTP delivery failed on both email and SMS: " + (sms_res.get("msg") or email_res.get("msg", "OTP error")))
    otp_channel = "both"

    # 5. Mark submission as otp_pending
    sub.status = "otp_pending"
    sub.reviewed_at = datetime.utcnow()
    await db.commit()

    await write_audit_log(db, admin, "approve_kyc_submission", target_trader_id=trader.id,
                          detail=f"Approved KYC sub #{submission_id} for {trader.full_name}, onboarding_id={onboarding_id}")

    # 5. Notify trader to open KYC link and enter OTP
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader,
            "\U0001f3e6 Your KYC has been approved for submission!\n"
            "Choice Bank has sent you a verification code by EMAIL and by SMS.\n"
            "Please open the SparkP2P app, go to Settings → Choice Bank, click ‘Set Up’, and enter the code.\n"
            "⚠️ Check your email spam folder if you don’t see it in your inbox."
        )
    except Exception as _e:
        logger.warning(f"[KYC] Approval notify Telegram failed: {_e}")

    try:
        from app.services.email import send_kyc_approved_for_otp_email
        send_kyc_approved_for_otp_email(trader.email, trader.full_name, otp_channel)
    except Exception as _e:
        logger.warning(f"[KYC] Approval notify email failed: {_e}")

    return {"status": "ok", "onboarding_id": onboarding_id, "otp_channel": otp_channel}


class AdminKycOtpBody(BaseModel):
    otp: str


@router.post("/kyc-submissions/{submission_id}/confirm-otp")
async def admin_confirm_kyc_otp(
    submission_id: int,
    body: AdminKycOtpBody,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Admin confirms Choice Bank OTP on behalf of the trader (called after phoning the trader)."""
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice
    sub = await db.get(KycSubmission, submission_id)
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.status != "otp_pending":
        raise HTTPException(400, f"Submission is not awaiting OTP (status: {sub.status})")
    if not sub.choice_onboarding_id:
        raise HTTPException(400, "No onboarding ID on this submission")

    result = await choice.confirm_otp(sub.choice_onboarding_id, body.otp.strip())
    logger.warning(f"[Admin] KYC OTP confirm sub#{submission_id}: code={result.get('code')} msg={result.get('msg')}")
    if result.get("code") != "00000":
        raise HTTPException(400, result.get("msg") or "OTP verification failed — check the code and try again")

    sub.status = "submitted"
    trader = await db.get(Trader, sub.trader_id)
    if trader:
        trader.choice_kyc_status = "pending:" + sub.choice_onboarding_id
    await db.commit()
    await write_audit_log(db, admin, "confirm_kyc_otp", target_trader_id=sub.trader_id,
                          detail=f"Admin confirmed OTP for sub #{submission_id} ({trader.full_name if trader else sub.trader_id})")
    return {"status": "submitted", "onboarding_id": sub.choice_onboarding_id}


@router.post("/kyc-submissions/{submission_id}/resend-otp")
async def admin_resend_kyc_otp(
    submission_id: int,
    admin: Trader = Depends(get_admin_trader),
    db: AsyncSession = Depends(get_db),
):
    """Resend Choice Bank OTP for a submission that is awaiting OTP."""
    from app.models.kyc_submission import KycSubmission
    from app.services.choice_bank import client as choice
    sub = await db.get(KycSubmission, submission_id)
    if not sub or sub.status != "otp_pending":
        raise HTTPException(400, "Submission is not awaiting OTP")
    if not sub.choice_onboarding_id:
        raise HTTPException(400, "No onboarding ID on this submission")

    email_res = await choice.resend_otp(sub.choice_onboarding_id, "EMAIL")
    sms_res = await choice.resend_otp(sub.choice_onboarding_id, "SMS")
    logger.warning(f"[Admin] KYC resend OTP sub#{submission_id}: email={email_res.get('code')} sms={sms_res.get('code')}")
    if email_res.get("code") != "00000" and sms_res.get("code") != "00000":
        raise HTTPException(400, "Failed to resend OTP: " + (sms_res.get("msg") or email_res.get("msg", "error")))
    return {"status": "resent"}


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


@router.get("/choice/account-status/{account_id}")
async def admin_choice_account_status(
    account_id: str,
    admin: Trader = Depends(get_admin_trader),
):
    """Check the live status of any Choice Bank account ID. Returns closed/open/unknown."""
    from app.services.choice_bank import client as _cb
    r = await _cb.get_account_details(account_id)
    code = r.get("code")
    if code == "13000":
        return {"account_id": account_id, "status": "closed", "detail": "Account does not exist — closure approved by Choice Bank."}
    if code == "00000":
        d = r.get("data") or {}
        return {
            "account_id": account_id,
            "status": "open",
            "account_status": d.get("accountStatus"),
            "abnormal_status": d.get("abnormalStatus"),
            "freeze_status": d.get("freezeStatus"),
            "balance": d.get("balance"),
            "currency": d.get("currency"),
            "account_name": d.get("accountName"),
        }
    return {"account_id": account_id, "status": "unknown", "code": code, "msg": r.get("msg")}


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
