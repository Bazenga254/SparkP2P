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
    """Fee for an outbound transfer. channel: 'MPESA' -> M-Pesa B2C; anything else -> PesaLink."""
    if (channel or "").upper() == "MPESA":
        return mpesa_outbound_fee(amount)
    return pesalink_outbound_fee(amount)
