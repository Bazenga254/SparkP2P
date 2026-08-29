-- Merchant-scheduled recurring Choice Bank transfers (standing orders).
-- The executor fires them via the same money path as a manual Send-Money transfer.
CREATE TABLE IF NOT EXISTS standing_orders (
    id               SERIAL PRIMARY KEY,
    trader_id        INTEGER NOT NULL REFERENCES traders(id),
    rail             VARCHAR(12)  NOT NULL,               -- pesalink | mpesa | choice
    payee_account    VARCHAR(64)  NOT NULL,
    payee_name       VARCHAR(120) NOT NULL,
    payee_bank_code  VARCHAR(20),
    payee_bank_name  VARCHAR(120),
    amount           DOUBLE PRECISION NOT NULL,
    remark           VARCHAR(140),
    schedule_type    VARCHAR(10)  NOT NULL,               -- monthly | weekly | once
    schedule_day     INTEGER,                             -- 1..31 (monthly) or 0..6 Mon=0 (weekly)
    run_date         DATE,                                -- for 'once'
    next_run_on      DATE NOT NULL,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at      TIMESTAMPTZ,
    last_status      VARCHAR(20),
    last_error       VARCHAR(300),
    last_tx_id       VARCHAR(64),
    run_count        INTEGER NOT NULL DEFAULT 0,
    last_notified_on DATE,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_standing_orders_trader_id   ON standing_orders(trader_id);
CREATE INDEX IF NOT EXISTS ix_standing_orders_next_run_on ON standing_orders(next_run_on);
