import asyncio
import hashlib
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Request, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_trader
from app.core.config import settings
from app.core.database import async_session, get_db
from app.models import Order, OrderStatus, OrderSide, Payment, PaymentDirection, PaymentStatus
from app.models.trader import Trader
from app.models.wallet import Wallet, WalletTransaction, TransactionType
from app.services.choice_bank import client as choice

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Signature verification (shared with client.py logic) ─────────────────────

def _flatten(obj, path="", pairs=None):
    if pairs is None:
        pairs = []
    if isinstance(obj, dict):
        if not obj and path:
            pairs.append((path, "{}"))
            return pairs
        for k, v in obj.items():
            child = f"{path}.{k}" if path else k
            _flatten(v, child, pairs)
    elif isinstance(obj, list):
        if not obj and path:
            pairs.append((path, "[]"))
            return pairs
        for i, v in enumerate(obj):
            _flatten(v, f"{path}[{i}]", pairs)
    else:
        pairs.append((path, "" if obj is None else str(obj)))
    return pairs


def _verify_signature(payload: dict, private_key: str) -> bool:
    try:
        original_sig = payload.get("signature", "")
        obj = {k: v for k, v in payload.items() if k != "signature"}
        obj["senderKey"] = private_key
        pairs = _flatten(obj)
        pairs.sort(key=lambda x: x[0])
        flat = "&".join(f"{k}={v}" for k, v in pairs)
        computed = hashlib.sha256(flat.encode()).hexdigest()
        return computed.lower() == original_sig.lower()
    except Exception as e:
        logger.warning(f"[ChoiceBank] Signature verification error: {e}")
        return False


# ── Webhook (Choice Bank → SparkP2P) ─────────────────────────────────────────

@router.post("/webhook/choice")
async def choice_bank_webhook(request: Request):
    """
    Receive Choice Bank BaaS callback notifications.

    Callback envelope:
      notificationType  — at top level (not inside params)
      params            — transaction data

    Callback 0002 (Transaction Result): fires when a transaction occurs on any sub-account.
    Callback 0003 (Balance Change): fires after every balance update.

    We use 0002 as the primary trigger for SELL order release.
    """
    try:
        payload = await request.json()
    except Exception:
        logger.warning("[ChoiceBank] Non-JSON webhook body received")
        return {"code": "00000", "msg": "OK"}

    logger.info(f"[ChoiceBank] Webhook: type={payload.get('notificationType')} | {payload}")

    # Signature verification disabled: CHOICE_BANK_SENDER_KEY is our outbound signing key,
    # not Choice Bank's callback signing key. Their callbacks use a different key we don't
    # have yet. Re-enable once Choice Bank provides their callback verification key.
    # private_key = settings.CHOICE_BANK_SENDER_KEY
    # if private_key and not _verify_signature(payload, private_key):
    #     logger.warning("[ChoiceBank] Invalid signature — ignoring")
    #     return {"code": "00000", "msg": "OK"}

    # notificationType is at the TOP LEVEL of the envelope
    notification_type = str(payload.get("notificationType") or "")
    params = payload.get("params") or {}

    try:
        if notification_type == "0002":
            await _handle_transaction_result(params, payload)
        elif notification_type == "0003":
            await _handle_transaction_result(params, payload)
        elif notification_type == "0004":
            await _handle_bulk_transfer_result(params, payload)
        elif notification_type == "0015":
            _handle_statement_ready(params, payload)
        else:
            logger.info(f"[ChoiceBank] Unhandled notification type {notification_type!r}")
    except Exception as exc:
        # Always return 200 to Choice Bank — a 500 causes retries and eventual URL blacklisting.
        logger.error(f"[ChoiceBank] Webhook error (type={notification_type}): {exc}", exc_info=True)

    return {"code": "00000", "msg": "Processed successfully"}


def _handle_statement_ready(params: dict, raw: dict):
    """Callback 0015 — Account Statement Ready.

    Choice fires this when a statement job finishes, carrying the jobId and the
    download URL. We cache it so the merchant's status poll returns instantly.
    Field names aren't fully pinned in the docs, so read the URL/jobId from every
    plausible key rather than assuming one.
    """
    from app.services.choice_bank import statement_store
    job_id = (params.get("jobId") or params.get("jobID") or raw.get("jobId") or "")
    url = (params.get("statementUrl") or params.get("statementURL") or
           params.get("url") or params.get("fileUrl") or params.get("downloadUrl") or "")
    if job_id and url:
        statement_store.set_url(str(job_id), str(url))
        logger.info(f"[ChoiceBank] 0015: statement ready for job {job_id}")
    else:
        logger.warning(f"[ChoiceBank] 0015 with no jobId/url — params={params}")


