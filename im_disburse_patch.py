#!/usr/bin/env python3
"""Appends I&M disbursement endpoints to extension.py on the VPS."""

new_code = """

# ═══════════════════════════════════════════════════════════
# I&M BANK DISBURSEMENTS — Desktop executes trader payouts
# ═══════════════════════════════════════════════════════════

@router.get("/pending-im-disbursements")
async def get_pending_im_disbursements(
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    \"\"\"Desktop app polls this for pending I&M bank transfers to traders.\"\"\"
    from sqlalchemy import select as sa_select
    result = await db.execute(
        sa_select(WalletTransaction, Trader)
        .join(Trader, WalletTransaction.trader_id == Trader.id)
        .where(
            WalletTransaction.transaction_type == TransactionType.WITHDRAWAL,
            WalletTransaction.status == "pending",
            WalletTransaction.settlement_method == "bank_paybill",
        )
        .order_by(WalletTransaction.created_at)
    )
    rows = result.all()
    return {
        "disbursements": [
            {
                "disbursement_id": txn.id,
                "trader_id": txn.trader_id,
                "trader_name": t.full_name,
                "account_number": txn.destination or t.settlement_account or "",
                "bank_name": t.settlement_bank_name or "I & M Bank Ltd",
                "amount": abs(txn.amount),
                "reference": "SparkP2P-WD" + str(txn.id),
            }
            for txn, t in rows
            if (txn.destination or t.settlement_account)
        ]
    }


class ImDisbursementResultRequest(BaseModel):
    disbursement_id: int
    reference_id: Optional[str] = None
    error: Optional[str] = None


@router.post("/im-disbursement-complete")
async def im_disbursement_complete(
    data: ImDisbursementResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    \"\"\"Desktop app calls this after I&M bank transfer to trader completes.\"\"\"
    from datetime import datetime, timezone as tz
    result = await db.execute(
        select(WalletTransaction).where(WalletTransaction.id == data.disbursement_id)
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(status_code=404, detail="Disbursement not found")
    txn.status = "completed"
    txn.processed_at = datetime.now(tz.utc)
    txn.processed_by = "settlement_bot:" + str(data.reference_id or "ok")
    await db.commit()
    return {"status": "ok", "disbursement_id": txn.id}


@router.post("/im-disbursement-failed")
async def im_disbursement_failed(
    data: ImDisbursementResultRequest,
    trader: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    \"\"\"Desktop app calls this if I&M bank transfer to trader failed.\"\"\"
    result = await db.execute(
        select(WalletTransaction).where(WalletTransaction.id == data.disbursement_id)
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(status_code=404, detail="Disbursement not found")
    err_str = str(data.error or "unknown")[:100]
    txn.status = "failed"
    txn.processed_by = "settlement_bot:failed:" + err_str
    await db.commit()
    return {"status": "failed", "disbursement_id": txn.id}
"""

target = "/root/SparkP2P/backend/app/api/routes/extension.py"
with open(target, "a") as f:
    f.write(new_code)
print("Appended OK")
