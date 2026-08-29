-- I&M per-payout rate may now be FRACTIONAL (Silver = KES 3.5).
-- im_charges.rate was INTEGER with a whitelist CHECK; widen it to NUMERIC(6,2) and
-- allow 3.5 (and 4, which the old CHECK was missing — the current Bronze rate).
-- Existing integer rows (5/7/8/9/10/12) convert cleanly to NUMERIC.
-- Safe to re-run.

ALTER TABLE im_charges DROP CONSTRAINT IF EXISTS ck_im_charges_known_rate;
ALTER TABLE im_charges ALTER COLUMN rate TYPE NUMERIC(6,2);
ALTER TABLE im_charges
  ADD CONSTRAINT ck_im_charges_known_rate CHECK (rate IN (0, 3.5, 4, 5, 7, 8, 9, 10, 12));
