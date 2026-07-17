-- Store WHERE a buy order's seller is to be paid.
--
-- The desktop app already extracts this from Binance and already sends it to
-- /api/telegram/request-buy-approval (order_number, method, phone,
-- account_number, bank_name, seller_name) — the server just formatted a Telegram
-- message and threw it away. So all 9,695 buy orders have
-- seller_payment_method/destination/name = NULL, and the I&M Bot's /poll had
-- nothing real to serve.
--
-- orders already has seller_payment_method / _destination / _name. The only
-- field with nowhere to go was the BANK NAME, which a PesaLink payout needs and
-- must never be guessed (engine/banks.js refuses to guess for good reason).
--
-- Additive, safe to run live.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS seller_payment_bank VARCHAR(100) NULL;
