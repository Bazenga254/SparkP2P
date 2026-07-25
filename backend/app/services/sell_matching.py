"""Match an inbound Choice Bank payment to the RIGHT sell order.

The old rule was amount-only, so it broke exactly as the merchant described: a
KES 2,000 payment could be attributed to a stale KES 13,000 order, and a payment
could not tell two same-amount orders apart. The agreed formula makes the payer's
NAME the deciding second factor — "different people can't have the same name":

  Match requires BOTH the amount AND the payer's name to match the order.
  Same amount but a different name  -> not this order, keep looking.
  Amount matches and the name is UNKNOWN (Binance name not captured yet) -> fall
    back to amount-only, so a legitimate order still releases (fail-safe; the
    existing behaviour, never a false hold).

Returns the best order, plus WHY, so the caller can release on a name-confirmed
match and be cautious otherwise.
"""
from dataclasses import dataclass

# Tolerance for buyers rounding up a shilling or two on M-Pesa (whole-shilling rail).
_ROUND_TOLERANCE = 5


def _words(s: str) -> set:
    return {w.lower() for w in (s or "").split() if len(w) >= 3}


def name_verdict(sender_name: str, order) -> str:
    """'match' | 'mismatch' | 'unknown' — the payer name vs the buyer's Binance name."""
    binance_name = (getattr(order, "counterparty_real_name", None)
                    or getattr(order, "counterparty_name", None) or "").strip()
    if not sender_name or not binance_name:
        return "unknown"
    return "match" if _words(sender_name) & _words(binance_name) else "mismatch"


def _amount_fits(order, amount: int, received: int = 0) -> bool:
    """Does this payment fit the order — as the full amount, or the remaining balance?"""
    total = int(order.fiat_amount or 0)
    remaining = total - int(received or 0)
    return (
        amount == total
        or amount == remaining
        or (0 < amount <= total + _ROUND_TOLERANCE and received == 0)
    )


@dataclass
class MatchResult:
    order: object | None
    verdict: str          # 'match' (amount+name), 'amount_only' (name unknown), or 'none'


def pick_order(orders, amount, sender_name, received_by_order: dict | None = None) -> MatchResult:
    """Choose the order an inbound payment belongs to.

    `orders`  — the trader's orders currently AWAITING payment (pending sells).
    `received_by_order` — {order_id: KES already received} for partial-payment matching.

    Preference order:
      1. amount fits AND name matches            -> confident release
      2. amount fits AND name is unknown          -> amount-only fall-back (fail-safe)
      3. otherwise                                -> no match (leave for a human / alert)
    Never returns an order whose name is a known MISMATCH.
    """
    received_by_order = received_by_order or {}
    amt = int(amount)

    amount_fits = [o for o in orders if _amount_fits(o, amt, received_by_order.get(o.id, 0))]
    if not amount_fits:
        return MatchResult(None, "none")

    # 1) amount + name match — the confident case. Oldest first (FIFO on a true tie).
    named = [o for o in amount_fits if name_verdict(sender_name, o) == "match"]
    if named:
        named.sort(key=lambda o: o.created_at or 0)
        return MatchResult(named[0], "match")

    # 2) amount fits but the Binance name is unknown — fall back to amount-only.
    unknown = [o for o in amount_fits if name_verdict(sender_name, o) == "unknown"]
    if unknown:
        unknown.sort(key=lambda o: o.created_at or 0)
        return MatchResult(unknown[0], "amount_only")

    # 3) every amount-matching order has a DIFFERENT name — this payment is not for
    #    any of them. Don't force it onto the wrong order.
    return MatchResult(None, "none")
