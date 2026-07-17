"""
In-flight leases for I&M Bot buy-order payouts.

One layer of the "never pay a seller twice" defence. When /poll hands an order
to a merchant's bot, it takes a short lease on that order number so the NEXT poll
(a retry, a second bot instance, a reconnect) does not hand out the same order
while a payment is in flight.

This is deliberately in-memory and best-effort. It is NOT the only guard, and it
is not the last line of defence:

  1. The I&M Bot itself refuses to re-pay an order id it has already recorded
     (client-side, survives the bot's own restart).
  2. This lease stops concurrent/duplicate SERVING within a poll window.
  3. /result only moves an order PENDING -> PAYMENT_SENT once; a second result
     is a no-op (the authoritative, persistent guard).

So if the server restarts and loses these leases, guard 1 and guard 3 still hold.
A lease also EXPIRES, so a bot that fetches an order and then crashes without
reporting does not strand that order forever — it becomes servable again after
LEASE_TTL and can be retried (I&M Bot's own idempotency prevents a real double
payment on that retry).
"""

import time
import threading

LEASE_TTL_S = 180  # a payment plus its report should be well inside 3 minutes

_lock = threading.Lock()
_leases: dict[str, dict] = {}  # order_number -> {trader_id, until}


def _now() -> float:
    return time.monotonic()


def try_lease(order_number: str, trader_id: int) -> bool:
    """Take a lease on this order for this trader. False if someone already holds
    a live one (so the caller must NOT serve it)."""
    with _lock:
        cur = _leases.get(order_number)
        if cur and cur["until"] > _now():
            return False
        _leases[order_number] = {"trader_id": trader_id, "until": _now() + LEASE_TTL_S}
        return True


def is_leased(order_number: str) -> bool:
    with _lock:
        cur = _leases.get(order_number)
        return bool(cur and cur["until"] > _now())


def release(order_number: str) -> None:
    """Drop a lease once the order is resolved (paid/failed/unknown), so a
    genuine later retry isn't blocked by a stale hold."""
    with _lock:
        _leases.pop(order_number, None)


def active_for(trader_id: int) -> list[str]:
    with _lock:
        now = _now()
        return [o for o, v in _leases.items() if v["trader_id"] == trader_id and v["until"] > now]
