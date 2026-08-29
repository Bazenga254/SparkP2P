-- Time-of-day (EAT) a standing order fires on its due date. NULL = legacy early-morning behaviour.
ALTER TABLE standing_orders ADD COLUMN IF NOT EXISTS run_time TIME;
