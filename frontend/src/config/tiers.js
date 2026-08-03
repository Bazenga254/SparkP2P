// Single source of truth for merchant-tier colours, labels and the ◆ Block badge
// across the WHOLE app — Market Activity, Price Tracker, the Settings badge and
// the Admin traders list. Change a colour / add a tier here and every surface
// updates. (Backend counterpart: app/core/tiers.py.)

export const TIER_COLOR = {
  block:  '#A855F7',   // purple — Binance Block Merchant (top tier)
  gold:   '#FFBE52',
  silver: '#D6DBE2',
  bronze: '#F08A3C',
  normal: '#929AA6',
};

export const TIER_LABEL = {
  block: 'Block', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', normal: 'Normal',
};

// The ◆ diamond marks the Block tier everywhere it appears.
export const TIER_DIAMOND = '◆';

export const tierColor = (t) => TIER_COLOR[String(t || '').toLowerCase()] || TIER_COLOR.normal;
export const tierLabel = (t) => TIER_LABEL[String(t || '').toLowerCase()] || (t || '');

// A merchant's DISPLAY tier from their stored fields. `binance_p2p_tier` is the
// true medal (incl. 'block'); `binance_merchant_tier` is the capability tier
// (block maps to 'gold'). Block wins so the badge always shows the upgrade.
export function merchantDisplayTier(m) {
  const p2p = String(m?.binance_p2p_tier || '').toLowerCase();
  if (p2p === 'block') return 'block';
  return String(m?.binance_merchant_tier || m?.binance_p2p_tier || '').toLowerCase();
}
