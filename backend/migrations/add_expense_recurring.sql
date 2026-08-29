-- Operating expenses become monthly-recurring by default: logged once, amortised to
-- each period. Existing rows default to recurring so a monthly rent stops being counted
-- in full on a single day.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT TRUE;
