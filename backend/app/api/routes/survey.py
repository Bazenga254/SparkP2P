from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_admin_trader, get_db, get_employee_or_admin
from app.models.survey import SurveyResponse
from app.services.sms import send_sms

router = APIRouter()

WA_GROUP_INVITE = "https://chat.whatsapp.com/BWLzd6ZI3LxHyYMhhOww57"

QUALIFYING_FREQUENCIES = {
    "Multiple times every day",
    "Once or twice every day",
}
QUALIFYING_VOLUMES = {
    "KES 5,000,000 – KES 10,000,000",
    "More than KES 10,000,000",
}


class SurveySubmit(BaseModel):
    full_name: str
    phone: str
    q1_is_merchant: str
    q2_trade_frequency: str | None = None
    q3_daily_volume: str | None = None
    q4_account_frozen: str | None = None
    q5_has_automation: str | None = None
    q5_automation_name: str | None = None
    q6_biggest_challenge: str | None = None
    q7_daily_transactions: str | None = None


def _normalize_phone(phone: str) -> str:
    return phone.strip().replace(" ", "").replace("-", "").lstrip("+")


@router.get("/check")
async def check_submission(phone: str, db: AsyncSession = Depends(get_db)):
    normalized = _normalize_phone(phone)
    result = await db.execute(select(SurveyResponse))
    all_rows = result.scalars().all()
    match = next(
        (r for r in all_rows if _normalize_phone(r.phone) == normalized),
        None
    )
    if match:
        return {
            "submitted": True,
            "is_qualified": match.is_qualified,
            "disqualified": match.disqualified,
            "invite_sent": match.invite_sent,
        }
    return {"submitted": False}


@router.post("/submit")
async def submit_survey(data: SurveySubmit, db: AsyncSession = Depends(get_db)):
    disqualified = data.q1_is_merchant.lower() != "yes"

    is_qualified = (
        not disqualified
        and data.q2_trade_frequency in QUALIFYING_FREQUENCIES
        and data.q3_daily_volume in QUALIFYING_VOLUMES
    )

    response = SurveyResponse(
        full_name=data.full_name,
        phone=data.phone,
        q1_is_merchant=data.q1_is_merchant,
        q2_trade_frequency=data.q2_trade_frequency,
        q3_daily_volume=data.q3_daily_volume,
        q4_account_frozen=data.q4_account_frozen,
        q5_has_automation=data.q5_has_automation,
        q5_automation_name=data.q5_automation_name,
        q6_biggest_challenge=data.q6_biggest_challenge,
        q7_daily_transactions=data.q7_daily_transactions,
        is_qualified=is_qualified,
        disqualified=disqualified,
    )
    db.add(response)
    await db.commit()
    await db.refresh(response)

    return {
        "id": response.id,
        "is_qualified": is_qualified,
        "disqualified": disqualified,
    }


@router.get("/responses")
async def get_survey_responses(
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_employee_or_admin),
):
    if not current_user.is_admin:
        perms = current_user.permissions or {}
        if not perms.get("survey"):
            raise HTTPException(status_code=403, detail="Survey access not permitted")
    result = await db.execute(
        select(SurveyResponse).order_by(SurveyResponse.submitted_at.desc())
    )
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "full_name": r.full_name,
            "phone": r.phone,
            "q1_is_merchant": r.q1_is_merchant,
            "q2_trade_frequency": r.q2_trade_frequency,
            "q3_daily_volume": r.q3_daily_volume,
            "q4_account_frozen": r.q4_account_frozen,
            "q5_has_automation": r.q5_has_automation,
            "q5_automation_name": r.q5_automation_name,
            "q6_biggest_challenge": r.q6_biggest_challenge,
            "q7_daily_transactions": r.q7_daily_transactions,
            "is_qualified": r.is_qualified,
            "disqualified": r.disqualified,
            "invite_sent": r.invite_sent,
            "invite_sent_at": r.invite_sent_at.isoformat() if r.invite_sent_at else None,
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        }
        for r in rows
    ]


@router.post("/{response_id}/send-invite")
async def send_invite(
    response_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_employee_or_admin),
):
    if not current_user.is_admin:
        perms = current_user.permissions or {}
        if not perms.get("survey"):
            raise HTTPException(status_code=403, detail="Survey access not permitted")
    result = await db.execute(
        select(SurveyResponse).where(SurveyResponse.id == response_id)
    )
    resp = result.scalar_one_or_none()
    if not resp:
        raise HTTPException(status_code=404, detail="Response not found")

    first = resp.full_name.strip().split()[0] if resp.full_name else "Merchant"
    msg = (
        f"Hi {first}! You've qualified to join the SparkP2P Merchant Group. "
        f"Click to join on WhatsApp: {WA_GROUP_INVITE}"
    )
    sent = send_sms(resp.phone, msg)
    if sent:
        resp.invite_sent = True
        resp.invite_sent_at = datetime.now(timezone.utc)
        await db.commit()
        return {"success": True}
    raise HTTPException(status_code=500, detail="SMS failed to send")
