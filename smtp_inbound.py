"""
Inbound SMTP server for otp.sparkp2p.com
Receives emails on port 25 and immediately forwards them to the internal
/api/webhooks/email-otp endpoint — eliminates the Brevo relay delay.
"""

import asyncio
import email as email_lib
import logging
import sys
from email.policy import default as email_policy

import httpx
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import SMTP

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SMTP] %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

INTERNAL_WEBHOOK = "http://127.0.0.1:8002/api/webhooks/email-otp"
ACCEPTED_DOMAIN = "otp.sparkp2p.com"
SMTP_HOSTNAME = "otp.sparkp2p.com"


def _extract_body(msg) -> str:
    """Return plain-text body from an email.message.Message."""
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain":
                charset = part.get_content_charset() or "utf-8"
                payload = part.get_payload(decode=True)
                if payload:
                    body = payload.decode(charset, errors="replace")
                    break
        if not body:
            for part in msg.walk():
                ct = part.get_content_type()
                if ct == "text/html":
                    charset = part.get_content_charset() or "utf-8"
                    payload = part.get_payload(decode=True)
                    if payload:
                        body = payload.decode(charset, errors="replace")
                    break
    else:
        charset = msg.get_content_charset() or "utf-8"
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode(charset, errors="replace")
    return body


class OTPHandler:
    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        domain = address.split("@")[-1].lower()
        if domain != ACCEPTED_DOMAIN:
            return f"550 5.1.1 Relay denied for {address}"
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        try:
            raw = envelope.content if isinstance(envelope.content, bytes) else envelope.content.encode()
            msg = email_lib.message_from_bytes(raw, policy=email_policy)
            sender = envelope.mail_from or ""
            recipients = envelope.rcpt_tos
            recipient = recipients[0] if recipients else ""
            subject = msg.get("Subject", "")
            body = _extract_body(msg)

            logger.info(f"Mail from={sender} to={recipient} subject={subject!r} body={body[:200]!r}")

            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.post(INTERNAL_WEBHOOK, json={
                    "sender": sender,
                    "recipient": recipient,
                    "subject": subject,
                    "body-plain": body,
                })
            logger.info(f"Webhook -> {r.status_code}")
        except Exception as exc:
            logger.error(f"handle_DATA error: {exc}")
        return "250 Message accepted"


class OTPController(Controller):
    """Controller that advertises otp.sparkp2p.com as SMTP hostname."""
    def factory(self):
        return SMTP(self.handler, hostname=SMTP_HOSTNAME, decode_data=True)


async def main():
    handler = OTPHandler()
    controller = OTPController(handler, hostname="0.0.0.0", port=25)
    controller.start()
    logger.info(f"SMTP inbound listening on 0.0.0.0:25 for @{ACCEPTED_DOMAIN} (hostname={SMTP_HOSTNAME})")
    try:
        await asyncio.Event().wait()
    finally:
        controller.stop()


if __name__ == "__main__":
    asyncio.run(main())