async def _handle_transaction_result(params: dict, raw: dict):
    """
    Callback 0002 — Transaction Result.
    Fires for every transaction (inbound and outbound) on any sub-account.
    We only act on successful inbound credits to a trader's account.
    """
    tx_id        = params.get("txId") or ""
    external_ref = (params.get("extInfo") or {}).get("externalTxId") or params.get("externalTxId") or ""
    account_id  = params.get("accountId") or ""
    tx_status   = params.get("txStatus") or ""
    tx_type     = params.get("txType") or ""       # distinguishes credit vs debit
    try:
        amount  = float(params.get("amount") or 0)
    except (TypeError, ValueError):
        amount  = 0.0
    try:
        fee_amount = abs(float(params.get("feeAmount") or params.get("totalFee") or 0))
    except (TypeError, ValueError):
        fee_amount = 0.0
    from app.services.outbound_fees import channel_from_txtype
    _channel = channel_from_txtype(tx_type)   # e.g. "M-Pesa Paybill" -> categorizes as B2B

    sender_name  = (params.get("extInfo") or {}).get("counterpartyName") or \
                   params.get("oppoAccountName") or ""
    sender_phone = (params.get("extInfo") or {}).get("oppoPhoneNumber") or \
                   params.get("oppoAccountId") or ""

    logger.info(
        f"[ChoiceBank] webhook: txId={tx_id}, account={account_id}, "
        f"status={tx_status}, type={tx_type}, KES {amount}"
    )

    # txStatus: -1=Timeout, 1=Pending, 2=Processing, 4=Failed, 8=SUCCESS
    _tx_success = not tx_status or str(tx_status) in ("8", "success", "completed", "00000")
    _tx_failed  = bool(tx_status) and str(tx_status) in ("4", "-1", "failed", "timeout")

    _OUTBOUND_TX_TYPES = {
        "TTID0001", "TTID0002", "TTID0005", "TTID0006",
        "TTID0009", "TTID0024", "TTID0025", "TTID0027",
    }
    if tx_type and tx_type.upper() in _OUTBOUND_TX_TYPES:
        logger.info(f"[ChoiceBank] Outbound tx: txType={tx_type}, status={tx_status}, KES {amount}")
        try:
            async with async_session() as _db:
                _tr = await _db.execute(select(Trader).where(Trader.choice_account_id == account_id))
                _trader = _tr.scalar_one_or_none()
                if _trader:
                    _recipient = sender_name or sender_phone or "Unknown"
                    _existing = (await _db.execute(
                        select(Payment).where(Payment.mpesa_transaction_id == tx_id)
                    )).scalar_one_or_none() if tx_id else None

                    # Idempotency: skip if already processed
                    if _existing and _existing.status in (PaymentStatus.COMPLETED, PaymentStatus.FAILED):
                        logger.info(f"[ChoiceBank] 0002: duplicate webhook for already-settled Payment {_existing.id} ({_existing.status}) — skipping")
                        return

                    _credits_refunded = False
                    if _existing and _existing.status == PaymentStatus.PENDING:
                        if _tx_success:
                            _existing.status = PaymentStatus.COMPLETED
                            if tx_id:
                                _existing.mpesa_receipt_number = tx_id
                            # Capture Choice Bank's ACTUAL fee + the channel (for accurate reconciliation)
                            if fee_amount:
                                _existing.fee = fee_amount
                            if _channel and not _existing.destination_type:
                                _existing.destination_type = _channel
                            await _db.commit()
                            logger.info(f"[ChoiceBank] 0002: Payment {_existing.id} PENDING->COMPLETED, fee={fee_amount}, channel={_channel}")
                        elif _tx_failed:
                            _existing.status = PaymentStatus.FAILED
                            await _db.commit()
                            # Credits retired — no refund needed (withdrawal fee is withheld by Choice Bank).
                            logger.info(f"[ChoiceBank] 0002: Payment {_existing.id} PENDING->FAILED")
                    elif _tx_success:
                        _db.add(Payment(
                            trader_id=_trader.id,
                            direction=PaymentDirection.OUTBOUND,
                            mpesa_transaction_id=tx_id or f"cb_out_{_trader.id}_{amount}",
                            transaction_type="CHOICE_OUTBOUND",
                            destination_type=_channel,
                            amount=amount,
                            fee=fee_amount,
                            phone=sender_phone,
                            destination=sender_phone or sender_name,
                            sender_name=sender_name,
                            remarks=f"Choice Bank outbound - txType {tx_type}",
                            status=PaymentStatus.COMPLETED,
                            raw_callback=raw,
                        ))
                        await _db.commit()
                    elif _tx_failed and tx_id:
                        # No PENDING record — Choice Bank notified us about a failure for a
                        # transaction we have no record of (e.g. direct API call or timing issue).
                        # Just log it; don't create a ghost record that pollutes Unmatched Withdrawals.
                        logger.warning(f"[ChoiceBank] Outbound FAILED with no app record: txId={tx_id}, txType={tx_type}, KES {amount} — logged only")

                    from app.api.routes.telegram import notify_trader
                    if _tx_success:
                        _tg = "ok KES " + f"{amount:,.0f}" + " withdrawal COMPLETED" + chr(10) + "Ref: " + (tx_id or "N/A")
                    elif _tx_failed and _existing:
                        # Only alert on failures that had a known PENDING record
                        _refund_note = " (20 credits refunded)" if _credits_refunded else ""
                        _tg = "fail KES " + f"{amount:,.0f}" + " withdrawal FAILED" + _refund_note + chr(10) + "Ref: " + (tx_id or "N/A")
                    elif _tx_failed:
                        _tg = None
                    else:
                        _tg = None
                    if _tg:
                        await notify_trader(_trader, _tg)
        except Exception as _e:
            logger.warning(f"[ChoiceBank] Outbound notify/save failed: {_e}")
        return

    if not _tx_success:
        logger.info(f"[ChoiceBank] Skipping non-success inbound: status={tx_status}")
        return

    if not account_id or amount <= 0:
        logger.warning("[ChoiceBank] Missing accountId or zero amount — skipping")
        return

    async with async_session() as db:
        # Find trader by their Choice Bank account ID
        trader_result = await db.execute(
            select(Trader).where(Trader.choice_account_id == account_id)
        )
        trader = trader_result.scalar_one_or_none()

        if not trader:
            # Idempotency: don't insert if this tx_id is already recorded
            if tx_id:
                dup = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == tx_id))
                if dup.scalar_one_or_none():
                    logger.info(f"[ChoiceBank] Duplicate webhook (no trader): txId={tx_id} — skipping")
                    return
            logger.warning(f"[ChoiceBank] No trader found for account {account_id} — saving unmatched")
            db.add(Payment(
                direction=PaymentDirection.INBOUND,
                mpesa_transaction_id=tx_id,
                mpesa_receipt_number=external_ref,
                transaction_type="CHOICE_INBOUND",
                amount=amount,
                phone=sender_phone,
                bill_ref_number=account_id,
                sender_name=sender_name,
                status=PaymentStatus.PENDING,
                raw_callback=raw,
            ))
            await db.commit()
            return

        # Idempotency: Choice Bank retries the 0002 webhook several times. If this tx_id is already
        # recorded for the trader, skip — the unique constraint would otherwise throw and the credit
        # was already applied on the first delivery.
        if tx_id:
            existing = (await db.execute(
                select(Payment).where(Payment.mpesa_transaction_id == tx_id)
            )).scalar_one_or_none()
            if existing:
                logger.info(f"[ChoiceBank] 0002 inbound: duplicate webhook txId={tx_id} (Payment {existing.id}) — skipping")
                return

        # Match the inbound payment to the correct pending SELL order BY AMOUNT — not just
        # "most recent". A KES 230,000 payment must go to the 230,000 order, not whatever
        # order happens to be newest (which caused a 230k payment to hit an 88.5k order,
        # get flagged as an overpayment, and be discarded).
        _pend_res = await db.execute(
            select(Order).where(
                Order.trader_id == trader.id,
                Order.side == OrderSide.SELL,
                Order.status == OrderStatus.PENDING,
            ).order_by(Order.created_at.desc())
        )
        _pending = _pend_res.scalars().all()
        # Match by AMOUNT *and* payer NAME (agreed formula). Same amount but a
        # different name means the payment belongs to a DIFFERENT order — never
        # force it onto the wrong one. Unknown Binance name falls back to
        # amount-only (fail-safe). Shared with the active poller.
        from app.services.sell_matching import pick_order
        _recv_map = {}
        for _o in _pending:
            _recv_map[_o.id] = (await db.execute(
                select(func.coalesce(func.sum(Payment.amount), 0)).where(
                    Payment.order_id == _o.id,
                    Payment.direction == PaymentDirection.INBOUND,
                    Payment.status == PaymentStatus.COMPLETED,
                    Payment.transaction_type == "CHOICE_INBOUND",
                )
            )).scalar() or 0
        _mr = pick_order(_pending, amount, sender_name, _recv_map)
        order = _mr.order
        if order:
            logger.info(f"[ChoiceBank] Matched inbound KES {amount:.0f} → order {order.binance_order_number} "
                        f"(order total KES {order.fiat_amount:.0f}) by amount+name [{_mr.verdict}]")

        if not order:
            logger.warning(
                f"[ChoiceBank] No pending SELL order for trader {trader.id} "
                f"({trader.full_name}) — checking for pending deposit or saving as unmatched"
            )
            # Try to match a pending CHOICE_DEPOSIT STK push (same trader, same amount, last 24 h)
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            pending_dep = (await db.execute(
                select(Payment).where(
                    Payment.trader_id == trader.id,
                    Payment.transaction_type == "CHOICE_DEPOSIT",
                    Payment.status == PaymentStatus.PENDING,
                    Payment.amount == amount,
                    Payment.created_at >= cutoff,
                ).order_by(Payment.created_at.desc()).limit(1)
            )).scalar_one_or_none()

            if pending_dep:
                # Mark the pending deposit as completed — no duplicate record needed
                pending_dep.status = PaymentStatus.COMPLETED
                pending_dep.mpesa_transaction_id = tx_id or pending_dep.mpesa_transaction_id
                pending_dep.mpesa_receipt_number = external_ref or pending_dep.mpesa_receipt_number
                pending_dep.sender_name = sender_name or pending_dep.sender_name
                await db.commit()
                logger.info(f"[ChoiceBank] Matched CHOICE_DEPOSIT for trader {trader.id}, amount={amount}")
            else:
                # General inbound (e.g. manual transfer from someone else)
                inbound_pmt = Payment(
                    trader_id=trader.id,
                    direction=PaymentDirection.INBOUND,
                    mpesa_transaction_id=tx_id,
                    mpesa_receipt_number=external_ref,
                    transaction_type="CHOICE_INBOUND",
                    amount=amount,
                    phone=sender_phone,
                    bill_ref_number=account_id,
                    sender_name=sender_name,
                    status=PaymentStatus.COMPLETED,
                    raw_callback=raw,
                )
                db.add(inbound_pmt)
                await db.flush()
                # Auto-credit trader wallet for every unmatched inbound deposit
                wallet_res = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
                wallet = wallet_res.scalar_one_or_none()
                if not wallet:
                    wallet = Wallet(trader_id=trader.id)
                    db.add(wallet)
                    await db.flush()
                wallet.balance      += amount
                wallet.total_earned += amount
                wallet.daily_volume += amount
                db.add(WalletTransaction(
                    trader_id=trader.id,
                    wallet_id=wallet.id,
                    transaction_type=TransactionType.SELL_CREDIT,
                    amount=amount,
                    balance_after=wallet.balance,
                    description=f"Manual deposit via Choice Bank paybill",
                ))
                await db.commit()
            try:
                from app.api.routes.telegram import notify_trader
                _tg_msg = (
                    "💰 KES " + f"{amount:,.0f}" +
                    " received in your Choice Bank" + chr(10) +
                    "From: " + (sender_name or sender_phone or "Unknown") + chr(10) +
                    ("✅ Deposit confirmed!" if pending_dep else "⚠️ No active sell order — saved for review.")
                )
                await notify_trader(trader, _tg_msg)
            except Exception as _e:
                logger.warning(f"[ChoiceBank] Unmatched inbound notify failed: {_e}")
            return

        # Overpayment (more than KES 5 over the order): flag as disputed
        if amount > order.fiat_amount + 5:
            logger.warning(
                f"[ChoiceBank] Overpayment for order {order.binance_order_number}: "
                f"expected KES {order.fiat_amount:.2f}, received KES {amount:.2f}"
            )
            order.status = OrderStatus.DISPUTED
            await db.commit()
            return

        # Idempotency: skip if this tx_id was already recorded
        if tx_id:
            dup_check = await db.execute(select(Payment).where(Payment.mpesa_transaction_id == tx_id))
            if dup_check.scalar_one_or_none():
                logger.info(f"[ChoiceBank] Duplicate webhook for order {order.binance_order_number}: txId={tx_id} — skipping")
                return

        # Save this payment (may be partial or exact)
        is_partial = amount < order.fiat_amount - 5
        db.add(Payment(
            order_id=order.id,
            trader_id=trader.id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=tx_id,
            transaction_type="CHOICE_INBOUND",
            amount=amount,
            phone=sender_phone,
            bill_ref_number=account_id,
            sender_name=sender_name,
            status=PaymentStatus.COMPLETED,
            raw_callback=raw,
        ))
        await db.flush()

        # Sum all inbound Choice Bank payments already recorded for this order
        total_result = await db.execute(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.order_id == order.id,
                Payment.direction == PaymentDirection.INBOUND,
                Payment.status == PaymentStatus.COMPLETED,
                Payment.transaction_type == "CHOICE_INBOUND",
            )
        )
        total_received = float(total_result.scalar() or 0)

        if total_received < order.fiat_amount - 5:
            # Still partial — alert the merchant and wait for the balance (no release yet).
            deficit = order.fiat_amount - total_received
            logger.info(
                f"[ChoiceBank] PARTIAL: {tx_id} → order {order.binance_order_number} "
                f"KES {amount} received, KES {total_received:.2f} total so far "
                f"(need KES {order.fiat_amount:.2f})"
            )
            await db.commit()
            try:
                from app.api.routes.telegram import notify_trader
                _tg = (
                    "⚠️ Underpayment on order " + (order.binance_order_number or "") + chr(10) +
                    "Received KES " + f"{total_received:,.0f}" + " of KES " + f"{order.fiat_amount:,.0f}" +
                    " (short KES " + f"{deficit:,.0f}" + ")." + chr(10) +
                    "Crypto NOT released — waiting for the balance."
                )
                await notify_trader(trader, _tg)
            except Exception as _e:
                logger.warning(f"[ChoiceBank] partial-payment notify failed: {_e}")
            return

        # Full amount reached.
        order.payment_confirmed_at = datetime.now(timezone.utc)
        if sender_phone:
            order.counterparty_phone = sender_phone
        # NOTE: do NOT overwrite counterparty_name with the sender name — the payer name-check
        # below needs the buyer's Binance name. The sender name is stored on the Payment record.

        # ── Payer name verification ────────────────────────────────────────
        # Compare the inbound sender's registered name (full name on M-Pesa/PesaLink inbound
        # payments) against the buyer's Binance legal name (counterparty_real_name, populated
        # by EP-13). Word-overlap match; skipped only when the Binance name isn't known yet
        # (fail-safe — never a false hold).
        _binance_name = (order.counterparty_real_name or "").strip()
        _name_mismatch = False
        if sender_name and _binance_name:
            _sender_words = {w.lower() for w in sender_name.split() if len(w) >= 3}
            _buyer_words  = {w.lower() for w in _binance_name.split() if len(w) >= 3}
            _name_mismatch = len(_sender_words & _buyer_words) == 0

        # On mismatch: HOLD (do not release) and alert the merchant (buttons below).
        # On match: mark received; auto-release happens after the wallet credit + commit.
        order.status = OrderStatus.DISPUTED if _name_mismatch else OrderStatus.PAYMENT_RECEIVED

        # Credit wallet
        wallet_result = await db.execute(select(Wallet).where(Wallet.trader_id == trader.id))
        wallet = wallet_result.scalar_one_or_none()
        if not wallet:
            wallet = Wallet(trader_id=trader.id)
            db.add(wallet)
            await db.flush()

        wallet.balance      += amount
        wallet.total_earned += amount
        wallet.daily_volume += amount
        if not is_partial:
            wallet.daily_trades += 1

        db.add(WalletTransaction(
            trader_id=trader.id,
            wallet_id=wallet.id,
            order_id=order.id,
            transaction_type=TransactionType.SELL_CREDIT,
            amount=amount,
            balance_after=wallet.balance,
            description=f"Choice Bank inbound {'(partial top-up)' if is_partial else 'payment'}",
        ))

        await db.commit()
        logger.info(
            f"[ChoiceBank] MATCHED: {tx_id} → order {order.binance_order_number} "
            f"(Trader: {trader.full_name}, KES {amount}, total KES {total_received:.2f}) → "
            f"{'HELD — payer name mismatch' if _name_mismatch else 'PAYMENT_RECEIVED'}"
        )

        try:
            from app.api.routes.telegram import notify_trader
            if _name_mismatch:
                # Determine payment channel for the alert label
                _pay_method = "pesalink" if _channel and "pesalink" in _channel.lower() else "mpesa"
                from app.api.routes.telegram import _pending_name_checks, _tg_send
                import time as _time
                _method_label = "PesaLink" if _pay_method == "pesalink" else "M-Pesa"
                _amt_str = f"KES {int(amount):,}"
                _text = (
                    f"⚠️ <b>Payment Name Mismatch — Your Action Required</b>\n\n"
                    f"<b>Order:</b> {order.binance_order_number}\n"
                    f"<b>Amount:</b> {_amt_str}\n"
                    f"<b>Method:</b> {_method_label}\n\n"
                    f"A payment has been received but the sender's name does not match the buyer's Binance name:\n\n"
                    f"  • <b>Sender name</b> ({_method_label}): <code>{sender_name}</code>\n"
                    f"  • <b>Buyer name</b> (Binance): <code>{_binance_name or 'Unknown'}</code>\n\n"
                    f"This may indicate the buyer used a third-party account. Crypto is NOT released.\n\n"
                    f"<b>Release crypto or hold for manual review?</b>"
                )
                _keyboard = {"inline_keyboard": [[
                    {"text": "✅ Release Crypto", "callback_data": f"name_approve:{order.binance_order_number}"},
                    {"text": "🔒 Hold — Review Manually", "callback_data": f"name_reject:{order.binance_order_number}"},
                ]]}
                _resp = await _tg_send("sendMessage", {
                    "chat_id": trader.telegram_chat_id,
                    "text": _text,
                    "parse_mode": "HTML",
                    "reply_markup": _keyboard,
                })
                if _resp and _resp.get("ok"):
                    _pending_name_checks[order.binance_order_number] = {
                        "chat_id": str(trader.telegram_chat_id),
                        "message_id": _resp["result"]["message_id"],
                        "status": "pending",
                        "trader_id": trader.id,
                        "created_at": _time.time(),
                    }
                logger.warning(
                    f"[ChoiceBank] Name mismatch on order {order.binance_order_number}: "
                    f"sender={sender_name!r} vs buyer={_binance_name!r} — HELD, Telegram alert sent"
                )
            else:
                # Name matches → auto-release crypto server-side so the sell completes even
                # if the desktop bot is offline. EP-20 via HMAC (relay-routed).
                _released = False
                try:
                    from app.services.binance.sapi_client import release_coin_2fa, relay_trader
                    from app.core.security import decrypt_data, binance_totp_secret
                    if trader.binance_api_key and trader.binance_api_secret:
                        relay_trader.set(trader.id)
                        _totp = binance_totp_secret(trader)
                        _rr = await release_coin_2fa(
                            decrypt_data(trader.binance_api_key),
                            decrypt_data(trader.binance_api_secret),
                            order.binance_order_number,
                            totp_secret=_totp,
                        )
                        _released = (_rr.get("code") == "000000") or (_rr.get("success") is True)
                        if _released:
                            order.status = OrderStatus.RELEASED
                            order.released_at = datetime.now(timezone.utc)
                            await db.commit()
                            logger.info(f"[ChoiceBank] Auto-released order {order.binance_order_number} (payer name OK)")
                        else:
                            logger.warning(f"[ChoiceBank] Auto-release not ready for {order.binance_order_number}: {_rr}")
                except Exception as _rele:
                    logger.warning(f"[ChoiceBank] Auto-release error for {order.binance_order_number}: {_rele}")
                _tg_msg = (
                    "💰 KES " + f"{amount:,.0f}" +
                    (" received — crypto released! ✅" if _released else " received — payment confirmed!") + chr(10) +
                    "From: " + (sender_name or sender_phone or "Unknown") + chr(10) +
                    "Order: " + (order.binance_order_number or "")
                )
                await notify_trader(trader, _tg_msg)
        except Exception as _e:
            logger.warning(f"[ChoiceBank] Matched inbound notify failed: {_e}")



