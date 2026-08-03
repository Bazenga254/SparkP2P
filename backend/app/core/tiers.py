"""Single source of truth for Binance P2P merchant tiers.

Every place that DETECTS or STORES a merchant tier goes through here, so the tier
set — and the special rule that a Block merchant keeps Gold capabilities — live in
ONE place. Change it here and every path (tier poller, connect-Binance, detect-name)
stays in sync.
"""

# Tiers we detect from Binance's ad feed, best -> worst. 'block' (the purple
# diamond — "Block Merchant") is Binance's TOP P2P tier, above gold.
DETECTABLE_TIERS = ("block", "gold", "silver", "bronze")


def merchant_tier_for(p2p_tier):
    """The binance_merchant_tier value to STORE for a detected p2p tier.

    Block merchants are ABOVE gold, but every Gold-gated capability
    (counterparty filters, the pro_max plan auto-assign, the 0.25 KES fee) checks
    `binance_merchant_tier == 'gold'`. So we store 'gold' for a block merchant —
    they keep all the Gold powers — while `binance_p2p_tier` records the true
    'block' medal, which is what the badge reads.

    Returns None for 'normal'/unknown, meaning "don't touch merchant_tier".
    """
    if p2p_tier == "block":
        return "gold"
    if p2p_tier in ("gold", "silver", "bronze"):
        return p2p_tier
    return None


def display_tier(trader):
    """A trader's DISPLAY tier (block/gold/silver/bronze/None) — 'block' from the
    real P2P medal, else the capability tier. This is what prices the weekly plan
    and drives the badge. Mirrors frontend merchantDisplayTier()."""
    p2p = (getattr(trader, "binance_p2p_tier", None) or "").lower()
    if p2p == "block":
        return "block"
    mt = (getattr(trader, "binance_merchant_tier", None) or getattr(trader, "binance_p2p_tier", None) or "").lower()
    return mt or None
