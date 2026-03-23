import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Trader, ChatMessage
from app.api.deps import get_current_trader

logger = logging.getLogger(__name__)

router = APIRouter()


class SendMessageRequest(BaseModel):
    order_id: int
    message: str


@router.post("/send")
async def send_chat_message(
    data: SendMessageRequest,
    sender: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Send a chat message about an order/dispute."""
    role = sender.role if sender.role in ("employee", "admin") else "trader"
    if sender.is_admin:
        role = "admin"

    msg = ChatMessage(
        order_id=data.order_id,
        sender_id=sender.id,
        sender_role=role,
        message=data.message,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)

    return {
        "id": msg.id,
        "order_id": msg.order_id,
        "sender_id": msg.sender_id,
        "sender_role": msg.sender_role,
        "message": msg.message,
        "created_at": msg.created_at.isoformat() if msg.created_at else "",
    }


@router.get("/history/{order_id}")
async def get_chat_history(
    order_id: int,
    sender: Trader = Depends(get_current_trader),
    db: AsyncSession = Depends(get_db),
):
    """Get chat history for an order."""
    result = await db.execute(
        select(ChatMessage, Trader.full_name.label("sender_name"))
        .join(Trader, ChatMessage.sender_id == Trader.id)
        .where(ChatMessage.order_id == order_id)
        .order_by(ChatMessage.created_at.asc())
    )
    rows = result.all()

    return [
        {
            "id": msg.id,
            "order_id": msg.order_id,
            "sender_id": msg.sender_id,
            "sender_name": sender_name,
            "sender_role": msg.sender_role,
            "message": msg.message,
            "created_at": msg.created_at.isoformat() if msg.created_at else "",
        }
        for msg, sender_name in rows
    ]
