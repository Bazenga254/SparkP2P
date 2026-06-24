"""Choice Bank OUTBOUND transaction fees borne by the trader.

These mirror the marked-up tariff Choice Bank charges on each outbound transfer (Choice Bank's
own cost + our markup). Choice Bank WITHHOLDS the full fee per transaction and remits our markup
to us monthly, so this module never moves money itself — Choice Bank debits the trader's account
by (amount + fee). It is the single source of truth used to DISPLAY the fee to the trader,
VALIDATE balance, and RECORD it for reconciliation against Choice Bank's monthly remittance.

Channels: M-Pesa B2C and PesaLink (bank). Amounts in KES.
"""

# M-Pesa B2C withdrawals below this are not offered.
MPESA_MIN_WITHDRAWAL = 1501


def mpesa_outbound_fee(amount: float) -> int:
    """M-Pesa B2C outbound fee in KES, by amount bracket."""
    a = float(amount or 0)
    if a <= 2500:    return 20
    if a <= 3500:    return 21
    if a <= 7500:    return 24   # 3,501-5,000 and 5,001-7,500
    if a <= 15000:   return 28   # 7,501-10,000 and 10,001-15,000
    if a <= 25000:   return 31   # 15,001-20,000 and 20,001-25,000
    if a <= 30000:   return 32
    if a <= 40000:   return 39   # 30,001-35,000 and 35,001-40,000
    return 40                    # 40,001 - 250,000


def pesalink_outbound_fee(amount: float) -> int:
    """PesaLink (bank) outbound fee in KES."""
    a = float(amount or 0)
    if a <= 1000:  return 10
    return 25


def outbound_fee(channel: str, amount: float) -> int:
    """Total fee for an outbound transfer (Choice Bank base cost + our markup). channel:
    'MPESA' -> M-Pesa B2C; anything else -> PesaLink."""
    if (channel or "").upper() == "MPESA":
        return mpesa_outbound_fee(amount)
    return pesalink_outbound_fee(amount)


# ── Our markup (revenue) portion of the fee ───────────────────────────────────
# Choice Bank keeps their base cost and remits THIS portion to us monthly. PesaLink is a flat
# KES 10 markup; M-Pesa is +8 up to 7,500, +10 to 30,000, +17 to 250,000.

def mpesa_markup(amount: float) -> int:
    a = float(amount or 0)
    if a <= 7500:    return 8
    if a <= 30000:   return 10
    return 17


def pesalink_markup(amount: float) -> int:
    return 15


def outbound_markup(channel: str, amount: float) -> int:
    """The markup (our revenue) inside an outbound fee — what Choice Bank remits to us monthly."""
    if (channel or "").upper() == "MPESA":
        return mpesa_markup(amount)
    return pesalink_markup(amount)


# ── Per-product tariff (for the admin revenue breakdown + Choice Bank invoice) ─────────────────
# Each product has its own Choice Bank base cost + our markup, by amount bracket (KES), taken from
# the combined charges sheet. markup = our revenue (what Choice Bank remits to us monthly).

def _bracket(amount, table):
    """table = list of (upper_inclusive, value); last entry's upper can be float('inf')."""
    a = float(amount or 0)
    for upper, val in table:
        if a <= upper:
            return val
    return table[-1][1]

# M-Pesa B2B (Paybill / Till / BuyGoods) — markup by amount bracket.
_B2B_MARKUP = [(49,1),(100,2),(500,3),(1000,6),(1500,8),(2500,11),(3500,13),(5000,17),(7500,20),
               (10000,23),(15000,27),(20000,29),(25000,32),(30000,34),(35000,38),(40000,45),
               (45000,46),(50000,48),(1000000,49),(3500000,50),(4500000,52),(5500000,54),(float("inf"),56)]
# Airtel B2C markup
_AIRTEL_B2C_MARKUP = [(100,0),(1500,2),(2500,3),(3500,4),(5000,4),(7500,5),(10000,5),(20000,6),
                      (25000,6),(40000,6),(float("inf"),6)]
_RTGS_KES_MARKUP = 100   # flat per-transfer markup (KES RTGS)


def mpesa_b2b_markup(amount: float) -> int:
    return _bracket(amount, _B2B_MARKUP)


def airtel_markup(amount: float) -> int:
    return _bracket(amount, _AIRTEL_B2C_MARKUP)


# Product keys used across the breakdown + invoice. RTGS/EFT/SWIFT are excluded — Choice Bank
# does not add (and therefore does not remit) a markup on those rails.
PRODUCTS = {
    "B2C":      "M-Pesa B2C",
    "B2B":      "M-Pesa B2B (Paybill/Till)",
    "PESALINK": "PesaLink / Bank",
    "AIRTEL":   "Airtel Money",
}


# Choice Bank txType -> a human channel string that categorize() understands. txType is the most
# reliable product signal on the 0002 webhook (destination fields are often blank).
_TXTYPE_CHANNEL = {
    "TTID0001": "M-Pesa",          # Withdraw to M-PESA (B2C)
    "TTID0025": "M-Pesa",          # M-Pesa IMT (B2C-style)
    "TTID0027": "M-Pesa",          # M-Pesa send
    "TTID0005": "M-Pesa Paybill",  # Paybill / Till (B2B)
    "TTID0006": "M-Pesa Paybill",  # Utility payment (B2B-style)
    "TTID0024": "Airtel Money",    # Airtel B2C
    "TTID0002": "Bank/PesaLink",   # Transfer out to bank
    "TTID0009": "Bank/PesaLink",   # PesaLink
}


def channel_from_txtype(tx_type: str) -> str:
    """Map a Choice Bank txType code to a channel string (fed into categorize)."""
    return _TXTYPE_CHANNEL.get((tx_type or "").upper(), "")


def categorize(transaction_type: str = "", destination_type: str = "", method: str = "") -> str:
    """Map a transaction's stored fields to a product key."""
    s = " ".join(str(x or "").lower() for x in (transaction_type, destination_type, method))
    if "paybill" in s or "till" in s or "buygoods" in s or "b2b" in s:
        return "B2B"
    if "airtel" in s:
        return "AIRTEL"
    if "rtgs" in s or "eft" in s or "swift" in s:
        return "EXCLUDED"   # no markup on these rails — skipped from the revenue breakdown
    if "mpesa" in s or "m-pesa" in s:
        return "B2C"
    return "PESALINK"   # bank / PesaLink transfers


def product_markup(product: str, amount: float) -> int:
    """Our markup (revenue) for one transaction of a given product."""
    p = (product or "").upper()
    if p == "B2C":      return mpesa_markup(amount)
    if p == "B2B":      return mpesa_b2b_markup(amount)
    if p == "PESALINK": return pesalink_markup(amount)
    if p == "AIRTEL":   return airtel_markup(amount)
    if p == "RTGS":     return _RTGS_KES_MARKUP
    return 0
