"""Squad Mode engine — Phase A: simulation (see docs/squad-mode.md).

Computes the coordinated team-pricing plan from the PUBLIC board (relay-free): which member
should sit in which slot, at what price and margin, on each side — applying the volume gate,
the margin band (loss protection), randomized inter-slot gaps, and the 15-minute rotation.

Phase A pushes nothing. The same plan feeds the live pusher in Phase B (per-member relay).
"""
import random
import time

TICK = 0.01
OUT_PCT = 0.03   # ignore spoof/outlier competitor prices


def _median(vals):
    s = sorted(v for v in vals if v and v > 0)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else 0.0


def _clean(rows):
    arr = [r for r in (rows or []) if (r.get("price") or 0) > 0]
    m = _median([r["price"] for r in arr[:15]])
    if not m:
        return arr
    f = [r for r in arr if abs(r["price"] - m) / m <= OUT_PCT]
    return f or arr


def _find(rows, nick):
    nl = (nick or "").strip().lower()
    for r in rows:                       # rows are ranked → first match is the best
        if (r.get("nick") or "").strip().lower() == nl:
            return r
    return None


def _side_plan(squad, members, rows_all, ref, is_sell, side_key, step):
    """Plan one side. rows_all = the board side the members' ads live on
    (sell ads sit on the Buy-USDT board; buy ads on the Sell-USDT board)."""
    rows = _clean(rows_all)
    mmin = float(squad.margin_min or 0)
    mmax = float(squad.margin_max or 0)
    gate_pct = float(squad.volume_gate_pct or 1.10)
    max_gap = max(TICK, float(squad.max_gap or 0.08))

    nick_set = {(m["nick"] or "").strip().lower() for m in members if m.get("nick")}
    on = []
    for m in members:
        row = _find(rows, m["nick"]) if m.get("nick") else None
        on.append({**m, "row": row, "online": bool(row)})
    live = sorted([m for m in on if m["online"]], key=lambda x: x["trader_id"])
    k = len(live)

    lo = (ref + mmin) if is_sell else (ref - mmax)
    hi = (ref + mmax) if is_sell else (ref - mmin)

    intruders = [r for r in rows if (r.get("nick") or "").strip().lower() not in nick_set]
    top_intruder = intruders[0] if intruders else None
    team_strength = _median([m["row"].get("available", 0) for m in live]) if live else 0.0
    contest = False
    if top_intruder and team_strength:
        if (top_intruder.get("available") or 0) > team_strength * gate_pct:
            contest = True
            gate_reason = f"{top_intruder['nick']} out-volumes the team — contesting."
        else:
            gate_reason = f"{top_intruder['nick']} is below team strength — holding for margin."
    elif not top_intruder:
        gate_reason = "No outsider ahead — holding at best margin."
    else:
        gate_reason = "No live team ads to position yet."

    plan = {
        "k": k, "step": step,
        "team_strength": round(team_strength),
        "contest": contest, "gate_reason": gate_reason,
        "top_intruder": ({"nick": top_intruder["nick"], "price": top_intruder["price"],
                          "available": round(top_intruder.get("available", 0))} if top_intruder else None),
        "band": {"min_price": round(lo, 2), "max_price": round(hi, 2), "ref": round(ref, 2)},
    }

    rng = random.Random(f"{squad.id}:{side_key}:{step}")
    if contest and top_intruder:
        beat = round(rng.uniform(TICK, 0.03), 2)
        anchor = (top_intruder["price"] - beat) if is_sell else (top_intruder["price"] + beat)
    elif top_intruder:
        anchor = (top_intruder["price"] + TICK) if is_sell else (top_intruder["price"] - TICK)
    else:
        anchor = hi if is_sell else lo
    anchor = min(max(anchor, lo), hi)

    # Ordered slots with randomized (non-rigid) gaps, clamped to the margin band.
    slots = []
    cum = 0.0
    for s in range(k):
        if s > 0:
            cum += round(rng.uniform(TICK, max_gap), 2)
        price = (anchor + cum) if is_sell else (anchor - cum)
        p = round(min(max(price, lo), hi), 2)
        margin = round((p - ref) if is_sell else (ref - p), 2)
        slots.append({"slot": s + 1, "price": p, "margin": margin})

    # Rotation: assign live members to slots; leader rotates each window.
    assign = {}
    for s in range(k):
        member = live[(step + s) % k]
        assign[member["trader_id"]] = slots[s]
    plan["leader_nick"] = live[step % k]["nick"] if k else None
    plan["slots"] = slots
    plan["members"] = []
    for m in on:
        a = assign.get(m["trader_id"]) if m["online"] else None
        plan["members"].append({
            "trader_id": m["trader_id"], "nick": m.get("nick"), "name": m.get("name"),
            "online": m["online"],
            "current_rank": (m["row"] or {}).get("rank") if m["online"] else None,
            "current_price": (m["row"] or {}).get("price") if m["online"] else None,
            "available": round((m["row"] or {}).get("available", 0)) if m["online"] else None,
            "target_slot": a["slot"] if a else None,
            "target_price": a["price"] if a else None,
            "target_margin": a["margin"] if a else None,
        })
    return plan


def _step_for(squad, k):
    if k <= 0:
        return 0
    rot_min = max(1, int(squad.rotation_minutes or 15))
    period = rot_min * 60
    anchor_ts = squad.rotation_anchor.timestamp() if squad.rotation_anchor else time.time()
    elapsed = max(0.0, time.time() - anchor_ts)
    return int(elapsed // period) % k


def simulate(squad, members, board):
    """members = [{trader_id, nick, name}] (active). Returns {sell?, buy?, rotation}."""
    buy_rows = board.get("buy", [])     # cheapest asks — members' SELL ads live here
    sell_rows = board.get("sell", [])   # highest bids — members' BUY ads live here
    cost = _median([r["price"] for r in _clean(buy_rows)[:5]])
    revenue = _median([r["price"] for r in _clean(sell_rows)[:5]])

    out = {}
    sides = []
    if squad.side_mode in ("both", "sell"):
        sides.append(("sell", buy_rows, cost, True))
    if squad.side_mode in ("both", "buy"):
        sides.append(("buy", sell_rows, revenue, False))

    nick_set = {(m["nick"] or "").strip().lower() for m in members if m.get("nick")}
    rot_min = max(1, int(squad.rotation_minutes or 15))
    period = rot_min * 60
    anchor_ts = squad.rotation_anchor.timestamp() if squad.rotation_anchor else time.time()
    elapsed = max(0.0, time.time() - anchor_ts)

    for side_key, rows, ref, is_sell in sides:
        # Need k first (live members on this side) to compute the rotation step.
        live_n = sum(1 for m in members if m.get("nick") and _find(_clean(rows), m["nick"]))
        step = (int(elapsed // period) % live_n) if live_n else 0
        out[side_key] = _side_plan(squad, members, rows, ref, is_sell, side_key, step)

    out["rotation"] = {"minutes": rot_min, "next_in_sec": int(period - (elapsed % period)) if period else None}
    return out
