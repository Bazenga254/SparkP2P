import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, OrderStatus, OrderSide, Trader, Payment, PaymentDirection, PaymentStatus
from app.models.wallet import Wallet, WalletTransaction, TransactionType

logger = logging.getLogger(__name__)


class MatchingEngine:
    """Matches incoming M-Pesa payments to Binance P2P orders."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def match_c2b_payment(
        self,
        amount: float,
        bill_ref_number: str,
        phone: str,
        sender_name: str,
        mpesa_transaction_id: str,
        raw_callback: dict,
    ) -> Optional[Order]:
        """
        Match an incoming C2B payment to a pending sell-side order.

        Matching strategy:
        1. Primary: Account reference (P2P-{trader_prefix}-{order_id})
        2. Fallback: Unique amount matching
        """
        # Parse account reference: P2P-T001-98765
        order = None
        trader = None

        if bill_ref_number and bill_ref_number.startswith("P2P-"):
            order = await self._match_by_reference(bill_ref_number)

        if not order:
            order = await self._match_by_amount(amount)

        if not order:
            logger.warning(
                f"No matching order for payment: amount={amount}, "
                f"ref={bill_ref_number}, phone={phone}, txn={mpesa_transaction_id}"
            )
            # Save as unmatched payment for manual review
            await self._save_unmatched_payment(
                amount, bill_ref_number, phone, sender_name,
                mpesa_transaction_id, raw_callback
            )
            return None

        # Get trader
        result = await self.db.execute(
            select(Trader).where(Trader.id == order.trader_id)
        )
        trader = result.scalar_one_or_none()

        # Verify amount matches (within KES 5 tolerance for rounding)
        if abs(order.fiat_amount - amount) > 5:
            logger.warning(
                f"Amount mismatch: expected {order.fiat_amount}, got {amount} "
                f"for order {order.binance_order_number}"
            )
            order.status = OrderStatus.DISPUTED
            await self.db.commit()
            return None

        # Save the payment record
        payment = Payment(
            order_id=order.id,
            trader_id=order.trader_id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=mpesa_transaction_id,
            transaction_type="C2B",
            amount=amount,
            phone=phone,
            bill_ref_number=bill_ref_number,
            sender_name=sender_name,
            status=PaymentStatus.COMPLETED,
            raw_callback=raw_callback,
        )
        self.db.add(payment)

        # Update order status
        order.status = OrderStatus.PAYMENT_RECEIVED
        order.payment_confirmed_at = datetime.now(timezone.utc)
        order.counterparty_phone = phone
        order.counterparty_name = sender_name

        # Credit trader's wallet
        await self._credit_wallet(order.trader_id, amount, order.id)

        await self.db.commit()

        logger.info(
            f"Payment matched: {mpesa_transaction_id} → Order {order.binance_order_number} "
            f"(Trader: {trader.full_name if trader else 'unknown'})"
        )
        return order

    async def _match_by_reference(self, reference: str) -> Optional[Order]:
        """Match by account reference (P2P-T001-98765)."""
        result = await self.db.execute(
            select(Order).where(
                Order.account_reference == reference,
                Order.side == OrderSide.SELL,
                Order.status == OrderStatus.PENDING,
            )
        )
        return result.scalar_one_or_none()

    async def _match_by_amount(self, amount: float) -> Optional[Order]:
        """Fallback: match by unique amount (within KES 1 tolerance)."""
        result = await self.db.execute(
            select(Order).where(
                Order.side == OrderSide.SELL,
                Order.status == OrderStatus.PENDING,
                Order.unique_amount.isnot(None),
                Order.unique_amount.between(amount - 1, amount + 1),
            )
        )
        orders = result.scalars().all()

        if len(orders) == 1:
            return orders[0]
        elif len(orders) > 1:
            logger.warning(f"Multiple orders match amount {amount} - flagging for review")
            return None
        return None

    async def _credit_wallet(self, trader_id: int, amount: float, order_id: int):
        """Credit trader's wallet balance."""
        result = await self.db.execute(
            select(Wallet).where(Wallet.trader_id == trader_id)
        )
        wallet = result.scalar_one_or_none()

        if not wallet:
            wallet = Wallet(trader_id=trader_id)
            self.db.add(wallet)
            await self.db.flush()

        wallet.balance += amount
        wallet.total_earned += amount
        wallet.daily_volume += amount
        wallet.daily_trades += 1

        # Record transaction
        txn = WalletTransaction(
            trader_id=trader_id,
            wallet_id=wallet.id,
            order_id=order_id,
            transaction_type=TransactionType.SELL_CREDIT,
            amount=amount,
            balance_after=wallet.balance,
            description=f"Payment received for order",
        )
        self.db.add(txn)

    async def _save_unmatched_payment(
        self, amount, ref, phone, name, txn_id, raw
    ):
        """Save unmatched payment for manual review."""
        payment = Payment(
            order_id=None,
            trader_id=None,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=txn_id,
            transaction_type="C2B",
            amount=amount,
            phone=phone,
            bill_ref_number=ref,
            sender_name=name,
            status=PaymentStatus.PENDING,
            raw_callback=raw,
        )
        self.db.add(payment)
        await self.db.commit()
