from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import email as email_controller

# Email routes — mounted at /api/coursework/{coursework_id}/report/email in main.py
router = APIRouter()


class EmailRequest(BaseModel):
    # The address to send the report to — defaults to the teacher's own email on the frontend
    to: str


# POST /api/coursework/{coursework_id}/report/email
# Sends the AI-generated report for an assignment as a formatted HTML email via Resend
@router.post("")
async def email_report(
    coursework_id: int,
    body: EmailRequest,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await email_controller.send_report_email(coursework_id, body.to, user, db)
