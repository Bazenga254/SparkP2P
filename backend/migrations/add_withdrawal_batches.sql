-- Batch withdrawal system
-- One M-PESA sweep per hour for all pending bank withdrawals combined,
-- then parallel I&M transfers to each trader's bank account.

-- 1. Batch container (one per hourly window)
CREATE TABLE IF NOT EXISTS withdrawal_batches (
    id SERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'collecting',
    total_amount FLOAT NOT NULL DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ NULL,
    swept_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS ix_withdrawal_batches_status ON withdrawal_batches(status);

-- 2. Individual trader disbursements within a batch
CREATE TABLE IF NOT EXISTS batch_items (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES withdrawal_batches(id),
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    wallet_tx_id INTEGER REFERENCES wallet_transactions(id) NULL,
    gross_amount FLOAT NOT NULL,
    net_amount FLOAT NOT NULL,
    fee_amount FLOAT NOT NULL,
    destination VARCHAR(200) NULL,
    destination_name VARCHAR(200) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    failure_reason VARCHAR(500) NULL,
    im_reference VARCHAR(100) NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS ix_batch_items_batch_id ON batch_items(batch_id);
CREATE INDEX IF NOT EXISTS ix_batch_items_trader_id ON batch_items(trader_id);
CREATE INDEX IF NOT EXISTS ix_batch_items_status ON batch_items(status);

-- 3. Link im_sweeps to a batch (null = legacy per-withdrawal sweep)
ALTER TABLE im_sweeps ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES withdrawal_batches(id) NULL;

-- 4. Link wallet_transactions to a batch item (null = non-batch transaction)
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS batch_item_id INTEGER REFERENCES batch_items(id) NULL;
