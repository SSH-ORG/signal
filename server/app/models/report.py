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

    # How many real-content submissions actually went into this report's AI
    # prompt, vs. how many existed at build time — differ only when a class
    # exceeds MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT (see controllers/report.py),
    # in which case the report only analyzed the first analyzed_submission_count
    # of them. Lets the UI/email disclose that honestly instead of describing
    # "the class" from a subset silently.
    analyzed_submission_count = Column(Integer, nullable=False, server_default="0")
    total_submission_count = Column(Integer, nullable=False, server_default="0")

    # Link back to the parent coursework
    coursework = relationship("Coursework", back_populates="report")
