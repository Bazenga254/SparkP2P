-- Add DAILY_VOLUME_FEE to transactiontype enum
-- Run this on the database before deploying the new code

ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'daily_volume_fee';
