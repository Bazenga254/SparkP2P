-- Migration: Add internal transfer transaction types to PostgreSQL enum
-- Run this on the VPS database before deploying the new code:
--   psql -U sparkp2p -d sparkp2p -f migrations/add_internal_transfer_types.sql

ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'INTERNAL_TRANSFER_OUT';
ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'INTERNAL_TRANSFER_IN';

-- Verify the new values exist:
-- SELECT enum_range(NULL::transactiontype);
