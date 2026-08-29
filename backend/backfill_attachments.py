"""One-time backfill: re-fetch already-stored inbox emails over IMAP and extract their
attachments (which weren't captured before the attachment feature shipped). Idempotent —
skips emails that already have attachment rows. Safe to re-run."""
import asyncio
import email
import imaplib

from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.models.email_message import EmailMessage
from app.models.email_attachment import EmailAttachment
from app.services.mail_poller import _extract_attachments


async def main():
    async with async_session() as db:
        rows = (await db.execute(select(EmailMessage.id, EmailMessage.uid).where(
            EmailMessage.folder == "inbox", EmailMessage.uid.isnot(None)))).all()
        have = set((await db.execute(select(EmailAttachment.email_id))).scalars().all())
    todo = [(eid, uid) for (eid, uid) in rows if eid not in have]
    print(f"inbox emails: {len(rows)}; already have attachments: {len(have)}; to backfill: {len(todo)}")

    M = imaplib.IMAP4_SSL(settings.MAILBOX_IMAP_HOST, settings.MAILBOX_IMAP_PORT)
    M.login(settings.MAILBOX_LOGIN, settings.MAILBOX_APP_PASSWORD)
    M.select("INBOX")
    total = 0
    for eid, uid in todo:
        try:
            typ, mdata = M.uid("fetch", str(uid), "(RFC822)")
            if not mdata or not mdata[0]:
                continue
            atts = _extract_attachments(email.message_from_bytes(mdata[0][1]))
            if not atts:
                continue
            async with async_session() as db:
                for at in atts:
                    db.add(EmailAttachment(email_id=eid, **at))
                await db.commit()
            total += len(atts)
            print(f"  email {eid} (uid {uid}): +{len(atts)} attachment(s)")
        except Exception as e:
            print(f"  email {eid} (uid {uid}) failed: {e}")
    try:
        M.logout()
    except Exception:
        pass
    print(f"DONE — added {total} attachment(s) across {len(todo)} emails")


if __name__ == "__main__":
    asyncio.run(main())
