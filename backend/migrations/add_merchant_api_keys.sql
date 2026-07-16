-- Merchant API keys — long-lived credentials for software a merchant runs
-- themselves (today: the downloadable I&M Bot, which pays buy orders from the
-- merchant's own I&M account on their own machine).
--
-- A JWT cannot do this job: it expires, and the bot runs unattended for weeks.
--
-- ADDITIVE ONLY. A new table touches no existing row and no existing query, so
-- this is safe to run against the live database while traders are online.
-- Nothing reads or writes it until the /api/im-bot routes are deployed.
--
-- The key itself is NEVER stored — only its SHA-256 hash. A leak of this table
-- yields hashes that cannot be replayed against a merchant's bank payouts.

CREATE TABLE IF NOT EXISTS merchant_api_keys (
    id           SERIAL PRIMARY KEY,
    trader_id    INTEGER NOT NULL REFERENCES traders(id),
    key_hash     VARCHAR(64) NOT NULL UNIQUE,
    key_prefix   VARCHAR(24) NOT NULL,
    name         VARCHAR(100) NULL,
    scope        VARCHAR(32) NOT NULL DEFAULT 'im_bot',
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE NULL,
    last_used_ip VARCHAR(45) NULL,
    revoked_at   TIMESTAMP WITH TIME ZONE NULL
);

-- Every authenticated request looks a key up by hash: this index is the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS ix_merchant_api_keys_key_hash
    ON merchant_api_keys (key_hash);

CREATE INDEX IF NOT EXISTS ix_merchant_api_keys_trader_id
    ON merchant_api_keys (trader_id);

-- Listing a merchant's live keys ("which of my keys still work?").
CREATE INDEX IF NOT EXISTS ix_merchant_api_keys_trader_active
    ON merchant_api_keys (trader_id, revoked_at);
