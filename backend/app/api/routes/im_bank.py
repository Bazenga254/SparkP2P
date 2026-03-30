"""
I&M Bank Payment Gateway — Callback & API Routes

Handles:
- Payment callbacks from I&M (async payment results)
- Account verification endpoint
- Manual settlement trigger
"""

import logging
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.routes.traders import get_current_trader
from app.models import Trader

logger = logging.getLogger(__name__)
router = APIRouter()


# ═══════════════════════════════════════════════════════════
# I&M PAYMENT CALLBACK
# I&M sends payment status here for async payments (M-Pesa, PesaLink)
# HTTP method: PUT (as per I&M spec)
# ═══════════════════════════════════════════════════════════

@router.put("/callback")
async def im_payment_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """
    I&M Bank pushes payment status here.
    Format: {bankReferenceId, bankStatus, reasonCode, reasonText, additions: {...}}
    """
    data = await request.json()
    logger.info(f"[I&M Callback] {data}")

    bank_ref = data.get('bankReferenceId', '')
    status = data.get('bankStatus', '')  # PROCESSED or FAILED
    reason = data.get('reasonText', '')
    additions = data.get('additions', {})
    beneficiary_name = additions.get('beneficiaryName', '')
    txn_id = additions.get('transactionID', '')
    result_desc = additions.get('resultDesc', '')

    if status == 'PROCESSED':
        logger.info(f"[I&M] Payment {bank_ref} processed: {beneficiary_name}, txn={txn_id}")
        # TODO: Match to pending settlement/order and update status
        # This will be connected when I&M credentials are live
    else:
        logger.warning(f"[I&M] Payment {bank_ref} failed: {reason} - {result_desc}")

    # I&M requires HTTP 200 response
    return {"status": "received"}


# ═══════════════════════════════════════════════════════════
# ACCOUNT VERIFICATION
# ═══════════════════════════════════════════════════════════

class VerifyIMAccountRequest(BaseModel):
    account_number: str


@router.post("/verify-account")
async def verify_im_account(
    data: VerifyIMAccountRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Verify an I&M Bank account — returns account holder name."""
    from app.services.im_bank import im_bank_client

    if not im_bank_client.base_url:
        raise HTTPException(status_code=503, detail="I&M Bank integration not yet configured")

    result = await im_bank_client.verify_im_account(data.account_number)

    if result.get('valid'):
        # Compare with trader's KYC name
        account_name = result['account_name'].upper()
        trader_name = trader.full_name.upper()

        # Check name match (at least 2 name parts)
        account_parts = account_name.split()
        trader_parts = trader_name.split()
        match_count = sum(1 for p in trader_parts if p in account_parts)
        name_match = match_count >= 2 or account_name == trader_name

        return {
            'valid': True,
            'account_name': result['account_name'],
            'name_match': name_match,
            'registered_name': trader.full_name,
        }
    else:
        return {
            'valid': False,
            'error': result.get('error', 'Invalid account'),
        }


# ═══════════════════════════════════════════════════════════
# PESALINK LOOKUP
# ═══════════════════════════════════════════════════════════

class PesaLinkLookupRequest(BaseModel):
    phone: str


@router.post("/pesalink-lookup")
async def pesalink_lookup(
    data: PesaLinkLookupRequest,
    trader: Trader = Depends(get_current_trader),
):
    """Look up PesaLink registered banks for a phone number."""
    from app.services.im_bank import im_bank_client

    if not im_bank_client.base_url:
        raise HTTPException(status_code=503, detail="I&M Bank integration not yet configured")

    result = await im_bank_client.pesalink_lookup(data.phone)
    return result
