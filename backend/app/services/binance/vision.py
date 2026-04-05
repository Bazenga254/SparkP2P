"""
Claude Vision — Binance P2P page analyzer.

Instead of fragile CSS selectors, sends a screenshot to Claude which reads
the page like a human and returns structured JSON with exact data.

This prevents misreads like "7 USDT" being parsed as "7,000 USDT".
Each screen in the release flow is identified and the correct next action returned.
"""

import json
import logging
import re
from typing import Optional

import anthropic

logger = logging.getLogger(__name__)

# Screens in the release flow
SCREENS = [
    "awaiting_payment",       # Timer counting down, buyer hasn't paid yet
    "verify_payment",         # Buyer marked as paid, showing Payment Received button
    "confirm_release_modal",  # Modal with checkbox + Confirm Release button
    "passkey_failed",         # Verify with passkey — Verification failed
    "security_verification",  # 0/2 or 1/2 — Authenticator App + Email options
    "totp_input",             # 6-digit input for Authenticator App code
    "email_otp_input",        # 6-digit input for Email OTP code
    "order_complete",         # Sale Successful / Order Completed
    "unknown",                # Unrecognised state
]

ANALYSIS_PROMPT = """You are analyzing a Binance P2P order page screenshot.
Extract ALL data with perfect precision and identify the exact screen state.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

{
  "screen": "<awaiting_payment|verify_payment|confirm_release_modal|passkey_failed|security_verification|totp_input|email_otp_input|order_complete|unknown>",
  "order_number": "<exact order number string or null>",
  "buyer_name": "<exact full name or null>",
  "fiat_amount_kes": <KES amount as plain number e.g. 1000.00 — NEVER add zeros>,
  "usdt_amount": <USDT amount as plain number e.g. 7.71 — read character by character>,
  "price_kes": <price per USDT as number or null>,
  "payment_method": "<M-pesa Paybill|Bank Transfer|null>",
  "account_number": "<e.g. P2P-T0001 or null>",
  "paybill_number": "<e.g. 4041355 or null>",
  "reference_message": "<reference message or null>",
  "countdown_timer": "<e.g. 13:32 or null>",
  "verification_progress": "<e.g. 0/2 or 1/2 or null>",
  "pending_verifications": [],
  "completed_verifications": [],
  "buttons_visible": [],
  "passkeys_not_available_visible": false,
  "checkbox_visible": false,
  "checkbox_checked": false,
  "input_field_visible": false,
  "input_placeholder": "<placeholder text of visible input or null>",
  "sale_successful": false,
  "error_message": "<any error text visible or null>"
}

CRITICAL NUMBER RULES — read every digit individually:
- "7.71 USDT" → usdt_amount: 7.71   (NOT 7710, NOT 7000, NOT 771)
- "1,000.00 KES" → fiat_amount_kes: 1000.00
- "KSh 129.70" → price_kes: 129.70
- Commas are thousand separators, periods are decimal points
- If you see "7" followed by "." followed by "7" followed by "1" → 7.71

Screen identification rules:
- "Awaiting Buyer's Payment" with countdown timer → awaiting_payment
- "Verify Payment" with Payment Received button → verify_payment
- Modal saying "Received payment in your account?" with checkbox → confirm_release_modal
- Modal saying "Verify with passkey" with "Verification failed" → passkey_failed
- Modal saying "Security Verification Requirements" with 0/2 or 1/2 → security_verification
- Input box specifically for Authenticator App code → totp_input
- Input box specifically for Email verification code → email_otp_input
- "Order Completed" or "Sale Successful" → order_complete"""


async def analyze_page(screenshot_b64: str, api_key: str) -> dict:
    """
    Send a Binance P2P page screenshot to Claude Vision.
    Returns structured dict describing screen state and all visible data.
    """
    try:
        client = anthropic.Anthropic(api_key=api_key)

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=800,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": screenshot_b64,
                        }
                    },
                    {
                        "type": "text",
                        "text": ANALYSIS_PROMPT,
                    }
                ]
            }]
        )

        text = response.content[0].text.strip()

        # Strip markdown code fences if Claude added them
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)

        # Extract JSON object
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            result = json.loads(match.group())
            logger.debug(f"Vision analysis: screen={result.get('screen')} usdt={result.get('usdt_amount')} kes={result.get('fiat_amount_kes')}")
            return result

        logger.error(f"Claude vision non-JSON response: {text[:300]}")
        return {"screen": "unknown", "error": "Non-JSON response from Claude"}

    except json.JSONDecodeError as e:
        logger.error(f"Claude vision JSON parse error: {e}")
        return {"screen": "unknown", "error": f"JSON parse error: {e}"}
    except Exception as e:
        logger.error(f"Claude vision API error: {e}")
        return {"screen": "unknown", "error": str(e)}


async def analyze_mpesa_screenshot(screenshot_b64: str, api_key: str, expected_amount: float, expected_paybill: str, order_reference: str) -> dict:
    """
    Analyze an M-Pesa confirmation screenshot sent by the buyer in chat.
    Verifies the payment details match the order.
    """
    try:
        client = anthropic.Anthropic(api_key=api_key)

        prompt = f"""Analyze this M-Pesa SMS/screenshot and extract the payment details.

Expected payment:
- Amount: KES {expected_amount}
- Paybill: {expected_paybill}
- Reference: {order_reference}

Return ONLY a valid JSON object:
{{
  "mpesa_code": "<transaction code e.g. UD5IZBECL3 or null>",
  "amount_paid": <numeric amount paid e.g. 1000.00>,
  "recipient": "<name of recipient e.g. SPARK FREELANCE SOLUTIONS or null>",
  "account_paid_to": "<account number paid to e.g. P2P-T0001 or null>",
  "paybill_paid_to": "<paybill number or null>",
  "is_valid_payment": <true if amount matches {expected_amount} AND paybill contains {expected_paybill}>,
  "mismatch_reason": "<reason if invalid or null>"
}}

Read numbers character by character. "1,000.00" = 1000.00 NOT 100000."""

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": screenshot_b64,
                        }
                    },
                    {"type": "text", "text": prompt}
                ]
            }]
        )

        text = response.content[0].text.strip()
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())

        return {"is_valid_payment": False, "error": "Could not parse M-Pesa screenshot"}

    except Exception as e:
        logger.error(f"M-Pesa screenshot analysis failed: {e}")
        return {"is_valid_payment": False, "error": str(e)}
