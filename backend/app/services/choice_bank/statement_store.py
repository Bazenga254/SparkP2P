"""Tiny in-memory cache of ready statement URLs, keyed by Choice Bank jobId.

Choice pushes callback 0015 the moment a statement is built, carrying the
download URL. That arrives on the webhook thread; the merchant is waiting on the
status endpoint. This is the hand-off between the two — the webhook writes the
URL here, the status endpoint reads it and returns instantly instead of polling
Choice.

In-memory on purpose: a statement job lives ≤15 min and the merchant is watching
the modal, so surviving a restart is not worth a DB table. If the process does
restart mid-job the status endpoint still falls back to querying Choice directly,
so nothing is lost — the callback is an optimisation, not the only path.
"""
import time

_TTL = 3600  # keep a ready URL for an hour, then forget it
_store: dict[str, dict] = {}   # jobId -> {"url": str, "at": float}


def set_url(job_id: str, url: str) -> None:
    if not job_id or not url:
        return
    _store[str(job_id)] = {"url": url, "at": time.time()}
    _sweep()


def get_url(job_id: str) -> str | None:
    row = _store.get(str(job_id))
    if not row:
        return None
    if time.time() - row["at"] > _TTL:
        _store.pop(str(job_id), None)
        return None
    return row["url"]


def _sweep() -> None:
    now = time.time()
    for k in [k for k, v in _store.items() if now - v["at"] > _TTL]:
        _store.pop(k, None)
