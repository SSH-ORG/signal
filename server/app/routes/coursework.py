from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import coursework as coursework_controller

# Coursework routes — all mounted at /api/coursework in main.py
router = APIRouter()


# Request body for updating an assignment's context
class ContextUpdateRequest(BaseModel):
    context: str  # Rubric / learning goals / answer key the teacher wants the AI to use


# GET /api/coursework
# Returns all assignments this teacher has already imported into Signal
@router.get("/")
def list_coursework(user: User = Depends(require_login), db: Session = Depends(get_db)):
    return coursework_controller.get_all_coursework(user, db)


# GET /api/coursework/{coursework_id}
# Returns a single assignment with all its submissions and AI report (if one exists)
@router.get("/{coursework_id}")
def get_coursework(
    coursework_id: int,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return coursework_controller.get_single_coursework(coursework_id, user, db)


# PATCH /api/coursework/{coursework_id}
# Lets a teacher add or edit the rubric/learning-goal context used by the AI report
@router.patch("/{coursework_id}")
def update_coursework_context(
    coursework_id: int,
    body: ContextUpdateRequest,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return coursework_controller.update_context(coursework_id, body.context, user, db)
