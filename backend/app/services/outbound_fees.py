"""Choice Bank OUTBOUND transaction fees — source of truth from the Combined Pricing sheet.

Three values per transaction:
  cb_fee   = Choice Bank's portion (their cost)
  our_markup = Spark AI's portion (our revenue, remitted monthly by Choice Bank)
  total_fee  = cb_fee + our_markup (what the trader's account is debited)

Choice Bank withholds the full fee per transaction and remits our markup to us monthly.
"""

MPESA_MIN_WITHDRAWAL = 1501


def _bracket(amount, table):
    a = float(amount or 0)
    for upper, val in table:
        if a <= upper:
            return val
    return table[-1][1]


# ── M-Pesa B2C ────────────────────────────────────────────────────────────────
# (upper_inclusive, (cb_fee, spark_markup, total))
_B2C = [
    (100,    (0,  8,  8)),
    (500,    (6,  8, 14)),
    (1000,   (6,  8, 14)),
    (1500,   (8,  8, 16)),
    (2500,   (12, 8, 20)),
    (3500,   (13, 8, 21)),
    (5000,   (16, 8, 24)),
    (7500,   (16, 8, 24)),
    (10000,  (18, 10, 28)),
    (15000,  (18, 10, 28)),
    (20000,  (21, 10, 31)),
    (25000,  (21, 10, 31)),
    (30000,  (22, 10, 32)),
    (35000,  (22, 17, 39)),
    (40000,  (22, 17, 39)),
    (50000,  (23, 17, 40)),
    (70000,  (23, 17, 40)),
    (150000, (23, 17, 40)),
    (float("inf"), (23, 17, 40)),
]

def mpesa_outbound_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _B2C])

def mpesa_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _B2C])

def mpesa_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _B2C])


# ── M-Pesa B2B Paybill / Till / BuyGoods ──────────────────────────────────────
_B2B = [
    (49,        (2,   1,   3)),
    (100,       (3,   2,   5)),
    (500,       (8,   3,  11)),
    (1000,      (15,  6,  21)),
    (1500,      (20,  8,  28)),
    (2500,      (27, 11,  38)),
    (3500,      (33, 13,  46)),
    (5000,      (42, 17,  59)),
    (7500,      (51, 20,  71)),
    (10000,     (58, 23,  81)),
    (15000,     (67, 27,  94)),
    (20000,     (72, 29, 101)),
    (25000,     (79, 32, 111)),
    (30000,     (84, 34, 118)),
    (35000,     (95, 38, 133)),
    (40000,     (112,45, 157)),
    (45000,     (116,46, 162)),
    (50000,     (121,48, 169)),
    (70000,     (122,49, 171)),
    (100000,    (122,49, 171)),
    (250000,    (122,49, 171)),
    (1000000,   (122,49, 171)),
    (1500000,   (125,50, 175)),
    (2500000,   (125,50, 175)),
    (3500000,   (125,50, 175)),
    (4500000,   (130,52, 182)),
    (5500000,   (135,54, 189)),
    (7500000,   (140,56, 196)),
    (float("inf"), (140,56, 196)),
]

def mpesa_b2b_total_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _B2B])

def mpesa_b2b_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _B2B])

def mpesa_b2b_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _B2B])


# ── Airtel B2C ────────────────────────────────────────────────────────────────
_AIRTEL_B2C = [
    (9,     (0,  3,  3)),
    (49,    (0,  5,  5)),
    (100,   (0,  7,  7)),
    (500,   (6,  5, 11)),
    (1000,  (6,  7, 13)),
    (1500,  (6, 10, 16)),
    (2500,  (8, 10, 18)),
    (3500,  (10,10, 20)),
    (5000,  (11,12, 23)),
    (7500,  (12,12, 24)),
    (10000, (13,13, 26)),
    (15000, (13,13, 26)),
    (20000, (14,14, 28)),
    (25000, (15,15, 30)),
    (30000, (16,16, 32)),
    (35000, (16,17, 33)),
    (40000, (16,18, 34)),
    (45000, (16,19, 35)),
    (50000, (16,20, 36)),
    (70000, (16,22, 38)),
    (float("inf"), (16,23, 39)),
]

