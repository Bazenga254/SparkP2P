-- Route a trader's BUY-order seller payments through their own I&M Bot instead
-- of Choice Bank B2C.
--
-- DEFAULT FALSE is the whole safety story: every one of the 10 existing traders
-- keeps paying via Choice Bank exactly as before, and the /api/im-bot/poll
-- endpoint serves NOTHING until a trader is explicitly opted in. Turning it on
-- for a trader is a deliberate act, coordinated with their desktop app (which
-- must then STOP paying that trader's buy orders — otherwise both pay the seller).
--
-- Additive, safe to run live.

ALTER TABLE traders
    ADD COLUMN IF NOT EXISTS buy_payout_via_im BOOLEAN NOT NULL DEFAULT FALSE;
