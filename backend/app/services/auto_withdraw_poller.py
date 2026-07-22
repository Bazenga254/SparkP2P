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

POLL_INTERVAL = 120          # seconds between balance checks
FEE_BUFFER = 5               # KES shaved off so amount + Choice's withheld fee <= balance
MIN_SWEEP = 100              # Choice Bank's own floor for a PesaLink transfer
FAIL_BACKOFF = 1800          # seconds to wait after a failed sweep before retrying that trader

# Traders currently mid-sweep — a sweep spans several await points (balance,
# initiate, wait-for-OTP, confirm) and a cycle could lap itself on a slow relay.
_in_flight: set[int] = set()

# After a failed confirm we back off, so we don't re-run applyForTransfer every
# cycle and pile up unconfirmed Choice-side pending transfers.
_retry_after: dict[int, float] = {}


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
        if balance < threshold:
            return  # not yet

        # Sweep the whole balance, less the fee Choice withholds on top (so
        # amount + fee never exceeds what's in the account) and a tiny buffer.
        fee = outbound_fee("BANK", balance)
        amount = int(balance) - int(fee) - FEE_BUFFER
        if amount < MIN_SWEEP:
            logger.info("[auto-withdraw] trader %s over threshold but sweepable amount %s < %s — skip",
                        trader_id, amount, MIN_SWEEP)
            return

        logger.info("[auto-withdraw] trader %s: balance %.0f >= threshold %.0f -> sweeping KES %s to %s (PesaLink)",
                    trader_id, balance, threshold, amount, trader.cb_withdrawal_bank_name)

        # Step 1 — create the PesaLink transfer + trigger the OTP SMS. The initiate
        # handler itself refuses if a withdrawal is already pending (2h), which is
        # our cross-restart double-fire guard.
        try:
            await cb_withdraw_initiate(CbWithdrawInitiateBody(amount=float(amount)), trader, db)
        except HTTPException as e:
            logger.info("[auto-withdraw] trader %s initiate declined: %s", trader_id, e.detail)
            _retry_after[trader_id] = time.time() + FAIL_BACKOFF
            return
        except Exception as e:
            logger.warning("[auto-withdraw] trader %s initiate error: %s", trader_id, e)
            _retry_after[trader_id] = time.time() + FAIL_BACKOFF
            return

        # Step 2 — wait on the SMS relay for the OTP and confirm. Same handler the
        # manual "Auto-confirm from SMS" button calls.
        try:
            await cb_withdraw_to_bank_auto(trader, db)
            logger.info("[auto-withdraw] trader %s: swept KES %s successfully", trader_id, amount)
            _retry_after.pop(trader_id, None)
        except HTTPException as e:
            logger.warning("[auto-withdraw] trader %s confirm failed (%s) — balance left in place, backing off",
                           trader_id, e.detail)
            _retry_after[trader_id] = time.time() + FAIL_BACKOFF
        except Exception as e:
            logger.warning("[auto-withdraw] trader %s confirm error: %s", trader_id, e)
            _retry_after[trader_id] = time.time() + FAIL_BACKOFF


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
