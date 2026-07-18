-- Prepaid payout credits for BOT-ONLY accounts.
--
-- Traders already have trader.b2c_credits; bot-only accounts (im_bot_accounts)
-- are a separate population with no trader row, so they need their own balance.
-- 1 credit = 1 I&M payout, bought at their flat KES 12 rate. Each payout consumes
-- one; at 0 the bot pauses and ignores new orders until they top up.
--
-- ADDITIVE + SAFE ON A LIVE DB: adding a NOT NULL column WITH a default is
-- instant on PG11+ (no table rewrite), and every existing row gets 0. Nothing
-- reads or writes it until the credits code is deployed.
--
-- Ownership note: run as the app role, or ALTER OWNER afterwards — see the DO
-- block, same as add_im_billing.sql (a hand-run migration as postgres would
-- leave the table postgres-owned and the app would get "permission denied").

ALTER TABLE im_bot_accounts
    ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sparkp2p') THEN
    ALTER TABLE im_bot_accounts OWNER TO sparkp2p;
  END IF;
END $$;
