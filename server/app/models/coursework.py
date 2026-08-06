from sqlalchemy import Column, Integer, Text, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


# Represents the 'coursework' table — one row per assignment a teacher creates or syncs
class Coursework(Base):
    __tablename__ = "coursework"

    coursework_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    title = Column(Text, nullable=False)                                     # Name of the assignment
    # Stored as 3 separate columns (not one combined string reconstructed by
    # regex on read) — a teacher's own text could otherwise contain something
    # that looks like a section boundary ("Rubric:" on its own line, say) and
    # get silently truncated, which then gets written right back on the next
    # save and permanently erases whatever was truncated away. See the
    # `context` property below for the assembled shape build_report reads.
    mental_model = Column(Text, nullable=False, default="")        # The teacher's own definition of correct understanding
    assignment_description = Column(Text, nullable=False, default="")  # Reference material — the assignment prompt itself
    rubric = Column(Text, nullable=False, default="")               # Reference material — grading criteria/answer key
    # Whether each reference material is actually sent to the AI — a teacher
    # can keep one visible/editable here while excluding it from what the
    # report is built from (e.g. a rubric's grading-criteria framing)
    include_description = Column(Boolean, nullable=False, default=True)
    include_rubric = Column(Boolean, nullable=False, default=True)
    user_id = Column(Integer, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)  # Which teacher owns this
    google_coursework_id = Column(Text)                                      # ID from Google Classroom (null if manually created)
    google_course_id = Column(Text)                                           # Google Classroom course (class) ID — needed to re-sync submissions in the background
    course_name = Column(Text, default="")                                    # Google Classroom course name — stored so it's available even after a course is archived
    due_date = Column(DateTime, nullable=True)                                # From Classroom's dueDate/dueTime — null if the assignment has none set
    work_type = Column(Text, nullable=True)                                  # Classroom's workType (ASSIGNMENT/SHORT_ANSWER_QUESTION) — null until synced

    # One coursework has many submissions (one per enrolled student, see Submission).
    # cascade="all, delete" means deleting a coursework also deletes its submissions.
    # Ordered by submission_id here, once, as the single source of truth — build_report's
    # "Student N" numbering and get_submissions_list both depend on a stable order, and
    # previously each had to remember to sort the same way independently (a real bug we
    # hit once already); baking it into the relationship itself removes that risk for
    # any future caller too.
    submissions = relationship(
        "Submission", back_populates="coursework", cascade="all, delete",
        order_by="Submission.submission_id",
    )

    # One coursework has at most one AI-generated report
    # uselist=False makes this a single object instead of a list
    report = relationship("Report", back_populates="coursework", uselist=False, cascade="all, delete")

    @property
    def context(self) -> str:
        # Assembled fresh from the 3 real columns, in the same labeled shape
        # the AI prompt has always expected — build_report/build_student_report
        # read this exact property, so nothing about report generation changes.
        parts = []
        if self.mental_model:
            parts.append(f"Mental Model:\n{self.mental_model}")
        if self.include_description and self.assignment_description:
            parts.append(f"Assignment Description:\n{self.assignment_description}")
        if self.include_rubric and self.rubric:
            parts.append(f"Rubric:\n{self.rubric}")
        return "\n\n".join(parts)
