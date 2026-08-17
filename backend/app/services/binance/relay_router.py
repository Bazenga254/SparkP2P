"""Per-trader Binance relay router.

Routes a signed Binance request to a specific trader's desktop, which executes it from the
trader's OWN residential IP and returns the response. The VPS still signs every request (api
keys never leave the server) and stores all resulting data — only the network egress moves to
the trader's machine.

Transport: the desktop holds one outbound long-poll (GET /ext/relay/poll). The VPS enqueues a
job for that trader; the desktop pulls it, calls Binance, and posts the result back
(POST /ext/relay/result). In-process queues/futures (single-worker, like the other in-memory
stores in this app). A call to a trader whose desktop isn't polling times out -> caller treats
that trader as offline (isolated; no impact on other traders).
"""
import asyncio
import logging
import time
import uuid

logger = logging.getLogger("sparkp2p.relay")

# TEMP diagnostic: trace the lifecycle of a job (enqueue -> pulled -> result/timeout) for a
# specific trader and for any API-key verify call, so we can see exactly where a stuck verify dies.
_DIAG_TRADER = 13

def _diag(trader_id: int, path: str = "") -> bool:
    return trader_id == _DIAG_TRADER or "listWithPagination" in (path or "") or "ads/list" in (path or "")

_RESULT_TIMEOUT = 25.0     # seconds the VPS waits for the desktop to execute a job
_PRESENCE_WINDOW = 70.0    # a desktop counts as "connected" if it polled within this window

_job_queues: dict[int, asyncio.Queue] = {}   # trader_id -> pending jobs
_job_futures: dict[str, asyncio.Future] = {}  # job_id -> awaiting result
_last_poll: dict[int, float] = {}             # trader_id -> last poll time (presence)
_last_ip: dict[int, str] = {}                 # trader_id -> source IP of the trader's relay device


class RelayOffline(Exception):
    """Raised when a trader's desktop relay did not execute the job in time (app not running)."""


def _queue(trader_id: int) -> asyncio.Queue:
    q = _job_queues.get(trader_id)
    if q is None:
        q = asyncio.Queue()
        _job_queues[trader_id] = q
    return q


def is_connected(trader_id: int) -> bool:
    return (time.time() - _last_poll.get(trader_id, 0)) < _PRESENCE_WINDOW


def last_ip(trader_id: int) -> str:
    """The source IP of the trader's relay device (their real connection IP), captured from their
    long-poll. Empty if they've never connected since the backend started."""
    return _last_ip.get(trader_id, "")


async def execute(trader_id: int, path: str, params: dict, body: dict, headers: dict, method: str = "POST", host: str = None) -> dict:
    """Enqueue a Binance request for the trader's desktop/phone and await its response. `host`
    overrides the default api.binance.com base — e.g. https://c2c.binance.com for cookie-auth chat
    sends. Returns the parsed JSON body. Raises RelayOffline on timeout."""
    job_id = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    _job_futures[job_id] = fut
    q = _queue(trader_id)
    if _diag(trader_id, path):
        logger.warning("[RELAY-DIAG] ENQUEUE job=%s trader=%s method=%s path=%s qsize=%d connected=%s",
                       job_id[:8], trader_id, method, path, q.qsize(), is_connected(trader_id))
    await q.put({
        "job_id": job_id, "method": method, "path": path,
        "params": params, "body": body, "headers": headers, "host": host,
    })
    try:
        result = await asyncio.wait_for(fut, timeout=_RESULT_TIMEOUT)
        if _diag(trader_id, path):
            logger.warning("[RELAY-DIAG] RESULT job=%s trader=%s OK", job_id[:8], trader_id)
    except asyncio.TimeoutError:
        if _diag(trader_id, path):
            logger.warning("[RELAY-DIAG] TIMEOUT job=%s trader=%s (no result in %.0fs) qsize_now=%d",
                           job_id[:8], trader_id, _RESULT_TIMEOUT, q.qsize())
        raise RelayOffline(f"trader {trader_id} relay offline (no response in {_RESULT_TIMEOUT:.0f}s)")
    finally:
        _job_futures.pop(job_id, None)
    return result.get("body")


async def next_job(trader_id: int, wait: float = 25.0, client_ip: str = ""):
    """Desktop long-poll: return the next job for this trader, or None if none within `wait`."""
    _last_poll[trader_id] = time.time()
    if client_ip:
        _last_ip[trader_id] = client_ip
    try:
        job = await asyncio.wait_for(_queue(trader_id).get(), timeout=wait)
    except asyncio.TimeoutError:
        return None
    if job and _diag(trader_id, job.get("path", "")):
        logger.warning("[RELAY-DIAG] PULLED job=%s trader=%s by IP=%s path=%s",
                       (job.get("job_id") or "")[:8], trader_id, client_ip, job.get("path"))
    return job


def deliver_result(job_id: str, body) -> bool:
    """Desktop posts back the executed response. Returns False if the job already timed out."""
    fut = _job_futures.get(job_id)
    if fut and not fut.done():
        fut.set_result({"body": body})
        return True
    logger.warning("[RELAY-DIAG] deliver_result job=%s: no waiting future (already timed out, or unknown job_id)", (job_id or "")[:8])
    return False
