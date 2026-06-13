# SparkP2P Squad Mode — Coordinated Team Pricing (design spec)

Status: **approved design, not yet built.** Locked decisions captured below.

## 1. What it is
A group of 2–N **verified merchant** accounts opt in to trade as a team ("squad"). The bot
coordinates their Binance P2P ad prices so the squad collectively holds the **top-K contiguous
slots** on the board (K = squad size; e.g. always top-4, no outsider breaking into 1–4), rotates
the #1 position among members for fairness, and only spends margin to overtake outsiders that are
a genuine threat — never pricing any member into a loss.

## 2. Hard constraints (confirmed)
- **Price changes require a verified P2P merchant.** Pushed via `POST /sapi/v1/c2c/ads/update`
  (the existing `update_ad_price`). Non-merchants get Binance **-1002 "not authorized"**. Every
  member must be a verified merchant with API key/secret connected.
- **Relay must be online per member.** Signed SAPI calls route through each member's desktop relay
  (the VPS IP is geo-blocked). A member whose relay is offline is **skipped** (can't move their
  price) until it returns. If fewer than 2 members are live, coordination pauses.
- **No wallet balances are visible.** Binance's public feed exposes per-ad **advertised available
  USDT**, **30-day order count**, **completion rate** — not account balances. "Volume" below =
  **advertised available USDT** (locked decision).

## 3. Locked decisions
| Decision | Choice |
|---|---|
| Volume gate trigger | **Contest an outsider only if its advertised volume > team strength** (a real flow-threat). Smaller outsiders are left to deplete. |
| Volume metric | **Advertised available USDT** (live, from the public feed). |
| Team formation | **Invite + accept.** Captain invites; each member accepts in their own app and connects their own verified API + relay. |
| Sides | **Both Buy-USDT and Sell-USDT**, coordinated independently, with round-trip loss protection. |
| Rotation interval | **15 minutes.** |
| Target block | Top-K contiguous, K = number of live members. |

## 4. Data model
- **squads**: id, name, captain_trader_id, block_size (default = live member count), rotation_minutes
  (15), side_mode ('both'), margin_min, margin_max (KES/USDT), volume_gate_pct (default 1.10 hysteresis),
  mode ('off' | 'sim' | 'live'), last_rotation_at, rotation_offset, created_at.
- **squad_members**: id, squad_id, trader_id, status ('invited' | 'active' | 'paused' | 'left'),
  joined_at. (Slot/rotation order is derived each cycle from rotation_offset, not stored per row.)

## 5. The engine (poller, every ~60s; `squad_engine.py`)
For each squad in mode sim/live:
1. Resolve **live members** = status active AND relay online AND API valid AND verified merchant.
   If < 2 → pause this squad this cycle.
2. Pull the live board (relay-free public feed; already cached).
3. For each side in scope (sell, buy):
   a. **team_strength** = median(advertised available USDT of the live members' ads on that side).
   b. **Intruders** = non-squad merchants currently inside the desired top-K block.
   c. **Volume gate**: for the strongest intruder, *contest* (price to push them out) only if
      `intruder.available > team_strength * volume_gate_pct`. Otherwise *hold* (accept them
      temporarily; preserve margin — they'll deplete and the squad rises).
   d. **Slot pricing** (loss-protected):
      - Define the **intrusion price** = price needed to keep the worst threatening outsider at
        rank K+1. The squad's tail slot prices just ahead of it.
      - Slots 1..K are ordered, each ≥1 tick more competitive than the next, so the squad occupies
        ranks 1..K contiguously.
      - Every slot price is **clamped to the margin band**: `[ref+min, ref+max]` on the sell side,
        `[ref-max, ref-min]` on the buy side (ref = opposite-side market median, so it works for
        one-sided members too). **Never below min margin.**
      - If holding (no qualifying threat), the whole block **relaxes toward max margin** (stretch
        the spread for maximum profit), keeping only the intra-squad tick ordering.
      - If beating a qualifying intruder would breach min margin → **do not chase**; accept the lost
        slot (profit > rank).
   e. **Rotation**: map members → slots using `rotation_offset`. When `now - last_rotation_at ≥ 15m`,
      increment the offset (leader → tail, others up one) and stamp `last_rotation_at`.
   f. **Apply**: for each live member, compute their assigned-slot target price; **sim** → record &
      surface in the UI; **live** → push via their relay with the existing rails (TICK 0.01,
      OUTLIER filter, MAX_STEP cap, MIN_PUSH_GAP throttle, global AUTOPRICE/SQUAD kill switch).

## 6. Loss protection / profitability (both sides)
- Team **margin band [min, max]** in KES/USDT; round-trip = sell − buy measured vs opposite-side
  market median (reuses the auto-pricer model).
- Leader is the most aggressive but **never below min**; tail slots carry more margin → the block
  captures a **margin gradient** instead of all sitting at the thinnest price.
- Uncontested → relax toward **max** margin (max-profit stretch). Hard floor always enforced.

## 7. Safety & guardrails
- Verified-merchant + API + relay + explicit member **consent** required.
- Reuse auto-pricer rails: outlier filter, step cap, push throttle, relay-gating, kill switch.
- **Simulation mode first**: the squad sees the full plan (who'd be in which slot, at what price and
  margin, gate status) before going live.
- Pause if < 2 live members. Skip offline members; rotation continues among the live set.
- All pushes idempotent/throttled; rotation = at most one price change per member per 15 min plus
  reactive moves within MIN_PUSH_GAP.

## 8. UI
The "Track a merchant" search evolves into a **Squad** panel (in the Price Tracker page):
- Create squad / invite by merchant name or email / accept-decline invites.
- Live roster with each member's current rank, advertised volume, relay status.
- **Rotation countdown** + who is #1 now.
- **Gate status**: "holding — top intruder below team strength" vs "contesting — outsider X above".
- Margin band inputs + sim→live switch + per-member fairness stats (time-at-#1).

## 9. Phased build
- **Phase A — Model + consent + sim dashboard.** Tables, invite/accept, squad panel, engine in
  SIMULATION only (computes & displays the plan + per-member target prices; pushes nothing). Lets
  the team validate the logic with zero risk.
- **Phase B — Live coordinated pricing + 15-min rotation.** Wire the engine to push real prices via
  each member's relay with all rails.
- **Phase C — Volume gate + margin gradient + fairness analytics.** The smart suppression, max-spread
  stretch, and per-member time-at-#1 reporting.

## 10. Open risks
- Coordinated pricing across independent accounts may bump Binance anti-collusion / ToS limits —
  worth a policy review before live.
- Relay flakiness directly degrades the block (offline member = a gap an outsider can fill).
- Rate limits on `ads/update` under heavy reactive churn — throttle conservatively.
