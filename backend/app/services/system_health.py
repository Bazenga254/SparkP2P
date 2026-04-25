"""
System Health Monitor
=====================
Tracks consecutive failures for critical external systems (im_bank, mpesa_org).
After FAILURE_THRESHOLD consecutive failures, alerts admin via SMS + email.
Sends recovery alert when a system starts working again.
"""
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

FAILURE_THRESHOLD = 3   # Alert admin after this many consecutive failures

# Per-system in-memory state — resets on service restart (acceptable)
_failure_counts: dict[str, int] = {}     # system -> consecutive failure count
_is_degraded:    dict[str, bool] = {}    # system -> currently degraded?
_last_error:     dict[str, str]  = {}    # system -> last error message
_degraded_since: dict[str, str]  = {}    # system -> ISO timestamp when degraded started

SYSTEMS = {
    "im_bank":   "I&M Bank",
    "mpesa_org": "M-PESA Org Portal",
}


def get_status() -> dict:
    """Return current health status for all systems. Used by /api/system-status."""
    result = {}
    for key, name in SYSTEMS.items():
        result[key] = {
            "name": name,
            "degraded": _is_degraded.get(key, False),
            "consecutive_failures": _failure_counts.get(key, 0),
            "last_error": _last_error.get(key),
            "degraded_since": _degraded_since.get(key),
        }
    return result


def is_degraded(system: str) -> bool:
    return _is_degraded.get(system, False)


async def report_failure(system: str, error: str):
    """Record a failure. Sends admin alert after FAILURE_THRESHOLD consecutive failures."""
    _failure_counts[system] = _failure_counts.get(system, 0) + 1
    _last_error[system] = error
    count = _failure_counts[system]

    logger.warning(f"[SystemHealth] {system} failure #{count}: {error}")

    if count >= FAILURE_THRESHOLD and not _is_degraded.get(system, False):
        _is_degraded[system] = True
        _degraded_since[system] = datetime.now(timezone.utc).isoformat()
        await _alert_admin_degraded(system, count, error)


async def report_success(system: str):
    """Record a success. Sends recovery alert if system was previously degraded."""
    was_degraded = _is_degraded.get(system, False)
    _failure_counts[system] = 0
    _last_error.pop(system, None)

    if was_degraded:
        _is_degraded[system] = False
        _degraded_since.pop(system, None)
        await _alert_admin_recovered(system)


async def _get_admin_contact():
    """Fetch admin phone + email from DB (first trader with is_admin=True)."""
    try:
        from app.core.database import async_session
        from app.models import Trader
        from sqlalchemy import select
        async with async_session() as db:
            result = await db.execute(
                select(Trader).where(Trader.is_admin == True).limit(1)
            )
            admin = result.scalar_one_or_none()
            if admin:
                return admin.phone, admin.email
    except Exception as e:
        logger.warning(f"[SystemHealth] Could not fetch admin contact: {e}")
    return None, None


async def _alert_admin_degraded(system: str, count: int, error: str):
    system_name = SYSTEMS.get(system, system)
    phone, email = await _get_admin_contact()

    logger.error(f"[SystemHealth] ADMIN ALERT: {system_name} degraded after {count} failures")

    if phone:
        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                phone,
                f"SparkP2P ADMIN: {system_name} is DOWN after {count} consecutive failures. "
                f"Trader withdrawals are blocked. Error: {error[:80]}"
            )
        except Exception as e:
            logger.warning(f"[SystemHealth] Admin SMS failed: {e}")

    if email:
        try:
            from app.services.email import send_email
            send_email(
                email,
                f"SparkP2P Admin Alert — {system_name} is Down",
                f"""
                <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                  <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                    <h2 style="color:#ef4444;font-size:20px;margin:0 0 12px;">&#9888;&#65039; System Failure Alert</h2>
                    <p style="color:#9ca3af;font-size:14px;">
                      <strong style="color:#fff;">{system_name}</strong> has failed
                      <strong style="color:#ef4444;">{count} times</strong> in a row.
                      New trader withdrawals are being blocked until the system recovers.
                    </p>
                    <div style="background:#0f1117;border-radius:10px;padding:16px;margin:16px 0;border-left:4px solid #ef4444;">
                      <p style="color:#f59e0b;font-weight:600;margin:0 0 8px;">Last Error</p>
                      <p style="color:#9ca3af;font-size:12px;margin:0;font-family:monospace;word-break:break-all;">{error[:400]}</p>
                    </div>
                    <p style="color:#d1d5db;font-size:13px;">
                      The system will automatically resume and notify you when it recovers.
                      Check the desktop bot logs and {system_name} portal for details.
                    </p>
                  </div>
                </div>
                """,
            )
        except Exception as e:
            logger.warning(f"[SystemHealth] Admin email failed: {e}")


async def _alert_admin_recovered(system: str):
    system_name = SYSTEMS.get(system, system)
    phone, email = await _get_admin_contact()

    logger.info(f"[SystemHealth] {system_name} recovered — notifying admin")

    if phone:
        try:
            from app.services.sms import send_otp_sms
            send_otp_sms(
                phone,
                f"SparkP2P ADMIN: {system_name} has RECOVERED. Trader withdrawals are resuming normally."
            )
        except Exception as e:
            logger.warning(f"[SystemHealth] Admin recovery SMS failed: {e}")

    if email:
        try:
            from app.services.email import send_email
            send_email(
                email,
                f"SparkP2P Admin — {system_name} Recovered",
                f"""
                <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                  <div style="background:#1a1d27;border-radius:12px;padding:32px;">
                    <h2 style="color:#10b981;font-size:20px;margin:0 0 12px;">&#9989; System Recovered</h2>
                    <p style="color:#9ca3af;font-size:14px;">
                      <strong style="color:#fff;">{system_name}</strong> has recovered.
                      Trader withdrawals are resuming normally.
                    </p>
                  </div>
                </div>
                """,
            )
        except Exception as e:
            logger.warning(f"[SystemHealth] Admin recovery email failed: {e}")
