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
    (35000,  (22, 12, 34)),
    (40000,  (22, 12, 34)),
    (50000,  (23, 12, 35)),
    (70000,  (23, 12, 35)),
    (150000, (23, 12, 35)),
    (float("inf"), (23, 12, 35)),
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


# ── M-Pesa B2B KRA Paybill ────────────────────────────────────────────────────
_KRA_PAYBILL = [
    (49,        (2,   1,   3)),
    (100,       (3,   2,   5)),
    (500,       (12,  5,  17)),
    (1000,      (17,  7,  24)),
    (1500,      (28, 11,  39)),
    (2500,      (33, 13,  46)),
    (3500,      (47, 19,  66)),
    (5000,      (56, 22,  78)),
    (7500,      (74, 30, 104)),
    (10000,     (80, 32, 112)),
    (15000,     (101,40, 141)),
    (20000,     (106,42, 148)),
    (25000,     (112,45, 157)),
    (30000,     (117,47, 164)),
    (35000,     (128,51, 179)),
    (40000,     (144,58, 202)),
    (45000,     (148,59, 207)),
    (float("inf"), (153,59, 212)),
]

def kra_paybill_total_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _KRA_PAYBILL])

def kra_paybill_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _KRA_PAYBILL])

def kra_paybill_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _KRA_PAYBILL])


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


# ── Airtel B2B ────────────────────────────────────────────────────────────────
_AIRTEL_B2B = [
    (9,     (0,   2,   2)),
    (49,    (0,   3,   3)),
    (100,   (0,   5,   5)),
    (500,   (7,   6,  13)),
    (1000,  (12, 10,  22)),
    (1500,  (15, 15,  30)),
    (2500,  (17, 17,  34)),
    (3500,  (24, 24,  48)),
    (5000,  (24, 24,  48)),
    (7500,  (37, 37,  74)),
    (10000, (42, 42,  84)),
    (15000, (62, 62, 124)),
    (20000, (67, 67, 134)),
    (25000, (73, 73, 146)),
    (30000, (78, 78, 156)),
    (35000, (101,101,202)),
    (40000, (106,106,212)),
    (45000, (110,110,220)),
    (50000, (113,113,226)),
    (70000, (113,113,226)),
    (float("inf"), (113,113,226)),
]

def airtel_b2b_total_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[2]) for u, v in _AIRTEL_B2B])

def airtel_b2b_cb_fee(amount: float) -> int:
    return _bracket(amount, [(u, v[0]) for u, v in _AIRTEL_B2B])

def airtel_b2b_markup(amount: float) -> int:
    return _bracket(amount, [(u, v[1]) for u, v in _AIRTEL_B2B])


