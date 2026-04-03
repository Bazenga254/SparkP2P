-- Add withdrawal tracking columns to wallet_transactions
-- Tracks who processed I&M bank withdrawals manually and when

ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS processed_by VARCHAR(100) NULL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP WITH TIME ZONE NULL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS destination VARCHAR(200) NULL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS settlement_method VARCHAR(20) NULL;
