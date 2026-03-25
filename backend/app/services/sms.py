"""SMS service using Advanta SMS API."""

import json
import logging
import urllib.request

from app.core.config import settings
from app.services.message_templates import get_cached_template

logger = logging.getLogger(__name__)

ADVANTA_BASE_URL = "https://quicksms.advantasms.com"


def send_sms(phone: str, message: str) -> bool:
    """Send SMS via Advanta SMS API."""
    api_key = settings.ADVANTA_API_KEY
    partner_id = settings.ADVANTA_PARTNER_ID
    shortcode = settings.ADVANTA_SHORTCODE

    if not api_key or not partner_id:
        logger.warning("Advanta SMS credentials not set — SMS not sent")
        return False

    # Normalize phone number to 254 format
    phone = normalize_phone(phone)

    payload = json.dumps({
        "apikey": api_key,
        "partnerID": partner_id,
        "message": message,
        "shortcode": shortcode,
        "mobile": phone,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            f"{ADVANTA_BASE_URL}/api/services/sendsms",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            responses = result.get("responses", [])
            if responses and responses[0].get("response-code") == 200:
                logger.info(f"SMS sent to {phone}: {responses[0].get('messageid')}")
                return True
            else:
                logger.error(f"SMS failed to {phone}: {result}")
                return False
    except Exception as e:
        logger.error(f"SMS error to {phone}: {e}")
        return False


def send_otp_sms(phone: str, message: str) -> bool:
    """Send OTP/transactional SMS via Advanta."""
    api_key = settings.ADVANTA_API_KEY
    partner_id = settings.ADVANTA_PARTNER_ID
    shortcode = settings.ADVANTA_SHORTCODE

    if not api_key or not partner_id:
        return False

    phone = normalize_phone(phone)

    payload = json.dumps({
        "apikey": api_key,
        "partnerID": partner_id,
        "message": message,
        "shortcode": shortcode,
        "mobile": phone,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            f"{ADVANTA_BASE_URL}/api/services/sendotp",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            responses = result.get("responses", [])
            if responses and responses[0].get("response-code") == 200:
                logger.info(f"OTP SMS sent to {phone}")
                return True
            else:
                logger.error(f"OTP SMS failed to {phone}: {result}")
                return False
    except Exception as e:
        logger.error(f"OTP SMS error to {phone}: {e}")
        return False


def get_sms_balance() -> float:
    """Check Advanta SMS account balance."""
    api_key = settings.ADVANTA_API_KEY
    partner_id = settings.ADVANTA_PARTNER_ID

    if not api_key or not partner_id:
        return 0.0

    try:
        payload = json.dumps({
            "apikey": api_key,
            "partnerID": partner_id,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{ADVANTA_BASE_URL}/api/services/getbalance",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            return float(result.get("credit", 0))
    except Exception as e:
        logger.error(f"SMS balance check error: {e}")
        return 0.0


def normalize_phone(phone: str) -> str:
    """Normalize phone to 254XXXXXXXXX format."""
    phone = phone.strip().replace(" ", "").replace("-", "").replace("+", "")
    if phone.startswith("0"):
        phone = "254" + phone[1:]
    if not phone.startswith("254"):
        phone = "254" + phone
    return phone


# ═══════════════════════════════════════════════════════════
# NOTIFICATION TEMPLATES
# ═══════════════════════════════════════════════════════════

def sms_deposit_received(phone: str, amount: float, balance: float) -> bool:
    """Notify trader of successful deposit."""
    tpl = get_cached_template("sms_deposit_received")
    if tpl:
        msg = tpl.format(amount=f"{amount:,.0f}", balance=f"{balance:,.0f}")
    else:
        msg = (
            f"SparkP2P: KES {amount:,.0f} deposited to your wallet. "
            f"New balance: KES {balance:,.0f}. "
            f"Happy trading!"
        )
    return send_otp_sms(phone, msg)


def sms_withdrawal_sent(phone: str, amount: float, balance: float) -> bool:
    """Notify trader of withdrawal."""
    tpl = get_cached_template("sms_withdrawal_sent")
    if tpl:
        msg = tpl.format(amount=f"{amount:,.0f}", balance=f"{balance:,.0f}")
    else:
        msg = (
            f"SparkP2P: KES {amount:,.0f} sent to your M-Pesa. "
            f"Remaining balance: KES {balance:,.0f}."
        )
    return send_otp_sms(phone, msg)


def sms_sell_order_completed(phone: str, crypto_amount: float, fiat_amount: float, currency: str = "USDT") -> bool:
    """Notify trader that a sell order was completed."""
    tpl = get_cached_template("sms_sell_order_completed")
    if tpl:
        msg = tpl.format(crypto_amount=f"{crypto_amount:.2f}", currency=currency, fiat_amount=f"{fiat_amount:,.0f}")
    else:
        msg = (
            f"SparkP2P: Sell order completed. {crypto_amount:.2f} {currency} released. "
            f"KES {fiat_amount:,.0f} credited to wallet."
        )
    return send_otp_sms(phone, msg)


def sms_buy_order_completed(phone: str, crypto_amount: float, fiat_amount: float, currency: str = "USDT") -> bool:
    """Notify trader that a buy order was completed."""
    tpl = get_cached_template("sms_buy_order_completed")
    if tpl:
        msg = tpl.format(crypto_amount=f"{crypto_amount:.2f}", currency=currency, fiat_amount=f"{fiat_amount:,.0f}")
    else:
        msg = (
            f"SparkP2P: Buy order completed. KES {fiat_amount:,.0f} paid to seller. "
            f"{crypto_amount:.2f} {currency} received."
        )
    return send_otp_sms(phone, msg)


def sms_insufficient_balance(phone: str, order_amount: float, balance: float) -> bool:
    """Warn trader of insufficient balance for buy order."""
    tpl = get_cached_template("sms_insufficient_balance")
    if tpl:
        msg = tpl.format(amount=f"{order_amount:,.0f}", balance=f"{balance:,.0f}")
    else:
        msg = (
            f"SparkP2P: Buy order for KES {order_amount:,.0f} could not be processed. "
            f"Balance: KES {balance:,.0f}. Deposit more funds at sparkp2p.com"
        )
    return send_otp_sms(phone, msg)


def sms_session_disconnected(phone: str) -> bool:
    """Alert trader that Binance session disconnected."""
    tpl = get_cached_template("sms_session_disconnected")
    if tpl:
        msg = tpl
    else:
        msg = (
            "SparkP2P: Your Binance session disconnected. "
            "Auto-trading paused. Open Chrome with Binance to reconnect."
        )
    return send_sms(phone, msg)


def sms_subscription_activated(phone: str, plan: str, expires: str) -> bool:
    """Notify trader of subscription activation."""
    tpl = get_cached_template("sms_subscription_activated")
    if tpl:
        msg = tpl.format(plan=plan.title(), expires=expires)
    else:
        msg = (
            f"SparkP2P: {plan.title()} plan activated! "
            f"Expires {expires}. Start trading at sparkp2p.com"
        )
    return send_sms(phone, msg)


def sms_verification_code(phone: str, code: str) -> bool:
    """Send verification code via SMS."""
    tpl = get_cached_template("sms_verification_code")
    if tpl:
        msg = tpl.format(code=code)
    else:
        msg = f"SparkP2P verification code: {code}. Valid for 10 minutes."
    return send_otp_sms(phone, msg)
