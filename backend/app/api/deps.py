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


async def write_audit_log(
    db: AsyncSession,
    actor: Trader,
    action: str,
    ip_address: str = "",
    target_trader_id: int = None,
    detail: str = None,
):
    """Write an entry to the audit_log table."""
    from app.models.audit_log import AuditLog
    log = AuditLog(
        actor_id=actor.id,
        actor_role=actor.role or ("admin" if actor.is_admin else "trader"),
        action=action,
        target_trader_id=target_trader_id,
        detail=detail,
        ip_address=ip_address,
    )
    db.add(log)
    await db.commit()


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


async def get_admin_trader(
    request: Request,
    trader: Trader = Depends(get_current_trader),
) -> Trader:
    """Ensure current user is an admin. Enforces IP allowlist if configured."""
    if not trader.is_admin:
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
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: your IP is not authorised for admin access",
            )

    return trader


async def get_employee_or_admin(
    trader: Trader = Depends(get_current_trader),
) -> Trader:
    """Ensure current user is an employee or admin."""
    if trader.role not in ("employee", "admin") and not trader.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Employee or admin access required",
        )
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
