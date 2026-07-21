from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import report as report_controller

# Global reports router — mounted at /api/reports in main.py
# Returns all assignments that have a generated report, across all courses
router = APIRouter()


@router.get("")
def list_all_reports(
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return report_controller.get_all_reports(user, db)
