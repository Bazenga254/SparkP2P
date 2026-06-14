"""Mobile push queue — mirrors Telegram alerts to the native app's notification bar.

Whenever the backend sends a trader a Telegram notification, it also enqueues a push here. The
phone's relay foreground service polls GET /ext/notifications/poll and posts a native Android
notification for each new item — so traders get a SparkP2P notification on the phone (e.g. a
deposit) even with the app backgrounded, as long as the relay is on. In-memory + single-worker
(like the other in-process stores); Telegram remains the durable channel.
"""
import itertools
import re
import threading
import time

_lock = threading.Lock()
_counter = itertools.count(1)
_queues: dict[int, list] = {}     # trader_id -> [{id, title, body, ts}]
MAX_PER_TRADER = 50

_MD = re.compile(r"[*_`]")        # strip basic Telegram markdown for a clean notification


def add(trader_id: int, message: str, title: str = "SparkP2P"):
    """Queue a push for the trader. Body = the alert text (markdown stripped, first line as title
    when the message has a clear heading)."""
    if not trader_id or not message:
        return
    body = _MD.sub("", str(message)).strip()
    lines = [l for l in body.split("\n") if l.strip()]
    # Use the first line as the title if it's short and there's more below it.
    if len(lines) > 1 and len(lines[0]) <= 48:
        title, body = lines[0].strip(), "\n".join(lines[1:]).strip()
    with _lock:
        q = _queues.setdefault(trader_id, [])
        q.append({"id": next(_counter), "title": title[:80], "body": body[:400], "ts": int(time.time())})
        if len(q) > MAX_PER_TRADER:
            del q[:len(q) - MAX_PER_TRADER]


def poll(trader_id: int, after_id: int = 0):
    """Return (items newer than after_id, latest id)."""
    with _lock:
        q = _queues.get(trader_id, [])
        items = [n for n in q if n["id"] > after_id]
        last = q[-1]["id"] if q else after_id
        return items, last
