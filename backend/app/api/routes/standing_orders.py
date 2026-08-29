"""Merchant standing-order management (self-service).

Create/list/pause/delete recurring Choice Bank transfers. Creating one moves money
unattended later, so it is guarded: TOTP is required, and a PesaLink bank payee is
name-verified via validateAccount. The executor (standing_order_poller) is what
actually sends money, gated by settings.STANDING_ORDERS_ENABLED.
"""
import logging
from datetime import date, datetime, time as _time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_db
from app.models.trader import Trader
from app.models.standing_order import StandingOrder
from app.services.choice_bank import client as choice
from app.services.standing_orders import compute_next_run, first_monthly_run, now_eat, DEFAULT_RUN_TIME

router = APIRouter()
logger = logging.getLogger("sparkp2p.standing_orders")

_RAILS = {"pesalink", "mpesa", "choice"}
_SCHEDULES = {"monthly", "weekly", "once"}


def _verify_totp_or_400(trader: Trader, code: str):
    import pyotp
    from app.core.security import decrypt_data
    if not trader.totp_secret:
        raise HTTPException(status_code=400, detail="Set up Google Authenticator in Profile & Security first.")
    if not code or not pyotp.TOTP(decrypt_data(trader.totp_secret)).verify(code.strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid Google Authenticator code.")


def _serialize(o: StandingOrder) -> dict:
    return {
        "id": o.id, "rail": o.rail, "payee_account": o.payee_account, "payee_name": o.payee_name,
        "payee_bank_code": o.payee_bank_code, "payee_bank_name": o.payee_bank_name,
        "amount": o.amount, "remark": o.remark,
        "schedule_type": o.schedule_type, "schedule_day": o.schedule_day,
        "run_date": o.run_date.isoformat() if o.run_date else None,
        "run_time": o.run_time.strftime("%H:%M") if o.run_time else None,
        "next_run_on": o.next_run_on.isoformat() if o.next_run_on else None,
        "active": o.active, "last_status": o.last_status, "last_error": o.last_error,
        "last_run_at": o.last_run_at.isoformat() if o.last_run_at else None,
        "last_tx_id": o.last_tx_id, "run_count": o.run_count,
    }


@router.get("/standing-orders")
async def list_orders(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(StandingOrder).where(StandingOrder.trader_id == trader.id).order_by(StandingOrder.created_at.desc())
    )).scalars().all()
    return {"orders": [_serialize(o) for o in rows],
            "choice_linked": bool(trader.choice_account_id),
            "totp_ready": bool(trader.totp_secret)}


class ValidatePayee(BaseModel):
    account: str
    bank_code: str


@router.post("/standing-orders/validate-payee")
async def validate_payee(body: ValidatePayee, trader: Trader = Depends(get_current_trader)):
    """PesaLink name lookup — confirm the beneficiary name before saving an order."""
    acc = (body.account or "").strip()
    if not acc or not (body.bank_code or "").strip():
        raise HTTPException(status_code=400, detail="Account number and bank are required.")
    try:
        res = await choice.validate_account(acc, body.bank_code.strip())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Name lookup failed: {e}")
    if res.get("code") != "00000":
        raise HTTPException(status_code=400, detail=res.get("msg", "Could not verify that account."))
    name = (res.get("data") or {}).get("accountName") or ""
    if not name:
        raise HTTPException(status_code=400, detail="No account name returned — check the details.")
    return {"account_name": name}


class CreateOrder(BaseModel):
    rail: str
    payee_account: str
    payee_name: str = ""
    payee_bank_code: str | None = None
    payee_bank_name: str | None = None
    amount: float
    remark: str | None = None
    schedule_type: str
    schedule_day: int | None = None      # 1..31 (monthly) or 0..6 Mon=0 (weekly)
    start_month: int | None = None       # 1..12 — the month the monthly order first runs in
    run_date: str | None = None          # ISO date for 'once'
    run_time: str | None = None          # "HH:MM" EAT — when on the day it fires
    totp_code: str


