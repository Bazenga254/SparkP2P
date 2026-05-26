from sqlalchemy import Column, Integer, String, Float, Date, DateTime
from datetime import datetime, timezone, date as _date
from app.core.database import Base


class Expense(Base):
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, index=True)
    description = Column(String(500), nullable=False)
    amount = Column(Float, nullable=False)
    category = Column(String(100), nullable=True, default="general")
    expense_date = Column(Date, nullable=False, default=_date.today)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
