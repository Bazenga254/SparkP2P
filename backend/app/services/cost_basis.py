"""Cost-basis sell-down mode — inventory + weighted-average cost (see docs/cost-basis-mode.md).

Phase 1: compute only (display/readout). The sell-floor + sell-down pricing integration is
Phase 2/3. Weighted-average accounting: avg cost changes only on buys; sells reduce quantity at
the running average; a clear-out (qty ≈ 0) resets the basis so the next buys start fresh.
"""
from datetime import datetime, timezone

from app.models.order import OrderSide

EPS = 1e-6


def _rate(o) -> float:
    u = float(o.crypto_amount or 0)
    r = float(o.exchange_rate or 0)
    if r > 0:
        return r
    return (float(o.fiat_amount or 0) / u) if u else 0.0


def compute_inventory(orders, starting_stock: float = 0.0, starting_cost: float = 0.0) -> dict:
    """Replay completed orders chronologically. Returns {inventory, avg_cost}."""
    qty = float(starting_stock or 0)
    avg = float(starting_cost or 0)
    chron = sorted([o for o in orders if o.created_at], key=lambda x: x.created_at)
    for o in chron:
        u = float(o.crypto_amount or 0)
        if u <= 0:
            continue
        if o.side == OrderSide.BUY:
            tot = qty * avg + u * _rate(o)
            qty += u
            avg = tot / qty if qty > 0 else 0.0
        else:  # SELL — remove at the running average
            qty -= u
            if qty <= EPS:
                qty, avg = 0.0, 0.0
    return {"inventory": round(max(qty, 0.0), 2), "avg_cost": round(avg, 4)}


def status_for(trader, orders, min_margin: float = 0.0) -> dict:
    """Full cost-basis readout for a trader: inventory, avg cost, phase and sell floor."""
    inv = compute_inventory(orders, trader.cb_starting_stock, trader.cb_starting_cost)
    buffer = float(trader.cb_cleared_buffer if trader.cb_cleared_buffer is not None else 50.0)
    enabled = bool(getattr(trader, "cb_enabled", False))
    has_stock = inv["inventory"] > buffer
    phase = "off" if not enabled else ("selldown" if has_stock else "roundtrip")
    floor = round(inv["avg_cost"] + float(min_margin or 0), 2) if inv["avg_cost"] else None
    return {
        "enabled": enabled,
        "inventory": inv["inventory"],
        "avg_cost": inv["avg_cost"],
        "cleared_buffer": buffer,
        "phase": phase,
        "sell_floor": floor,
        "min_margin": float(min_margin or 0),
        "starting_stock": float(trader.cb_starting_stock or 0),
        "starting_cost": float(trader.cb_starting_cost or 0),
        "set_at": trader.cb_set_at.isoformat() if trader.cb_set_at else None,
    }
