import asyncio
import logging
import random
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models import Trader, TraderStatus, Order, OrderSide, OrderStatus
from app.services.binance.client import BinanceP2PClient, BinanceSessionExpired
from app.services.settlement.engine import SettlementEngine

logger = logging.getLogger(__name__)


class BinanceOrderPoller:
    """
    Background service that polls Binance P2P for new orders
    and manages the order lifecycle.
    """

    def __init__(self, poll_interval: int = 10):
        self.poll_interval = poll_interval  # seconds
        self.running = False

    async def start(self):
        """Start the polling loop."""
        self.running = True
        logger.info("Binance order poller started")

        while self.running:
            try:
                await self._poll_all_traders()
            except Exception as e:
                logger.error(f"Poller error: {e}")

            # Add random jitter to polling interval (8-15 seconds instead of fixed 10)
            jitter = random.uniform(0.7, 1.5)
            await asyncio.sleep(self.poll_interval * jitter)

    def stop(self):
        """Stop the polling loop."""
        self.running = False
        logger.info("Binance order poller stopped")

    async def _poll_all_traders(self):
        """Poll orders for all active traders."""
        async with async_session() as db:
            result = await db.execute(
                select(Trader).where(
                    Trader.status == TraderStatus.ACTIVE,
                    Trader.binance_connected == True,
                )
            )
            traders = result.scalars().all()

            for trader in traders:
                try:
                    await self._poll_trader(trader, db)
                    # Reset fail counter on success
                    if hasattr(trader, '_poll_failures'):
                        trader._poll_failures = 0
                except BinanceSessionExpired:
                    # Track consecutive failures before disconnecting
                    if not hasattr(trader, '_poll_failures'):
                        trader._poll_failures = 0
                    trader._poll_failures += 1
                    logger.warning(
                        f"Session error for trader {trader.id} ({trader.full_name}). "
                        f"Failure {trader._poll_failures}/5"
                    )
                    # Only disconnect after 5 consecutive failures (50 seconds)
                    if trader._poll_failures >= 5:
                        logger.warning(f"Marking trader {trader.id} as disconnected after 5 failures")
                        trader.binance_connected = False
                        await db.commit()
                except Exception as e:
                    logger.error(f"Error polling trader {trader.id}: {e}")

    async def _poll_trader(self, trader: Trader, db: AsyncSession):
        """Poll both sell and buy orders for a single trader."""
        # Check subscription
        from app.models.subscription import Subscription, SubscriptionStatus
        sub_result = await db.execute(
            select(Subscription).where(
                Subscription.trader_id == trader.id,
                Subscription.status == SubscriptionStatus.ACTIVE,
            ).order_by(Subscription.expires_at.desc())
        )
        sub = sub_result.scalar_one_or_none()
        if not sub or not sub.is_active:
            return  # No active subscription, skip automation

        client = BinanceP2PClient.from_trader(trader)

        # Poll sell orders (buyer pays us)
        sell_orders = await client.get_pending_orders(trade_type="SELL")
        for binance_order in sell_orders:
            await self._process_sell_order(binance_order, trader, client, db)

        # Poll buy orders (we pay seller)
        buy_orders = await client.get_pending_orders(trade_type="BUY")
        for binance_order in buy_orders:
            await self._process_buy_order(binance_order, trader, client, db)

    async def _process_sell_order(
        self, binance_order: dict, trader: Trader, client: BinanceP2PClient, db: AsyncSession
    ):
        """Process a sell-side order from Binance."""
        order_number = binance_order.get("orderNumber", "")

        # Check if we already track this order
        result = await db.execute(
            select(Order).where(Order.binance_order_number == order_number)
        )
        existing = result.scalar_one_or_none()

        if existing:
            return  # Already tracking

        # Create new order
        amount = float(binance_order.get("totalPrice", 0))
        crypto_amount = float(binance_order.get("amount", 0))
        rate = float(binance_order.get("price", 0))
        currency = binance_order.get("asset", "USDT")

        prefix = f"T{trader.id:04d}"
        account_ref = f"P2P-{prefix}-{order_number}"

        order = Order(
            trader_id=trader.id,
            binance_order_number=order_number,
            binance_ad_number=binance_order.get("advNo"),
            side=OrderSide.SELL,
            crypto_amount=crypto_amount,
            crypto_currency=currency,
            fiat_amount=amount,
            exchange_rate=rate,
            account_reference=account_ref,
            counterparty_name=binance_order.get("buyerNickname"),
        )
        db.add(order)
        await db.commit()

        # Send payment instructions via Binance chat
        message = (
            f"Hello! Please pay KES {amount:,.0f} to:\n"
            f"Paybill: {self._get_paybill()}\n"
            f"Account: {account_ref}\n\n"
            f"Your crypto will be released automatically after payment confirmation."
        )
        try:
            await client.send_chat_message(order_number, message)
        except Exception as e:
            logger.warning(f"Failed to send chat message for {order_number}: {e}")

        logger.info(f"New sell order tracked: {order_number} for trader {trader.full_name}")

    async def _process_buy_order(
        self, binance_order: dict, trader: Trader, client: BinanceP2PClient, db: AsyncSession
    ):
        """Process a buy-side order from Binance."""
        order_number = binance_order.get("orderNumber", "")

        # Check if we already track this order
        result = await db.execute(
            select(Order).where(Order.binance_order_number == order_number)
        )
        existing = result.scalar_one_or_none()

        if existing:
            return  # Already tracking

        amount = float(binance_order.get("totalPrice", 0))
        crypto_amount = float(binance_order.get("amount", 0))
        rate = float(binance_order.get("price", 0))
        currency = binance_order.get("asset", "USDT")

        # Extract seller's payment details from order detail
        order_detail = await client.get_order_detail(order_number)
        seller_pay = self._parse_seller_payment(order_detail)

        order = Order(
            trader_id=trader.id,
            binance_order_number=order_number,
            binance_ad_number=binance_order.get("advNo"),
            side=OrderSide.BUY,
            crypto_amount=crypto_amount,
            crypto_currency=currency,
            fiat_amount=amount,
            exchange_rate=rate,
            counterparty_name=binance_order.get("sellerNickname"),
            counterparty_phone=seller_pay.get("phone"),
            seller_payment_method=seller_pay.get("method"),
            seller_payment_destination=seller_pay.get("destination"),
            seller_payment_name=seller_pay.get("name"),
        )
        db.add(order)
        await db.commit()

        # Auto-pay if enabled, within limits, AND trader is on Pro tier
        # Starter tier only gets sell-side automation
        if trader.auto_pay_enabled and amount <= trader.max_single_trade and trader.tier == "pro":
            settlement = SettlementEngine(db)
            success = await settlement.pay_buy_side_seller(order, trader)

            if success:
                # Mark as paid on Binance
                await client.mark_as_paid(order_number)

                # Send chat message
                try:
                    await client.send_chat_message(
                        order_number,
                        f"Payment of KES {amount:,.0f} sent. "
                        f"Please check and release the crypto. Thank you!"
                    )
                except Exception:
                    pass

                logger.info(f"Buy order auto-paid: {order_number}")
            else:
                logger.warning(f"Buy order auto-pay failed: {order_number}")

        logger.info(f"New buy order tracked: {order_number} for trader {trader.full_name}")

    @staticmethod
    def _parse_seller_payment(order_detail: dict) -> dict:
        """
        Parse seller's payment details from Binance order detail.

        Binance payMethods structure:
        payMethods[0].identifier = "MpesaPaybill" | "BankTransfer" | "Mpesa" | ...
        payMethods[0].fields = [
            {fieldName: "Account name", fieldValue: "JOHN DOE"},
            {fieldName: "Account number", fieldValue: "1234567890"},
            {fieldName: "Paybill number", fieldValue: "522522"},
            {fieldName: "Phone number", fieldValue: "0712345678"},
        ]
        """
        result = {
            "method": None,
            "destination": None,
            "name": None,
            "phone": None,
        }

        pay_methods = order_detail.get("payMethods", [])
        if not pay_methods:
            return result

        # Use the selected payment method
        selected_id = order_detail.get("selectedPayId")
        pay_method = None
        for pm in pay_methods:
            if str(pm.get("id")) == str(selected_id):
                pay_method = pm
                break
        if not pay_method:
            pay_method = pay_methods[0]

        identifier = pay_method.get("identifier", "").lower()
        fields = {
            f.get("fieldName", "").lower(): f.get("fieldValue", "")
            for f in pay_method.get("fields", [])
        }

        result["name"] = fields.get("account name", "")

        if "mpesapaybill" in identifier or "paybill" in identifier:
            # M-Pesa Paybill → B2B
            paybill = fields.get("paybill number", "")
            account = fields.get("account number", "")
            result["method"] = "bank"  # B2B to bank paybill
            result["destination"] = f"{paybill}:{account}"

        elif "mpesa" in identifier:
            # Personal M-Pesa → B2C
            phone = fields.get("phone number", "") or fields.get("mobile number", "")
            result["method"] = "mpesa"
            result["destination"] = phone
            result["phone"] = phone

        elif "bank" in identifier:
            # Bank Transfer → B2B
            bank = fields.get("bank name", "")
            account = fields.get("account number", "")
            # Map common Kenya banks to paybills
            bank_paybills = {
                "kcb": "522522", "equity": "247247", "cooperative": "400200",
                "co-op": "400200", "i&m": "542542", "stanbic": "600100",
                "ncba": "880100", "absa": "303030", "family": "222111",
                "dtb": "516600", "standard chartered": "329329",
            }
            paybill = ""
            for name, pb in bank_paybills.items():
                if name in bank.lower():
                    paybill = pb
                    break
            result["method"] = "bank"
            result["destination"] = f"{paybill}:{account}" if paybill else account

        else:
            # Unknown — log for review
            result["method"] = identifier
            result["destination"] = str(fields)

        return result

    @staticmethod
    def _get_paybill() -> str:
        from app.core.config import settings
        return settings.MPESA_SHORTCODE


# Singleton
order_poller = BinanceOrderPoller()
