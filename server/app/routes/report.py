from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import report as report_controller

# Report routes — mounted at /api/coursework/:id/report in main.py
router = APIRouter()


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
# Sends all submissions to the AI and generates a confusion report
# Errors if a report already exists or there are no submissions
@router.post("")
def create_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.generate_report(coursework_id, user, db)


# POST /api/coursework/{coursework_id}/report/email
# Emails the existing report to the teacher's own address
@router.post("/email")
async def email_report(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await report_controller.email_report(coursework_id, user, db)
