-- Let a credit top-up belong to a BOT-ONLY account, not just a trader.
--
-- credit_purchases is the receipt ledger that makes credit grants idempotent
-- (the C2B confirmation and STK callback both fire for one payment; the receipt
-- dedupes them). Bot-only accounts need the same protection, but trader_id was
-- NOT NULL and they have no trader row — so their receipts had nowhere to live.
--
-- Safe on a live DB: DROP NOT NULL rewrites nothing; adding a nullable column is
-- instant on PG11+. Every existing row has trader_id set and bot_account_id NULL,
-- so they satisfy the new one-owner CHECK. Verified against production first.

ALTER TABLE credit_purchases
    ALTER COLUMN trader_id DROP NOT NULL;

ALTER TABLE credit_purchases
    ADD COLUMN IF NOT EXISTS bot_account_id INTEGER NULL REFERENCES im_bot_accounts(id);

ALTER TABLE credit_purchases
    DROP CONSTRAINT IF EXISTS ck_credit_purchases_one_owner;
ALTER TABLE credit_purchases
    ADD CONSTRAINT ck_credit_purchases_one_owner CHECK (
        (trader_id IS NOT NULL AND bot_account_id IS NULL) OR
        (trader_id IS NULL AND bot_account_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS ix_credit_purchases_bot_account ON credit_purchases (bot_account_id);