def airtel_total_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _AIRTEL_B2C])

def airtel_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _AIRTEL_B2C])

def airtel_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _AIRTEL_B2C])


# ── PesaLink / Bank ───────────────────────────────────────────────────────────
_PESALINK = [
    (100,   (0,  15, 15)),
    (1000,  (0,  15, 15)),
    (float("inf"), (15, 15, 30)),
]

def pesalink_outbound_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _PESALINK])

def pesalink_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _PESALINK])

def pesalink_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _PESALINK])


# ── Generic helpers ───────────────────────────────────────────────────────────

def outbound_fee(channel: str, amount: float) -> int:
    c = (channel or "").upper()
    if c == "MPESA":   return mpesa_outbound_fee(amount)
    if c == "AIRTEL":  return airtel_total_fee(amount)
    return pesalink_outbound_fee(amount)

def outbound_markup(channel: str, amount: float) -> int:
    c = (channel or "").upper()
    if c == "MPESA":   return mpesa_markup(amount)
    if c == "AIRTEL":  return airtel_markup(amount)
    return pesalink_markup(amount)

def outbound_cb_fee(channel: str, amount: float) -> int:
    c = (channel or "").upper()
    if c == "MPESA":   return mpesa_cb_fee(amount)
    if c == "AIRTEL":  return airtel_cb_fee(amount)
    return pesalink_cb_fee(amount)


# ── Per-product tariff (revenue breakdown + invoice) ──────────────────────────

PRODUCTS = {
    "B2C":      "M-Pesa B2C",
    "B2B":      "M-Pesa B2B (Paybill/Till)",
    "PESALINK": "PesaLink / Bank",
    "AIRTEL":   "Airtel Money",
}

_TXTYPE_CHANNEL = {
    "TTID0001": "M-Pesa",
    "TTID0025": "M-Pesa",
    "TTID0027": "M-Pesa",
    "TTID0005": "M-Pesa Paybill",
    "TTID0006": "M-Pesa Paybill",
    "TTID0024": "Airtel Money",
    "TTID0002": "Bank/PesaLink",
    "TTID0009": "Bank/PesaLink",
}


def channel_from_txtype(tx_type: str) -> str:
    return _TXTYPE_CHANNEL.get((tx_type or "").upper(), "")


def categorize(transaction_type: str = "", destination_type: str = "", method: str = "") -> str:
    s = " ".join(str(x or "").lower() for x in (transaction_type, destination_type, method))
    if "paybill" in s or "till" in s or "buygoods" in s or "b2b" in s:
        return "B2B"
    if "airtel" in s:
        return "AIRTEL"
    if "rtgs" in s or "eft" in s or "swift" in s:
        return "EXCLUDED"
    if "mpesa" in s or "m-pesa" in s:
        return "B2C"
    return "PESALINK"


def product_markup(product: str, amount: float) -> int:
    p = (product or "").upper()
    if p == "B2C":      return mpesa_markup(amount)
    if p == "B2B":      return mpesa_b2b_markup(amount)
    if p == "PESALINK": return pesalink_markup(amount)
    if p == "AIRTEL":   return airtel_markup(amount)
    return 0

def product_cb_fee(product: str, amount: float) -> int:
    """Choice Bank's portion of the fee (their cost, not remitted to us)."""
    p = (product or "").upper()
    if p == "B2C":      return mpesa_cb_fee(amount)
    if p == "B2B":      return mpesa_b2b_cb_fee(amount)
    if p == "PESALINK": return pesalink_cb_fee(amount)
    if p == "AIRTEL":   return airtel_cb_fee(amount)
    return 0

def product_total_fee(product: str, amount: float) -> int:
    return product_cb_fee(product, amount) + product_markup(product, amount)
