from sqlalchemy import Column, Integer, Text, ForeignKey, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


# Represents the 'report' table — one AI-generated confusion report per assignment
# A report is created by sending all submissions to the AI and storing the response
class Report(Base):
    __tablename__ = "report"

    report_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    content = Column(Text, nullable=False)                              # The full AI-generated report text
    coursework_id = Column(                                             # Which assignment this report belongs to
        Integer,
        ForeignKey("coursework.coursework_id", ondelete="CASCADE"),
        unique=True,    # Enforces one report per assignment at the database level
        nullable=False
    )
    created_at = Column(TIMESTAMP, server_default=func.now())          # Timestamp set automatically by PostgreSQL when the row is inserted

    # Link back to the parent coursework
    coursework = relationship("Coursework", back_populates="report")