# ── PesaLink / Bank ───────────────────────────────────────────────────────────
_PESALINK = [
    (100,   (0,  15, 15)),
    (1000,  (0,  15, 15)),
    (float("inf"), (15, 10, 25)),
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


# ── Buy-order payout charge (shared by admin revenue view + merchant profit card) ──────
# M-Pesa caps a single transaction at KES 250,000 — above that a payout must use Pesalink.
MPESA_TX_CAP = 250000

def infer_payout_channel(amount: float, method: str = "auto") -> str:
    """Infer the payout rail for a buy-order payout when the actual rail wasn't recorded.
      method='auto'     -> M-Pesa up to the per-transaction cap, Pesalink above
      method='mpesa'    -> assume every payout via M-Pesa
      method='pesalink' -> assume every payout via Pesalink
    """
    if method == "mpesa":
        return "MPESA"
    if method == "pesalink":
        return "PESALINK"
    return "MPESA" if float(amount or 0) <= MPESA_TX_CAP else "PESALINK"

def order_outbound_charge(amount: float, method: str = "auto") -> int:
    """Total outbound fee charged to the merchant for paying the seller on one buy order
    (Choice Bank's base cost + our markup), with the rail inferred from the amount.

    Single source of truth: the admin "Outbound fees by rail" view and the merchant-side
    "Choice Bank Fees" line both derive their totals from this, so the two always agree.
    """
    return outbound_fee(infer_payout_channel(amount, method), float(amount or 0))


# ── Per-product tariff (revenue breakdown + invoice) ──────────────────────────

PRODUCTS = {
    "B2C":         "M-Pesa B2C",
    "B2B":         "M-Pesa B2B (Paybill/Till)",
    "KRA_PAYBILL": "M-Pesa B2B (KRA Paybill)",
    "PESALINK":    "PesaLink / Bank",
    "AIRTEL":      "Airtel Money B2C",
    "AIRTEL_B2B":  "Airtel Money B2B",
    "CASH_KES":    "KES Cash Withdrawal",
    "CASH_USD":    "USD Cash Withdrawal",
}

# KRA shortcode — used to distinguish KRA Paybill from regular B2B Paybill
KRA_SHORTCODE = "572572"

_TXTYPE_CHANNEL = {
    "TTID0001": "M-Pesa",
    "TTID0025": "M-Pesa",
    "TTID0027": "M-Pesa",
    "TTID0005": "M-Pesa Paybill",
    "TTID0006": "M-Pesa Paybill",
    "TTID0024": "Airtel Money",
    "TTID0002": "Bank/PesaLink",
    "TTID0009": "Bank/PesaLink",
    # Cash withdrawals — TTIDs TBD (will update when a real transaction is observed)
    # "TTIDXXXX": "KES Cash Withdrawal",
    # "TTIDYYYY": "USD Cash Withdrawal",
}


def channel_from_txtype(tx_type: str) -> str:
    return _TXTYPE_CHANNEL.get((tx_type or "").upper(), "")


def categorize(transaction_type: str = "", destination_type: str = "", method: str = "") -> str:
    """Map a payment's metadata to a PRODUCTS key.

    destination_type "kra_paybill" is set at initiation time (business_number == KRA_SHORTCODE)
    so it beats the generic paybill check below.
    destination_type "airtel_b2b" is set when the trader pays an Airtel business number.
    """
    s = " ".join(str(x or "").lower() for x in (transaction_type, destination_type, method))
    # Cash withdrawals
    if "kes cash withdrawal" in s or destination_type == "cash_kes":
        return "CASH_KES"
    if "usd cash withdrawal" in s or destination_type == "cash_usd":
        return "CASH_USD"
    # KRA Paybill (must come before generic B2B check)
    if "kra_paybill" in s or destination_type == "kra_paybill":
        return "KRA_PAYBILL"
    # Airtel B2B (must come before generic Airtel check)
    if "airtel_b2b" in s or destination_type == "airtel_b2b":
        return "AIRTEL_B2B"
    # Generic B2B (Paybill / Till / BuyGoods)
    if "paybill" in s or "till" in s or "buygoods" in s or "b2b" in s:
        return "B2B"
    # Airtel B2C
    if "airtel" in s:
        return "AIRTEL"
    # Excluded rails
    if "rtgs" in s or "eft" in s or "swift" in s:
        return "EXCLUDED"
    # M-Pesa B2C (individual send-money)
    if "mpesa" in s or "m-pesa" in s:
        return "B2C"
    return "PESALINK"


def product_markup(product: str, amount: float) -> int:
    p = (product or "").upper()
    if p == "B2C":         return mpesa_markup(amount)
    if p == "B2B":         return mpesa_b2b_markup(amount)
    if p == "KRA_PAYBILL": return kra_paybill_markup(amount)
    if p == "PESALINK":    return pesalink_markup(amount)
    if p == "AIRTEL":      return airtel_markup(amount)
    if p == "AIRTEL_B2B":  return airtel_b2b_markup(amount)
    if p == "CASH_KES":    return 25   # flat KES 25 per KES cash withdrawal
    if p == "CASH_USD":    return 1    # flat KES 1 per USD cash withdrawal
    return 0

def product_cb_fee(product: str, amount: float) -> int:
    """Choice Bank's portion of the fee (their cost, not remitted to us)."""
    p = (product or "").upper()
    if p == "B2C":         return mpesa_cb_fee(amount)
    if p == "B2B":         return mpesa_b2b_cb_fee(amount)
    if p == "KRA_PAYBILL": return kra_paybill_cb_fee(amount)
    if p == "PESALINK":    return pesalink_cb_fee(amount)
    if p == "AIRTEL":      return airtel_cb_fee(amount)
    if p == "AIRTEL_B2B":  return airtel_b2b_cb_fee(amount)
    if p == "CASH_KES":    return 0   # Choice Bank doesn't charge for KES ATM withdrawals
    if p == "CASH_USD":    return 1   # Choice Bank charges KES 1 for USD withdrawals
    return 0

def product_total_fee(product: str, amount: float) -> int:
    return product_cb_fee(product, amount) + product_markup(product, amount)