async def _handle_bulk_transfer_result(params: dict, raw: dict):
    """
    Callback 0004 — Merchant Bulk Transfer Result.
    Fires when a batch_disburse() transfer completes or fails.
    Updates the Payment record from PENDING to COMPLETED/FAILED.
    """
    order_id = params.get("orderId") or ""
    result_array = params.get("resultArray") or []

    logger.info(f"[ChoiceBank] 0004 bulk result: orderId={order_id}, items={len(result_array)}")

    for item in result_array:
        tx_id     = item.get("txId") or ""
        tx_status = str(item.get("txStatus") or "")
        try:
            amount = float(item.get("amount") or 0)
        except (ValueError, TypeError):
            amount = 0.0

        success = tx_status in ("SUCCESS", "8", "success", "00000")

        async with async_session() as _db:
            from app.models import Payment, PaymentStatus
            pmt = (await _db.execute(
                select(Payment).where(Payment.mpesa_transaction_id == order_id)
            )).scalar_one_or_none()

            if not pmt:
                logger.warning(f"[ChoiceBank] 0004: no Payment found for orderId={order_id}")
                continue

            pmt.status = PaymentStatus.COMPLETED if success else PaymentStatus.FAILED
            if tx_id:
                pmt.mpesa_receipt_number = tx_id
            await _db.commit()
            logger.info(f"[ChoiceBank] 0004: Payment {pmt.id} → {'COMPLETED' if success else 'FAILED'}")

            trader = await _db.get(Trader, pmt.trader_id)
            if trader:
                try:
                    from app.api.routes.telegram import notify_trader
                    if success:
                        msg = (
                            "✅ KES " + f"{amount:,.0f}" + " bank withdrawal COMPLETED" + chr(10) +
                            "Ref: " + (tx_id or order_id)
                        )
                    else:
                        msg = (
                            "❌ KES " + f"{amount:,.0f}" + " bank withdrawal FAILED" + chr(10) +
                            "Ref: " + order_id + chr(10) +
                            "Status: " + tx_status
                        )
                    await notify_trader(trader, msg)
                except Exception as _e:
                    logger.warning(f"[ChoiceBank] 0004 notify failed: {_e}")


async def _handle_balance_change(params: dict):
    """Callback 0003 — Balance Change. Log only; order status managed by 0002."""
    logger.info(
        f"[ChoiceBank] 0003 balance change: account={params.get('accountId')}, "
        f"KES {params.get('amount')}, balance={params.get('balance')}"
    )


# ── Onboarding Routes (SparkP2P → Choice Bank) ───────────────────────────────

class WalletOnboardRequest(BaseModel):
    trader_id: int
    first_name: str
    last_name: str
    middle_name: str = ""
    mobile: str               # 9-digit (no 254/0 prefix)
    id_number: str
    birthday: str             # yyyy-mm-dd
    gender: int               # 0=female, 1=male
    email: str = ""
    address: str = ""
    front_photo_b64: str      # National ID front
    back_photo_b64: str       # National ID back
    selfie_b64: str


class CurrentOnboardRequest(BaseModel):
    trader_id: int
    first_name: str
    last_name: str
    middle_name: str = ""
    mobile: str
    id_number: str
    birthday: str
    gender: int
    email: str = ""
    address: str = ""
    kra_pin: str
    employment_status: str
    monthly_income: str


class OtpConfirmRequest(BaseModel):
    trader_id: int
    onboarding_request_id: str
    otp: str


class TransferRequest(BaseModel):
    trader_id: int
    payee_mobile: str         # 9-digit phone number (no 254/0 prefix)
    amount: float
    payee_bank_code: str      # from get_bank_codes(); e.g. M-Pesa code
    payee_name: str = ""
    remark: str = ""