@router.post("/standing-orders")
async def create_order(body: CreateOrder, trader: Trader = Depends(get_current_trader),
                       db: AsyncSession = Depends(get_db)):
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Link your Choice Bank account first.")
    if body.rail not in _RAILS:
        raise HTTPException(status_code=400, detail="Invalid rail.")
    if body.schedule_type not in _SCHEDULES:
        raise HTTPException(status_code=400, detail="Invalid schedule.")
    if body.amount is None or body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount.")
    acc = (body.payee_account or "").strip()
    if not acc:
        raise HTTPException(status_code=400, detail="Enter the payee account/number.")

    # Money-movement guard: TOTP always.
    _verify_totp_or_400(trader, body.totp_code)

    # Resolve/verify the payee name.
    payee_name = (body.payee_name or "").strip()
    payee_bank_code = (body.payee_bank_code or "").strip() or None
    if body.rail == "pesalink":
        if not payee_bank_code:
            raise HTTPException(status_code=400, detail="Select the beneficiary's bank.")
        if body.amount > 999999:
            raise HTTPException(status_code=400, detail="PesaLink is limited to KES 999,999 per transfer.")
        try:
            res = await choice.validate_account(acc, payee_bank_code)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Name verification failed: {e}")
        if res.get("code") != "00000":
            raise HTTPException(status_code=400, detail=res.get("msg", "Could not verify that account."))
        verified = (res.get("data") or {}).get("accountName") or ""
        if not verified:
            raise HTTPException(status_code=400, detail="Account name could not be verified.")
        payee_name = verified                                    # trust the bank's name, not the typed one
    else:
        if not payee_name:
            raise HTTPException(status_code=400, detail="Enter the payee name.")
        if body.rail == "mpesa":
            payee_bank_code = "M-PESA"

    # Parse the run time (EAT "HH:MM"); default 09:00.
    run_time = DEFAULT_RUN_TIME
    if (body.run_time or "").strip():
        try:
            hh, mm = (body.run_time.strip().split(":") + ["0"])[:2]
            run_time = _time(int(hh), int(mm))
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Enter a valid time (HH:MM).")

    now = now_eat()

    # Validate schedule fields + compute the first run (its date+time strictly ahead of now).
    run_date = None
    schedule_day = body.schedule_day
    if body.schedule_type == "monthly":
        if schedule_day is None or not (1 <= schedule_day <= 31):
            raise HTTPException(status_code=400, detail="Choose a day of the month (1–31).")
        if body.start_month is not None and not (1 <= body.start_month <= 12):
            raise HTTPException(status_code=400, detail="Choose a valid start month.")
    elif body.schedule_type == "weekly":
        if schedule_day is None or not (0 <= schedule_day <= 6):
            raise HTTPException(status_code=400, detail="Choose a weekday.")
    else:  # once
        try:
            run_date = date.fromisoformat((body.run_date or "").strip())
        except ValueError:
            raise HTTPException(status_code=400, detail="Choose a valid run date.")

    if body.schedule_type == "monthly" and body.start_month:
        next_run = first_monthly_run(body.start_month, schedule_day, run_time, now)
    else:
        next_run = compute_next_run(body.schedule_type, schedule_day, run_date, run_time, now)
    if not next_run:
        raise HTTPException(status_code=400, detail="That date/time is already in the past — pick a future one.")

    order = StandingOrder(
        trader_id=trader.id, rail=body.rail, payee_account=acc, payee_name=payee_name,
        payee_bank_code=payee_bank_code, payee_bank_name=(body.payee_bank_name or "").strip() or None,
        amount=float(body.amount), remark=(body.remark or "").strip()[:140] or None,
        schedule_type=body.schedule_type, schedule_day=schedule_day, run_date=run_date,
        run_time=run_time, next_run_on=next_run, active=True,
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)
    logger.info("[standing-order] trader %s created #%s %s KES %s -> %s (%s) next=%s",
                trader.id, order.id, order.rail, order.amount, payee_name, acc, next_run)
    return _serialize(order)


class UpdateOrder(BaseModel):
    active: bool | None = None
    amount: float | None = None


@router.patch("/standing-orders/{order_id}")
async def update_order(order_id: int, body: UpdateOrder,
                       trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    order = await db.get(StandingOrder, order_id)
    if not order or order.trader_id != trader.id:
        raise HTTPException(status_code=404, detail="Not found.")
    if body.active is not None:
        order.active = bool(body.active)
    if body.amount is not None:
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="Enter a valid amount.")
        order.amount = float(body.amount)
    await db.commit()
    await db.refresh(order)
    return _serialize(order)


@router.delete("/standing-orders/{order_id}")
async def delete_order(order_id: int, trader: Trader = Depends(get_current_trader),
                       db: AsyncSession = Depends(get_db)):
    order = await db.get(StandingOrder, order_id)
    if not order or order.trader_id != trader.id:
        raise HTTPException(status_code=404, detail="Not found.")
    await db.delete(order)
    await db.commit()
    return {"ok": True}
