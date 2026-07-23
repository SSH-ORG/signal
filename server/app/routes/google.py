from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import google as google_controller

# Google Classroom sync routes — all mounted at /api/google in main.py
router = APIRouter()


# Request body for the import endpoint — frontend must send the course_id
# alongside the request so we know which Google Classroom course to pull from
class ImportRequest(BaseModel):
    course_id: str            # The Google Classroom course ID the assignment belongs to
    context: str | None = None  # Teacher-reviewed context/rubric; falls back to the Classroom description if omitted
    course_name: str = ""     # Course name stored so it's available even after a course is archived


# GET /api/google/coursework
# Returns { courses, coursework } — every active Google Classroom course (even ones
# with no assignments yet) plus a flat list of assignments across all of them
# Does NOT save anything to our database — just a live fetch for browsing
@router.get("/coursework")
async def list_google_coursework(
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await google_controller.fetch_google_coursework(user, db)


# GET /api/google/coursework/{google_coursework_id}/rubric?course_id=...
# Fetches the structured rubric from Google Classroom and returns it as formatted text
# The frontend uses this to pre-fill the context box on the Assignment Detail screen
@router.get("/coursework/{google_coursework_id}/rubric")
async def get_rubric(
    google_coursework_id: str,
    course_id: str,  # Required query param — GC rubric API needs both IDs
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await google_controller.fetch_rubric(google_coursework_id, course_id, user, db)


# POST /api/google/coursework/{google_coursework_id}/import
# Imports a specific assignment and all its student submissions into our database
# After importing, the assignment will appear in GET /api/coursework
@router.post("/coursework/{google_coursework_id}/import")
async def import_coursework(
    google_coursework_id: str,
    body: ImportRequest,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await google_controller.import_google_coursework(
        google_coursework_id, body.course_id, user, db,
        context=body.context, course_name=body.course_name,
    )
