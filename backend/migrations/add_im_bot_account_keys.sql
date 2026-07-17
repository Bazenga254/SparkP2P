-- Let a merchant API key belong to a BOT-ONLY account, not just a trader.
--
-- Why: a bot-only user (not a SparkP2P client, KES 12) runs I&M Automation
-- standalone — their own Binance keys, their own I&M account. They still need a
-- credential to report payouts back for billing. merchant_api_keys.trader_id was
-- NOT NULL REFERENCES traders(id), and they have no trader row.
--
-- One key table rather than two: the mint/hash/verify/revoke logic is delicate
-- (SHA-256, never store the key, revoke checks the owner) and a second copy of it
-- is a second place to get it subtly wrong.
--
-- THIS ONE IS NOT OPTIONAL AT DEPLOY. init_db() runs create_all() on every
-- startup, which CREATES new tables but never ALTERS an existing one — so unlike
-- im_charges/im_bot_accounts, this change will NOT appear on its own. Run it
-- BEFORE deploying code that reads bot_account_id.
--
-- Safe on a live database:
--   * DROP NOT NULL rewrites nothing and cannot fail.
--   * Adding a nullable column with no default is instant on PG11+ (no rewrite).
--   * The CHECK validates existing rows — all of which have trader_id set and
--     bot_account_id NULL, so they pass. Verified against production first.
-- Existing keys keep working untouched: their trader_id is still set, and every
-- query that filtered on it still matches.

ALTER TABLE merchant_api_keys
    ALTER COLUMN trader_id DROP NOT NULL;

ALTER TABLE merchant_api_keys
    ADD COLUMN IF NOT EXISTS bot_account_id INTEGER NULL REFERENCES im_bot_accounts(id);

-- Exactly one owner. Without this, a key with neither owner authenticates a
-- payout nobody can be billed for, and a key with both is ambiguous about who to
-- charge — at two different rates.
ALTER TABLE merchant_api_keys
    DROP CONSTRAINT IF EXISTS ck_merchant_api_keys_one_owner;
ALTER TABLE merchant_api_keys
    ADD CONSTRAINT ck_merchant_api_keys_one_owner CHECK (
        (trader_id IS NOT NULL AND bot_account_id IS NULL) OR
        (trader_id IS NULL AND bot_account_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS ix_merchant_api_keys_bot_account
    ON merchant_api_keys (bot_account_id, revoked_at);
