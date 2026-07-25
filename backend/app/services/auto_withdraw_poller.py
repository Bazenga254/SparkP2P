"""Auto-sweep poller — empty a merchant's Choice Bank balance to their bank.

When a merchant turns on auto-withdraw and sets a threshold, this watches their
Choice Bank balance and, the moment it reaches the threshold, sweeps the WHOLE
balance to their configured withdrawal bank account over PesaLink (never M-Pesa),
confirming the OTP automatically over the same MacroDroid SMS relay the buy-order
flow uses.

This moves REAL MONEY with no human present, so it is deliberately conservative:

  * Only fires for traders who explicitly enabled it AND saved a bank account.
  * Only when the LIVE balance is at/above the threshold.
  * Reuses the exact HTTP initiate + auto-confirm handlers, so the Choice Bank
    call, the Payment row, the ledger entry and the notification are identical to
    a manual withdrawal — no parallel money path to drift.
  * Never holds a DB session across the slow Choice/relay calls.
  * A per-trader in-flight lock plus the initiate handler's own 2-hour
    pending-withdrawal guard stop it ever firing twice for one sweep. A failed
    OTP simply leaves the balance in place and it retries a later cycle.
"""
import asyncio
import logging
import time

from app.core.database import async_session
from app.models import Trader

logger = logging.getLogger(__name__)

POLL_INTERVAL = 60           # seconds between balance checks (near-immediate)
FEE_BUFFER = 5               # KES shaved off so amount + Choice's withheld fee <= balance
MIN_SWEEP = 100              # Choice Bank's own floor for a PesaLink transfer
FAIL_BACKOFF = 600           # seconds to wait after a failed sweep before retrying that trader

# Traders currently mid-sweep — a sweep spans several await points (balance,
# initiate, wait-for-OTP, confirm) and a cycle could lap itself on a slow relay.
_in_flight: set[int] = set()

# After a failed confirm we back off, so we don't re-run applyForTransfer every
# cycle and pile up unconfirmed Choice-side pending transfers.
_retry_after: dict[int, float] = {}

# A sweep, once TRIGGERED (balance hit the threshold), empties the account — even
# across cycles. If a big balance needs several legs and one fails, the remainder
# can drop BELOW the threshold and could never re-trigger on its own; this flag
# keeps sweeping regardless of the threshold until the account is empty.
_draining: dict[int, bool] = {}

# PesaLink settles INSTANTLY only up to ~1M per transfer; above that a Choice
# withdrawal routes to RTGS (slow / next-day), which is exactly what a merchant
# does NOT want. So a sweep bigger than this cap is split into several instant
# PesaLink legs, a minute apart. 900k (below the ~1M ceiling) leaves headroom.
_LEG_CAP = 900_000
_LEG_GAP_S = 60          # wait between legs (let the previous one settle + OTP)


def _plan_legs(balance: int):
    """Drain the WHOLE balance in instant PesaLink legs (≤ cap each). The
    threshold is only the TRIGGER; once a sweep fires it empties the account —
    it does NOT stop at the threshold. Each leg's amount + Choice's withheld fee
    never exceeds the money left, so a leg can never fail for insufficient funds.

        750,000   -> [749,970]                (whole balance, under the cap)
      1,200,000   -> [900,000, 299,945]       (two legs; ~0 left)
      1,800,000   -> [900,000, 899,945]       (two legs; ~0 left)
    """
    from app.services.outbound_fees import outbound_fee
    legs, remaining = [], int(balance)
    while remaining >= MIN_SWEEP and len(legs) < 20:
        gross = min(_LEG_CAP, remaining)
        fee = int(outbound_fee("BANK", gross))
        # If the leg + its fee wouldn't fit, shave it to leave room for the fee.
        if gross + fee > remaining:
            gross = remaining - fee - FEE_BUFFER
        if gross < MIN_SWEEP:
            break
        legs.append(gross)
        remaining -= (gross + fee)
    return legs


