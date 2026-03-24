import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Float, Enum, DateTime, ForeignKey
)
from app.core.database import Base


class TransactionType(str, enum.Enum):
    DEPOSIT = "deposit"               # Trader deposits via M-Pesa STK Push
    SELL_CREDIT = "sell_credit"       # Money in from sell side
    BUY_DEBIT = "buy_debit"          # Money out for buy side
    BUY_RESERVE = "buy_reserve"      # Funds reserved for pending buy order
    BUY_RELEASE = "buy_release"      # Reserved funds released (order cancelled/expired)
    WITHDRAWAL = "withdrawal"         # Trader withdraws
    PLATFORM_FEE = "platform_fee"     # Fee deducted
    SETTLEMENT_FEE = "settlement_fee" # B2C/B2B fee
    ADJUSTMENT = "adjustment"         # Manual adjustment by admin


class Wallet(Base):
    __tablename__ = "wallets"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), unique=True, nullable=False, index=True)

    # KES balance
    balance = Column(Float, default=0.0)           # Available to withdraw
    reserved = Column(Float, default=0.0)           # Locked for pending buy orders
    total_earned = Column(Float, default=0.0)       # Lifetime earnings
    total_withdrawn = Column(Float, default=0.0)    # Lifetime withdrawals
    total_fees_paid = Column(Float, default=0.0)    # Lifetime platform fees

    # Daily tracking
    daily_volume = Column(Float, default=0.0)
    daily_trades = Column(Integer, default=0)
    daily_reset_date = Column(String(10), nullable=True)  # YYYY-MM-DD

    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))


class WalletTransaction(Base):
    __tablename__ = "wallet_transactions"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, ForeignKey("traders.id"), nullable=False, index=True)
    wallet_id = Column(Integer, ForeignKey("wallets.id"), nullable=False)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=True)

    transaction_type = Column(Enum(TransactionType), nullable=False)
    amount = Column(Float, nullable=False)  # Positive = credit, negative = debit
    balance_after = Column(Float, nullable=False)
    description = Column(String(255), nullable=True)

    # M-Pesa tracking (for deposits)
    mpesa_checkout_id = Column(String(100), nullable=True, index=True)
    mpesa_receipt = Column(String(50), nullable=True)
    status = Column(String(20), default="completed")  # pending, completed, failed

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
