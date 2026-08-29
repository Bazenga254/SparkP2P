-- Track the source IMAP folder so the poller can sync ALL mail folders (Notification,
-- Newsletter, etc.), not just INBOX, with a per-folder UID baseline.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS imap_folder VARCHAR(64) DEFAULT 'INBOX';
CREATE INDEX IF NOT EXISTS ix_email_messages_imap_folder ON email_messages(imap_folder);
UPDATE email_messages SET imap_folder = 'INBOX' WHERE imap_folder IS NULL;
