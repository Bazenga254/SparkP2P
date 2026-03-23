import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Order, OrderStatus, Trader, Payment, PaymentDirection, PaymentStatus,
    SettlementMethod,
)
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.core.config import settings
from app.services.mpesa.client import mpesa_client

logger = logging.getLogger(__name__)


# B2C fee schedule (approximate)
B2C_FEES = [
    (100, 0),
    (1500, 15),
    (5000, 23),
    (10000, 25),
    (15000, 27),
    (25000, 30),
    (50000, 35),
    (150000, 40),
]

B2B_FEE = 50  # Approximate flat fee for B2B
PLATFORM_SETTLEMENT_MARKUP = 25  # KES 25 markup on every withdrawal (our profit)


def estimate_b2c_fee(amount: float) -> int:
    """Estimate B2C transaction fee based on amount."""
    for threshold, fee in B2C_FEES:
        if amount <= threshold:
            return fee
    return 40


def get_total_settlement_fee(trader, amount: float) -> tuple:
    """Calculate total settlement fee: Safaricom fee + platform markup.
    Returns (safaricom_fee, platform_markup, total_fee)
    """
    if trader.settlement_method == SettlementMethod.MPESA:
        safaricom_fee = estimate_b2c_fee(amount)
    else:
        safaricom_fee = B2B_FEE
    return safaricom_fee, PLATFORM_SETTLEMENT_MARKUP, safaricom_fee + PLATFORM_SETTLEMENT_MARKUP


