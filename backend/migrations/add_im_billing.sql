-- I&M Automation billing: bot-only accounts + the charge ledger.
--
-- ADDITIVE ONLY. Two new tables. No existing row, column or query is touched,
-- so this is safe to run against the live database while traders are online.
-- Nothing reads or writes either table until the billing code is deployed.
--
-- WHY BOT-ONLY ACCOUNTS ARE NOT TRADERS: they are people who use the I&M bot but
-- are not SparkP2P clients (the KES 12 rate). Putting them in `traders` would
-- drop strangers into the trader list, the trader counts, the churn figures and
-- the enforcement sweep. They are billable and admin-visible, but separate.

CREATE TABLE IF NOT EXISTS im_bot_accounts (
    id                SERIAL PRIMARY KEY,
    email             VARCHAR(255) NOT NULL UNIQUE,
    password_hash     VARCHAR(255) NOT NULL,
    full_name         VARCHAR(120) NULL,
    phone             VARCHAR(24) NULL,
    email_verified_at TIMESTAMP WITH TIME ZONE NULL,
    -- Set if this person later becomes a real SparkP2P client. Their old charges
    -- stay bot-only history; from then on they bill as that trader.
    linked_trader_id  INTEGER NULL REFERENCES traders(id),
    status            VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at     TIMESTAMP WITH TIME ZONE NULL
);

-- Emails are case-insensitive in practice. Storing "Bob@x.com" alongside
-- "bob@x.com" would create a second account the user cannot log into — and since
-- three failed logins lock an account for 24 hours, a phone keyboard's
-- auto-capital would lock someone out of their own account. The database refuses
-- it even if some future caller forgets to normalise.
CREATE UNIQUE INDEX IF NOT EXISTS ix_im_bot_accounts_email_lower
    ON im_bot_accounts (LOWER(email));

CREATE INDEX IF NOT EXISTS ix_im_bot_accounts_status  ON im_bot_accounts (status);
CREATE INDEX IF NOT EXISTS ix_im_bot_accounts_created ON im_bot_accounts (created_at);
CREATE INDEX IF NOT EXISTS ix_im_bot_accounts_linked  ON im_bot_accounts (linked_trader_id);


-- The charge ledger. THIS TABLE IS THE BILL: revenue, the 100-payout intro
-- allowance and what a merchant owes are all derived by reading it. No running
-- total is kept anywhere else — a counter that can drift from the ledger will.
--
-- A row exists ONLY if money actually left the bank. A FAILED payout, one
-- refused for zero balance, and an UNKNOWN one all write nothing.
CREATE TABLE IF NOT EXISTS im_charges (
    id             SERIAL PRIMARY KEY,
    -- Exactly one owner — enforced below, not by hope.
    trader_id      INTEGER NULL REFERENCES traders(id),
    bot_account_id INTEGER NULL REFERENCES im_bot_accounts(id),
    account_type   VARCHAR(16) NOT NULL,          -- 'sparkp2p' | 'bot_only'

    -- The one thing standing between us and billing a merchant twice for a
    -- single payout. Retries, redeliveries and races are normal here; this
    -- constraint holds even when the code above it is wrong.
    order_id       VARCHAR(64) NOT NULL UNIQUE,

    -- Copied in, never re-derived. A charge is a historical fact: if we looked
    -- the rate up at read time, a trader upgrading Gold -> B2C would rewrite
    -- every payout they ever made from 7 to 5 and last month's revenue would
    -- change underneath us.
    rate           INTEGER NOT NULL,
    payout_amount  INTEGER NOT NULL,
    plan           VARCHAR(32) NULL,              -- plan in force at the time, or NULL
    bank_ref       VARCHAR(64) NULL,              -- I&M's own reference; audit trail
    charged_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT ck_im_charges_one_owner CHECK (
        (trader_id IS NOT NULL AND bot_account_id IS NULL) OR
        (trader_id IS NULL AND bot_account_id IS NOT NULL)
    ),
    -- 5/7/8/9/10/12 are the only rates we offer. A charge at any other rate is a
    -- bug, and must be stopped at the door rather than discovered in revenue.
    CONSTRAINT ck_im_charges_known_rate CHECK (rate IN (5, 7, 8, 9, 10, 12)),
    CONSTRAINT ck_im_charges_positive_payout CHECK (payout_amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_im_charges_order_id ON im_charges (order_id);

-- Revenue is read as "this owner, over this period".
CREATE INDEX IF NOT EXISTS ix_im_charges_trader_time ON im_charges (trader_id, charged_at);
CREATE INDEX IF NOT EXISTS ix_im_charges_bot_time    ON im_charges (bot_account_id, charged_at);
-- Splitting revenue by population (SparkP2P vs bot-only) in the admin.
CREATE INDEX IF NOT EXISTS ix_im_charges_account_type ON im_charges (account_type, charged_at);
-- The intro-allowance count: this trader's rows at the intro rate (10).
CREATE INDEX IF NOT EXISTS ix_im_charges_trader_rate  ON im_charges (trader_id, rate);
