from sqlalchemy.orm import Session
from fastapi import HTTPException

from app.models.user import User
from app.models.coursework import Coursework


def get_all_coursework(user: User, db: Session) -> list:
    # Returns all assignments this teacher has imported into Signal
    coursework = db.query(Coursework).filter(Coursework.user_id == user.user_id).all()

    return [
        {
            "coursework_id": cw.coursework_id,
            "title": cw.title,
            "context": cw.context,
            "google_coursework_id": cw.google_coursework_id,
            "submission_count": len(cw.submissions),  # How many student responses are stored
        }
        for cw in coursework
    ]


def update_context(coursework_id: int, context: str, user: User, db: Session) -> dict:
    # Lets a teacher add or edit the rubric/learning-goal context used by the AI report
    cw = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not cw:
        raise HTTPException(status_code=404, detail="Assignment not found")

    cw.context = context
    db.commit()
    db.refresh(cw)

    return {
        "coursework_id": cw.coursework_id,
        "title": cw.title,
        "context": cw.context,
        "google_coursework_id": cw.google_coursework_id,
    }


def get_single_coursework(coursework_id: int, user: User, db: Session) -> dict:
    # Returns one assignment with its submissions and report (if generated)
    cw = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,  # Make sure this assignment belongs to this teacher
    ).first()

    if not cw:
        raise HTTPException(status_code=404, detail="Assignment not found")

    return {
        "coursework_id": cw.coursework_id,
        "title": cw.title,
        "context": cw.context,
        "google_coursework_id": cw.google_coursework_id,
        "submissions": [
            {"submission_id": s.submission_id, "content": s.content}
            for s in cw.submissions
        ],
        "report": {"content": cw.report.content} if cw.report else None,
    }
