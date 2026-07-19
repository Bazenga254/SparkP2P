"""
Resolving whether the bot should automate a given order — per ad, per side.

This is the money-path gate. The old check was one global flag:

    (trader.bot_trade_mode or 'both') in ('both', 'sell_only')   # for a sell

The new check keeps that as the FALLBACK and lets a specific ad override it. The
one rule that keeps this safe: an ad with no config row resolves to the trader's
global mode, so a trader who never touches the Ads page behaves exactly as before.
"""

import logging

from sqlalchemy import select

logger = logging.getLogger(__name__)


async def resolve_mode(db, trader, adv_no: str | None) -> str:
    """The effective automation mode for one ad: 'both' | 'buy_only' | 'sell_only'
    | 'off'. A per-ad row wins; otherwise the trader's global bot_trade_mode; and
    if that's unset, 'both' (automate everything) — today's default."""
    global_mode = getattr(trader, "bot_trade_mode", None) or "both"
    if not adv_no:
        return global_mode
    from app.models.ad_automation import AdAutomation
    row = (await db.execute(
        select(AdAutomation.mode).where(
            AdAutomation.trader_id == trader.id,
            AdAutomation.adv_no == str(adv_no),
        )
    )).scalar_one_or_none()
    return row or global_mode


def side_allowed(mode: str, side: str) -> bool:
    """Does `mode` permit automating this side? side is 'buy' or 'sell'."""
    if mode == "off":
        return False
    if side == "buy":
        return mode in ("both", "buy_only")
    if side == "sell":
        return mode in ("both", "sell_only")
    return False


async def is_automated(db, trader, adv_no: str | None, side: str) -> bool:
    """One call for the gates: should the bot automate this order?"""
    return side_allowed(await resolve_mode(db, trader, adv_no), side)
