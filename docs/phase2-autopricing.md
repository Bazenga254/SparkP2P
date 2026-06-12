# SparkP2P — Phase 2 Spec v2: Smart Auto-Pricing

> Status: **DRAFT for review.** Nothing built yet. Phase 1 (Price Tracker) is live.
> 5 open questions at the bottom are still to be decided by the product owner.

## Background / phase plan
- **Phase 1 — Price Tracker** ✅ live: read-only live competitor board (Buy/Sell split, verified
  Gold/Silver/Bronze tiers from the feed's `vipLevel`, tier filter, merchant search). Admin-gated per trader.
- **Phase 2 — Smart Auto-Pricing** ← this document.
- **Phase 3 — Loss protection + AI advisory** on incoming/matched trades (deferred).

## Key correction — think in terms of the ROUND-TRIP spread
The **"Buy USDT" board** is your *cost* to acquire coin; the **"Sell USDT" board** is your *revenue*
when you offload. The trap (pump/dump): the **buy board gets pumped** (cost spikes) but the **sell
board doesn't follow** (revenue flat) — so chasing rank on each side *independently* makes you commit
to **buy high / sell low** = squeezed or negative margin. The bot must judge **both sides together**,
not in isolation.

---

## 1. Three modes (merchant picks)
1. **Monitor only (Advisory)** — bot never changes prices. It watches your rank and sends Telegram
   alerts: *"Sell ad: you're #2 on Gold, #6 overall. Buy ad: #1 on Gold. AROGO2 just overtook you on
   Sell."* Tracks who is above/below you and rank changes. Lowest-risk; recommended launch mode.
2. **Floating auto-price** — dynamically holds your rank target **within a margin band**: tightens
   margin to win when the market is crowded; **widens it when you're alone** (more breathing room).
3. **Fixed auto-price** — defends a set price/margin around a chosen figure all day (re-pegs to hold
   that level; does not chase extra margin).

## 2. Margin as a flexible band (not a fixed number)
- Merchant sets a **range: min → max**, e.g. **0.1% – 0.6%**, or narrow to **0.3% – 0.4%**.
- Units: **percentage OR absolute KES per USDT** (merchant's choice), mirroring the Profit page's
  "Avg Margin KES 0.46". Example floating band: **KES 0.38 → 0.46**.
- Usage: the bot moves price **within the band** to satisfy the rank target. Fierce competition →
  margin drifts toward the **min** (still profitable). Thin/empty market → margin expands toward the
  **max**. It will **never** go below the band min — that is the hard floor.

## 3. Rank target — with scope
- Target: "**always #1**", "top 2", "top 5", etc.
- **Scope:** within a **tier** (e.g. "#1 among Gold merchants") **or** across the **whole table**
  (Gold+Silver+Bronze). Chosen per side.
- The bot adjusts **both buy and sell** ad prices to hold the target within the margin band.

## 4. The intelligence (anti-manipulation + asymmetry) — heart of v2
Before moving any price, the engine runs:
- **Round-trip spread guard (Phase 2, hard rule):** compute *achievable sell price − achievable buy
  price* from the live boards. If holding the rank target would push that spread **below the margin
  band min**, the bot **does not chase** — it holds at the best price that still respects the band and
  accepts a lower rank. Stops "buy high / sell low."
- **Outlier / spoof detection:** compare the rank-1 (or target-rank) price against the **median of the
  top N** on that side. If #1 is abnormally far from the pack (likely spoof/pump), peg against the
  **pack, not the outlier** — never get baited by one manipulated ad.
- **Asymmetry advisory (Phase 2 → Phase 3 bridge):** if the **buy board is spiking** but the **sell
  board isn't following**, the bot **holds** and sends Telegram: *"Buy-side prices are rising
  abnormally (rank-1 is X% above the top-10 average) while sell-side is flat. Holding your price to
  protect your margin — not chasing."*
- Net effect: the bot stays **honest about the real spread** — it won't inflate both sides to show a
  nominal margin if the market can't support the sell side.

## 5. Controls (Configure → Auto-Pricing, admin-gated)
Per side (Buy / Sell):
- Mode: Monitor / Floating / Fixed
- Rank target + scope (tier or whole table)
- Margin band (min–max, % or KES)
- Peg-against filter (which tiers, min completion %, always exclude self + dead ads)
- Max price step per update
- Update cadence

## 6. Architecture
- **Read:** existing `price_tracker.get_board()` (no relay needed) for competitor prices + tiers.
- **Own ads:** `get_merchant_ads` (EP-4 `listWithPagination`) via the trader's relay → `advNo` +
  current price per ad.
- **Decide:** pure decision engine (rank + band + spread guard + outlier guard) → target price or
  "hold". Unit-testable in isolation.
- **Write:** `POST /sapi/v1/c2c/ads/update` with **only** `{advNo, price}` (signed, via relay — same
  path as the Gold-Merchant filter push; extra fields throw error 187049). Monitor mode never writes.
- **Alerts:** Telegram for rank changes (Monitor) and advisories (all modes).
- **Loop:** new relay-gated background poller (alongside order_poller, filter_sync_poller, …),
  throttled per trader.

## 7. Safety / rollout
- Margin-band **min is the hard floor**; never crossed.
- **Simulation mode** (compute + show + Telegram, do not push) before going Live.
- Max updates/hour per ad; global + per-trader **kill switch**.
- **Relay-gated** — pauses if the trader's relay drops (no errors, no stale pushes).
- Admin enables Auto-Pricing per trader (same On/Off pattern as Price Tracker).
- Rollout: Monitor-only → Simulation → Live (one pilot trader) → general.

## 8. Data model (new `trader` columns, indicative)
`auto_pricing_enabled` (bool, admin-gated) · `ap_mode` ('monitor'|'floating'|'fixed') · per side
(`ap_sell_*`, `ap_buy_*`): enabled, rank_target, rank_scope ('tier'|'all'), margin_min, margin_max,
margin_unit ('kes'|'pct'), fixed_price (fixed mode) · `ap_peg_tiers` · `ap_min_completion` ·
`ap_max_step` · `ap_update_interval_s` · `ap_max_updates_per_hour` · `ap_last_pushed_at`.

## 9. Phase boundary
- **Phase 2** = your *ad pricing*: the 3 modes, margin band, rank target, spread/outlier guards, rank
  + advisory Telegrams.
- **Phase 3** = protection on *incoming/matched trades*: hard never-buy-above / never-sell-below at
  execution + AI counterparty-anomaly decline. The asymmetry advisory bridges the two.

## 10. Decisions (LOCKED)
1. **Margin band unit** — **KES per USDT** (default), with % as an optional alternative.
2. **Outlier threshold** — default (tunable): flag/hold when rank-1 is **> 0.5% above the top-5
   average** on that side. Owner to fine-tune after seeing it live.
3. **Pack baseline** — **top 5** (median/average of the top 5 used for outlier + asymmetry checks).
4. **Launch mode** — **Monitor-only first**, then add Floating/Fixed. (Confirmed.)
5. **Telegram alerts** — default trigger: **when you drop out of your target rank.** Made
   **configurable** so each merchant chooses what they want (drop-out-of-target, who is currently #1,
   when someone overtakes them, periodic price/rank summary, etc.).

## 11. Build sequencing (once approved)
1. DB fields + admin gate + Configure → Auto-Pricing panel (defaults: Monitor / Simulation).
2. Pure decision engine (read board → target price or hold; spread + outlier guards) — unit-testable.
3. Monitor mode + rank/advisory Telegram alerts (no writes).
4. Simulation surfacing (show "would set X").
5. Live push via relay + throttle + kill switch.
6. Pilot on one trader, then general.
