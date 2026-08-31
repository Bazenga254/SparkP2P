"""
Shareable, password-protected, READ-ONLY public views of a Choice Bank account.

A merchant (or an admin) creates a link; anyone with the link + its password can, ON THE
WEBSITE (not the app), see the account balance, the paybill/account numbers, optionally the
transactions (with payer names), and deposit by M-Pesa STK. They can NOT withdraw or transfer.

Security posture:
  - Password is bcrypt-hashed; the plaintext is never stored or returned. Admins can delete /
    suspend / unlock a link but can NEVER see the password.
  - 4 wrong password attempts LOCK the link; only an admin can unlock it.
  - A short-lived signed view token gates the read + deposit endpoints after unlock.
  - Deposits go to the MERCHANT'S OWN Choice account (normal paybill payment). This module
    never touches the subscription paybill.
"""
import secrets
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Header, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader, get_admin_trader
from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token, decode_access_token
from app.models import Payment, PaymentDirection, PaymentStatus
from app.models.trader import Trader
from app.models.account_share_link import AccountShareLink
from app.services.choice_bank import client as choice
from app.services.sms import send_sms

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FAILED = 4


def _valid_pin(pin: str) -> bool:
    return bool(pin) and pin.isdigit() and 4 <= len(pin) <= 6


def _sms_link(phone: str | None, url: str, pin: str, label: str) -> None:
    """Text the recipient the link + PIN. Best-effort — never blocks link creation."""
    if not phone:
        return
    try:
        send_sms(phone, f"You've been given access to a SparkP2P account ({label}). "
                        f"View balance & deposit here: {url} PIN: {pin}. Keep your PIN private.")
    except Exception as exc:
        logger.warning("[ShareLink] SMS send failed: %s", exc)
VIEW_TOKEN_MINUTES = 30
CHOICE_TX_TYPES = ["CHOICE_DEPOSIT", "CHOICE_INBOUND", "CHOICE_OUTBOUND"]


# ── helpers ───────────────────────────────────────────────────────────────────
def _public_url(slug: str) -> str:
    return f"https://sparkp2p.com/account/{slug}"


def _link_out(l: AccountShareLink, include_url: bool = True) -> dict:
    """Owner/admin-facing shape. NEVER includes the password."""
    d = {
        "id": l.id,
        "slug": l.slug,
        "label": l.label or "Account view",
        "status": l.status,
        "show_transactions": l.show_transactions,
        "allow_deposit": l.allow_deposit,
        "failed_attempts": l.failed_attempts,
        "locked": l.status == "locked",
        "account_number": l.choice_account_number,
        "created_by": l.created_by,
        "recipient_phone": ("•" * max(0, len(l.recipient_phone) - 4) + l.recipient_phone[-4:]) if l.recipient_phone else None,
        "view_count": l.view_count,
        "last_viewed_at": l.last_viewed_at.isoformat() if l.last_viewed_at else None,
        "created_at": l.created_at.isoformat() if l.created_at else None,
    }
    if include_url:
        d["url"] = _public_url(l.slug)
    return d


async def _account_snapshot(link: AccountShareLink) -> dict:
    """Live balance + paybill/account numbers for the link's Choice account."""
    acct_id = link.choice_account_id
    # Choice's account API rarely returns a per-account shortCode; the paybill is the shared
    # Choice Bank paybill (444174) and the account NUMBER identifies the account — same as the
    # merchant's own "My Paybill" screen, which falls back to this constant.
    out = {"balance": None, "currency": "KES", "account_number": link.choice_account_number,
           "paybill": "444174", "status": None}
    if not acct_id:
        return out
    try:
        r = await choice.get_account_details(acct_id)
        data = r.get("data") or {}
        out.update({
            "balance": data.get("balance"),
            "currency": data.get("currency", "KES"),
            "account_number": data.get("accountNumber") or link.choice_account_number,
            "paybill": data.get("shortCode") or "444174",
            "status": data.get("accountStatus"),
        })
    except Exception as exc:
        logger.warning("[ShareLink] balance fetch failed for %s: %s", link.slug, exc)
    return out


def _require_view(slug: str, x_share_token: str | None) -> str:
    """Validate the short-lived view token issued at unlock; returns the slug it is for."""
    if not x_share_token:
        raise HTTPException(status_code=401, detail="Enter the account password to continue.")
    payload = decode_access_token(x_share_token)
    if not payload or payload.get("typ") != "share" or payload.get("sub") != slug:
        raise HTTPException(status_code=401, detail="Session expired — enter the password again.")
    return slug


