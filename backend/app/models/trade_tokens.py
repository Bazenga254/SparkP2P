from datetime import datetime, timezone
from sqlalchemy import Column, Integer, Float, String, DateTime
from app.core.database import Base


class TradeTokenPurchase(Base):
    __tablename__ = "trade_token_purchases"

    id = Column(Integer, primary_key=True, index=True)
    trader_id = Column(Integer, nullable=False, index=True)
    amount_kes = Column(Float, nullable=False)       # KES paid
    tokens_granted = Column(Integer, nullable=False)
    rate_per_token = Column(Float, nullable=False)   # KES per token
    source = Column(String(20), nullable=False)      # 'balance' | 'admin' | 'reimbursement'
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