@router.post("/choice/onboard/wallet")
async def onboard_wallet(body: WalletOnboardRequest, db: AsyncSession = Depends(get_db)):
    """
    Initiate wallet account creation for a trader.
    Returns onboardingRequestId — use it for OTP confirmation and status polling.
    """
    _email = (body.email or "").strip()
    if not _email or "@" not in _email or "." not in _email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="A valid email is required — use the same email as your Binance account.")
    result = await choice.create_wallet_account(
        user_id=str(body.trader_id),
        first_name=body.first_name,
        last_name=body.last_name,
        middle_name=body.middle_name,
        mobile=body.mobile,
        id_number=body.id_number,
        birthday=body.birthday,
        gender=body.gender,
        email=body.email,
        address=body.address,
        front_photo_b64=body.front_photo_b64,
        back_photo_b64=body.back_photo_b64,
        selfie_b64=body.selfie_b64,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Onboarding failed"))

    onboarding_id = result.get("data", {}).get("onboardingRequestId")

    # Store onboarding request ID on the trader for OTP + status polling
    trader = await db.get(Trader, body.trader_id)
    if trader:
        trader.choice_kyc_status = f"onboarding:{onboarding_id}"
        await db.commit()

    # Verify the EMAIL during onboarding (otpType=EMAIL) so the registered email becomes verified —
    # required for each later transaction's sendOtp(EMAIL), which the bot reads from the same inbox.
    # SMS fallback so onboarding never breaks if the email OTP can't be sent.
    otp_channel = "email"
    otp_res = await choice.send_otp(onboarding_id, "EMAIL")
    if (otp_res or {}).get("code") != "00000":
        logger.warning(f"[ChoiceBank] wallet EMAIL OTP failed ({(otp_res or {}).get('msg')}) — SMS fallback for {onboarding_id}")
        otp_channel = "sms"
        await choice.send_otp(onboarding_id, "SMS")

    return {"onboardingRequestId": onboarding_id, "otp_channel": otp_channel}


@router.post("/choice/onboard/current")
async def onboard_current(body: CurrentOnboardRequest, db: AsyncSession = Depends(get_db)):
    """
    Initiate current account creation (no transaction limits).
    Selfie must be verified via Smile ID SDK on the frontend before calling this.
    """
    result = await choice.create_current_account(
        user_id=str(body.trader_id),
        first_name=body.first_name,
        last_name=body.last_name,
        middle_name=body.middle_name,
        mobile=body.mobile,
        id_number=body.id_number,
        birthday=body.birthday,
        gender=body.gender,
        email=body.email,
        address=body.address,
        kra_pin=body.kra_pin,
        employment_status=body.employment_status,
        monthly_income=body.monthly_income,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Onboarding failed"))

    onboarding_id = result.get("data", {}).get("onboardingRequestId")

    trader = await db.get(Trader, body.trader_id)
    if trader:
        trader.choice_kyc_status = f"onboarding:{onboarding_id}"
        await db.commit()

    return {"onboardingRequestId": onboarding_id}


class UploadMediaRequest(BaseModel):
    onboarding_request_id: str
    media_type: str     # KYCF00001=ID front, KYCF00002=ID back, KYCF00006=selfie
    media_b64: str      # base64-encoded jpg/jpeg image
    content_type: str = "image"


@router.post("/choice/onboard/upload-media")
async def upload_kyc_document(body: UploadMediaRequest):
    """
    Upload a single KYC document for current account onboarding.
    Must be called after POST /choice/onboard/current, within 30 minutes.

    Required documents for National ID (idType=101):
      KYCF00001 — ID front (jpg)
      KYCF00002 — ID back (jpg)
      KYCF00006 — Selfie (jpg) — must be Smile ID verified on frontend first

    Call this endpoint once per document. All three must be uploaded before
    Choice Bank starts KYC review.
    """
    result = await choice.upload_kyc_media(
        onboarding_request_id=body.onboarding_request_id,
        media_type=body.media_type,
        media_b64=body.media_b64,
        content_type=body.content_type,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Media upload failed"))
    return {"status": "uploaded", "mediaType": body.media_type}


@router.post("/choice/onboard/otp")
async def confirm_onboarding_otp(body: OtpConfirmRequest, db: AsyncSession = Depends(get_db)):
    """Confirm the OTP received by the trader to proceed with wallet account creation."""
    result = await choice.confirm_otp(body.onboarding_request_id, body.otp)
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "OTP confirmation failed"))
    return {"status": "confirmed"}


# ── Close account (so the trader can re-onboard fresh — e.g. to get the email verified) ──────────
_pending_close: dict[int, str] = {}   # trader_id -> applicationId awaiting OTP confirmation


class CloseAccountInitiate(BaseModel):
    closure_reason: str = "Account holder circumstances have changed"


class CloseAccountConfirm(BaseModel):
    otp: str


@router.post("/choice/account/close/initiate")
async def close_account_initiate(body: CloseAccountInitiate, trader: Trader = Depends(get_current_trader)):
    """Step 1: request closure of the trader's Choice account. Blocks if funds remain (withdraw first).
    Sends an OTP (SMS, since the email may be unverified) to validate; Choice staff then manually
    review/approve. Closing the LAST account lets the trader re-onboard fresh (email-verified)."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    # Safeguard — never close an account that still holds funds.
    try:
        det = await choice.get_account_details(trader.choice_account_id)
        bal = float((det.get("data") or {}).get("balance") or 0)
    except Exception:
        bal = 0.0
    if bal > 1:
        raise HTTPException(status_code=400,
            detail=f"Withdraw your balance first — KES {bal:,.0f} remaining. Empty the account, then close it.")
    r = await choice.close_individual_account(trader.choice_account_id, body.closure_reason, "SMS")
    if r.get("code") != "00000":
        raise HTTPException(status_code=400, detail=r.get("msg", "Account closure request failed"))
    app_id = (r.get("data") or {}).get("applicationId") or ""
    if not app_id:
        raise HTTPException(status_code=502, detail="No applicationId returned by Choice")
    _pending_close[trader.id] = app_id
    return {"status": "otp_sent", "applicationId": app_id,
            "message": "Enter the OTP sent to your phone to confirm the closure request."}


@router.post("/choice/account/close/confirm")
async def close_account_confirm(body: CloseAccountConfirm, trader: Trader = Depends(get_current_trader)):
    """Step 2: confirm the OTP. After this, Choice staff review the closure; the result arrives via
    callback. Once approved, the trader re-onboards (now with the email-verification step)."""
    app_id = _pending_close.get(trader.id)
    if not app_id:
        raise HTTPException(status_code=400, detail="No pending closure request. Start again.")
    r = await choice.confirm_otp(app_id, body.otp.strip())
    if r.get("code") != "00000":
        raise HTTPException(status_code=400, detail=r.get("msg", "Invalid or expired OTP"))
    _pending_close.pop(trader.id, None)
    return {"status": "submitted",
            "message": "Closure submitted. Choice will review and approve; result arrives via callback. "
                       "Once closed, re-onboard for a fresh, email-verified account."}


@router.get("/choice/onboard/status/{onboarding_request_id}")
async def check_onboarding_status(onboarding_request_id: str, trader_id: int, db: AsyncSession = Depends(get_db)):
    """
    Poll onboarding status. When status=3 or 7 the account is active.
    Saves choice_account_id and choice_account_number to the trader on success.
    """
    result = await choice.get_onboarding_status(onboarding_request_id)
    data = result.get("data") or {}
    # Choice returns the onboarding state as `onboardingStatus` (3 = passed, 7 = active),
    # NOT `status` — reading the wrong field meant approvals were never captured here.
    status = data.get("onboardingStatus", data.get("status"))

    if status in (3, 7, "3", "7"):
        account_id     = data.get("accountId") or data.get("account_id") or ""
        account_number = data.get("accountNumber") or data.get("account_number") or account_id

        if account_id:
            trader = await db.get(Trader, trader_id)
            if trader:
                trader.choice_account_id     = account_id
                trader.choice_account_number = account_number
                trader.choice_kyc_status     = "approved"
                await db.commit()
                logger.info(
                    f"[ChoiceBank] Trader {trader_id} account activated: "
                    f"accountId={account_id}, number={account_number}"
                )

    return {
        "status": status,
        "accountId": data.get("accountId"),
        "accountNumber": data.get("accountNumber"),
        "raw": data,
    }


class DepositRequest(BaseModel):
    amount: int  # whole KES amount
    mobile: str = ""  # optional override phone; if empty, uses trader's registered phone


def _normalize_mobile(raw: str) -> str:
    """Normalize any Kenyan phone format to 9-digit local number (e.g. 712345678)."""
    raw = raw.strip().replace(" ", "").replace("-", "")
    if raw.startswith("+254"):
        raw = raw[4:]
    elif raw.startswith("254"):
        raw = raw[3:]
    elif raw.startswith("0"):
        raw = raw[1:]
    return raw


async def _monitor_deposit(payment_id: int, tx_id: str):
    """Watch an STK deposit's ACTUAL Choice transaction (getTransResult) until it settles.

    Replaces a blind 3-minute balance-delta check, which was wrong in BOTH directions: any
    concurrent movement on the account (the bot paying a buy order, a retry deposit landing)
    could hide a real deposit, or — as actually happened — mark a FAILED deposit as COMPLETED
    because a *different* credit arrived inside the window. txStatus is authoritative.

    STK needs the payer to enter their M-Pesa PIN, so poll for a few minutes. Anything still
    unsettled when we give up stays PENDING for deposit_reconcile_poller to keep watching.
    """
    if not tx_id:
        return
    outcome = await choice.wait_for_transfer_result(tx_id, timeout_s=300, interval_s=5)
    if outcome == "pending":
        logger.info("[ChoiceDeposit] payment %s still unsettled after 5m — leaving to the poller", payment_id)
        return
    try:
        async with async_session() as _db:
            p = await _db.get(Payment, payment_id)
            if not p or p.status != PaymentStatus.PENDING:
                return
            p.status = PaymentStatus.COMPLETED if outcome == "success" else PaymentStatus.FAILED
            p.remarks = ((p.remarks or "") + f" [tx-{outcome}]").strip()
            await _db.commit()
            logger.info("[ChoiceDeposit] payment %s (KES %s) → %s via getTransResult(%s)",
                        payment_id, p.amount, outcome, tx_id)
    except Exception as e:
        logger.warning(f"[ChoiceDeposit] monitor error for payment {payment_id}: {e}")


@router.post("/choice/deposit")
async def stk_push_deposit(
    body: DepositRequest,
    background_tasks: BackgroundTasks,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Trigger M-Pesa STK push to deposit into the trader's Choice Bank account."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    if body.amount < 1:
        raise HTTPException(status_code=400, detail="Amount must be at least KES 1")

    raw_phone = body.mobile.strip() if body.mobile and body.mobile.strip() else (trader.phone or "")
    mobile = _normalize_mobile(raw_phone)
    if len(mobile) != 9 or not mobile.isdigit():
        raise HTTPException(status_code=400, detail="Invalid phone number — enter a valid Kenyan number")

    result = await choice.deposit_from_mpesa(trader.choice_account_id, mobile, body.amount)
    tx_id = result.get("data", {}).get("txId") or result.get("txId") or ""

    # Log the initiated deposit so it appears in the merchant's transaction history
    payment_id = None
    try:
        p = Payment(
            trader_id=trader.id,
            direction=PaymentDirection.INBOUND,
            mpesa_transaction_id=tx_id or f"cb_stk_{trader.id}_{body.amount}",
            transaction_type="CHOICE_DEPOSIT",
            amount=body.amount,
            phone=mobile,
            sender_name=(trader.full_name or "").strip() or "M-Pesa Deposit",
            remarks="Deposit via M-Pesa STK to Choice Bank",
            status=PaymentStatus.PENDING,
        )
        db.add(p)
        await db.commit()
        await db.refresh(p)
        payment_id = p.id
    except Exception as _log_err:
        logger.warning(f"Failed to log deposit to payments: {_log_err}")

    # Track the real transaction to completion instead of guessing from the balance.
    if payment_id and tx_id:
        background_tasks.add_task(_monitor_deposit, payment_id, tx_id)
    elif payment_id:
        logger.warning("[ChoiceDeposit] payment %s has no Choice txId — cannot track; left PENDING", payment_id)

    return {"txId": tx_id, "status": "stk_sent"}


@router.get("/choice/deposit/status")
async def deposit_status(tx_id: str, trader: Trader = Depends(get_current_trader),
                         db: AsyncSession = Depends(get_db)):
    """Live status of one STK deposit, so the UI can WATCH the money land rather than
    telling the merchant 'STK sent' and leaving them guessing. Settles the Payment row too,
    so a merchant sitting on the modal never waits for the background poller."""
    tx_id = (tx_id or "").strip()
    if not tx_id:
        raise HTTPException(status_code=400, detail="tx_id required")

    p = (await db.execute(select(Payment).where(
        Payment.mpesa_transaction_id == tx_id,
        Payment.trader_id == trader.id,
        Payment.transaction_type == "CHOICE_DEPOSIT",
    ))).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Deposit not found")

    # Already settled (by the inline monitor or the poller) — report what we have.
    if p.status != PaymentStatus.PENDING:
        return {"status": "success" if p.status == PaymentStatus.COMPLETED else "failed",
                "amount": float(p.amount)}

    try:
        r = await choice.get_transaction_result(tx_id)
        st = str((r.get("data") or {}).get("txStatus") or "")
    except Exception as exc:
        logger.warning("[ChoiceDeposit] status check failed for %s: %s", tx_id, exc)
        return {"status": "pending", "amount": float(p.amount)}

    if st == "8":
        p.status = PaymentStatus.COMPLETED
        p.remarks = ((p.remarks or "") + " [tx-verified]").strip()
        await db.commit()
        return {"status": "success", "amount": float(p.amount)}
    if st in ("4", "-1"):
        p.status = PaymentStatus.FAILED
        p.remarks = ((p.remarks or "") + " [tx-failed]").strip()
        await db.commit()
        return {"status": "failed", "amount": float(p.amount)}

    return {"status": "pending", "amount": float(p.amount)}


@router.get("/choice/balance/{trader_id}")
async def get_trader_balance(trader_id: int, db: AsyncSession = Depends(get_db)):
    """Get the live Choice Bank balance for a trader's sub-account."""
    trader = await db.get(Trader, trader_id)
    if not trader or not trader.choice_account_id:
        raise HTTPException(status_code=404, detail="Trader has no Choice Bank account")

    result = await choice.get_account_details(trader.choice_account_id)
    data = result.get("data") or {}
    return {
        "accountId":     data.get("accountId"),
        "accountNumber": data.get("accountNumber") or trader.choice_account_number,
        "balance":       data.get("balance"),
        "currency":      data.get("currency", "KES"),
        "status":        data.get("accountStatus"),
        "shortCode":     data.get("shortCode"),
    }


@router.post("/choice/transfer")
async def initiate_transfer(body: TransferRequest, db: AsyncSession = Depends(get_db)):
    """
    Send money from a trader's Choice Bank account to a mobile number (B2C).
    Used for BUY orders — pays the seller via M-Pesa or Airtel.
    payee_mobile: 9-digit phone number without 254/0 prefix.
    """
    trader = await db.get(Trader, body.trader_id)
    if not trader or not trader.choice_account_id:
        raise HTTPException(status_code=404, detail="Trader has no Choice Bank account")

    result = await choice.transfer(
        payer_account_id=trader.choice_account_id,
        payee_account_id=body.payee_mobile,
        amount=body.amount,
        payee_bank_code=body.payee_bank_code,
        payee_name=body.payee_name,
        remark=body.remark or "SparkP2P P2P order payment",
        notify_mobile=body.payee_mobile,
    )
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer failed"))

    tx_id = (result.get("data") or {}).get("txId", "")
    logger.info(
        f"[ChoiceBank] Transfer initiated: txId={tx_id}, "
        f"KES {body.amount} → {body.payee_mobile}"
    )
    try:
        from app.api.routes.telegram import notify_trader
        _tg_msg = (
            "📤 KES " + f"{body.amount:,.0f}" +
            " sent via Choice Bank" + chr(10) +
            "To: " + (body.payee_name or body.payee_mobile) + chr(10) +
            "Ref: " + (tx_id or "N/A")
        )
        await notify_trader(trader, _tg_msg)
    except Exception as _e:
        logger.warning(f"[ChoiceBank] Transfer notify failed: {_e}")
    return {"txId": tx_id, "status": "submitted"}


@router.get("/choice/bank-codes")
async def get_bank_codes():
    """Return all supported payment channel codes (call once to identify M-Pesa code)."""
    result = await choice.get_bank_codes()
    return result.get("data") or result


# ── Payments Hub — user-facing "Send Money" (OTP-confirmed) ───────────────────
# Mirrors the proven withdraw-to-M-Pesa flow (transfer → sendOtp → confirmOperation) but lets the
# trader send to ANY M-Pesa number, not just their own settlement phone.

class SendMoneyInitiate(BaseModel):
    payee_phone: str
    amount: float
    payee_name: str = ""
    remark: str = ""
    network: str = "mpesa"   # "mpesa" or "airtel"


class SendMoneyConfirm(BaseModel):
    otp: str


_pending_send_money: dict[int, dict] = {}


def _normalize_msisdn(phone: str) -> str:
    p = (phone or "").strip().replace(" ", "")
    if p.startswith("+254"):
        p = p[4:]
    elif p.startswith("254"):
        p = p[3:]
    elif p.startswith("0"):
        p = p[1:]
    return p


@router.post("/choice/pay/send-money/initiate")
async def send_money_initiate(body: SendMoneyInitiate, trader: Trader = Depends(get_current_trader)):
    """Step 1: start a Choice Bank → M-Pesa transfer to an arbitrary number; OTP is sent to the
    trader's registered phone."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    phone = _normalize_msisdn(body.payee_phone)
    if len(phone) != 9 or not phone.isdigit() or phone[0] not in ("7", "1"):
        raise HTTPException(status_code=400, detail="Enter a valid Kenyan phone number (e.g. 0712345678)")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    network = (body.network or "mpesa").lower()
    bank_code = "AIRTEL" if network == "airtel" else "M-PESA"
    limit = 70000 if network == "airtel" else 250000
    if body.amount > limit:
        raise HTTPException(status_code=400, detail=f"{'Airtel' if network == 'airtel' else 'M-Pesa'} transfers are limited to KES {limit:,} per transaction")

    # ── Pre-flight: minimum amount (M-Pesa rejects < KES 10) + balance covers amount + fee ──
    if body.amount < 10:
        raise HTTPException(status_code=400,
            detail=f"Minimum transfer is KES 10 — you entered KES {body.amount:,.0f}. Increase the amount to at least KES 10.")
    from app.services.outbound_fees import outbound_fee
    _fee = outbound_fee("AIRTEL" if network == "airtel" else "MPESA", float(body.amount))
    _needed = float(body.amount) + _fee
    try:
        _bal_res = await choice.get_account_details(trader.choice_account_id)
        _bal = float((_bal_res.get("data") or {}).get("balance") or 0)
    except Exception:
        _bal = None
    if _bal is not None and _bal < _needed:
        _short = _needed - _bal
        raise HTTPException(status_code=400,
            detail=(f"Insufficient balance: KES {_bal:,.0f} available, but KES {_needed:,.0f} needed "
                    f"(KES {body.amount:,.0f} + KES {_fee:,.0f} fee). Add KES {_short:,.0f} to your Choice account."))

    try:
        result = await choice.transfer(
            payer_account_id=trader.choice_account_id,
            payee_account_id=phone,
            amount=body.amount,
            payee_bank_code=bank_code,
            payee_name=body.payee_name or "",
            remark=body.remark or "SparkP2P send money",
            notify_mobile=phone,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transfer initiation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer rejected"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")

    try:
        otp_res = await choice.send_otp(tx_id, otp_type="SMS")
        if otp_res.get("code") != "00000":
            logger.warning("[ChoiceBank] send-money sendOtp(SMS): " + str(otp_res.get("code")) + " " + str(otp_res.get("msg")))
    except Exception as exc:
        logger.warning("[ChoiceBank] send-money sendOtp failed: " + str(exc))

    msg = "Enter the OTP Choice Bank sent to your registered phone to confirm this transfer."
    _pending_send_money[trader.id] = {"tx_id": tx_id, "amount": body.amount, "phone": phone, "name": body.payee_name}
    return {"status": "otp_sent", "message": msg}


@router.post("/choice/pay/send-money/resend-email")
async def send_money_resend_email(trader: Trader = Depends(get_current_trader)):
    """SMS OTP didn't arrive — resend the SAME transfer's OTP via EMAIL instead (merchant-triggered).
    The merchant then enters the email code in the normal confirm step (confirm_otp is channel-agnostic)."""
    pending = _pending_send_money.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    try:
        r = await choice.resend_otp(pending["tx_id"], otp_type="EMAIL")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not send email OTP: {exc}")
    if r.get("code") != "00000":
        raise HTTPException(
            status_code=400,
            detail=r.get("msg") or "Email OTP isn't available for this account (your email may not be verified with Choice Bank).",
        )
    return {"status": "email_otp_sent",
            "message": "We've sent the OTP to your registered email. Enter it below to complete the transfer."}


# ── Email verification (enables the email-OTP fallback) ─────────────────────────
# Choice's getAccountDetails does NOT expose whether an account's email is verified,
# so we let merchants verify it on demand and track the result on the trader. Once
# verified, the "get the code by email" fallback on transfers actually delivers.
_pending_email_verify: dict[int, str] = {}  # trader_id -> applicationId


def _mask_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return email
    name, _, domain = email.partition("@")
    head = name[:1] if name else ""
    return f"{head}{'*' * max(len(name) - 1, 1)}@{domain}"


async def _trader_id_number(db: AsyncSession, trader_id: int) -> str | None:
    """National ID captured at KYC, if we have it (older/admin onboardings may not)."""
    from app.models.kyc_submission import KycSubmission
    k = (await db.execute(
        select(KycSubmission)
        .where(KycSubmission.trader_id == trader_id,
               KycSubmission.id_number.isnot(None), KycSubmission.id_number != "")
        .order_by(KycSubmission.id.desc())
    )).scalars().first()
    return (k.id_number.strip() if k and k.id_number else None)


class EmailVerifyStart(BaseModel):
    id_number: str | None = None  # merchant supplies their National ID only if we don't have it


@router.get("/choice/email-verify/status")
async def email_verify_status(trader: Trader = Depends(get_current_trader),
                              db: AsyncSession = Depends(get_db)):
    """Whether this account's email is verified (→ email-OTP fallback works) and,
    if not, whether we already have the National ID needed to start verification."""
    has_id = bool(await _trader_id_number(db, trader.id))
    return {
        "verified": bool(getattr(trader, "choice_email_verified", False)),
        "email": _mask_email(trader.email),
        "need_id_number": not has_id,
    }


@router.post("/choice/email-verify/start")
async def email_verify_start(body: EmailVerifyStart, trader: Trader = Depends(get_current_trader),
                             db: AsyncSession = Depends(get_db)):
    """Send an OTP to the account's registered email so the merchant can verify it."""
    id_number = (body.id_number or "").strip() or await _trader_id_number(db, trader.id)
    if not id_number:
        raise HTTPException(status_code=400,
                            detail="Enter your National ID number to verify your email.")
    try:
        r = await choice.verify_email_address(id_number)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not start email verification: {exc}")
    app_id = None
    data = r.get("data")
    if isinstance(data, dict):
        app_id = data.get("applicationId") or data.get("businessId")
    if r.get("code") != "00000" or not app_id:
        raise HTTPException(
            status_code=400,
            detail=r.get("msg") or "Couldn't start email verification — check the National ID matches this account.",
        )
    _pending_email_verify[trader.id] = str(app_id)
    return {"status": "otp_sent",
            "email": _mask_email(trader.email),
            "message": f"We've sent a verification code to your email ({_mask_email(trader.email) or 'on file'}). Enter it to enable email OTP."}


@router.post("/choice/email-verify/confirm")
async def email_verify_confirm(body: SendMoneyConfirm, trader: Trader = Depends(get_current_trader),
                               db: AsyncSession = Depends(get_db)):
    """Confirm the email OTP; on success the email-OTP fallback becomes available."""
    app_id = _pending_email_verify.get(trader.id)
    if not app_id:
        raise HTTPException(status_code=400, detail="No pending verification. Please start again.")
    try:
        result = await choice.confirm_contact_verify(app_id, body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Verification failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired code"))

    _pending_email_verify.pop(trader.id, None)
    trader.choice_email_verified = True
    db.add(trader)
    await db.commit()
    return {"status": "verified",
            "message": "✅ Email verified. You can now receive OTPs by email when SMS doesn't arrive."}


@router.post("/choice/pay/send-money/confirm")
async def send_money_confirm(body: SendMoneyConfirm, trader: Trader = Depends(get_current_trader),
                             db: AsyncSession = Depends(get_db)):
    """Step 2: confirm the OTP to release the transfer."""
    pending = _pending_send_money.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    try:
        result = await choice.confirm_otp(pending["tx_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_send_money.pop(trader.id, None)
    _to = pending.get("name") or ("0" + pending["phone"])

    # Pre-create Payment record tagged as M-Pesa B2C so the webhook finds it ready.
    try:
        from app.models.payment import Payment as _Pmt, PaymentDirection as _PD, PaymentStatus as _PS
        db.add(_Pmt(
            trader_id=trader.id,
            direction=_PD.OUTBOUND,
            mpesa_transaction_id=pending["tx_id"],
            transaction_type="CHOICE_OUTBOUND",
            amount=float(pending["amount"]),
            destination=pending.get("phone", ""),
            destination_type="M-Pesa",
            sender_name=pending.get("name") or "",
            remarks=f"Send money to {_to} via Choice Bank",
            status=_PS.PENDING,
        ))
    except Exception:
        pass

    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_SEND, -float(pending["amount"]),
                              f"Sent to {_to} via Choice Bank", mpesa_receipt=pending["tx_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001F4E4 KES {pending['amount']:,.0f} sent via Choice Bank to {_to}\nRef: {pending['tx_id']}")
    except Exception:
        pass
    return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}


@router.post("/choice/pay/send-money/confirm-sms")
async def send_money_confirm_sms(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Auto-capture Choice Bank SMS OTP via MacroDroid webhook for manual send-money flow."""
    import asyncio as _asyncio
    from app.api.routes.extension import _pending_sms_otps

    pending = _pending_send_money.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")

    account_last_4 = str(trader.choice_account_id)[-4:]
    event = _asyncio.Event()
    _pending_sms_otps[account_last_4] = {"event": event, "otp": None}

    try:
        try:
            await _asyncio.wait_for(event.wait(), timeout=120.0)
        except _asyncio.TimeoutError:
            logger.warning("[SMS-OTP] send-money 60s timeout for ****" + account_last_4 + " - resending")
            try:
                await choice.resend_otp(pending["tx_id"], otp_type="SMS")
            except Exception as _re:
                logger.warning("[SMS-OTP] resend_otp failed: " + str(_re))
            event.clear()
            _pending_sms_otps[account_last_4]["otp"] = None
            try:
                await _asyncio.wait_for(event.wait(), timeout=90.0)
            except _asyncio.TimeoutError:
                raise HTTPException(status_code=408, detail="SMS OTP did not arrive. Check your phone and try again.")

        otp = (_pending_sms_otps.get(account_last_4) or {}).get("otp")
        if not otp:
            raise HTTPException(status_code=500, detail="SMS OTP event fired but no code stored")

        logger.info("[SMS-OTP] send-money OTP received for ****" + account_last_4 + " - confirming")
        result = await choice.confirm_otp(pending["tx_id"], otp)
        if result.get("code") != "00000":
            raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

        _pending_send_money.pop(trader.id, None)
        _to = pending.get("name") or ("0" + pending["phone"])

        try:
            from app.models.payment import Payment as _Pmt, PaymentDirection as _PD, PaymentStatus as _PS
            db.add(_Pmt(
                trader_id=trader.id, direction=_PD.OUTBOUND,
                mpesa_transaction_id=pending["tx_id"], transaction_type="CHOICE_OUTBOUND",
                amount=float(pending["amount"]), destination=pending.get("phone", ""),
                destination_type="M-Pesa", sender_name=pending.get("name") or "",
                remarks="Send money to " + _to + " via Choice Bank",
                status=_PS.PENDING,
            ))
        except Exception:
            pass
        try:
            from app.services.ledger import record_activity
            from app.models.wallet import TransactionType as _TT
            await record_activity(db, trader.id, _TT.CHOICE_SEND, -float(pending["amount"]),
                                  "Sent to " + _to + " via Choice Bank", mpesa_receipt=pending["tx_id"])
            await db.commit()
        except Exception:
            pass
        try:
            from app.api.routes.telegram import notify_trader
            await notify_trader(trader, "KES " + str(int(pending["amount"])) + " sent via Choice Bank to " + _to + " Ref: " + pending["tx_id"])
        except Exception:
            pass
        return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}
    finally:
        _pending_sms_otps.pop(account_last_4, None)


# ── Payments Hub — M-Pesa Paybill / Till (B2B), OTP-confirmed ─────────────────
# Same shape as Send Money but via mpesa_business_transfer (TTID0005). Field names in the client
# call are best-effort pending Choice Bank's API Details — a wrong name is REJECTED (no money moves).

class PaybillInitiate(BaseModel):
    business_number: str
    amount: float
    account_number: str = ""   # required for Paybill; blank for Till / Buy Goods
    is_paybill: bool = True


class PaybillConfirm(BaseModel):
    otp: str


_pending_paybill: dict[int, dict] = {}


@router.get("/choice/pay/lookup-shortcode")
async def lookup_shortcode(code: str, trader: Trader = Depends(get_current_trader)):
    """Confirmation-of-payee for an M-Pesa Paybill/Till — returns the registered business name so
    the user can confirm before paying. (Individual phone numbers are NOT lookupable — M-Pesa only
    exposes business shortcode names.) accountType=1, bankCode=M-PESA per Choice's validateAccount."""
    c = (code or "").strip()
    if not c.isdigit() or not (5 <= len(c) <= 7):
        raise HTTPException(status_code=400, detail="Enter a valid Paybill or Till number")
    try:
        r = await choice._post("/account/validateAccount", {"accountId": c, "accountType": 1, "bankCode": "M-PESA"})
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Name check unavailable: {exc}")
    code_ = r.get("code")
    if code_ == "10001":
        raise HTTPException(status_code=503, detail="Name check is busy — please try again")
    if code_ != "00000":
        raise HTTPException(status_code=404, detail="No name found for this number — check it's correct")
    name = ((r.get("data") or {}).get("accountName") or "").strip()
    if not name:
        raise HTTPException(status_code=404, detail="No name returned — verify the number")
    return {"name": name, "code": c}


@router.post("/choice/pay/paybill/initiate")
async def paybill_initiate(body: PaybillInitiate, trader: Trader = Depends(get_current_trader)):
    """Step 1: pay an M-Pesa Paybill or Till from the trader's Choice Bank account; OTP is sent to
    the trader's registered phone."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    biz = (body.business_number or "").strip()
    if not biz.isdigit() or not (5 <= len(biz) <= 7):
        raise HTTPException(status_code=400, detail="Enter a valid Paybill or Till number")
    acct = (body.account_number or "").strip()
    if body.is_paybill and not acct:
        raise HTTPException(status_code=400, detail="Enter the account number for this Paybill")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if body.amount > 250000:
        raise HTTPException(status_code=400, detail="M-Pesa payments are limited to KES 250,000 per transaction")

    try:
        result = await choice.mpesa_business_transfer(
            payer_account_id=trader.choice_account_id,
            business_number=biz,
            amount=body.amount,
            account_number=acct,
            is_paybill=body.is_paybill,
            remark="SparkP2P paybill",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Payment initiation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Payment rejected"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")

    try:
        await choice.send_otp(tx_id)
    except Exception as exc:
        logger.warning(f"[ChoiceBank] paybill sendOtp failed: {exc}")

    _pending_paybill[trader.id] = {"tx_id": tx_id, "amount": body.amount, "biz": biz, "acct": acct, "is_paybill": body.is_paybill}
    return {"status": "otp_sent", "message": "Enter the OTP Choice Bank sent to your registered phone to confirm this payment."}


@router.post("/choice/pay/paybill/confirm")
async def paybill_confirm(body: PaybillConfirm, trader: Trader = Depends(get_current_trader),
                          db: AsyncSession = Depends(get_db)):
    """Step 2: confirm the OTP to release the Paybill/Till payment."""
    pending = _pending_paybill.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending payment. Please start again.")
    try:
        result = await choice.confirm_otp(pending["tx_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_paybill.pop(trader.id, None)
    _dest = f"Paybill {pending['biz']} acc {pending['acct']}" if pending["is_paybill"] else f"Till {pending['biz']}"

    # Tag destination_type for revenue categorization (kra_paybill beats generic paybill).
    from app.services.outbound_fees import KRA_SHORTCODE
    if pending["biz"] == KRA_SHORTCODE:
        _dest_type = "kra_paybill"
    elif not pending["is_paybill"]:
        _dest_type = "mpesa_till"
    else:
        _dest_type = "mpesa_paybill"

    # Pre-create the Payment record so the webhook finds it and just updates status.
    # This ensures destination_type is set correctly before the webhook fires.
    try:
        from app.models.payment import Payment as _Pmt, PaymentDirection as _PD, PaymentStatus as _PS
        db.add(_Pmt(
            trader_id=trader.id,
            direction=_PD.OUTBOUND,
            mpesa_transaction_id=pending["tx_id"],
            transaction_type="CHOICE_OUTBOUND",
            amount=float(pending["amount"]),
            destination=_dest,
            destination_type=_dest_type,
            remarks=f"Paybill payment via Choice Bank",
            status=_PS.PENDING,
        ))
    except Exception:
        pass

    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_PAYBILL, -float(pending["amount"]),
                              f"Paid {_dest} via Choice Bank", mpesa_receipt=pending["tx_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001F9FE KES {pending['amount']:,.0f} paid via Choice Bank to {_dest}\nRef: {pending['tx_id']}")
    except Exception:
        pass
    return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}


# ── Payments Hub — bank list & account name lookup ────────────────────────────

@router.get("/choice/banks")
async def list_banks(trader: Trader = Depends(get_current_trader)):
    """Clean bank-code list for PesaLink/RTGS dropdowns."""
    result = await choice.get_bank_codes()
    # API returns { data: { bankCodeList: [...] } }
    raw = result.get("data") or result
    if isinstance(raw, dict):
        raw = raw.get("bankCodeList") or []
    if not isinstance(raw, list):
        return []
    banks = []
    for b in raw:
        code = str(b.get("bankCode") or b.get("code") or b.get("bankId") or "").strip()
        name = (b.get("bankName") or b.get("name") or b.get("bank_name") or "").strip()
        # Exclude mobile money and internal codes from the bank selector
        if code and name and code not in ("M-PESA", "AIRTEL"):
            banks.append({"code": code, "name": name})
    return sorted(banks, key=lambda x: x["name"])


@router.get("/choice/pay/lookup-mpesa-name")
async def lookup_mpesa_name(phone: str, trader: Trader = Depends(get_current_trader)):
    """Hakikisha-style name lookup for a personal M-Pesa number (accountType=3).
    Returns the masked subscriber name registered on M-Pesa (e.g. 'JOHN D****** M******')."""
    p = _normalize_msisdn(phone)
    if len(p) != 9 or not p.isdigit() or p[0] not in ("7", "1"):
        raise HTTPException(status_code=400, detail="Enter a valid Kenyan phone number")
    import asyncio as _a
    r = {}
    # Retry the transient Hakikisha failures (10000 'failed to query mpesa info', 10001 busy) —
    # these are M-Pesa's name service flaking, NOT a bad number, so a retry usually succeeds.
    for attempt in range(3):
        try:
            r = await choice._post("/account/validateAccount", {
                "accountId": p, "accountType": 3, "bankCode": "M-PESA",
            })
        except Exception as exc:
            if attempt == 2:
                raise HTTPException(status_code=503, detail=f"Name check temporarily unavailable: {exc}")
            await _a.sleep(0.8)
            continue
        if r.get("code") in ("10000", "10001") and attempt < 2:
            await _a.sleep(0.8)
            continue
        break

    code = r.get("code")
    if code == "00000":
        name = ((r.get("data") or {}).get("accountName") or "").strip()
        if name:
            return {"name": name, "phone": p}
        raise HTTPException(status_code=503, detail="M-Pesa did not return a name — you can still proceed if the number is correct")
    if code == "13000":  # the only code that means the number genuinely isn't registered
        raise HTTPException(status_code=404, detail="This number is not registered on M-Pesa")
    # 10000/10001 after retries, or any other code — transient service issue, not a bad number.
    raise HTTPException(status_code=503, detail="M-Pesa name check is temporarily unavailable — the number may still be valid, you can proceed")


@router.get("/choice/pay/lookup-account")
async def lookup_bank_account(
    account_id: str, bank_code: str = "", trader: Trader = Depends(get_current_trader)
):
    """Confirmation-of-payee for PesaLink (external) or internal Choice account."""
    acc = (account_id or "").strip()
    if not acc:
        raise HTTPException(status_code=400, detail="Enter an account number")
    try:
        params: dict = {"accountId": acc}
        if bank_code:
            params["accountType"] = 4
            params["bankCode"] = bank_code
        else:
            params["accountType"] = 0
        r = await choice._post("/account/validateAccount", params)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Name check unavailable: {exc}")
    if r.get("code") == "10001":
        raise HTTPException(status_code=503, detail="Name check is busy — try again")
    if r.get("code") != "00000":
        raise HTTPException(status_code=404, detail="Account not found — check the details")
    name = ((r.get("data") or {}).get("accountName") or "").strip()
    if not name:
        raise HTTPException(status_code=404, detail="No name returned — verify the account number")
    return {"name": name, "account_id": acc}


# ── Payments Hub — PesaLink / To Other Accounts / To Own Account ──────────────

class BankTransferBody(BaseModel):
    beneficiary_account: str
    beneficiary_name: str
    bank_code: str = ""          # empty for internal Choice-to-Choice transfer
    bank_name: str = ""
    amount: float
    remark: str = ""


_pending_bank_transfer: dict[int, dict] = {}


@router.post("/choice/pay/bank-transfer/initiate")
async def bank_transfer_initiate(body: BankTransferBody, trader: Trader = Depends(get_current_trader)):
    """PesaLink to external bank OR internal Choice-to-Choice. OTP to email (SMS fallback)."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    acc = (body.beneficiary_account or "").strip()
    if not acc:
        raise HTTPException(status_code=400, detail="Enter the beneficiary account number")
    if not (body.beneficiary_name or "").strip():
        raise HTTPException(status_code=400, detail="Enter the beneficiary name")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if body.bank_code and body.amount > 999999:
        raise HTTPException(status_code=400, detail="PesaLink is limited to KES 999,999. Use RTGS for larger amounts.")

    try:
        result = await choice.transfer(
            payer_account_id=trader.choice_account_id,
            payee_account_id=acc,
            amount=body.amount,
            payee_bank_code=body.bank_code or "",
            payee_name=(body.beneficiary_name or "").strip(),
            remark=body.remark or "SparkP2P bank transfer",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transfer initiation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Transfer rejected"))

    tx_id = (result.get("data") or {}).get("txId") or ""
    if not tx_id:
        raise HTTPException(status_code=502, detail="No transaction ID returned")

    otp_channel = "SMS"
    try:
        otp_res = await choice.send_otp(tx_id, otp_type="SMS")
        if otp_res.get("code") != "00000":
            await choice.send_otp(tx_id, otp_type="SMS")
            otp_channel = "SMS"
    except Exception as exc:
        logger.warning(f"[ChoiceBank] bank-transfer sendOtp failed: {exc}")

    label = (f"{body.bank_name} {acc}").strip() if body.bank_code else f"Choice account {acc}"
    _pending_bank_transfer[trader.id] = {
        "tx_id": tx_id, "amount": body.amount,
        "beneficiary": (body.beneficiary_name or "").strip(), "label": label,
    }
    msg = "Enter the OTP Choice Bank sent to your registered phone to confirm this transfer."
    return {"status": "otp_sent", "message": msg}


@router.post("/choice/pay/bank-transfer/confirm")
async def bank_transfer_confirm(
    body: SendMoneyConfirm, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)
):
    """Confirm OTP for PesaLink / internal transfer."""
    pending = _pending_bank_transfer.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    try:
        result = await choice.confirm_otp(pending["tx_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_bank_transfer.pop(trader.id, None)
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_BANK_TRANSFER, -float(pending["amount"]),
                              f"Transfer to {pending['beneficiary']} ({pending['label']}) via Choice Bank",
                              mpesa_receipt=pending["tx_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001F3E6 KES {pending['amount']:,.0f} sent to {pending['beneficiary']} ({pending['label']})\nRef: {pending['tx_id']}")
    except Exception:
        pass
    return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}



@router.post("/choice/pay/bank-transfer/confirm-sms")
async def bank_transfer_confirm_sms(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Auto-capture Choice Bank SMS OTP for PesaLink / internal bank transfer."""
    import asyncio as _asyncio
    from app.api.routes.extension import _pending_sms_otps

    pending = _pending_bank_transfer.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transfer. Please start again.")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")

    account_last_4 = str(trader.choice_account_id)[-4:]
    cached = _pending_sms_otps.get(account_last_4)
    import time as _t
    if cached and cached.get("otp") and cached.get("event") is None and _t.time() - cached.get("ts", 0) < 300:
        otp = cached["otp"]
        _pending_sms_otps.pop(account_last_4, None)
    else:
        event = _asyncio.Event()
        _pending_sms_otps[account_last_4] = {"event": event, "otp": None}
        try:
            try:
                await _asyncio.wait_for(event.wait(), timeout=120.0)
            except _asyncio.TimeoutError:
                logger.warning("[SMS-OTP] bank-transfer 120s timeout for ****" + account_last_4 + " - resending")
                try:
                    await choice.resend_otp(pending["tx_id"], otp_type="SMS")
                except Exception as _re:
                    logger.warning("[SMS-OTP] resend_otp failed: " + str(_re))
                event.clear()
                _pending_sms_otps[account_last_4]["otp"] = None
                try:
                    await _asyncio.wait_for(event.wait(), timeout=90.0)
                except _asyncio.TimeoutError:
                    raise HTTPException(status_code=408, detail="SMS OTP did not arrive. Check your phone and try again.")
            otp = (_pending_sms_otps.get(account_last_4) or {}).get("otp")
            if not otp:
                raise HTTPException(status_code=500, detail="SMS OTP event fired but no code stored")
        finally:
            _pending_sms_otps.pop(account_last_4, None)

    logger.info("[SMS-OTP] bank-transfer OTP received for ****" + account_last_4 + " - confirming")
    try:
        result = await choice.confirm_otp(pending["tx_id"], otp)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_bank_transfer.pop(trader.id, None)
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_BANK_TRANSFER, -float(pending["amount"]),
                              f"Transfer to {pending['beneficiary']} ({pending['label']}) via Choice Bank",
                              mpesa_receipt=pending["tx_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001f3e6 KES {pending['amount']:,.0f} sent to {pending['beneficiary']} ({pending['label']})\nRef: {pending['tx_id']}")
    except Exception:
        pass
    return {"status": "success", "tx_id": pending["tx_id"], "amount": pending["amount"]}

# ── Payments Hub — RTGS ────────────────────────────────────────────────────────

class RtgsInitiateBody(BaseModel):
    beneficiary_account: str
    beneficiary_name: str
    bank_code: str
    bank_name: str
    amount: float
    payment_purpose: str = "SparkP2P transfer"
    remark: str = ""


_pending_rtgs: dict[int, dict] = {}


@router.post("/choice/pay/rtgs/initiate")
async def rtgs_initiate(body: RtgsInitiateBody, trader: Trader = Depends(get_current_trader)):
    """Initiate a domestic RTGS interbank transfer. OTP sent to email (SMS fallback)."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if not (body.bank_code or "").strip():
        raise HTTPException(status_code=400, detail="Select a destination bank")
    if not (body.beneficiary_account or "").strip():
        raise HTTPException(status_code=400, detail="Enter the beneficiary account number")
    if not (body.beneficiary_name or "").strip():
        raise HTTPException(status_code=400, detail="Enter the beneficiary name")

    try:
        result = await choice.large_domestic_interbank_transfer(
            payer_account_id=trader.choice_account_id,
            beneficiary_bank_code=body.bank_code.strip(),
            beneficiary_bank_name=body.bank_name.strip(),
            beneficiary_account_id=body.beneficiary_account.strip(),
            beneficiary_name=body.beneficiary_name.strip(),
            amount=body.amount,
            payment_channel="RTGS",
            payment_purpose=body.payment_purpose or "SparkP2P transfer",
            message_to_beneficiary=body.remark or "",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"RTGS initiation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "RTGS transfer rejected"))

    app_id = (result.get("data") or {}).get("applicationId") or ""
    if not app_id:
        raise HTTPException(status_code=502, detail="No application ID returned")

    otp_channel = "SMS"
    try:
        otp_res = await choice.send_otp(app_id, otp_type="SMS")
        if otp_res.get("code") != "00000":
            await choice.send_otp(app_id, otp_type="SMS")
            otp_channel = "SMS"
    except Exception as exc:
        logger.warning(f"[ChoiceBank] RTGS sendOtp failed: {exc}")

    _pending_rtgs[trader.id] = {
        "app_id": app_id, "amount": body.amount,
        "beneficiary": body.beneficiary_name.strip(),
        "bank": body.bank_name.strip(),
        "account": body.beneficiary_account.strip(),
    }
    msg = "Enter the OTP Choice Bank sent to your registered phone to confirm this RTGS transfer."
    return {"status": "otp_sent", "message": msg}


@router.post("/choice/pay/rtgs/confirm")
async def rtgs_confirm(
    body: SendMoneyConfirm, trader: Trader = Depends(get_current_trader), db: AsyncSession = Depends(get_db)
):
    """Confirm OTP for an RTGS transfer."""
    pending = _pending_rtgs.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending RTGS transfer. Please start again.")
    try:
        result = await choice.confirm_otp(pending["app_id"], body.otp.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_rtgs.pop(trader.id, None)
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_RTGS, -float(pending["amount"]),
                              f"RTGS to {pending['beneficiary']} at {pending['bank']} (acc {pending['account']})",
                              mpesa_receipt=pending["app_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001F3DB RTGS KES {pending['amount']:,.0f} to {pending['beneficiary']} at {pending['bank']}\nRef: {pending['app_id']}")
    except Exception:
        pass
    return {"status": "success", "application_id": pending["app_id"], "amount": pending["amount"]}



@router.post("/choice/pay/rtgs/confirm-sms")
async def rtgs_confirm_sms(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Auto-capture Choice Bank SMS OTP for RTGS transfer."""
    import asyncio as _asyncio
    from app.api.routes.extension import _pending_sms_otps

    pending = _pending_rtgs.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending RTGS transfer. Please start again.")
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")

    account_last_4 = str(trader.choice_account_id)[-4:]
    cached = _pending_sms_otps.get(account_last_4)
    import time as _t
    if cached and cached.get("otp") and cached.get("event") is None and _t.time() - cached.get("ts", 0) < 300:
        otp = cached["otp"]
        _pending_sms_otps.pop(account_last_4, None)
    else:
        event = _asyncio.Event()
        _pending_sms_otps[account_last_4] = {"event": event, "otp": None}
        try:
            try:
                await _asyncio.wait_for(event.wait(), timeout=120.0)
            except _asyncio.TimeoutError:
                logger.warning("[SMS-OTP] rtgs 120s timeout for ****" + account_last_4 + " - resending")
                try:
                    await choice.resend_otp(pending["app_id"], otp_type="SMS")
                except Exception as _re:
                    logger.warning("[SMS-OTP] resend_otp failed: " + str(_re))
                event.clear()
                _pending_sms_otps[account_last_4]["otp"] = None
                try:
                    await _asyncio.wait_for(event.wait(), timeout=90.0)
                except _asyncio.TimeoutError:
                    raise HTTPException(status_code=408, detail="SMS OTP did not arrive. Check your phone and try again.")
            otp = (_pending_sms_otps.get(account_last_4) or {}).get("otp")
            if not otp:
                raise HTTPException(status_code=500, detail="SMS OTP event fired but no code stored")
        finally:
            _pending_sms_otps.pop(account_last_4, None)

    logger.info("[SMS-OTP] rtgs OTP received for ****" + account_last_4 + " - confirming")
    try:
        result = await choice.confirm_otp(pending["app_id"], otp)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OTP confirmation failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "Invalid or expired OTP"))

    _pending_rtgs.pop(trader.id, None)
    try:
        from app.services.ledger import record_activity
        from app.models.wallet import TransactionType as _TT
        await record_activity(db, trader.id, _TT.CHOICE_RTGS, -float(pending["amount"]),
                              f"RTGS to {pending['beneficiary']} at {pending['bank']} (acc {pending['account']})",
                              mpesa_receipt=pending["app_id"])
        await db.commit()
    except Exception:
        pass
    try:
        from app.api.routes.telegram import notify_trader
        await notify_trader(trader, f"\U0001f3db RTGS KES {pending['amount']:,.0f} to {pending['beneficiary']} at {pending['bank']}\nRef: {pending['app_id']}")
    except Exception:
        pass
    return {"status": "success", "application_id": pending["app_id"], "amount": pending["amount"]}

# ── Payments Hub — Generic OTP resend ─────────────────────────────────────────

class ResendOtpBody(BaseModel):
    flow: str  # "send_money" | "paybill" | "bank_transfer" | "rtgs"

@router.post("/choice/pay/resend-otp")
async def resend_payment_otp(body: ResendOtpBody, trader: Trader = Depends(get_current_trader)):
    """Re-send the OTP for a pending payment flow. Caller provides the flow name."""
    _flow_map = {
        "send_money":    _pending_send_money,
        "paybill":       _pending_paybill,
        "bank_transfer": _pending_bank_transfer,
        "rtgs":          _pending_rtgs,
    }
    store = _flow_map.get(body.flow)
    if store is None:
        raise HTTPException(status_code=400, detail="Unknown flow")
    pending = store.get(trader.id)
    if not pending:
        raise HTTPException(status_code=400, detail="No pending transaction — please start over")
    tx_id = pending.get("tx_id") or pending.get("app_id")
    if not tx_id:
        raise HTTPException(status_code=400, detail="Missing transaction reference")
    try:
        await choice.resend_otp(tx_id, otp_type="SMS")
    except Exception:
        try:
            await choice.resend_otp(tx_id, otp_type="SMS")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Could not resend OTP: {e}")
    return {"message": "A new OTP has been sent to your email."}


# ── Payments Hub — M-Pesa to Bank (STK Push deposit) ──────────────────────────

class MpesaToBankBody(BaseModel):
    mobile: str
    amount: int   # KES whole number for STK push


@router.post("/choice/pay/mpesa-to-bank")
async def mpesa_to_bank_deposit(body: MpesaToBankBody, trader: Trader = Depends(get_current_trader)):
    """Trigger M-Pesa STK push to deposit funds into the trader's Choice Bank account."""
    if not trader.choice_account_id:
        raise HTTPException(status_code=400, detail="No Choice Bank account linked")
    phone = _normalize_msisdn(body.mobile)
    if len(phone) != 9 or not phone.isdigit() or phone[0] not in ("7", "1"):
        raise HTTPException(status_code=400, detail="Enter a valid Kenyan M-Pesa number")
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if body.amount > 150000:
        raise HTTPException(status_code=400, detail="M-Pesa deposits are limited to KES 150,000 per transaction")

    msisdn = "254" + phone
    try:
        result = await choice.deposit_from_mpesa(
            account_id=trader.choice_account_id,
            mobile=msisdn,
            amount=int(body.amount),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"STK push failed: {exc}")
    if result.get("code") != "00000":
        raise HTTPException(status_code=400, detail=result.get("msg", "STK push rejected"))

    return {
        "status": "stk_sent",
        "message": f"Check your phone for an M-Pesa prompt. Enter your M-Pesa PIN to deposit KES {body.amount:,} into your Choice Bank account.",
    }

