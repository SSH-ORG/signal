from sqlalchemy import Column, Integer, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


# Represents the 'submission' table — one row per enrolled student for an assignment,
# kept in sync with Google's live state, whether or not that student has submitted
# anything. content is empty ("") for anyone who hasn't turned in real, readable work —
# see google.py's sync_coursework and SUBMITTED_STATES for what actually counts.
class Submission(Base):
    __tablename__ = "submission"

    submission_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    content = Column(Text, nullable=False)                                   # The actual student response text
    coursework_id = Column(Integer, ForeignKey("coursework.coursework_id", ondelete="CASCADE"), nullable=False)  # Which assignment this belongs to
    google_submission_id = Column(Text)                                      # ID from Google Classroom (null if manually added)
    # Google's per-student user ID from Classroom. Treat as sensitive (FERPA):
    # never expose it raw in API responses or send it to the AI — only used
    # internally for roster/email lookups (see google.py).
    google_user_id = Column(Text)
    student_name = Column(Text, nullable=True)        # Full name from Google Classroom roster
    student_report = Column(Text, nullable=True)  # AI-generated report for this one student's submission
    state = Column(Text, nullable=True)  # Google's raw submission state (TURNED_IN, NEW, CREATED, RETURNED, RECLAIMED_BY_STUDENT...)
    # Google's own last-modified timestamp for this submission — lets sync tell
    # "this genuinely changed" apart from "still the same as last time we looked",
    # so re-extracting content (a real Docs API fetch) only happens when needed
    google_updated_at = Column(Text, nullable=True)

    # Link back to the parent coursework
    coursework = relationship("Coursework", back_populates="submissions")