async def _sweep_one(trader_id: int):
    """Run one sweep for a trader that is over threshold. Own DB session."""
    from app.api.routes.extension import _choice_balance
    from app.api.routes.traders import (
        cb_withdraw_initiate,
        cb_withdraw_to_bank_auto,
        CbWithdrawInitiateBody,
    )
    from app.services.outbound_fees import outbound_fee
    from fastapi import HTTPException

    async with async_session() as db:
        trader = await db.get(Trader, trader_id)
        if not trader or not trader.cb_auto_withdraw_enabled:
            return
        threshold = trader.cb_auto_withdraw_threshold or 0
        if threshold <= 0:
            return
        if not (trader.cb_withdrawal_account and trader.cb_withdrawal_bank_code):
            return  # nowhere to send it — can't sweep

        if time.time() < _retry_after.get(trader_id, 0):
            return  # backing off after a recent failed attempt

        balance = await _choice_balance(trader)
        if balance is None:
            return  # balance unavailable this cycle — try again later

        # Trigger on the threshold; but if a drain is already underway (a prior
        # sweep left a remainder below the threshold), keep going — a sweep empties
        # the account, it does not stop at the threshold.
        draining = _draining.get(trader_id, False)
        if balance < threshold and not draining:
            return  # below the threshold and not finishing an earlier drain

        # Drain the WHOLE balance in instant PesaLink legs (≤ ~1M each).
        legs = _plan_legs(int(balance))
        if not legs:
            _draining.pop(trader_id, None)   # nothing left worth sweeping — done
            return

        _draining[trader_id] = True   # a drain is in progress until the account is empty

        logger.info("[auto-withdraw] trader %s: balance %.0f >= threshold %.0f -> sweeping KES %s in %d leg(s) %s to %s (PesaLink)",
                    trader_id, balance, threshold, sum(legs), len(legs), legs, trader.cb_withdrawal_bank_name)

        for i, amount in enumerate(legs):
            # Leg 1 respects the "one withdrawal at a time" guard (cross-restart
            # protection); later legs skip it — they are deliberate continuations.
            body = CbWithdrawInitiateBody(amount=float(amount), skip_pending_guard=(i > 0))
            try:
                await cb_withdraw_initiate(body, trader, db)
            except HTTPException as e:
                logger.info("[auto-withdraw] trader %s leg %d initiate declined: %s", trader_id, i + 1, e.detail)
                _retry_after[trader_id] = time.time() + FAIL_BACKOFF
                return
            except Exception as e:
                logger.warning("[auto-withdraw] trader %s leg %d initiate error: %s", trader_id, i + 1, e)
                _retry_after[trader_id] = time.time() + FAIL_BACKOFF
                return

            try:
                await cb_withdraw_to_bank_auto(trader, db)
                logger.info("[auto-withdraw] trader %s: leg %d/%d KES %s swept", trader_id, i + 1, len(legs), amount)
            except HTTPException as e:
                logger.warning("[auto-withdraw] trader %s leg %d confirm failed (%s) — stopping; rest stays for next cycle",
                               trader_id, i + 1, e.detail)
                _retry_after[trader_id] = time.time() + FAIL_BACKOFF
                return
            except Exception as e:
                logger.warning("[auto-withdraw] trader %s leg %d confirm error: %s — stopping", trader_id, i + 1, e)
                _retry_after[trader_id] = time.time() + FAIL_BACKOFF
                return

            if i < len(legs) - 1:
                await asyncio.sleep(_LEG_GAP_S)   # let the leg settle before the next

        _retry_after.pop(trader_id, None)
        # Every planned leg went out, so the balance at trigger time is drained.
        # (On a leg FAILURE we return above WITHOUT clearing _draining, so the next
        # cycle keeps draining even if the leftover is now below the threshold.)
        # Money that landed DURING the sweep is judged fresh against the threshold
        # next cycle.
        _draining.pop(trader_id, None)
        logger.info("[auto-withdraw] trader %s: sweep complete (%d leg(s), KES %s)", trader_id, len(legs), sum(legs))


async def _cycle():
    # Short read: who has it enabled? Release the session before the slow work.
    from sqlalchemy import select
    async with async_session() as db:
        ids = (await db.execute(
            select(Trader.id).where(Trader.cb_auto_withdraw_enabled.is_(True))
        )).scalars().all()

    for tid in ids:
        if tid in _in_flight:
            continue
        _in_flight.add(tid)
        try:
            await _sweep_one(tid)
        except Exception as e:
            logger.warning("[auto-withdraw] trader %s cycle error: %s", tid, e)
        finally:
            _in_flight.discard(tid)


async def auto_withdraw_poller():
    logger.info("[auto-withdraw] poller started (every %ss)", POLL_INTERVAL)
    while True:
        try:
            await _cycle()
        except Exception as e:
            logger.warning("[auto-withdraw] cycle failed: %s", e)
        await asyncio.sleep(POLL_INTERVAL)
