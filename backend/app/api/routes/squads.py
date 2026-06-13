"""Squad Mode API — Phase A (model + consent + simulation). See docs/squad-mode.md.

Live price pushing is Phase B; here mode is limited to 'off' | 'sim'.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Trader, Squad, SquadMember
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────
async def _my_squad(db: AsyncSession, trader_id: int):
    """The squad where I'm captain or an active member (a trader is in at most one)."""
    sq = (await db.execute(select(Squad).where(Squad.captain_trader_id == trader_id))).scalar_one_or_none()
    if sq:
        return sq
    mem = (await db.execute(
        select(SquadMember).where(SquadMember.trader_id == trader_id, SquadMember.status == "active")
    )).scalar_one_or_none()
    if mem:
        return (await db.execute(select(Squad).where(Squad.id == mem.squad_id))).scalar_one_or_none()
    return None


async def _members(db: AsyncSession, squad: Squad):
    rows = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == squad.id, SquadMember.status != "left")
    )).scalars().all()
    ids = [m.trader_id for m in rows]
    traders = {t.id: t for t in (await db.execute(select(Trader).where(Trader.id.in_(ids)))).scalars().all()} if ids else {}
    from app.services.binance import relay_router
    out = []
    for m in rows:
        t = traders.get(m.trader_id)
        if not t:
            continue
        out.append({
            "trader_id": t.id, "name": t.full_name, "email": t.email,
            "nick": t.binance_nickname, "status": m.status,
            "is_captain": t.id == squad.captain_trader_id,
            "has_api": bool(t.binance_api_key),
            "verified": (t.binance_p2p_tier in ("gold", "silver", "bronze")),
            "relay_online": bool(relay_router.is_connected(t.id)),
        })
    return out


def _squad_dict(squad: Squad, trader_id: int):
    return {
        "id": squad.id, "name": squad.name, "mode": squad.mode,
        "rotation_minutes": squad.rotation_minutes,
        "margin_min": squad.margin_min, "margin_max": squad.margin_max,
        "side_mode": squad.side_mode, "volume_gate_pct": squad.volume_gate_pct,
        "max_gap": squad.max_gap, "is_captain": squad.captain_trader_id == trader_id,
    }


# ── schemas ──────────────────────────────────────────────────────
class CreateSquad(BaseModel):
    name: str


class InviteBody(BaseModel):
    email: str


class RespondBody(BaseModel):
    squad_id: int
    accept: bool


class SquadSettings(BaseModel):
    mode: Optional[str] = None
    rotation_minutes: Optional[int] = None
    margin_min: Optional[float] = None
    margin_max: Optional[float] = None
    side_mode: Optional[str] = None
    volume_gate_pct: Optional[float] = None
    max_gap: Optional[float] = None


# ── endpoints ────────────────────────────────────────────────────
@router.get("/me")
async def my_squad(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    squad = await _my_squad(db, trader.id)
    # Pending invites for me
    inv_rows = (await db.execute(
        select(SquadMember).where(SquadMember.trader_id == trader.id, SquadMember.status == "invited")
    )).scalars().all()
    invites = []
    for iv in inv_rows:
        sq = (await db.execute(select(Squad).where(Squad.id == iv.squad_id))).scalar_one_or_none()
        if not sq:
            continue
        cap = (await db.execute(select(Trader).where(Trader.id == sq.captain_trader_id))).scalar_one_or_none()
        invites.append({"squad_id": sq.id, "name": sq.name, "captain_name": cap.full_name if cap else "—"})
    if not squad:
        return {"squad": None, "role": None, "members": [], "invites": invites}
    return {
        "squad": _squad_dict(squad, trader.id),
        "role": "captain" if squad.captain_trader_id == trader.id else "member",
        "members": await _members(db, squad),
        "invites": invites,
    }


@router.post("/create")
async def create_squad(body: CreateSquad, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    if not getattr(trader, "price_tracker_enabled", False):
        raise HTTPException(403, "Squad Mode is part of the Price Tracker, which isn't enabled for your account.")
    if await _my_squad(db, trader.id):
        raise HTTPException(400, "You're already in a squad. Leave it first.")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Squad name required.")
    squad = Squad(name=name, captain_trader_id=trader.id, mode="off",
                  rotation_anchor=datetime.now(timezone.utc))
    db.add(squad)
    await db.flush()
    db.add(SquadMember(squad_id=squad.id, trader_id=trader.id, status="active"))
    await db.commit()
    return {"status": "created", "squad_id": squad.id}


@router.post("/invite")
async def invite_member(body: InviteBody, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    squad = await _my_squad(db, trader.id)
    if not squad or squad.captain_trader_id != trader.id:
        raise HTTPException(403, "Only the squad captain can invite members.")
    email = (body.email or "").strip().lower()
    target = (await db.execute(select(Trader).where(Trader.email == email))).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "No SparkP2P account with that email.")
    if target.id == trader.id:
        raise HTTPException(400, "You're already the captain.")
    # Already a member/invite of this squad?
    existing = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == squad.id, SquadMember.trader_id == target.id,
                                  SquadMember.status != "left")
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "That merchant is already invited or in the squad.")
    # In another active squad?
    if await _my_squad(db, target.id):
        raise HTTPException(400, "That merchant is already in another squad.")
    db.add(SquadMember(squad_id=squad.id, trader_id=target.id, status="invited"))
    await db.commit()
    return {"status": "invited", "name": target.full_name}


