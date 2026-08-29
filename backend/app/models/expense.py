from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime
from datetime import datetime, timezone, date as _date
from app.core.database import Base


class Expense(Base):
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, index=True)
    description = Column(String(500), nullable=False)
    # For a recurring expense, `amount` is the MONTHLY cost (KES/month), effective from
    # expense_date onward — logged once, it applies every month. The dashboard amortises
    # it to whatever period is shown (a day gets ~amount/30, a full month gets `amount`).
    amount = Column(Float, nullable=False)
    category = Column(String(100), nullable=True, default="general")
    expense_date = Column(Date, nullable=False, default=_date.today)   # start / one-off date
    recurring = Column(Boolean, nullable=False, default=True)          # True = monthly recurring
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
