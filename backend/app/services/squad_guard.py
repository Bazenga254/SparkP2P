"""Squad self-deal guard — squadmate counterparty detection (anti wash-trading).

Squad members must never trade with each other (that would be wash trading). This resolves the
set of a trader's squadmates' Binance nicknames so the order-screening flow can flag/decline any
order whose counterparty is a fellow squad member. Applies whenever the trader is in a squad with
other active members (sim or live) — the no-self-deal rule isn't mode-dependent.
"""
from sqlalchemy import select


async def squadmate_nicks(db, trader_id: int) -> set[str]:
    """Lowercased Binance nicknames of this trader's active squadmates (excludes self).
    Empty set if the trader isn't in a squad."""
    from app.models import Trader, Squad, SquadMember
    sq = (await db.execute(select(Squad).where(Squad.captain_trader_id == trader_id))).scalar_one_or_none()
    if not sq:
        mem = (await db.execute(
            select(SquadMember).where(SquadMember.trader_id == trader_id, SquadMember.status == "active")
        )).scalar_one_or_none()
        if mem:
            sq = (await db.execute(select(Squad).where(Squad.id == mem.squad_id))).scalar_one_or_none()
    if not sq:
        return set()
    rows = (await db.execute(
        select(SquadMember).where(SquadMember.squad_id == sq.id, SquadMember.status == "active")
    )).scalars().all()
    ids = [r.trader_id for r in rows if r.trader_id != trader_id]
    if not ids:
        return set()
    traders = (await db.execute(select(Trader).where(Trader.id.in_(ids)))).scalars().all()
    return {(t.binance_nickname or "").strip().lower() for t in traders if t.binance_nickname}
