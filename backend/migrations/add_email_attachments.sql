-- Incoming email attachments (extracted by the IMAP poller, downloaded on demand).
CREATE TABLE IF NOT EXISTS email_attachments (
    id           SERIAL PRIMARY KEY,
    email_id     INTEGER NOT NULL REFERENCES email_messages(id),
    filename     VARCHAR(400),
    content_type VARCHAR(160),
    size         INTEGER,
    content_b64  TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_email_attachments_email ON email_attachments(email_id);

ALTER TABLE email_attachments OWNER TO sparkp2p;
ALTER SEQUENCE email_attachments_id_seq OWNER TO sparkp2p;
