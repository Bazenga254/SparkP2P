# Cost-Basis Sell-Down Mode (design spec)

Status: **approved design, not yet built.** Locked decisions below.

## 1. Goal
Stop the bot from ever pricing a merchant into a loss when they resume trading. If they're holding
USDT bought at average cost **C**, the bot floors the sell price at **C + min margin**, prioritises
**selling that stock down first**, and only switches to the advanced buy-low/sell-high round-trip
optimiser once the existing stock is cleared.

## 2. Locked decisions
| Decision | Choice |
|---|---|
| Cost basis | **Weighted-average buy price** (matches the existing Profit engine's avg-buy rate). |
| Pre-existing stock | **Merchant enters starting stock + avg cost once**; the bot tracks it automatically from then on. |
| Sell-down behaviour | **Sell-only until cleared** — pause buying, push the sell ad to rank well at ≥ cost + margin. |
| "Cleared" threshold | **Near zero** — inventory below a small USDT buffer counts as depleted. |

## 3. What we already have
`tracking.py` records every completed order (side, `crypto_amount` USDT, `fiat_amount` KES,
`exchange_rate` unit price) and already computes a running **weighted-average buy rate** + per-day
spread P&L. The cost basis is therefore derivable from real order history — we only add the
pre-bot starting position the merchant supplies once.

## 4. Inventory & cost-basis model
Weighted-average method (avg cost changes only on buys; sells reduce quantity at the current avg):
```
inventory = starting_stock + Σ(buy USDT)  − Σ(sell USDT)        [since cb_set_at]
avg_cost  = (starting_stock·starting_cost + Σ(buy USDT · buy_rate)) / (starting_stock + Σ buy USDT)
```
When `inventory` drops to ~0 the basis resets (next buys start a fresh average). Recomputed from
orders on each pricing cycle (cheap) so it always reflects live trading.

## 5. New trader fields
- `cb_enabled` (bool) — opt in.
- `cb_starting_stock` (USDT), `cb_starting_cost` (KES/USDT), `cb_set_at` (datetime) — one-time input.
- `cb_cleared_buffer` (USDT, default ~50) — below this = "stock depleted".
- (derived, optionally cached) `cb_inventory`, `cb_avg_cost`, `cb_phase`.

## 6. Behaviour (per pricing cycle)
If `cb_enabled` and `inventory > cb_cleared_buffer` → **SELL-DOWN phase**:
- Sell-ad floor = `avg_cost + min_margin` (never below what they paid + min profit).
- Price the **sell** ad as competitively as the floor allows (the joint optimiser, but with the
  sell floor = avg_cost instead of the market-median reference).
- **Pause the buy side** (skip buy-ad repricing / hold it non-competitive) so they don't accumulate
  more stock before clearing.

Else → **ROUND-TRIP phase**: the full joint optimiser (buy low / sell high) from the auto-pricing spec.

The daily "resume" calc uses `avg_cost` as the sell floor, so a fresh day can never instruct a
below-cost sale.

## 7. UI
A "Stock & cost basis" card (in the auto-pricing area / Profit page):
- Enable cost-basis protection toggle.
- One-time **starting stock + avg cost** input (editable; auto-tracks after).
- Live readout: **held USDT**, **avg cost**, **current phase** (Selling down ▸ / Round-trip), and the
  computed **sell floor**.

## 8. Phased build
- **Phase 1 — Tracking + input + readout (display only).** New fields, compute inventory + avg cost
  from orders + starting input, merchant input UI, live readout + phase indicator. No pricing change.
- **Phase 2 — Floor in the optimiser (sim first).** Feed `avg_cost` as the sell floor and the
  sell-down/round-trip phase switch into the auto-pricing simulation.
- **Phase 3 — Live enforcement.** Apply the floor + sell-down in the live auto-pricer and squad engine.

## 9. Notes / risks
- Only stock bought through the bot (plus the merchant's one-time entry) is costed — fully accurate
  going forward, approximate for legacy holdings until the next clear-out resets the basis.
- Sell-only pausing the buy side reduces volume temporarily by design (clear stock first).
- Ties into the joint round-trip optimiser from the Auto-pricing work (shared sell-floor concept).
