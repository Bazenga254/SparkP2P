"""Internal wallet-to-wallet transfers between SparkP2P traders. Zero fees."""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Trader
from app.models.wallet import Wallet, WalletTransaction, TransactionType

logger = logging.getLogger(__name__)


def _normalize_phone(phone: str) -> str:
    """Normalize a phone number for comparison.
    Strips spaces, dashes, plus signs. Converts 07xx to 2547xx, etc.
    """
    phone = phone.strip().replace(" ", "").replace("-", "").replace("+", "")
    if phone.startswith("0") and len(phone) == 10:
        phone = "254" + phone[1:]
    if not phone.startswith("254") and len(phone) == 9:
        phone = "254" + phone
    return phone


async def find_trader_by_phone(db: AsyncSession, phone: str) -> Trader | None:
    """Find a SparkP2P trader by phone number, trying multiple formats."""
    normalized = _normalize_phone(phone)

    # Try exact match first
    result = await db.execute(
        select(Trader).where(Trader.phone == phone)
    )
    trader = result.scalar_one_or_none()
    if trader:
        return trader

    # Try normalized (254...) format
    result = await db.execute(
        select(Trader).where(Trader.phone == normalized)
    )
    trader = result.scalar_one_or_none()
    if trader:
        return trader

    # Try 0-prefixed format
    if normalized.startswith("254"):
        local = "0" + normalized[3:]
        result = await db.execute(
            select(Trader).where(Trader.phone == local)
        )
        trader = result.scalar_one_or_none()
        if trader:
            return trader

    # Try +254 format
    result = await db.execute(
        select(Trader).where(Trader.phone == "+" + normalized)
    )
    trader = result.scalar_one_or_none()
    return trader


async def transfer_between_wallets(
    db: AsyncSession,
    from_trader_id: int,
    to_trader_id: int,
    amount: float,
    description: str = "",
    order_id: int = None,
) -> bool:
    """Transfer funds from one trader's wallet to another. FREE - no Safaricom fees.

    Returns True on success, raises Exception on failure.
    """
    if from_trader_id == to_trader_id:
        raise ValueError("Cannot transfer to yourself")

    if amount <= 0:
        raise ValueError("Transfer amount must be positive")

    # Get sender wallet
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == from_trader_id)
    )
    sender_wallet = result.scalar_one_or_none()

    if not sender_wallet:
        raise ValueError("Sender wallet not found")

    if sender_wallet.balance < amount:
        raise ValueError(
            f"Insufficient balance. Have KES {sender_wallet.balance:,.0f}, need KES {amount:,.0f}"
        )

    # Get receiver wallet (create if it doesn't exist)
    result = await db.execute(
        select(Wallet).where(Wallet.trader_id == to_trader_id)
    )
    receiver_wallet = result.scalar_one_or_none()

    if not receiver_wallet:
        receiver_wallet = Wallet(trader_id=to_trader_id)
        db.add(receiver_wallet)
        await db.flush()

    # Get trader names for description
    sender_result = await db.execute(
        select(Trader).where(Trader.id == from_trader_id)
    )
    sender = sender_result.scalar_one_or_none()

    receiver_result = await db.execute(
        select(Trader).where(Trader.id == to_trader_id)
    )
    receiver = receiver_result.scalar_one_or_none()

    sender_name = sender.full_name if sender else f"Trader #{from_trader_id}"
    receiver_name = receiver.full_name if receiver else f"Trader #{to_trader_id}"

    # Debit sender
    sender_wallet.balance -= amount
    out_desc = description or f"Internal transfer to {receiver_name}"

    sender_txn = WalletTransaction(
        trader_id=from_trader_id,
        wallet_id=sender_wallet.id,
        order_id=order_id,
        transaction_type=TransactionType.INTERNAL_TRANSFER_OUT,
        amount=-amount,
        balance_after=sender_wallet.balance,
        description=out_desc,
        status="completed",
    )
    db.add(sender_txn)

    # Credit receiver
    receiver_wallet.balance += amount
    receiver_wallet.total_earned += amount
    in_desc = description or f"Internal transfer from {sender_name}"

    receiver_txn = WalletTransaction(
        trader_id=to_trader_id,
        wallet_id=receiver_wallet.id,
        order_id=order_id,
        transaction_type=TransactionType.INTERNAL_TRANSFER_IN,
        amount=amount,
        balance_after=receiver_wallet.balance,
        description=in_desc,
        status="completed",
    )
    db.add(receiver_txn)

    await db.flush()

    logger.info(
        f"Internal transfer: KES {amount:,.0f} from {sender_name} (#{from_trader_id}) "
        f"to {receiver_name} (#{to_trader_id}) - FREE, no fees"
    )

    # Send email notifications
    try:
        from app.services.email import send_internal_transfer_sent, send_internal_transfer_received
        if sender:
            send_internal_transfer_sent(
                sender.email, sender_name, amount, receiver_name, sender_wallet.balance
            )
        if receiver:
            send_internal_transfer_received(
                receiver.email, receiver_name, amount, sender_name, receiver_wallet.balance
            )
    except Exception as e:
        logger.warning(f"Failed to send internal transfer email notifications: {e}")

    return True
