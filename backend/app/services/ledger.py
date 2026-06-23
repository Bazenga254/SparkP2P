"""Activity ledger helper — record a money event for the admin/user "Recent Activity" feed.

Used for movements that are NOT P2P-trading-wallet changes (subscription Paybill deposits, Choice
Bank send-money / Paybill / withdrawals). It writes a WalletTransaction row for display only and
does NOT modify the trading wallet's balance, so wallet accounting stays correct. The caller commits.
"""
import logging

from sqlalchemy import select

from app.models.wallet import Wallet, WalletTransaction, TransactionType

logger = logging.getLogger(__name__)


async def record_activity(db, trader_id: int, tx_type: TransactionType, amount: float,
                          description: str, balance_after: float = 0.0,
                          status: str = "completed", mpesa_receipt: str = "") -> None:
    """Append a display-only ledger row. amount sign sets direction (+ inbound / - outbound).
    balance_after is meaningful for subscription deposits (the running balance); pass 0 for Choice
    movements where the live bank balance isn't known here."""
    try:
        wallet = (await db.execute(select(Wallet).where(Wallet.trader_id == trader_id))).scalar_one_or_none()
        if not wallet:
            wallet = Wallet(trader_id=trader_id)
            db.add(wallet)
            await db.flush()
        db.add(WalletTransaction(
            trader_id=trader_id,
            wallet_id=wallet.id,
            transaction_type=tx_type,
            amount=float(amount),
            balance_after=float(balance_after),
            description=description,
            status=status,
            mpesa_receipt=mpesa_receipt or None,
        ))
    except Exception as e:
        logger.warning(f"[Ledger] failed to record {tx_type} for trader {trader_id}: {e}")
