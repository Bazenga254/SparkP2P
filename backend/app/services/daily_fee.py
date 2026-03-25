"""
Daily Volume Fee Service

Calculates and deducts 0.05% of each trader's daily trading volume.
Run at midnight via the housekeeping poller.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, OrderStatus, Trader, TraderStatus
from app.models.wallet import Wallet, WalletTransaction, TransactionType

logger = logging.getLogger(__name__)

DAILY_FEE_RATE = 0.0005  # 0.05%


async def calculate_and_deduct_daily_fees(db: AsyncSession):
    """Run at midnight. For each active trader:
    1. Sum all completed order volumes for today (buy + sell fiat_amount)
    2. Calculate 0.05% fee
    3. Deduct from wallet
    4. Record as wallet transaction (type: DAILY_VOLUME_FEE)
    5. Send SMS notification
    """
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    # Get all completed orders today, grouped by trader
    result = await db.execute(
        select(
            Order.trader_id,
            func.sum(Order.fiat_amount).label("total_volume"),
        )
        .where(
            Order.created_at >= today_start,
            Order.status.in_([
                OrderStatus.COMPLETED,
                OrderStatus.RELEASED,
                OrderStatus.SETTLING,
                OrderStatus.PAYMENT_RECEIVED,
                OrderStatus.PAYMENT_SENT,
            ]),
        )
        .group_by(Order.trader_id)
    )
    trader_volumes = result.all()

    if not trader_volumes:
        logger.info("Daily fee: No trading volume today, nothing to deduct")
        return

    deducted_count = 0
    total_fees_collected = 0.0

    for trader_id, total_volume in trader_volumes:
        total_volume = float(total_volume or 0)
        if total_volume <= 0:
            continue

        fee = round(total_volume * DAILY_FEE_RATE, 2)
        if fee < 1:
            # Skip trivially small fees (less than KES 1)
            continue

        # Get wallet
        wallet_result = await db.execute(
            select(Wallet).where(Wallet.trader_id == trader_id)
        )
        wallet = wallet_result.scalar_one_or_none()
        if not wallet:
            logger.warning(f"Daily fee: No wallet for trader {trader_id}, skipping")
            continue

        # Deduct fee (deduct what's available if insufficient)
        actual_fee = fee
        deficit = 0.0
        if wallet.balance < fee:
            actual_fee = max(wallet.balance, 0)
            deficit = fee - actual_fee
            logger.warning(
                f"Daily fee: Trader {trader_id} insufficient balance. "
                f"Fee={fee}, Balance={wallet.balance}, Deducting={actual_fee}, Deficit={deficit}"
            )

        if actual_fee > 0:
            wallet.balance -= actual_fee
            wallet.total_fees_paid += actual_fee

            # Record transaction
            txn = WalletTransaction(
                trader_id=trader_id,
                wallet_id=wallet.id,
                transaction_type=TransactionType.DAILY_VOLUME_FEE,
                amount=-actual_fee,
                balance_after=wallet.balance,
                description=(
                    f"Daily volume fee (0.05%): Volume KES {total_volume:,.0f}, "
                    f"Fee KES {fee:,.0f}"
                    + (f", Deficit KES {deficit:,.0f}" if deficit > 0 else "")
                ),
            )
            db.add(txn)
            deducted_count += 1
            total_fees_collected += actual_fee

        # Send SMS notification
        try:
            trader_result = await db.execute(
                select(Trader).where(Trader.id == trader_id)
            )
            trader = trader_result.scalar_one_or_none()
            if trader and trader.phone:
                from app.services.sms import send_sms
                msg = (
                    f"SparkP2P: Daily platform fee of KES {actual_fee:,.0f} deducted. "
                    f"Volume: KES {total_volume:,.0f}. "
                    f"Balance: KES {wallet.balance:,.0f}"
                )
                if deficit > 0:
                    msg += f". Outstanding: KES {deficit:,.0f}"
                send_sms(trader.phone, msg)
        except Exception as e:
            logger.error(f"Daily fee SMS failed for trader {trader_id}: {e}")

    await db.commit()
    logger.info(
        f"Daily fee: Deducted from {deducted_count} traders, "
        f"Total collected: KES {total_fees_collected:,.0f}"
    )
