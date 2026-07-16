from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models import Trader

security = HTTPBearer(auto_error=False)


def get_client_ip(request: Request) -> str:
    """Extract real client IP, respecting X-Forwarded-For from nginx."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Staff actions that should ping the super admin(s) in real time (not just sit in the audit table).
SENSITIVE_AUDIT_ACTIONS = {
    "change_role", "change_status", "change_subscription", "toggle_price_tracker",
    "reset_trader_password", "resolve_payment", "admin_login", "employee_login",
    "denied_action",
}


async def write_audit_log(
    db: AsyncSession,
    actor: Trader,
    action: str,
    ip_address: str = "",
    target_trader_id: int = None,
    detail: str = None,
):
    """Write an entry to the audit_log table; for sensitive staff actions, also alert the super
    admin(s) over Telegram so they know in real time what employees/admins are doing."""
    from app.models.audit_log import AuditLog
    log = AuditLog(
        actor_id=actor.id,
        actor_role=actor.role or ("admin" if actor.is_admin else "trader"),
        action=action,
        target_trader_id=target_trader_id,
        detail=detail,
        # Fall back to the IP stashed on the actor by the admin/staff dependency, so every
        # admin-gated action records the IP without each endpoint having to pass it.
        ip_address=ip_address or getattr(actor, "_client_ip", "") or "",
    )
    db.add(log)
    await db.commit()

    if action in SENSITIVE_AUDIT_ACTIONS or action.endswith("_login_failed") or action.endswith("_login_locked"):
        try:
            await _alert_super_admins(db, actor, action, detail, target_trader_id)
        except Exception:
            pass


async def _alert_super_admins(db, actor, action, detail, target_trader_id):
    """Telegram-ping every super admin (role=admin) about a sensitive action by someone else."""
    from sqlalchemy import select
    res = await db.execute(select(Trader).where(Trader.is_admin == True, Trader.role == "admin"))
    label = (action or "").replace("_", " ").title()
    target = f" — trader #{target_trader_id}" if target_trader_id else ""
    msg = (f"🔔 *SparkP2P admin activity*\n"
           f"{actor.full_name} ({actor.role or 'admin'}): {label}{target}"
           + (f"\n{detail}" if detail else ""))
    for sa in res.scalars().all():
        if sa.id == actor.id or not getattr(sa, "telegram_chat_id", None):
            continue
        try:
            from app.api.routes.telegram import notify_trader
            await notify_trader(sa, msg)
        except Exception:
            pass


async def log_event(db: AsyncSession, trader_id: int, message: str, level: str = "info"):
    """Record a server-side activity-log line on a trader's account (logins, password changes,
    API-key problems, etc.) so it shows in their Logs view and the admin trader-detail logs.
    Best-effort — never breaks the calling request if logging fails."""
    try:
        from app.models.bot_log import BotLog
        from datetime import datetime, timezone
        db.add(BotLog(
            trader_id=trader_id,
            level=(level or "info")[:20],
            message=(message or "")[:500],
            time=datetime.now(timezone.utc).isoformat(),
        ))
        await db.commit()
    except Exception:
        try: await db.rollback()
        except Exception: pass


async def get_current_trader(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> Trader:
    """Get the current authenticated trader from JWT token."""
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated - no token provided",
        )

    payload = decode_access_token(credentials.credentials)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    trader_id = payload.get("sub")
    if not trader_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = await db.execute(
        select(Trader).where(Trader.id == int(trader_id))
    )
    trader = result.scalar_one_or_none()

    if not trader:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trader not found",
        )

    return trader


async def get_current_trader_id(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Lightweight auth — returns the trader id straight from the JWT, WITHOUT
    opening a DB connection. Use for long-lived endpoints (e.g. the relay
    long-poll) so they don't pin a pool connection for the whole request."""
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_access_token(credentials.credentials)
    sub = payload.get("sub") if payload else None
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return int(sub)


async def get_trader_id_from_api_key(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Authenticate software the MERCHANT runs themselves (the I&M Bot) via a
    long-lived API key: `Authorization: Bearer sp2p_…`.

    A JWT cannot do this job — it expires, and the bot runs unattended for weeks
    on a merchant's own machine.

    Like `get_current_trader_id`, this takes NO `Depends(get_db)`: the I&M Bot
    poll is a long-poll, and holding a pooled connection for the whole wait would
    exhaust the pool once several merchants poll back-to-back. `resolve_key`
    opens and closes its own short-lived session instead.

    The key IS the identity — the trader is resolved FROM the key's hash, never
    supplied by the caller.
    """
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    from app.services.api_keys import resolve_key

    trader_id = await resolve_key(credentials.credentials, scope="im_bot", client_ip=get_client_ip(request))
    if trader_id is None:
        # One message for missing/expired/revoked/wrong-scope: never help a
        # caller work out WHICH of those a key is.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or revoked API key")
    return trader_id


async def get_admin_trader(
    request: Request,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
) -> Trader:
    """Ensure current user is an admin. Enforces IP allowlist if configured. Denied attempts by
    staff (e.g. an employee trying an admin-only action) are recorded + alerted."""
    if not trader.is_admin:
        # Log/alert only for staff probing admin-only endpoints (a plain trader hitting these is
        # browser noise, not a security event).
        if (trader.role or "") in ("employee", "admin"):
            await write_audit_log(
                db, trader, "denied_action", ip_address=get_client_ip(request),
                detail=f"denied admin action: {request.method} {request.url.path}",
            )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )

    # IP allowlist check
    from app.core.config import settings
    allowed_ips_raw = settings.ALLOWED_ADMIN_IPS.strip()
    if allowed_ips_raw:
        allowed = [ip.strip() for ip in allowed_ips_raw.split(",") if ip.strip()]
        client_ip = get_client_ip(request)
        if allowed and client_ip not in allowed:
            await write_audit_log(
                db, trader, "denied_action", ip_address=client_ip,
                detail=f"admin IP not authorised: {request.method} {request.url.path}",
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: your IP is not authorised for admin access",
            )

    trader._client_ip = get_client_ip(request)   # used by write_audit_log
    return trader


async def get_employee_or_admin(
    request: Request,
    trader: Trader = Depends(get_current_trader),
) -> Trader:
    """Ensure current user is an employee or admin."""
    if trader.role not in ("employee", "admin") and not trader.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Employee or admin access required",
        )
    trader._client_ip = get_client_ip(request)   # used by write_audit_log
    return trader


async def check_subscription(trader: Trader, db: AsyncSession) -> bool:
    """Check if trader has active subscription."""
    from app.models.subscription import Subscription, SubscriptionStatus
    result = await db.execute(
        select(Subscription).where(
            Subscription.trader_id == trader.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        ).order_by(Subscription.expires_at.desc())
    )
    sub = result.scalar_one_or_none()
    if sub and sub.is_active:
        return True
    return False
