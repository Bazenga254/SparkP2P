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


def send_payment_method_added(to_email: str, trader_name: str, method: str, destination: str) -> bool:
    """Notify trader that a new payment/settlement method was added."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #fff; font-size: 20px; margin: 0 0 8px;">Payment Method Updated</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, a settlement method was updated on your account.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Method</span>
                    <span style="color: #fff; font-size: 13px; font-weight: 600;">{method}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">Destination</span>
                    <span style="color: #fff; font-size: 13px; font-weight: 600;">{destination}</span>
                </div>
            </div>
            <p style="color: #ef4444; font-size: 12px; margin: 0;">
                If you did not make this change, please login immediately and update your password.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Payment Method Updated", html)


def send_binance_connected(to_email: str, trader_name: str, binance_name: str) -> bool:
    """Notify trader that their Binance account was connected."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #fff; font-size: 20px; margin: 0 0 8px;">Binance Account Connected</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, your Binance P2P account has been connected successfully.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">Binance Name</span>
                    <span style="color: #10b981; font-size: 13px; font-weight: 600;">{binance_name}</span>
                </div>
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                Your trades will now be automated based on your subscription plan.
            </p>
            <p style="color: #ef4444; font-size: 12px; margin-top: 12px;">
                If you did not connect this account, please login immediately and disconnect it.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Binance Account Connected", html)


def send_subscription_activated(to_email: str, trader_name: str, plan: str, expires: str) -> bool:
    """Notify trader that their subscription was activated."""
    plan_display = "Starter (KES 5,000/mo)" if plan == "starter" else "Pro (KES 10,000/mo)"
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px; text-align: center;">
            <div style="font-size: 48px; margin-bottom: 12px;">🎉</div>
            <h2 style="color: #10b981; font-size: 22px; margin: 0 0 8px;">Subscription Activated!</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 24px;">
                Hi {trader_name}, welcome to SparkP2P {plan_display.split('(')[0].strip()}!
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; text-align: left; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Plan</span>
                    <span style="color: #f59e0b; font-size: 13px; font-weight: 600;">{plan_display}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">Expires</span>
                    <span style="color: #fff; font-size: 13px; font-weight: 600;">{expires}</span>
                </div>
            </div>
            <p style="color: #9ca3af; font-size: 13px; margin: 0;">
                Your P2P trades will now be automated. Happy trading!
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Subscription Activated", html)


def send_deposit_received(to_email: str, trader_name: str, amount: float, new_balance: float) -> bool:
    """Notify trader that a deposit was received."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #10b981; font-size: 20px; margin: 0 0 8px;">Deposit Received</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, your deposit has been credited to your SparkP2P wallet.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Amount Deposited</span>
                    <span style="color: #10b981; font-size: 13px; font-weight: 600;">KES {amount:,.0f}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">New Balance</span>
                    <span style="color: #f59e0b; font-size: 13px; font-weight: 600;">KES {new_balance:,.0f}</span>
                </div>
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                Your wallet is ready for buy-side auto-pay orders.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Deposit Received", html)


def send_insufficient_balance(to_email: str, trader_name: str, order_amount: float, current_balance: float) -> bool:
    """Notify trader of insufficient balance for a buy order."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #ef4444; font-size: 20px; margin: 0 0 8px;">Insufficient Balance</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, a buy order could not be processed due to insufficient wallet balance.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Order Amount</span>
                    <span style="color: #ef4444; font-size: 13px; font-weight: 600;">KES {order_amount:,.0f}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">Your Balance</span>
                    <span style="color: #f59e0b; font-size: 13px; font-weight: 600;">KES {current_balance:,.0f}</span>
                </div>
            </div>
            <p style="color: #f59e0b; font-size: 13px; margin: 0; font-weight: 600;">
                Please deposit more funds to continue auto-paying buy orders.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, "SparkP2P - Insufficient Balance for Buy Order", html)


def send_seller_paid(to_email: str, trader_name: str, amount: float, seller_name: str, order_number: str) -> bool:
    """Notify trader that payment was sent to seller for a buy order."""
    html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; font-size: 28px; margin: 0;">SparkP2P</h1>
            <p style="color: #888; font-size: 14px;">Automated P2P Trading</p>
        </div>
        <div style="background: #1a1d27; border-radius: 12px; padding: 32px;">
            <h2 style="color: #10b981; font-size: 20px; margin: 0 0 8px;">Payment Sent to Seller</h2>
            <p style="color: #9ca3af; font-size: 14px; margin: 0 0 20px;">
                Hi {trader_name}, we've sent payment to the seller for your buy order.
            </p>
            <div style="background: #0f1117; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Amount Paid</span>
                    <span style="color: #10b981; font-size: 13px; font-weight: 600;">KES {amount:,.0f}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af; font-size: 13px;">Seller</span>
                    <span style="color: #fff; font-size: 13px; font-weight: 600;">{seller_name}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #9ca3af; font-size: 13px;">Order</span>
                    <span style="color: #fff; font-size: 13px; font-weight: 600;">{order_number}</span>
                </div>
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                The order has been marked as paid on Binance. Waiting for seller to release crypto.
            </p>
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 20px;">
            Powered by Spark AI &bull; sparkp2p.com
        </p>
    </div>
    """
    return send_email(to_email, f"SparkP2P - Payment Sent for Order {order_number}", html)


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