async def _get_link_owned(link_id: int, trader: Trader, db: AsyncSession) -> AccountShareLink:
    l = await db.get(AccountShareLink, link_id)
    if not l or l.trader_id != trader.id:
        raise HTTPException(status_code=404, detail="Link not found")
    return l


# ══════════════════════════════════════════════════════════════════════════════
# MERCHANT — create & manage own links
# ══════════════════════════════════════════════════════════════════════════════
class CreateLink(BaseModel):
    label: str | None = None
    pin: str
    show_transactions: bool = True
    allow_deposit: bool = True
    recipient_phone: str | None = None


@router.post("/links")
async def create_link(body: CreateLink, trader: Trader = Depends(get_current_trader),
                      db: AsyncSession = Depends(get_db)):
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="Link a Choice Bank account first.")
    if not _valid_pin(body.pin):
        raise HTTPException(status_code=400, detail="PIN must be 4 to 6 digits.")
    slug = secrets.token_urlsafe(8)[:12]
    phone = (body.recipient_phone or "").strip() or None
    link = AccountShareLink(
        slug=slug,
        trader_id=trader.id,
        choice_account_id=trader.choice_account_id,
        choice_account_number=trader.choice_account_number,
        label=(body.label or "").strip()[:120] or "Account view",
        password_hash=hash_password(body.pin),
        show_transactions=bool(body.show_transactions),
        allow_deposit=bool(body.allow_deposit),
        recipient_phone=phone,
        created_by="merchant",
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    _sms_link(phone, _public_url(slug), body.pin, link.label)
    out = _link_out(link)
    out["sms_sent"] = bool(phone)
    return out


@router.get("/links")
async def list_links(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(AccountShareLink).where(AccountShareLink.trader_id == trader.id)
        .order_by(AccountShareLink.created_at.desc())
    )).scalars().all()
    return {"links": [_link_out(l) for l in rows]}


class UpdateLink(BaseModel):
    label: str | None = None
    show_transactions: bool | None = None
    allow_deposit: bool | None = None


