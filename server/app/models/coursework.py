from sqlalchemy import Column, Integer, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


# Represents the 'coursework' table — one row per assignment a teacher creates or syncs
class Coursework(Base):
    __tablename__ = "coursework"

    coursework_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    title = Column(Text, nullable=False)                                     # Name of the assignment
    context = Column(Text, default="")                                       # Optional rubric/learning goals/answer key for the AI
    user_id = Column(Integer, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)  # Which teacher owns this
    google_coursework_id = Column(Text)                                      # ID from Google Classroom (null if manually created)
    google_course_id = Column(Text)                                           # Google Classroom course (class) ID — needed to re-sync submissions in the background
    course_name = Column(Text, default="")                                    # Google Classroom course name — stored so it's available even after a course is archived
    due_date = Column(DateTime, nullable=True)                                # From Classroom's dueDate/dueTime — null if the assignment has none set
    student_count = Column(Integer, nullable=True)                           # Total enrolled in the class (not just submitted) — fetched once per course, not per assignment

    # One coursework has many submissions (one per student)
    # cascade="all, delete" means deleting a coursework also deletes its submissions
    submissions = relationship("Submission", back_populates="coursework", cascade="all, delete")

    # One coursework has at most one AI-generated report
    # uselist=False makes this a single object instead of a list
    report = relationship("Report", back_populates="coursework", uselist=False, cascade="all, delete")
