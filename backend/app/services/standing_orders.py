"""Standing-order scheduling + execution.

execute_standing_order() moves REAL money on the same path as a manual Send-Money
transfer (choice.transfer -> send_otp -> SMS-relay auto-confirm -> confirm_otp ->
ledger + notify). It is only ever called by the poller, and only when
settings.STANDING_ORDERS_ENABLED is True. No parallel money path — the rail
mapping mirrors the manual Send-Money handlers in choice_bank.py.
"""
import asyncio
import logging
from calendar import monthrange
from datetime import date, datetime, time, timedelta, timezone

from app.services.choice_bank import client as choice

logger = logging.getLogger("sparkp2p.standing_orders")

FEE_CUSHION_KES = 1          # tiny rounding cushion on top of the exact rail fee
OTP_WAIT_S = 120
OTP_RESEND_WAIT_S = 90

# Standing-order schedules are reckoned in Kenya time (EAT, UTC+3) — that is the
# "day" and "time" a merchant means. The server clock is UTC, so we convert.
EAT = timezone(timedelta(hours=3))
DEFAULT_RUN_TIME = time(9, 0)   # 09:00 EAT when the merchant didn't pick a time


def now_eat() -> datetime:
    return datetime.now(EAT)


# ── Scheduling ──────────────────────────────────────────────────────────────
def _clamp_day(year: int, month: int, day: int) -> date:
    """A monthly day that overflows a short month (e.g. 31 in Feb) lands on the
    last day of that month."""
    last = monthrange(year, month)[1]
    return date(year, month, min(day, last))


def _at(d: date, run_time) -> datetime:
    """The EAT datetime for date `d` at the order's run time."""
    return datetime.combine(d, run_time or DEFAULT_RUN_TIME, tzinfo=EAT)


