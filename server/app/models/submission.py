from sqlalchemy import Column, Integer, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


class Submission(Base):
    __tablename__ = "submission"

    submission_id = Column(Integer, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    coursework_id = Column(Integer, ForeignKey("coursework.coursework_id", ondelete="CASCADE"), nullable=False)
    google_submission_id = Column(Text)

    coursework = relationship("Coursework", back_populates="submissions")
