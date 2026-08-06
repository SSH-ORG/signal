from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload
from fastapi import HTTPException

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission
from app.controllers.google import SUBMITTED_STATES


def get_all_coursework(user: User, db: Session) -> list:
    # Returns all assignments this teacher has synced into Signal
    coursework = db.query(Coursework).options(
        selectinload(Coursework.report)
    ).filter(Coursework.user_id == user.user_id).all()

    # A plain count, not selectinload(Coursework.submissions) — this only ever
    # needs how many students actually submitted, not their full text content,
    # and this runs on every Courses-screen visit, for every assignment ever
    # synced. Every enrolled student has a row now (see sync_coursework), so this
    # must filter to submitted states — otherwise it would count everyone, not
    # just who submitted.
    counts = dict(
        db.query(Submission.coursework_id, func.count(Submission.submission_id))
        .join(Coursework, Coursework.coursework_id == Submission.coursework_id)
        .filter(Coursework.user_id == user.user_id, Submission.state.in_(SUBMITTED_STATES))
        .group_by(Submission.coursework_id)
        .all()
    )

    # Separate, unfiltered count — every enrolled student, submitted or not.
    # Lets the classwide report's Flagged Students card show "of N students"
    # without the Detail screen needing to visit the Students tab first.
    total_counts = dict(
        db.query(Submission.coursework_id, func.count(Submission.submission_id))
        .join(Coursework, Coursework.coursework_id == Submission.coursework_id)
        .filter(Coursework.user_id == user.user_id)
        .group_by(Submission.coursework_id)
        .all()
    )

    # Real-content count — matches build_report's own filter exactly (non-null,
    # non-whitespace-only content), not just "submitted" state. This is what the
    # 50-submission cap actually counts against, so it's what the Detail screen's
    # pre-build warning needs — submission_count above would over/undercount it
    # since a submission can be in a SUBMITTED_STATES state but still be blank.
    content_counts = dict(
        db.query(Submission.coursework_id, func.count(Submission.submission_id))
        .join(Coursework, Coursework.coursework_id == Submission.coursework_id)
        .filter(
            Coursework.user_id == user.user_id,
            Submission.content.isnot(None),
            func.trim(Submission.content) != "",
        )
        .group_by(Submission.coursework_id)
        .all()
    )

    return [
        {
            "coursework_id": cw.coursework_id,
            "title": cw.title,
            "mental_model": cw.mental_model,
            "assignment_description": cw.assignment_description,
            "rubric": cw.rubric,
            "include_description": cw.include_description,
            "include_rubric": cw.include_rubric,
            "google_coursework_id": cw.google_coursework_id,
            "google_course_id": cw.google_course_id,  # Lets Reports/Detail navigate without a live Google lookup
            "course_name": cw.course_name or "",
            "due_date": cw.due_date.isoformat() if cw.due_date else None,
            "submission_count": counts.get(cw.coursework_id, 0),
            "total_students": total_counts.get(cw.coursework_id, 0),
            "content_submission_count": content_counts.get(cw.coursework_id, 0),
            "has_report": cw.report is not None,  # Lets the Detail screen skip fetching a report that doesn't exist yet
        }
        for cw in coursework
    ]


def update_context(
    coursework_id: int,
    mental_model: str,
    assignment_description: str,
    rubric: str,
    include_description: bool,
    include_rubric: bool,
    user: User,
    db: Session,
) -> dict:
    # Lets a teacher add or edit the mental model/reference material used by the AI report.
    # Each field is its own column — no combined string to reconstruct, so a teacher's own
    # text can never be mistaken for a section boundary and silently truncated.
    cw = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not cw:
        raise HTTPException(status_code=404, detail="Assignment not found")

    cw.mental_model = mental_model
    cw.assignment_description = assignment_description
    cw.rubric = rubric
    cw.include_description = include_description
    cw.include_rubric = include_rubric
    db.commit()
    db.refresh(cw)

    return {
        "coursework_id": cw.coursework_id,
        "title": cw.title,
        "mental_model": cw.mental_model,
        "assignment_description": cw.assignment_description,
        "rubric": cw.rubric,
        "include_description": cw.include_description,
        "include_rubric": cw.include_rubric,
        "google_coursework_id": cw.google_coursework_id,
    }
