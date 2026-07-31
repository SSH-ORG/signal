import asyncio
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import report as report_controller

# Report routes — mounted at /api/coursework/:id/report in main.py
router = APIRouter()


# Optional — a teacher can tailor the Next Step wording before it goes
# directly to a student (e.g. rephrasing from "the student should..." to
# "you should..."). Only affects this one email; the stored report is untouched.
class SendToStudentRequest(BaseModel):
    next_step_override: str | None = None


# GET /api/coursework/{coursework_id}/report
# Returns the existing AI report for an assignment
@router.get("")
def get_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.get_report(coursework_id, user, db)


# POST /api/coursework/{coursework_id}/report
# Sends all submissions to the AI and builds a confusion report
@router.post("")
async def create_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.build_report(coursework_id, user, db)


# POST /api/coursework/{coursework_id}/report/email
# Emails the existing report to the teacher's own address
@router.post("/email")
async def email_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await report_controller.email_report(coursework_id, user, db)


# DELETE /api/coursework/{coursework_id}/report
# Deletes the report so the teacher can rebuild a fresh one
@router.delete("")
def delete_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.delete_report(coursework_id, user, db)


# GET /api/coursework/{coursework_id}/report/submissions
# Lists all submissions for an assignment with their student reports (if built)
@router.get("/submissions")
def list_submissions(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.get_submissions_list(coursework_id, user, db)


# POST /api/coursework/{coursework_id}/report/submissions/{submission_id}
# Builds a student report focused on one student's submission
@router.post("/submissions/{submission_id}")
def build_student(
    coursework_id: int,
    submission_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.build_student_report(coursework_id, submission_id, user, db)


# POST /api/coursework/{coursework_id}/report/submissions/{submission_id}/email
# Emails one student's report to the teacher's own address
@router.post("/submissions/{submission_id}/email")
async def email_student(
    coursework_id: int,
    submission_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await report_controller.email_student_report(coursework_id, submission_id, user, db)


# POST /api/coursework/{coursework_id}/report/submissions/{submission_id}/send-to-student
# Sends one student's report directly to the student's own email
@router.post("/submissions/{submission_id}/send-to-student")
async def send_to_student(
    coursework_id: int,
    submission_id: int,
    body: SendToStudentRequest = SendToStudentRequest(),
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await report_controller.send_student_report(
        coursework_id, submission_id, user, db, next_step_override=body.next_step_override
    )