class SettlementEngine:
    """Handles settling funds to traders via B2C or B2B."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def settle_order(self, order: Order) -> bool:
        """Settle a single completed order to the trader."""
        trader = await self._get_trader(order.trader_id)
        if not trader:
            logger.error(f"Trader {order.trader_id} not found for order {order.id}")
            return False

        # Calculate settlement amount
        platform_fee = self._get_platform_fee(trader)
        settlement_fee = self._estimate_settlement_fee(trader, order.fiat_amount)
        net_amount = order.fiat_amount - platform_fee - settlement_fee

        if net_amount <= 0:
            logger.error(f"Net amount <= 0 for order {order.id}")
            return False

        # Deduct fees from wallet
        await self._deduct_fees(trader.id, platform_fee, settlement_fee, order.id)

        # Send payment
        success = await self._send_payment(trader, net_amount, order)

        if success:
            order.status = OrderStatus.COMPLETED
            order.settled_at = datetime.now(timezone.utc)
            order.platform_fee = platform_fee
            order.settlement_fee = settlement_fee

            # Update trader stats
            trader.total_trades += 1
            trader.total_volume += order.fiat_amount

            await self.db.commit()
            logger.info(
                f"Order {order.binance_order_number} settled: "
                f"KES {net_amount} to {trader.full_name}"
            )
        return success

    async def batch_settle(self, trader_id: int, simulate: bool = False) -> bool:
        """Settle accumulated balance to trader in one transaction.

        Fee breakdown:
        - Safaricom fee (B2C ~KES 25 or B2B ~KES 50) — goes to Safaricom
        - Platform markup (KES 25) — our profit per withdrawal
        - Total deducted from trader = safaricom_fee + platform_markup
        """
        trader = await self._get_trader(trader_id)
        if not trader:
            return False

        wallet = await self._get_wallet(trader_id)
        if not wallet or wallet.balance <= 0:
            return False

        # Check threshold — don't withdraw below trader's configured threshold
        if trader.batch_threshold and wallet.balance < trader.batch_threshold:
            logger.info(
                f"Trader {trader.id} balance KES {wallet.balance} below threshold "
                f"KES {trader.batch_threshold} — skipping withdrawal"
            )
            return False

        amount = wallet.balance
        safaricom_fee, platform_markup, total_fee = get_total_settlement_fee(trader, amount)
        net_amount = amount - total_fee

        if net_amount <= 0:
            return False

        success = await self._send_payment(trader, net_amount, simulate=simulate)

        if success:
            # Deduct full amount from wallet
            wallet.balance -= amount
            wallet.total_withdrawn += net_amount
            wallet.total_fees_paid += total_fee

            # Record withdrawal
            txn = WalletTransaction(
                trader_id=trader_id,
                wallet_id=wallet.id,
                transaction_type=TransactionType.WITHDRAWAL,
                amount=-net_amount,
                balance_after=wallet.balance,
                description=f"Withdrawal: KES {net_amount} to {trader.settlement_method.value}",
            )
            self.db.add(txn)

            # Record Safaricom fee
            self.db.add(WalletTransaction(
                trader_id=trader_id,
                wallet_id=wallet.id,
                transaction_type=TransactionType.SETTLEMENT_FEE,
                amount=-safaricom_fee,
                balance_after=wallet.balance,
                description=f"Safaricom fee: KES {safaricom_fee}",
            ))

            # Record platform markup (our revenue)
            self.db.add(WalletTransaction(
                trader_id=trader_id,
                wallet_id=wallet.id,
                transaction_type=TransactionType.PLATFORM_FEE,
                amount=-platform_markup,
                balance_after=wallet.balance,
                description=f"Service fee: KES {platform_markup}",
            ))

            await self.db.commit()
            logger.info(
                f"Settled KES {net_amount} to {trader.full_name} "
                f"(safaricom: {safaricom_fee}, markup: {platform_markup})"
            )

        return success

    async def auto_settle_if_threshold(self, trader_id: int) -> bool:
        """Auto-settle if trader's balance exceeds their threshold.
        Called after each trade completes.
        """
        trader = await self._get_trader(trader_id)
        if not trader or not trader.batch_settlement_enabled:
            return False

        wallet = await self._get_wallet(trader_id)
        if not wallet:
            return False

        threshold = trader.batch_threshold or 50000  # Default KES 50,000
        if wallet.balance >= threshold:
            logger.info(
                f"Trader {trader.id} balance KES {wallet.balance} >= threshold "
                f"KES {threshold} — auto-settling"
            )
            return await self.batch_settle(trader_id)

        return False

    async def _send_payment(
        self, trader: Trader, amount: float, order: Optional[Order] = None,
        simulate: bool = False,
    ) -> bool:
        """Send payment to trader via their preferred settlement method."""
        try:
            remarks = f"Payment from {trader.full_name}"
            occasion = f"AutoP2P Settlement"
            if order:
                occasion = f"Order {order.binance_order_number}"

            # Simulation mode for testing
            if simulate:
                logger.info(
                    f"[SIMULATED] Settlement: KES {amount} to {trader.full_name} "
                    f"via {trader.settlement_method.value}"
                )
                result = {"simulated": True, "amount": amount}
                # Save payment record and return
                payment = Payment(
                    order_id=order.id if order else None,
                    trader_id=trader.id,
                    direction=PaymentDirection.OUTBOUND,
                    transaction_type=trader.settlement_method.value,
                    amount=amount,
                    destination=trader.settlement_phone or trader.settlement_paybill,
                    destination_type=trader.settlement_method.value,
                    remarks=remarks,
                    status=PaymentStatus.COMPLETED,
                    raw_callback=result,
                )
                self.db.add(payment)
                return True

            if trader.settlement_method == SettlementMethod.MPESA:
                # B2C to trader's M-Pesa
                result = await mpesa_client.send_b2c(
                    phone=trader.settlement_phone,
                    amount=amount,
                    remarks=remarks,
                    occasion=occasion,
                )

            elif trader.settlement_method == SettlementMethod.BANK_PAYBILL:
                # B2B to bank Paybill (KCB 522522, Equity 247247, etc.)
                result = await mpesa_client.send_b2b(
                    receiver_shortcode=trader.settlement_paybill,
                    amount=amount,
                    account_number=trader.settlement_account,
                    remarks=remarks,
                    command_id="BusinessPayBill",
                )

            elif trader.settlement_method == SettlementMethod.TILL:
                # B2B to Till (Buy Goods)
                result = await mpesa_client.send_b2b(
                    receiver_shortcode=trader.settlement_paybill,
                    amount=amount,
                    remarks=remarks,
                    command_id="BusinessBuyGoods",
                )

            elif trader.settlement_method == SettlementMethod.PAYBILL:
                # B2B to trader's own Paybill
                result = await mpesa_client.send_b2b(
                    receiver_shortcode=trader.settlement_paybill,
                    amount=amount,
                    account_number=trader.settlement_account,
                    remarks=remarks,
                    command_id="BusinessPayBill",
                )

            else:
                logger.error(f"Unknown settlement method: {trader.settlement_method}")
                return False

            # Save outbound payment record
            payment = Payment(
                order_id=order.id if order else None,
                trader_id=trader.id,
                direction=PaymentDirection.OUTBOUND,
                transaction_type=trader.settlement_method.value,
                amount=amount,
                destination=trader.settlement_phone or trader.settlement_paybill,
                destination_type=trader.settlement_method.value,
                remarks=remarks,
                status=PaymentStatus.COMPLETED,
                raw_callback=result,
            )
            self.db.add(payment)
            return True

        except Exception as e:
            logger.error(f"Settlement failed for trader {trader.id}: {e}")
            return False

    async def pay_buy_side_seller(
        self, order: Order, trader: Trader
    ) -> bool:
        """Pay the seller on the buy side (merchant is buying USDT)."""
        if not order.seller_payment_destination:
            logger.error(f"No seller payment details for order {order.id}")
            return False

        amount = order.fiat_amount
        remarks = f"Payment from {trader.full_name}"

        try:
            if order.seller_payment_method == "mpesa":
                result = await mpesa_client.send_b2c(
                    phone=order.seller_payment_destination,
                    amount=amount,
                    remarks=remarks,
                    occasion=f"P2P Order {order.binance_order_number}",
                )
            elif order.seller_payment_method == "bank":
                # Parse paybill and account from destination
                parts = order.seller_payment_destination.split(":")
                paybill = parts[0]
                account = parts[1] if len(parts) > 1 else ""
                result = await mpesa_client.send_b2b(
                    receiver_shortcode=paybill,
                    amount=amount,
                    account_number=account,
                    remarks=remarks,
                )
            else:
                logger.error(f"Unknown seller payment method: {order.seller_payment_method}")
                return False

            # Deduct from trader wallet
            wallet = await self._get_wallet(trader.id)
            if wallet:
                wallet.balance -= amount
                wallet.reserved -= amount

                txn = WalletTransaction(
                    trader_id=trader.id,
                    wallet_id=wallet.id,
                    order_id=order.id,
                    transaction_type=TransactionType.BUY_DEBIT,
                    amount=-amount,
                    balance_after=wallet.balance,
                    description=f"Buy side payment for order {order.binance_order_number}",
                )
                self.db.add(txn)

            order.status = OrderStatus.PAYMENT_SENT
            order.payment_sent_at = datetime.now(timezone.utc)

            payment = Payment(
                order_id=order.id,
                trader_id=trader.id,
                direction=PaymentDirection.OUTBOUND,
                transaction_type="B2C",
                amount=amount,
                destination=order.seller_payment_destination,
                destination_type=order.seller_payment_method,
                remarks=remarks,
                status=PaymentStatus.COMPLETED,
                raw_callback=result,
            )
            self.db.add(payment)
            await self.db.commit()

            logger.info(
                f"Buy side payment sent: KES {amount} to {order.seller_payment_destination} "
                f"for order {order.binance_order_number}"
            )
            return True

        except Exception as e:
            logger.error(f"Buy side payment failed for order {order.id}: {e}")
            return False

    def _get_platform_fee(self, trader: Trader) -> float:
        """Get platform fee based on trader tier.
        Monthly subscription model:
        - starter (KES 5,000/mo): sell-side only, no per-trade fee
        - pro (KES 10,000/mo): buy + sell, no per-trade fee
        Per-trade fees are 0 for subscribed users.
        """
        if trader.tier in ("starter", "pro"):
            return 0
        # Unsubscribed/default users pay per-trade fee
        return settings.PLATFORM_FEE_PER_TRADE

    def _estimate_settlement_fee(self, trader: Trader, amount: float) -> float:
        """Estimate total settlement fee (Safaricom + platform markup)."""
        _, _, total = get_total_settlement_fee(trader, amount)
        return total

    async def _get_trader(self, trader_id: int) -> Optional[Trader]:
        result = await self.db.execute(
            select(Trader).where(Trader.id == trader_id)
        )
        return result.scalar_one_or_none()

    async def _get_wallet(self, trader_id: int) -> Optional[Wallet]:
        result = await self.db.execute(
            select(Wallet).where(Wallet.trader_id == trader_id)
        )
        return result.scalar_one_or_none()

    async def _deduct_fees(
        self, trader_id: int, platform_fee: float, settlement_fee: float, order_id: int
    ):
        """Deduct platform and settlement fees from wallet."""
        wallet = await self._get_wallet(trader_id)
        if not wallet:
            return

        if platform_fee > 0:
            wallet.balance -= platform_fee
            wallet.total_fees_paid += platform_fee
            self.db.add(WalletTransaction(
                trader_id=trader_id,
                wallet_id=wallet.id,
                order_id=order_id,
                transaction_type=TransactionType.PLATFORM_FEE,
                amount=-platform_fee,
                balance_after=wallet.balance,
                description=f"Platform fee: KES {platform_fee}",
            ))