@router.patch("/links/{link_id}")
async def update_link(link_id: int, body: UpdateLink,
                      trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    l = await _get_link_owned(link_id, trader, db)
    if body.label is not None:
        l.label = body.label.strip()[:120] or "Account view"
    if body.show_transactions is not None:
        l.show_transactions = bool(body.show_transactions)
    if body.allow_deposit is not None:
        l.allow_deposit = bool(body.allow_deposit)
    await db.commit()
    await db.refresh(l)
    return _link_out(l)


class ChangePin(BaseModel):
    pin: str
    recipient_phone: str | None = None   # optional: re-send the new PIN by SMS


@router.post("/links/{link_id}/password")
async def change_pin(link_id: int, body: ChangePin,
                     trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    if not _valid_pin(body.pin):
        raise HTTPException(status_code=400, detail="PIN must be 4 to 6 digits.")
    l = await _get_link_owned(link_id, trader, db)
    l.password_hash = hash_password(body.pin)
    l.failed_attempts = 0
    if l.status == "locked":
        l.status = "active"   # a fresh PIN clears an owner-side lock
    phone = (body.recipient_phone or "").strip() or l.recipient_phone
    if phone:
        l.recipient_phone = phone
    await db.commit()
    _sms_link(phone, _public_url(l.slug), body.pin, l.label)
    return {"ok": True, "sms_sent": bool(phone)}


class SetStatus(BaseModel):
    status: str   # 'active' | 'suspended'


@router.post("/links/{link_id}/status")
async def set_status(link_id: int, body: SetStatus,
                     trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    if body.status not in ("active", "suspended"):
        raise HTTPException(status_code=400, detail="status must be active or suspended")
    l = await _get_link_owned(link_id, trader, db)
    if l.status == "locked" and body.status == "active":
        raise HTTPException(status_code=403, detail="This link is locked — only an admin can unlock it.")
    l.status = body.status
    await db.commit()
    return _link_out(l)


@router.delete("/links/{link_id}")
async def delete_link(link_id: int, trader: Trader = Depends(get_current_trader),
                      db: AsyncSession = Depends(get_db)):
    l = await _get_link_owned(link_id, trader, db)
    await db.delete(l)
    await db.commit()
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════════════════
# PUBLIC — password-gated read-only view + deposit (no auth)
# ══════════════════════════════════════════════════════════════════════════════
class Unlock(BaseModel):
    pin: str


@router.post("/public/account/{slug}/unlock")
async def unlock(slug: str, body: Unlock, db: AsyncSession = Depends(get_db)):
    link = (await db.execute(select(AccountShareLink).where(AccountShareLink.slug == slug))).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="This link does not exist.")
    if link.status == "suspended":
        raise HTTPException(status_code=403, detail="This link has been suspended by its owner.")
    if link.status == "locked":
        raise HTTPException(status_code=423, detail="This link is locked after too many wrong PINs. Contact the owner.")

    if not verify_password(body.pin or "", link.password_hash):
        link.failed_attempts = (link.failed_attempts or 0) + 1
        if link.failed_attempts >= MAX_FAILED:
            link.status = "locked"
        await db.commit()
        if link.status == "locked":
            raise HTTPException(status_code=423, detail="Too many wrong attempts — the link is now locked.")
        left = MAX_FAILED - link.failed_attempts
        raise HTTPException(status_code=401, detail=f"Wrong PIN. {left} attempt(s) left before the link locks.")

    link.failed_attempts = 0
    link.view_count = (link.view_count or 0) + 1
    link.last_viewed_at = datetime.now(timezone.utc)
    await db.commit()
    token = create_access_token({"sub": slug, "typ": "share"}, expires_delta=timedelta(minutes=VIEW_TOKEN_MINUTES))
    return {"token": token}


@router.get("/public/account/{slug}")
async def public_view(slug: str, x_share_token: str | None = Header(default=None),
                      db: AsyncSession = Depends(get_db)):
    _require_view(slug, x_share_token)
    link = (await db.execute(select(AccountShareLink).where(AccountShareLink.slug == slug))).scalar_one_or_none()
    if not link or link.status != "active":
        raise HTTPException(status_code=404, detail="This link is no longer available.")
    trader = await db.get(Trader, link.trader_id)
    snap = await _account_snapshot(link)
    return {
        "label": link.label or "Account view",
        "account_name": (trader.full_name if trader else None) or link.label or "Account",
        "account_number": snap["account_number"],
        "paybill": snap["paybill"],
        "balance": snap["balance"],
        "currency": snap["currency"],
        "show_transactions": link.show_transactions,
        "allow_deposit": link.allow_deposit,
    }


@router.get("/public/account/{slug}/transactions")
async def public_transactions(slug: str, x_share_token: str | None = Header(default=None),
                              db: AsyncSession = Depends(get_db)):
    _require_view(slug, x_share_token)
    link = (await db.execute(select(AccountShareLink).where(AccountShareLink.slug == slug))).scalar_one_or_none()
    if not link or link.status != "active":
        raise HTTPException(status_code=404, detail="This link is no longer available.")
    if not link.show_transactions:
        return {"transactions": [], "hidden": True}

    rows = (await db.execute(
        select(Payment).where(
            Payment.trader_id == link.trader_id,
            Payment.transaction_type.in_(CHOICE_TX_TYPES),
        ).order_by(Payment.created_at.desc()).limit(50)
    )).scalars().all()

    out = []
    for p in rows:
        direction = "in" if p.direction == PaymentDirection.INBOUND else "out"
        status = p.status.value if hasattr(p.status, "value") else str(p.status)
        name = (p.sender_name or "").strip() if direction == "in" else (p.destination or "").strip()
        out.append({
            "direction": direction,
            "amount": float(p.amount or 0),
            "name": name or ("Deposit" if direction == "in" else "Payment"),
            "type": "Deposit" if (p.transaction_type or "").upper() == "CHOICE_DEPOSIT" else ("Received" if direction == "in" else "Sent"),
            "status": status,
            "date": p.created_at.isoformat() if p.created_at else None,
        })
    return {"transactions": out, "hidden": False}


class PublicDeposit(BaseModel):
    phone: str
    amount: int


@router.post("/public/account/{slug}/deposit")
async def public_deposit(slug: str, body: PublicDeposit, background_tasks: BackgroundTasks,
                         x_share_token: str | None = Header(default=None), db: AsyncSession = Depends(get_db)):
    _require_view(slug, x_share_token)
    link = (await db.execute(select(AccountShareLink).where(AccountShareLink.slug == slug))).scalar_one_or_none()
    if not link or link.status != "active":
        raise HTTPException(status_code=404, detail="This link is no longer available.")
    if not link.allow_deposit:
        raise HTTPException(status_code=403, detail="Deposits are turned off for this link.")
    if not link.choice_account_id:
        raise HTTPException(status_code=400, detail="This account cannot receive deposits right now.")
    if body.amount < 1:
        raise HTTPException(status_code=400, detail="Amount must be at least KES 1.")

    from app.api.routes.choice_bank import _normalize_mobile, _monitor_deposit
    mobile = _normalize_mobile((body.phone or "").strip())
    if len(mobile) != 9 or not mobile.isdigit():
        raise HTTPException(status_code=400, detail="Enter a valid Kenyan phone number.")

    result = await choice.deposit_from_mpesa(link.choice_account_id, mobile, body.amount)
    tx_id = result.get("data", {}).get("txId") or result.get("txId") or ""

    # No tx id = Choice did NOT start an STK push (soft failure). Surface the real reason
    # instead of falsely telling the viewer to "check your phone".
    if not tx_id:
        msg = (result.get("message") or (result.get("data") or {}).get("message")
               or "M-Pesa could not start the deposit — please try again in a moment.")
        logger.warning("[ShareLink] deposit no txId for %s: %s", link.slug, result)
        raise HTTPException(status_code=502, detail=msg)

    payment_id = None
    try:
        p = Payment(
            trader_id=link.trader_id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=tx_id or f"cb_link_{link.id}_{body.amount}",
            transaction_type="CHOICE_DEPOSIT",
            amount=body.amount,
            phone=mobile,
            sender_name="",  # the real payer name lands from the M-Pesa/Choice callback
            remarks=f"Deposit via shared link {link.slug}",
            status=PaymentStatus.PENDING,
        )
        db.add(p)
        await db.commit()
        await db.refresh(p)
        payment_id = p.id
    except Exception as exc:
        logger.warning("[ShareLink] failed to log deposit: %s", exc)

    if payment_id and tx_id:
        background_tasks.add_task(_monitor_deposit, payment_id, tx_id)
    return {"txId": tx_id, "status": "stk_sent"}


@router.get("/public/account/{slug}/deposit-status")
async def public_deposit_status(slug: str, tx_id: str, x_share_token: str | None = Header(default=None),
                                db: AsyncSession = Depends(get_db)):
    _require_view(slug, x_share_token)
    link = (await db.execute(select(AccountShareLink).where(AccountShareLink.slug == slug))).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    p = (await db.execute(select(Payment).where(
        Payment.mpesa_transaction_id == tx_id.strip(),
        Payment.trader_id == link.trader_id,
        Payment.transaction_type == "CHOICE_DEPOSIT",
    ))).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if p.status != PaymentStatus.PENDING:
        return {"status": "success" if p.status == PaymentStatus.COMPLETED else "failed", "amount": float(p.amount)}
    try:
        r = await choice.get_transaction_result(tx_id.strip())
        st = str((r.get("data") or {}).get("txStatus") or "")
    except Exception:
        return {"status": "pending", "amount": float(p.amount)}
    if st == "8":
        p.status = PaymentStatus.COMPLETED
        await db.commit()
        return {"status": "success", "amount": float(p.amount)}
    if st in ("4", "-1"):
        p.status = PaymentStatus.FAILED
        await db.commit()
        return {"status": "failed", "amount": float(p.amount)}
    return {"status": "pending", "amount": float(p.amount)}


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN — list / unlock / suspend / delete (never sees passwords)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/admin/share-links/trader/{trader_id}")
async def admin_list_links(trader_id: int, admin: Trader = Depends(get_admin_trader),
                           db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(AccountShareLink).where(AccountShareLink.trader_id == trader_id)
        .order_by(AccountShareLink.created_at.desc())
    )).scalars().all()
    return {"links": [_link_out(l) for l in rows]}


@router.post("/admin/share-links/{link_id}/unlock")
async def admin_unlock(link_id: int, admin: Trader = Depends(get_admin_trader),
                       db: AsyncSession = Depends(get_db)):
    l = await db.get(AccountShareLink, link_id)
    if not l:
        raise HTTPException(status_code=404, detail="Link not found")
    l.failed_attempts = 0
    l.status = "active"
    await db.commit()
    return _link_out(l)


@router.post("/admin/share-links/{link_id}/status")
async def admin_set_status(link_id: int, body: SetStatus, admin: Trader = Depends(get_admin_trader),
                           db: AsyncSession = Depends(get_db)):
    if body.status not in ("active", "suspended"):
        raise HTTPException(status_code=400, detail="status must be active or suspended")
    l = await db.get(AccountShareLink, link_id)
    if not l:
        raise HTTPException(status_code=404, detail="Link not found")
    l.status = body.status
    await db.commit()
    return _link_out(l)


@router.delete("/admin/share-links/{link_id}")
async def admin_delete(link_id: int, admin: Trader = Depends(get_admin_trader),
                       db: AsyncSession = Depends(get_db)):
    l = await db.get(AccountShareLink, link_id)
    if not l:
        raise HTTPException(status_code=404, detail="Link not found")
    await db.delete(l)
    await db.commit()
    return {"ok": True}
