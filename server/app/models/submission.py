from sqlalchemy import Column, Integer, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


# Represents the 'submission' table — one row per student submission for an assignment
class Submission(Base):
    __tablename__ = "submission"

    submission_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    content = Column(Text, nullable=False)                                   # The actual student response text
    coursework_id = Column(Integer, ForeignKey("coursework.coursework_id", ondelete="CASCADE"), nullable=False)  # Which assignment this belongs to
    google_submission_id = Column(Text)                                      # ID from Google Classroom (null if manually added)
    # Google's per-student user ID from Classroom — stable but opaque without the
    # classroom.rosters.readonly scope we don't request. Treat as sensitive (FERPA):
    # never expose it raw in API responses, only ever surface an anonymized label
    # derived from it (e.g. "Student #4f2a") when flagged-student features are built.
    google_user_id = Column(Text)

    # Link back to the parent coursework
    coursework = relationship("Coursework", back_populates="submissions")
