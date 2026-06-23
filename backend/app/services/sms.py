"""SMS service using Advanta SMS API."""

import json
import logging
import re
import urllib.request

from app.core.config import settings
from app.services.message_templates import get_cached_template

logger = logging.getLogger(__name__)

ADVANTA_BASE_URL = "https://quicksms.advantasms.com"

# Emoji / pictographic symbol ranges. SMS gateways mangle these into garbage
# (e.g. the warning sign ⚠️ arrived as "as i,"), so strip them before sending.
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # emoji & supplemental symbols
    "\U00002600-\U000027BF"  # misc symbols + dingbats (✅ ✕ ✓ etc.)
    "\U00002300-\U000023FF"  # technical (⏳ ⌛ etc.)
    "\U00002B00-\U00002BFF"  # arrows/stars
    "\U00002190-\U000021FF"  # arrows
    "\U0000FE00-\U0000FE0F"  # variation selectors
    "\U000020D0-\U000020FF"  # combining marks for symbols
    "]+",
    flags=re.UNICODE,
)


def gsm_safe(text: str) -> str:
    """Strip emoji/symbols and collapse leftover spaces so SMS text isn't garbled by the gateway."""
    if not text:
        return text
    return re.sub(r"\s{2,}", " ", _EMOJI_RE.sub("", text)).strip()


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
    message = gsm_safe(message)

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
    message = gsm_safe(message)

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


def sms_subscription_reminder(phone: str, name: str, plan_label: str, expires: str,
                              amount, acct: str, days: int, paybill: str) -> bool:
    """Pre-expiry reminder. days=5 is gentle; days<=3 warns about bot reconfiguration."""
    first = (name or "").strip().split(" ")[0] or "Customer"
    if days <= 3:
        msg = (f"Dear {first}, your SparkP2P bot will be DISCONNECTED on {expires}. "
               f"If it disconnects you must reconfigure the bot from scratch. Avoid this — pay "
               f"KES {int(amount):,} via M-Pesa Paybill {paybill}, Account {acct}, or from your "
               f"Choice Bank wallet in the app. - SparkP2P")
    else:
        msg = (f"Dear {first}, your SparkP2P {plan_label} subscription expires on {expires}. "
               f"To keep your bot running, pay KES {int(amount):,} via M-Pesa Paybill {paybill}, "
               f"Account {acct}, or instantly from your Choice Bank wallet in the app. - SparkP2P")
    return send_sms(phone, msg)


def sms_subscription_deposit(phone: str, name: str, amount, balance, due, plan_label: str,
                             acct: str, paybill: str) -> bool:
    """Confirm a partial deposit that hasn't yet activated a plan ('pay slowly')."""
    first = (name or "").strip().split(" ")[0] or "Customer"
    msg = (f"Dear {first}, we received KES {int(amount):,}. Your SparkP2P balance is now "
           f"KES {int(balance):,}. Pay KES {int(due):,} more to activate {plan_label} via M-PESA "
           f"Paybill {paybill}, Account {acct}, or from your Choice Bank wallet. - SparkP2P")
    return send_sms(phone, msg)


def sms_subscription_disconnected(phone: str, name: str, amount, acct: str, paybill: str) -> bool:
    """Sent on the day the subscription lapses and the bot is disconnected."""
    first = (name or "").strip().split(" ")[0] or "Customer"
    msg = (f"Dear {first}, your SparkP2P service has been DISCONNECTED due to non-payment and your "
           f"bot settings have been reset. To restore service, pay KES {int(amount):,} via M-Pesa "
           f"Paybill {paybill}, Account {acct}, or from your Choice Bank wallet, then log in to "
           f"reconfigure your bot. - SparkP2P")
    return send_sms(phone, msg)


def sms_subscription_renewed(phone: str, name: str, plan_label: str, expires: str, was_disconnected: bool) -> bool:
    """Confirm a renewal/activation. If they were disconnected, prompt them to reconfigure."""
    first = (name or "").strip().split(" ")[0] or "Customer"
    if was_disconnected:
        msg = (f"Dear {first}, your SparkP2P {plan_label} subscription has been RENEWED and is valid "
               f"until {expires}. As your service had been disconnected, please log in to reconfigure "
               f"your bot to your specific settings. - SparkP2P")
    else:
        msg = (f"Dear {first}, your SparkP2P {plan_label} subscription has been renewed and is now "
               f"valid until {expires}. Thank you for trading with us. - SparkP2P")
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


# Android SMS Retriever hash for the release-signed SparkP2P app (com.sparkp2p.app). The OTP SMS
# must begin with "<#>" and end with this 11-char hash so the app can auto-read the code into the
# login boxes. Regenerate if the release signing keystore ever changes.
SMS_RETRIEVER_HASH = "h3Oop6l5h0F"


def sms_verification_code(phone: str, code: str) -> bool:
    """Send a login/reset verification code, formatted for Android SMS Retriever auto-fill."""
    tpl = get_cached_template("sms_verification_code")
    body = tpl.format(code=code) if tpl else f"SparkP2P verification code: {code}. Valid for 10 minutes."
    msg = f"<#> {body}\n{SMS_RETRIEVER_HASH}"
    return send_otp_sms(phone, msg)