@router.post("/respond")
async def respond_invite(body: RespondBody, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    inv = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == body.squad_id, SquadMember.trader_id == trader.id,
                                  SquadMember.status == "invited")
    )).scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "No pending invite found.")
    if not body.accept:
        inv.status = "left"
        await db.commit()
        return {"status": "declined"}
    if await _my_squad(db, trader.id):
        raise HTTPException(400, "You're already in a squad. Leave it first.")
    inv.status = "active"
    await db.commit()
    return {"status": "joined"}


@router.post("/leave")
async def leave_squad(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    squad = await _my_squad(db, trader.id)
    if not squad:
        raise HTTPException(404, "You're not in a squad.")
    if squad.captain_trader_id == trader.id:
        # Captain disbands the squad.
        await db.execute(SquadMember.__table__.delete().where(SquadMember.squad_id == squad.id))
        await db.execute(Squad.__table__.delete().where(Squad.id == squad.id))
        await db.commit()
        return {"status": "disbanded"}
    mem = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == squad.id, SquadMember.trader_id == trader.id)
    )).scalar_one_or_none()
    if mem:
        mem.status = "left"
        await db.commit()
    return {"status": "left"}


@router.put("/settings")
async def update_settings(body: SquadSettings, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    squad = await _my_squad(db, trader.id)
    if not squad or squad.captain_trader_id != trader.id:
        raise HTTPException(403, "Only the squad captain can change settings.")
    if body.mode is not None:
        if body.mode == "live":
            raise HTTPException(400, "Live coordinated pricing is Phase B — not enabled yet. Use Simulate for now.")
        squad.mode = body.mode if body.mode in ("off", "sim") else "off"
        if squad.mode == "sim" and not squad.rotation_anchor:
            squad.rotation_anchor = datetime.now(timezone.utc)
    if body.rotation_minutes is not None:
        squad.rotation_minutes = max(1, min(int(body.rotation_minutes), 120))
    if body.margin_min is not None:
        squad.margin_min = max(0.0, float(body.margin_min))
    if body.margin_max is not None:
        squad.margin_max = max(0.0, float(body.margin_max))
    if body.side_mode is not None:
        squad.side_mode = body.side_mode if body.side_mode in ("both", "sell", "buy") else "both"
    if body.volume_gate_pct is not None:
        squad.volume_gate_pct = min(max(float(body.volume_gate_pct), 1.0), 3.0)
    if body.max_gap is not None:
        squad.max_gap = min(max(float(body.max_gap), 0.01), 1.0)
    await db.commit()
    return {"status": "saved"}


@router.get("/simulation")
async def squad_simulation(trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)):
    squad = await _my_squad(db, trader.id)
    if not squad:
        raise HTTPException(404, "You're not in a squad.")
    mem_rows = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == squad.id, SquadMember.status == "active")
    )).scalars().all()
    ids = [m.trader_id for m in mem_rows]
    traders = (await db.execute(select(Trader).where(Trader.id.in_(ids)))).scalars().all() if ids else []
    members = [{"trader_id": t.id, "nick": t.binance_nickname, "name": t.full_name} for t in traders]

    from app.services.price_tracker import get_board
    from app.services.squad_engine import simulate
    try:
        board = await get_board("USDT", "KES")
    except Exception:
        raise HTTPException(502, "Couldn't load the live board right now. Try again.")
    plan = simulate(squad, members, board)
    plan["mode"] = squad.mode
    plan["missing_nicks"] = [m["name"] for m in members if not m.get("nick")]
    return plan
