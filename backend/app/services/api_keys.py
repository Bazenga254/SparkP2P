"""
Merchant API key generation and resolution.

A key authorises software to be paid FROM a merchant's bank account, so the
threat model is closer to a bank credential than a session token.

Design, and why:

  * Keys are HIGH-ENTROPY RANDOM, so SHA-256 is the correct hash — not bcrypt.
    bcrypt/argon2 exist to make GUESSING cheap-to-verify secrets expensive; a
    256-bit random string cannot be guessed, and a slow hash on the hot path
    would add latency to every single poll. This is what Stripe and GitHub do.
  * The plaintext key is returned EXACTLY ONCE, at creation, and never stored.
    We cannot show it again, and that is the point: a leaked database yields
    hashes that cannot be replayed against a merchant's payouts.
  * Lookup is BY HASH, never by trader — an attacker presenting a key must not
    be able to steer which trader it resolves to. The key IS the identity.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.core.database import async_session
from app.models.api_key import MerchantApiKey

logger = logging.getLogger(__name__)

KEY_PREFIX = "sp2p_"
PREFIX_SHOWN = 12          # characters kept in the clear for the UI
LAST_SEEN_THROTTLE_S = 20  # don't write last_used_at on literally every poll


def as_utc(dt: datetime | None) -> datetime | None:
    """Coerce a datetime to timezone-aware UTC.

    Postgres TIMESTAMPTZ normally hands back aware datetimes, but a naive one
    reaching this code (another driver, a value written by raw SQL, a test on
    sqlite) makes `now - dt` raise TypeError — inside the AUTH path, which would
    500 every poll from the merchant's bot. Assume UTC, which is what everything
    here writes.
    """
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def generate_key() -> str:
    """A new plaintext key. Held in memory only long enough to show the merchant."""
    # token_urlsafe(32) = 256 bits of entropy, URL-safe so it survives copy/paste
    # out of a browser and into the bot's settings box.
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def prefix_of(plaintext: str) -> str:
    return plaintext[:PREFIX_SHOWN]


async def create_key(
    trader_id: int | None = None,
    name: str | None = None,
    scope: str = "im_bot",
    bot_account_id: int | None = None,
) -> tuple[str, MerchantApiKey]:
    """Mint a key for EXACTLY ONE owner — a trader, or a bot-only account.

    Returns (plaintext, row) — the plaintext is the ONLY copy that will ever
    exist; the caller must show it and drop it.

    The one-owner rule is checked here as well as by the database, so a caller
    gets a clear error instead of an IntegrityError from three layers down. A key
    with no owner would authenticate a payout nobody can be billed for; a key
    with both is ambiguous about who to charge, at two different rates.
    """
    if (trader_id is None) == (bot_account_id is None):
        raise ValueError("a key needs exactly one owner: trader_id XOR bot_account_id")
    plaintext = generate_key()
    row = MerchantApiKey(
        trader_id=trader_id,
        bot_account_id=bot_account_id,
        key_hash=hash_key(plaintext),
        key_prefix=prefix_of(plaintext),
        name=(name or "I&M Bot")[:100],
        scope=scope,
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    logger.info(
        "api_key: minted %s… for %s (scope=%s)",
        row.key_prefix,
        f"trader {trader_id}" if trader_id else f"bot_account {bot_account_id}",
        scope,
    )
    return plaintext, row


async def resolve_key_owner(
    plaintext: str, scope: str = "im_bot", client_ip: str | None = None
) -> tuple[str, int] | None:
    """Plaintext key -> (account_type, owner_id), or None.

    THE primitive: one lookup, one copy of the revoke/scope/heartbeat rules.
    account_type is one of im_pricing.ACCOUNT_* and is what decides the rate, so
    it comes from the KEY and never from the caller — a bot that could name its
    own account type could name its own price.

    Opens and closes its OWN short-lived session on purpose. The I&M Bot poll is
    a long-poll; if authentication held a pooled connection for the whole wait,
    every merchant polling back-to-back would exhaust the pool. This mirrors why
    `get_current_trader_id` is deliberately token-only.
    """
    if not plaintext or not plaintext.startswith(KEY_PREFIX):
        return None

    digest = hash_key(plaintext)
    now = datetime.now(timezone.utc)

    async with async_session() as db:
        row = (
            await db.execute(
                select(MerchantApiKey).where(MerchantApiKey.key_hash == digest)
            )
        ).scalar_one_or_none()

        if row is None:
            return None
        if row.revoked_at is not None:
            logger.warning("api_key: REVOKED key %s… presented", row.key_prefix)
            return None
        if row.scope != scope:
            logger.warning("api_key: key %s… has scope=%s, wanted %s", row.key_prefix, row.scope, scope)
            return None

        if row.trader_id is not None:
            owner = ("sparkp2p", row.trader_id)
        elif row.bot_account_id is not None:
            owner = ("bot_only", row.bot_account_id)
        else:
            # ck_merchant_api_keys_one_owner forbids this, so it should be
            # unreachable. If it ever happens, refuse rather than guess: an
            # ownerless key authenticates a payout nobody can be billed for.
            logger.error("api_key: key %s… has NO owner — refusing", row.key_prefix)
            return None

        # last_used_at is the bot's heartbeat — the poller authenticates on every
        # poll, so this IS "last seen". Throttled so a 25s long-poll loop doesn't
        # write on every request.
        last = as_utc(row.last_used_at)
        stale = last is None or (now - last).total_seconds() > LAST_SEEN_THROTTLE_S
        if stale:
            await db.execute(
                update(MerchantApiKey)
                .where(MerchantApiKey.id == row.id)
                .values(last_used_at=now, last_used_ip=(client_ip or None))
            )
            await db.commit()

        return owner


async def resolve_key(plaintext: str, scope: str = "im_bot", client_ip: str | None = None) -> int | None:
    """Plaintext key -> TRADER id, or None.

    NOTE THE NAME: this answers "which trader is this?", so a valid BOT-ONLY key
    returns None — a bot-only account has no trader row and must never be
    mistaken for one. The 401 that produces on a trader-only endpoint is correct;
    it is a refusal, not an error. Endpoints serving both populations must call
    resolve_key_owner() instead.
    """
    owner = await resolve_key_owner(plaintext, scope=scope, client_ip=client_ip)
    if owner is None or owner[0] != "sparkp2p":
        return None
    return owner[1]


async def list_keys(trader_id: int, scope: str = "im_bot") -> list[MerchantApiKey]:
    async with async_session() as db:
        return list(
            (
                await db.execute(
                    select(MerchantApiKey)
                    .where(MerchantApiKey.trader_id == trader_id, MerchantApiKey.scope == scope)
                    .order_by(MerchantApiKey.created_at.desc())
                )
            ).scalars()
        )


async def revoke_key(trader_id: int, key_id: int) -> bool:
    """Revoke one of THIS trader's keys.

    trader_id is part of the WHERE clause, not a check afterwards — otherwise a
    merchant could revoke another merchant's key by guessing an id.
    """
    async with async_session() as db:
        res = await db.execute(
            update(MerchantApiKey)
            .where(
                MerchantApiKey.id == key_id,
                MerchantApiKey.trader_id == trader_id,
                MerchantApiKey.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc))
        )
        await db.commit()
        return res.rowcount > 0
