-- Adds the buyer's verified/legal name to orders for payer name-match (anti-fraud).
-- Best-effort: populated by EP-13 (sell_order_state) when Binance exposes a real name.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS counterparty_real_name VARCHAR(255) NULL;
