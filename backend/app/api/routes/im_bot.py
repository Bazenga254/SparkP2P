"""
I&M Bot — link between SparkP2P and the merchant's own downloadable I&M Bot.

The bot runs on the MERCHANT's machine, logged into THEIR I&M account, on THEIR
IP. SparkP2P never logs into a bank. The bot dials out and polls; nothing is
exposed on the merchant's PC.

Mounted at /api/im-bot (NOT /api/im — that belongs to the older im_bank.py
gateway routes).

This file currently covers step 1 of the link: merchant API keys.
  Merchant, from the browser (JWT auth):
    POST   /api/im-bot/keys          mint a key (plaintext shown ONCE)
    GET    /api/im-bot/keys          list this merchant's keys (never the key)
    DELETE /api/im-bot/keys/{id}     revoke
    GET    /api/im-bot/link-status   is my bot online?
  The bot itself (API-key auth):
    GET    /api/im-bot/ping          proves a key works end-to-end

BUY ORDERS ONLY. I&M can only send money out, so the bot pays sellers when the
merchant BUYS crypto. Sell orders stay on the Choice Bank gateway.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_trader_id_from_api_key
from app.api.routes.traders import get_current_trader
from app.models import Trader
from app.services import api_keys as keysvc

logger = logging.getLogger(__name__)
router = APIRouter()

# A bot polls well inside this, so a longer gap means it is not running.
ONLINE_WINDOW_S = 90


class CreateKeyRequest(BaseModel):
    name: str | None = None


def _public(row) -> dict:
    """A key row as the UI may see it — prefix only. The key itself does not
    exist anywhere to return."""
    return {
        "id": row.id,
        "name": row.name,
        "prefix": row.key_prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
        "last_used_ip": row.last_used_ip,
        "revoked": row.revoked_at is not None,
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
    }


def _online(row) -> bool:
    """Online = a live key polled within the window. as_utc() because a naive
    timestamp here would raise inside the status endpoint."""
    if row is None or row.revoked_at is not None:
        return False
    last = keysvc.as_utc(row.last_used_at)
    if last is None:
        return False
    return (datetime.now(timezone.utc) - last).total_seconds() <= ONLINE_WINDOW_S


# ═══════════════════════════════════════════════════════════
# MERCHANT (browser, JWT auth)
# ═══════════════════════════════════════════════════════════

@router.post("/keys")
async def create_api_key(data: CreateKeyRequest, trader: Trader = Depends(get_current_trader)):
    """Mint an API key for this merchant's I&M Bot.

    The plaintext is returned HERE AND ONLY HERE — we store just its hash, so it
    can never be shown again. The UI must make the merchant copy it now.
    """
    plaintext, row = await keysvc.create_key(trader.id, name=data.name)
    logger.info("im-bot: trader %s minted API key %s…", trader.id, row.key_prefix)
    return {
        "key": plaintext,          # ← the only time this ever leaves the server
        "shown_once": True,
        "api_key": _public(row),
    }


@router.get("/keys")
async def list_api_keys(trader: Trader = Depends(get_current_trader)):
    rows = await keysvc.list_keys(trader.id)
    live = [r for r in rows if r.revoked_at is None]
    # "Is my bot online?" = did any live key poll recently. last_used_at is the
    # heartbeat: the bot authenticates on every poll, so last-used IS last-seen.
    # as_utc in the sort key too: comparing a naive against an aware datetime
    # raises, and these rows come straight from the driver.
    newest = max(
        (r for r in live if r.last_used_at), key=lambda r: keysvc.as_utc(r.last_used_at), default=None
    )
    return {
        "keys": [_public(r) for r in rows],
        "online": _online(newest),
        "last_seen_at": newest.last_used_at.isoformat() if newest and newest.last_used_at else None,
    }


@router.delete("/keys/{key_id}")
async def revoke_api_key(key_id: int, trader: Trader = Depends(get_current_trader)):
    """Revoke a key. Takes effect on the bot's next poll — there is no cache to
    outlive it."""
    ok = await keysvc.revoke_key(trader.id, key_id)
    if not ok:
        # Same answer whether the key belongs to someone else or never existed:
        # do not confirm the existence of another merchant's key.
        raise HTTPException(status_code=404, detail="Key not found")
    logger.info("im-bot: trader %s revoked key id=%s", trader.id, key_id)
    return {"ok": True}


@router.get("/link-status")
async def link_status(trader: Trader = Depends(get_current_trader)):
    """What the Settings card shows: is this merchant's bot connected?"""
    rows = await keysvc.list_keys(trader.id)
    live = [r for r in rows if r.revoked_at is None]
    # as_utc in the sort key too: comparing a naive against an aware datetime
    # raises, and these rows come straight from the driver.
    newest = max(
        (r for r in live if r.last_used_at), key=lambda r: keysvc.as_utc(r.last_used_at), default=None
    )
    return {
        "has_key": len(live) > 0,
        "online": _online(newest),
        "last_seen_at": newest.last_used_at.isoformat() if newest and newest.last_used_at else None,
        "last_seen_ip": newest.last_used_ip if newest else None,
        "buy_orders_only": True,
    }


# ═══════════════════════════════════════════════════════════
# THE BOT (API-key auth)
# ═══════════════════════════════════════════════════════════

@router.get("/ping")
async def ping(trader_id: int = Depends(get_trader_id_from_api_key)):
    """The bot's "Test connection". Proves the key resolves to exactly one
    trader, and marks the bot as seen (resolve_key updates last_used_at).

    Returns the trader id so a merchant can confirm the key is linked to the
    account they expect — a key silently linked to the WRONG trader would pay
    another merchant's orders from this merchant's bank account.
    """
    return {"ok": True, "trader_id": trader_id, "buy_orders_only": True}
