"""Add payment confirmation message to C2B handler and sell order processing."""
import re

# Fix 1: mpesa.py — store confirmation message when payment matches
f = "app/api/routes/mpesa.py"
with open(f) as fh:
    content = fh.read()

old = """        if order:
            # Credit the trader's wallet with the sell amount
            await _credit_wallet_for_sell(order, amount, db)
            # Payment matched — trigger auto-release
            await _trigger_auto_release(order, db)"""

new = """        if order:
            # Credit the trader's wallet with the sell amount
            await _credit_wallet_for_sell(order, amount, db)

            # Store confirmation message for the bot to send on Binance chat
            masked_phone = f"0{phone[-9:-4]}***{phone[-2:]}" if len(phone) >= 9 else phone
            order.confirmation_message = (
                f"Payment of KES {amount:,.0f} received from {masked_phone}. "
                f"Receipt: {txn_id}. Releasing your USDT now..."
            )
            await db.commit()

            # Payment matched — trigger auto-release
            await _trigger_auto_release(order, db)"""

content = content.replace(old, new)
with open(f, "w") as fh:
    fh.write(content)
print("mpesa.py updated")

# Fix 2: extension.py — send confirmation message before release
f2 = "app/api/routes/extension.py"
with open(f2) as fh:
    content2 = fh.read()

# When order has PAYMENT_RECEIVED and auto_release, send confirmation chat first
old2 = """    if existing:
        # Already tracked — check if payment was received and needs release
        if existing.status == OrderStatus.PAYMENT_RECEIVED and trader.auto_release_enabled:
            existing.status = OrderStatus.RELEASING
            await db.commit()
            return {"action": "release", "order_number": order_number}
        return None"""

new2 = """    if existing:
        # Already tracked — check if payment was received and needs release
        if existing.status == OrderStatus.PAYMENT_RECEIVED and trader.auto_release_enabled:
            existing.status = OrderStatus.RELEASING
            await db.commit()
            # Send confirmation message first, then release
            confirm_msg = getattr(existing, 'confirmation_message', None) or ''
            return {
                "action": "release",
                "order_number": order_number,
                "confirmation_message": confirm_msg,
            }
        return None"""

content2 = content2.replace(old2, new2)
with open(f2, "w") as fh:
    fh.write(content2)
print("extension.py updated")
