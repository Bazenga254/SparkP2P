-- Tracks whether a trader's Choice Bank account email is verified, which gates
-- the email-OTP fallback for transfers (Send Money / buy payments).
ALTER TABLE traders ADD COLUMN IF NOT EXISTS choice_email_verified BOOLEAN DEFAULT FALSE;
