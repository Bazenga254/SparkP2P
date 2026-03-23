"""Email service using Brevo (formerly Sendinblue) API."""

import json
import logging
import urllib.request

from app.core.config import settings

logger = logging.getLogger(__name__)


def send_email(to_email: str, subject: str, html_content: str) -> bool:
    """Send email via Brevo API."""
    api_key = settings.BREVO_API_KEY
    if not api_key:
        logger.warning("BREVO_API_KEY not set — email not sent")
        return False

    payload = json.dumps({
        "sender": {
            "name": settings.BREVO_FROM_NAME,
            "email": settings.BREVO_FROM_EMAIL,
        },
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_content,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            "https://api.brevo.com/v3/smtp/email",
            data=payload,
            method="POST",
            headers={
                "api-key": api_key,
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f"Email sent to {to_email}: {resp.status}")
            return resp.status in (200, 201)
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


def send_verification_code(to_email: str, code: str) -> bool:
    """Send email verification code."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px; text-align: center;">
            <h2 style="color: #fff; font-size: 20px; margin: 0 0 8px;">Verify Your Email</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 24px;">
                Enter this code to complete your registration:
            </p>
            <div style="background: #0f1117; border: 2px solid #f59e0b; border-radius: 10px; padding: 16px; margin: 0 auto; max-width: 200px;">
                <span style="font-size: 32px; font-weight: 700; color: #f59e0b; letter-spacing: 8px;">{code}</span>
            </div>
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">
                This code expires in 10 minutes.<br>
                If you didn't request this, please ignore this email.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Verify Your Email", html)
