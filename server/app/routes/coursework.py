from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import coursework as coursework_controller

# Coursework routes — all mounted at /api/coursework in main.py
router = APIRouter()


# Request body for updating an assignment's context — 3 separate fields, not
# one combined string, so nothing here needs to be reconstructed by parsing
class ContextUpdateRequest(BaseModel):
    mental_model: str = ""
    assignment_description: str = ""
    rubric: str = ""
    include_description: bool = True
    include_rubric: bool = True


# GET /api/coursework
# Returns all assignments this teacher has already synced into Signal
@router.get("/")
def list_coursework(user: User = Depends(require_login), db: Session = Depends(get_db)):
    return coursework_controller.get_all_coursework(user, db)


# PATCH /api/coursework/{coursework_id}
# Lets a teacher add or edit the mental model/reference material used by the AI report
@router.patch("/{coursework_id}")
def update_coursework_context(
    coursework_id: int,
    body: ContextUpdateRequest,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return coursework_controller.update_context(
        coursework_id,
        body.mental_model,
        body.assignment_description,
        body.rubric,
        body.include_description,
        body.include_rubric,
        user,
        db,
    )
