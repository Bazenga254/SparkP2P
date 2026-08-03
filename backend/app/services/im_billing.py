"""
Writing a charge to the ledger — the one place money is counted.

Called from exactly two spots, both when a payout has actually MOVED MONEY:
  * a trader's /result, on the PAID that first advances a PENDING order
  * a bot-only account's payout report

The rules it enforces, none of which the caller should have to remember:

1. IDEMPOTENT ON order_id. A charge is written at most once per payout, ever.
   The unique index on im_charges.order_id is the real guard (races, retries and
   redeliveries are normal here — we have already had a payment double-counted by
   two callbacks); this function checks first only so the common case returns a
   clean "already billed" instead of an IntegrityError. BOTH matter: the check
   handles the sequential retry, the constraint handles the true race.

2. THE RATE IS RESOLVED HERE, FROM SUBSCRIPTION STATE — never passed in. A bot
   that named its own rate would name its own price. For a trader we read
   active_plan() (a real, unexpired subscription), NEVER billing_active() (which
   returns True for everyone when enforcement is off — see im_pricing).

3. ONLY money that moved is billed. The caller must not call this for FAILED,
   for a zero-balance refusal, or for UNKNOWN — should_bill() is the gate, and it
   is asserted here too so a mistaken caller fails loudly instead of over-billing.
"""

import logging

from sqlalchemy import select

from app.models.im_charge import ImCharge
from app.services import im_pricing as pricing
from app.services.im_pricing import (
    ACCOUNT_SPARKP2P, ACCOUNT_BOT_ONLY, should_bill,
)

logger = logging.getLogger(__name__)


class AlreadyBilled(Exception):
    """This order_id is already on the ledger. Not an error — the expected
    outcome of a duplicate PAID. Carries the existing row for the caller."""
    def __init__(self, existing: ImCharge):
        self.existing = existing
        super().__init__(f"order {existing.order_id} already billed")


async def record_charge(
    db,
    *,
    account_type: str,
    order_id: str,
    payout_amount: int,
    trader_id: int | None = None,
    bot_account_id: int | None = None,
    bank_ref: str | None = None,
    outcome: str = pricing.OUTCOME_PAID,
) -> ImCharge:
    """Write one charge for one payout, resolving the rate from live state.

    Returns the new ImCharge. Raises AlreadyBilled if this order_id is already on
    the ledger (idempotency), or ValueError if asked to bill something that did
    not move money, or a payout amount that is not positive.

    Does NOT commit — the caller owns the transaction, so the charge lands in the
    SAME commit as the order-status change it accompanies. Either both happen or
    neither does: we never advance an order to PAYMENT_SENT without billing it,
    nor bill for an advance that rolled back.
    """
    if not should_bill(outcome):
        # A caller reached here for a FAILED/UNKNOWN/refused payout. That is a
        # bug in the caller, and billing it would take a merchant's money for a
        # payment that did not happen. Refuse loudly.
        raise ValueError(f"refusing to bill a payout with outcome={outcome!r}")

    amount = int(payout_amount or 0)
    if amount <= 0:
        raise ValueError(f"refusing to bill a non-positive payout: {amount}")

    if (trader_id is None) == (bot_account_id is None):
        raise ValueError("a charge needs exactly one owner: trader_id XOR bot_account_id")

    # Idempotency check FIRST (see rule 1). Cheap, and turns the ordinary
    # duplicate-PAID into a clean signal instead of a constraint violation.
    existing = (await db.execute(
        select(ImCharge).where(ImCharge.order_id == order_id)
    )).scalar_one_or_none()
    if existing is not None:
        raise AlreadyBilled(existing)

    # Resolve the rate from real state. For a bot-only account this is always 12;
    # for a trader it reads their actual active plan (or the intro allowance).
    _weekly_unlimited = False
    if account_type == ACCOUNT_BOT_ONLY:
        info = pricing.rate_for_bot_only()
    else:
        info = await pricing.rate_for_trader(db, trader_id)
        # On an ACTIVE weekly plan this payout is already paid for by the flat
        # weekly fee — bill it at rate 0 and consume no credit (the revenue is the
        # weekly fee, recorded as a plan payment, not a per-payout charge).
        from app.models.trader import Trader as _Trader
        from app.services import im_weekly_plan as _weekly
        _t = await db.get(_Trader, trader_id)
        _weekly_unlimited = bool(_t and _weekly.on_active_weekly_plan(_t))

    charge = ImCharge(
        trader_id=trader_id,
        bot_account_id=bot_account_id,
        account_type=account_type,
        order_id=order_id,
        rate=0 if _weekly_unlimited else info["rate"],
        payout_amount=amount,
        plan=info.get("plan"),
        bank_ref=bank_ref,
    )
    # Insert inside a SAVEPOINT so that if a racing duplicate trips the unique
    # order_id constraint, only THIS insert is undone — the caller's outer
    # transaction (the order-status advance) survives. A plain rollback here would
    # also undo the order advance, breaking the atomicity we promise above.
    from sqlalchemy.exc import IntegrityError
    try:
        async with db.begin_nested():
            db.add(charge)
            await db.flush()
    except IntegrityError:
        again = (await db.execute(
            select(ImCharge).where(ImCharge.order_id == order_id)
        )).scalar_one_or_none()
        if again is not None:
            raise AlreadyBilled(again)
        raise  # a different integrity problem — do not swallow it

    # Consume ONE prepaid credit for this payout, in the SAME transaction as the
    # charge — so credits and the ledger can never disagree, and the AlreadyBilled
    # path above means a duplicate PAID spends nothing. A bot-only account always
    # runs on the prepaid I&M rail; a trader only if they're on I&M / own-paybill
    # (a Choice Bank trader has no credit balance and consumes none).
    from app.services import credits as creditsvc
    from app.models.im_bot_account import ImBotAccount
    from app.models.trader import Trader
    if account_type == ACCOUNT_BOT_ONLY:
        acct = await db.get(ImBotAccount, bot_account_id)
        if acct is not None:
            creditsvc.consume_bot(acct, 1)
    else:
        trader = await db.get(Trader, trader_id)
        if trader is not None and not _weekly_unlimited and creditsvc.trader_credits_enabled(trader):
            creditsvc.consume_trader(trader, 1)

    logger.info(
        "im_billing: charged %s %s KES %s for payout %s (amount %s)",
        account_type,
        trader_id if trader_id is not None else f"bot#{bot_account_id}",
        info["rate"], order_id, amount,
    )
    return charge
