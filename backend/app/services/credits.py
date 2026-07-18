"""
Prepaid payout credits for I&M Automation.

1 credit = 1 payout. You buy credits by paying KES to paybill 4041355; the number
you get is round(deposit / your rate) — so a Gold merchant (rate 7) turns KES
1,000 into 143 credits, Silver (8) into 125, B2C/VIP (5) into 200, a bot-only
user (12) into 83. Each payout the bot makes consumes ONE credit. At zero, the
bot stops: it ignores new Binance orders until the balance is topped up.

THE RATE IS LOCKED AT PURCHASE. A credit is a payout you've already paid for, so
consumption is always 1-per-payout regardless of what the rate is later. The rate
only decides how many credits a deposit buys, at the moment you buy them.

WHO HAS CREDITS: only the two rails that pay from the merchant's OWN account —
I&M Bot and Own-Paybill/B2C. A Choice Bank trader never touches this: their fees
are withheld at source by Choice Bank, so there's nothing to prepay.

TWO BALANCES, ONE MEANING:
  * a SparkP2P trader's balance lives in trader.b2c_credits
  * a bot-only account's balance lives in im_bot_accounts.credits
They never mix (different people); each is read/spent on its own row.
"""

import logging

logger = logging.getLogger(__name__)

# The rails that pay from the merchant's own account, and so are prepaid.
RAILS_WITH_CREDITS = frozenset({"im_bot", "own_paybill"})

# You can't buy fewer than this — small top-ups aren't worth the M-Pesa fee, and
# it keeps the "round(deposit/rate)" grant from producing a handful of credits.
MIN_DEPOSIT_KES = 1000


def trader_rail(trader) -> str:
    """The one buy-order payout rail for a trader, from its two flags."""
    if getattr(trader, "b2c_own_paybill_enabled", False):
        return "own_paybill"
    if getattr(trader, "buy_payout_via_im", False):
        return "im_bot"
    return "choice_bank"


def trader_credits_enabled(trader) -> bool:
    """Does this trader use a prepaid rail (so the credits UI applies)?"""
    return trader_rail(trader) in RAILS_WITH_CREDITS


def credits_for(amount, rate) -> int:
    """How many credits a deposit buys at a given rate. round(), per the spec's
    own example (1000 / 7 -> 143). Guards a bad rate rather than dividing by zero."""
    r = int(rate or 0)
    if r <= 0:
        return 0
    return int(round(float(amount or 0) / r))


async def credit_rate_for_trader(db, trader_id: int) -> int:
    """The rate a trader's credits are priced at — their real plan rate
    (5/7/8/9/10/12), resolved the one true way (active_plan, never
    billing_active)."""
    from app.services import im_pricing as pricing
    info = await pricing.rate_for_trader(db, trader_id)
    return int(info["rate"])


def credit_rate_bot_only() -> int:
    """Bot-only accounts are always the flat 12."""
    from app.services import im_pricing as pricing
    return int(pricing.RATE_BOT_ONLY)


def trader_balance(trader) -> int:
    return int(getattr(trader, "b2c_credits", 0) or 0)


def bot_balance(acct) -> int:
    return int(getattr(acct, "credits", 0) or 0)


def consume_trader(trader, n: int = 1) -> int:
    """Spend n credits off a trader, never below zero. Returns the new balance.
    Mutates the row; the CALLER commits (so this lands in the same transaction as
    the payout's ledger charge — either both happen or neither)."""
    bal = max(0, trader_balance(trader) - int(n))
    trader.b2c_credits = bal
    return bal


def consume_bot(acct, n: int = 1) -> int:
    bal = max(0, bot_balance(acct) - int(n))
    acct.credits = bal
    return bal


async def grant_bot_credits(db, bot_account_id: int, amount: float, receipt: str = ""):
    """Idempotently top up a BOT-ONLY account's credits from a paybill payment
    (reference CB<id>). Priced at the flat 12 rate: round(amount / 12).

    Idempotent per M-Pesa receipt, the SAME way trader credits are: an advisory
    lock serialises the C2B + STK double-fire, and a completed credit_purchases
    row records the receipt so a later redelivery grants nothing. credit_purchases
    now carries bot_account_id, so bot receipts have a durable home."""
    from sqlalchemy import text as _text, select as _select
    from app.models.im_bot_account import ImBotAccount
    from app.models.subscription import CreditPurchase

    rate = credit_rate_bot_only()
    granted = credits_for(amount, rate)
    if receipt:
        await db.execute(_text("SELECT pg_advisory_xact_lock(hashtext(:r))"), {"r": "cr:" + str(receipt)})
        done = (await db.execute(
            _select(CreditPurchase).where(CreditPurchase.mpesa_receipt == receipt,
                                          CreditPurchase.status == "completed").limit(1)
        )).scalars().first()
        if done:
            logger.info("[Credits] bot top-up %s already granted — skipped", receipt)
            return None

    acct = await db.get(ImBotAccount, bot_account_id)
    if acct is not None:
        acct.credits = int(acct.credits or 0) + granted
    db.add(CreditPurchase(bot_account_id=bot_account_id, amount=amount, credits=granted,
                          mpesa_receipt=receipt or None, status="completed"))
    await db.commit()
    logger.warning("[Credits] bot#%s +%s credits (KES %s, receipt %s)", bot_account_id, granted, amount, receipt or "—")
    return granted
