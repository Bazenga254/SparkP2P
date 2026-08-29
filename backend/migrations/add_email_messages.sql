-- Admin dashboard mailbox: emails pulled from Zoho over IMAP + sent copies (compose/reply via Brevo).
CREATE TABLE IF NOT EXISTS email_messages (
    id           SERIAL PRIMARY KEY,
    folder       VARCHAR(20) NOT NULL DEFAULT 'inbox',
    uid          VARCHAR(64),
    message_id   VARCHAR(512),
    in_reply_to  VARCHAR(512),
    from_addr    VARCHAR(320),
    from_name    VARCHAR(200),
    to_addr      VARCHAR(600),
    subject      VARCHAR(1000),
    snippet      VARCHAR(300),
    body_text    TEXT,
    body_html    TEXT,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    is_support   BOOLEAN NOT NULL DEFAULT FALSE,
    received_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_email_messages_folder     ON email_messages(folder);
CREATE INDEX IF NOT EXISTS ix_email_messages_uid        ON email_messages(uid);
CREATE INDEX IF NOT EXISTS ix_email_messages_message_id ON email_messages(message_id);
CREATE INDEX IF NOT EXISTS ix_email_messages_received   ON email_messages(received_at);
CREATE INDEX IF NOT EXISTS ix_email_messages_support    ON email_messages(is_support);

-- App connects as role sparkp2p; hand ownership over if applied by the postgres superuser.
ALTER TABLE email_messages OWNER TO sparkp2p;
ALTER SEQUENCE email_messages_id_seq OWNER TO sparkp2p;
