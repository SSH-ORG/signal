from sqlalchemy import Column, Integer, Text, ForeignKey, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Report(Base):
    __tablename__ = "report"

    report_id = Column(Integer, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    coursework_id = Column(Integer, ForeignKey("coursework.coursework_id", ondelete="CASCADE"), unique=True, nullable=False)
    created_at = Column(TIMESTAMP, server_default=func.now())

    coursework = relationship("Coursework", back_populates="report")