def compute_next_run(schedule_type: str, schedule_day, run_date, run_time, now: datetime):
    """The next date this order is due — the earliest scheduled date whose run TIME
    is still strictly ahead of `now` (EAT). So an order set for today at 15:00 counts
    as today while it's before 15:00, and rolls forward once 15:00 has passed.
    Returns None for a 'once' order with no future slot left."""
    today = now.date()
    if schedule_type == "once":
        return run_date if (run_date and _at(run_date, run_time) > now) else None

    if schedule_type == "weekly":
        wd = int(schedule_day)                     # 0=Mon .. 6=Sun (Python weekday)
        cand = today + timedelta(days=(wd - today.weekday() + 7) % 7)   # this week's weekday (or today)
        if _at(cand, run_time) <= now:             # today's slot already passed -> next week
            cand += timedelta(days=7)
        return cand

    # monthly — this month's day if its time is still ahead, else next month.
    day = int(schedule_day)
    cand = _clamp_day(today.year, today.month, day)
    if _at(cand, run_time) > now:
        return cand
    y, m = (today.year + (today.month // 12)), ((today.month % 12) + 1)
    return _clamp_day(y, m, day)


def first_monthly_run(start_month: int, day: int, run_time, now: datetime) -> date:
    """The FIRST run of a monthly order the merchant asked to START in `start_month`
    (1..12) on `day` at `run_time`. Begins in the chosen month when that month is still
    ahead this year; a current-month slot that has already passed rolls to NEXT MONTH
    (not next year); a past chosen month means "start from now going forward"."""
    today = now.date()
    # Begin in the chosen month if it's this month or a future month this year;
    # otherwise (a past month) begin from the current month and roll forward.
    start_y, start_m = (today.year, start_month) if start_month >= today.month else (today.year, today.month)
    for i in range(13):
        m = ((start_m - 1 + i) % 12) + 1
        y = start_y + ((start_m - 1 + i) // 12)
        cand = _clamp_day(y, m, day)
        if _at(cand, run_time) > now:
            return cand
    return _clamp_day(start_y + 1, start_month, day)


def advance_after_run(order) -> None:
    """Move the order to its next occurrence after a SUCCESSFUL run, or deactivate
    a fired 'once'. Caller commits."""
    now = now_eat()
    if order.schedule_type == "once":
        order.active = False
        order.next_run_on = order.run_date or now.date()
        return
    nxt = compute_next_run(order.schedule_type, order.schedule_day, order.run_date, order.run_time, now)
    order.next_run_on = nxt or now.date()


# ── Execution ───────────────────────────────────────────────────────────────
def _rail_transfer_kwargs(order, payer_account_id: str) -> dict:
    """Map a standing order onto choice.transfer() args for its rail."""
    if order.rail == "mpesa":
        phone = "".join(ch for ch in (order.payee_account or "") if ch.isdigit())
        if phone.startswith("254"):
            phone = phone[3:]
        elif phone.startswith("0"):
            phone = phone[1:]
        return dict(payer_account_id=payer_account_id, payee_account_id=phone,
                    amount=order.amount, payee_bank_code="M-PESA",
                    remark=order.remark or "SparkP2P standing order")
    if order.rail == "choice":                     # internal Choice-to-Choice
        return dict(payer_account_id=payer_account_id, payee_account_id=order.payee_account,
                    amount=order.amount, payee_bank_code="",
                    payee_name=order.payee_name or "",
                    remark=order.remark or "SparkP2P standing order")
    # pesalink (external bank)
    return dict(payer_account_id=payer_account_id, payee_account_id=order.payee_account,
                amount=order.amount, payee_bank_code=order.payee_bank_code or "",
                payee_name=order.payee_name or "",
                remark=order.remark or "SparkP2P standing order")


def _label(order) -> str:
    if order.rail == "mpesa":
        return f"M-Pesa {order.payee_account}"
    if order.rail == "choice":
        return f"Choice account {order.payee_account}"
    return f"{order.payee_bank_name or 'bank'} {order.payee_account}".strip()


async def _wait_sms_otp(trader, tx_id: str) -> str:
    """Auto-capture the Choice SMS OTP over the MacroDroid relay — mirrors
    bank_transfer_confirm_sms. Raises on timeout (no relay / no SMS)."""
    from app.api.routes.extension import _pending_sms_otps
    import time as _t
    acc4 = str(trader.choice_account_id)[-4:]

    cached = _pending_sms_otps.get(acc4)
    if cached and cached.get("otp") and cached.get("event") is None and _t.time() - cached.get("ts", 0) < 300:
        otp = cached["otp"]
        _pending_sms_otps.pop(acc4, None)
        return otp

    event = asyncio.Event()
    _pending_sms_otps[acc4] = {"event": event, "otp": None}
    try:
        try:
            await asyncio.wait_for(event.wait(), timeout=OTP_WAIT_S)
        except asyncio.TimeoutError:
            try:
                await choice.resend_otp(tx_id, otp_type="SMS")
            except Exception as _re:
                logger.warning("[standing-order] resend_otp failed: %s", _re)
            event.clear()
            _pending_sms_otps[acc4]["otp"] = None
            await asyncio.wait_for(event.wait(), timeout=OTP_RESEND_WAIT_S)
        otp = (_pending_sms_otps.get(acc4) or {}).get("otp")
        if not otp:
            raise RuntimeError("SMS OTP event fired but no code stored")
        return otp
    finally:
        _pending_sms_otps.pop(acc4, None)


async def execute_standing_order(order, trader, db) -> tuple[str, str | None, str | None]:
    """Run one standing order NOW. Returns (status, tx_id, error) where status is
    'success' | 'skipped_no_funds' | 'failed'. Never raises."""
    from app.api.routes.extension import _choice_balance

    if not trader.choice_account_id:
        return ("failed", None, "No Choice Bank account linked")

    # 1. Funds check — skip (don't part-pay) if the balance can't cover amount + fee.
    try:
        bal = await _choice_balance(trader)
    except Exception as e:
        return ("failed", None, f"Balance check failed: {e}")
    if bal is None:
        return ("failed", None, "Balance unavailable")
    # Use the ACTUAL rail fee from the pricing table (PesaLink flat 25, M-Pesa tiered),
    # not a flat guess. pesalink + internal Choice map to the BANK/PesaLink table.
    from app.services.outbound_fees import outbound_fee
    fee = outbound_fee("MPESA" if order.rail == "mpesa" else "BANK", order.amount)
    needed = float(order.amount) + fee + FEE_CUSHION_KES
    if float(bal) < needed:
        return ("skipped_no_funds", None,
                f"Balance KES {float(bal):,.0f} < KES {float(order.amount):,.0f} + KES {fee} fee")

    label = _label(order)
    try:
        # 2. Initiate the transfer for this rail.
        result = await choice.transfer(**_rail_transfer_kwargs(order, trader.choice_account_id))
        if result.get("code") != "00000":
            return ("failed", None, result.get("msg", "Transfer rejected by Choice Bank"))
        tx_id = (result.get("data") or {}).get("txId") or ""
        if not tx_id:
            return ("failed", None, "No transaction ID returned")

        # 3. Send + auto-confirm the SMS OTP.
        try:
            await choice.send_otp(tx_id, otp_type="SMS")
        except Exception as e:
            logger.warning("[standing-order] sendOtp failed for tx %s: %s", tx_id, e)
        otp = await _wait_sms_otp(trader, tx_id)
        conf = await choice.confirm_otp(tx_id, otp)
        if conf.get("code") != "00000":
            return ("failed", tx_id, conf.get("msg", "OTP confirmation rejected"))
    except Exception as e:
        return ("failed", None, str(e)[:280])

    # 4. Ledger + notify (best-effort — the money already moved).
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_BANK_TRANSFER, -float(order.amount),
                              f"Standing order to {order.payee_name} ({label}) via Choice Bank",
                              mpesa_receipt=tx_id)
        await db.commit()
    except Exception:
        await db.rollback()
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001F501 Standing order paid: KES {float(order.amount):,.0f} to "
                                    f"{order.payee_name} ({label})\nRef: {tx_id}")
    except Exception:
        pass

    return ("success", tx_id, None)
