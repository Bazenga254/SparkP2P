"""Central credit (trade_tokens) charging + low-balance alerting.

Pricing (credits):
  - Telegram notification:            0.1 per message
  - Choice Bank -> M-Pesa (B2C), by KES amount:
        <= 1,500            6
        1,501 - 7,500       12
        7,501 - 15,000      18
        15,001 - 40,000     22
        40,001 - 250,000    24
  - Choice Bank -> Bank (PesaLink):   20 flat
Low-balance: one SMS when balance first drops below LOW_BALANCE_THRESHOLD;
flag resets on top-up back above the threshold.
"""
import logging
from sqlalchemy import select
from app.core.database import async_session
from app.models.trader import Trader
from app.services import sms

logger = logging.getLogger(__name__)

TELEGRAM_NOTIFY_CREDIT = 0.1
PESALINK_CREDIT_FEE = 20
LOW_BALANCE_THRESHOLD = 100


def mpesa_credit_fee(amount: float) -> int:
    """Tiered credit fee for a Choice -> M-Pesa (B2C) withdrawal of  KES."""
    a = float(amount or 0)
    if a <= 1500:    return 6
    if a <= 7500:    return 12
    if a <= 15000:   return 18
    if a <= 40000:   return 22
    return 24


def withdrawal_credit_fee(channel: str, amount: float) -> int:
    """channel: 'MPESA' -> tiered; anything else (BANK/PesaLink) -> flat 20."""
    if (channel or '').upper() == 'MPESA':
        return mpesa_credit_fee(amount)
    return PESALINK_CREDIT_FEE


def _maybe_low_balance_alert(trader: Trader) -> None:
    """Mutates trader.credits_low_alerted; sends one SMS on crossing below threshold."""
    bal = float(trader.trade_tokens or 0)
    if bal < LOW_BALANCE_THRESHOLD and not trader.credits_low_alerted:
        phone = getattr(trader, 'phone', None) or getattr(trader, 'settlement_phone', None)
        if phone:
            try:
                sms.send_sms(
                    phone,
                    f"SparkP2P: Your credit balance is low ({bal:.1f} credits). "
                    f"Top up to keep your bot running and avoid interruptions."
                )
            except Exception as e:
                logger.warning('low-balance SMS failed for trader %s: %s', trader.id, e)
        trader.credits_low_alerted = True
    elif bal >= LOW_BALANCE_THRESHOLD and trader.credits_low_alerted:
        trader.credits_low_alerted = False


def charge(db, trader: Trader, amount: float, reason: str = '') -> float:
    """Deduct  credits from trader (caller's session; caller commits).
    Handles low-balance alerting. Returns the new balance."""
    new_bal = round(float(trader.trade_tokens or 0) - float(amount), 2)
    trader.trade_tokens = new_bal
    _maybe_low_balance_alert(trader)
    logger.info('Charged %.2f credits to trader %s (%s) -> %.2f', amount, trader.id, reason, new_bal)
    return new_bal


async def charge_standalone(trader_id: int, amount: float, reason: str = '') -> float:
    """Open a fresh session, deduct credits, commit. For callers without a db session
    (e.g. Telegram notification helpers). Returns new balance, or -1 if trader missing."""
    async with async_session() as db:
        trader = (await db.execute(select(Trader).where(Trader.id == trader_id))).scalar_one_or_none()
        if not trader:
            return -1
        bal = charge(db, trader, amount, reason)
        await db.commit()
        return bal
