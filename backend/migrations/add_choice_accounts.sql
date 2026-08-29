-- Phase 1: multi Choice Bank accounts per trader (registry + active switch).
-- The ACTIVE row is mirrored onto traders.choice_account_id/_number/kyc/onboarding_status,
-- so every existing consumer keeps reading the trader fields unchanged.

CREATE TABLE IF NOT EXISTS choice_accounts (
    id                    SERIAL PRIMARY KEY,
    trader_id             INTEGER NOT NULL REFERENCES traders(id),
    account_id            VARCHAR(100),
    account_number        VARCHAR(50),
    label                 VARCHAR(120),
    account_type          VARCHAR(24) NOT NULL DEFAULT 'personal',   -- 'personal' | 'sme'
    business_type         INTEGER,                                   -- SME businessType 1..4
    kyc_status            VARCHAR(100),
    onboarding_request_id VARCHAR(64),
    onboarding_status     VARCHAR(16),
    is_active             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_choice_accounts_trader     ON choice_accounts(trader_id);
CREATE INDEX IF NOT EXISTS ix_choice_accounts_account_id ON choice_accounts(account_id);
CREATE INDEX IF NOT EXISTS ix_choice_accounts_active     ON choice_accounts(is_active);

-- Backfill: every trader that already has a Choice account gets it as the ACTIVE registry row.
INSERT INTO choice_accounts
    (trader_id, account_id, account_number, label, account_type, kyc_status, onboarding_status, is_active)
SELECT t.id, t.choice_account_id, t.choice_account_number, 'Primary account', 'personal',
       t.choice_kyc_status, t.onboarding_status, TRUE
FROM traders t
WHERE t.choice_account_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM choice_accounts ca WHERE ca.trader_id = t.id);

-- The app connects as role `sparkp2p`; if this migration was applied by the postgres
-- superuser, hand ownership to the app role (matches every other table).
ALTER TABLE choice_accounts OWNER TO sparkp2p;
ALTER SEQUENCE choice_accounts_id_seq OWNER TO sparkp2p;
