from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import require_login
from app.models.user import User
from app.controllers import auth as auth_controller

# Auth router — all routes here are mounted at /auth in main.py
router = APIRouter()


# Request body for updating the teacher's profile — all fields optional so the
# frontend can send just what changed (e.g. only the notification toggle)
class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    email: str | None = None
    email_notifications_enabled: bool | None = None


# Redirects teacher to Google login page
@router.get("/google")
async def login(request: Request):
    return await auth_controller.google_login(request)


# Google redirects here after teacher signs in
@router.get("/google/callback", name="auth_callback")
async def callback(request: Request, db: Session = Depends(get_db)):
    return await auth_controller.google_callback(request, db)


# Logs the teacher out by clearing their session
@router.post("/logout")
async def logout(request: Request):
    return await auth_controller.logout(request)


# Returns the currently logged-in teacher — frontend calls this on load
@router.get("/me")
async def me(request: Request, db: Session = Depends(get_db)):
    return await auth_controller.get_me(request, db)


# Updates the teacher's editable profile fields (name, email, notification preference)
@router.patch("/profile")
async def update_profile(
    body: ProfileUpdateRequest,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await auth_controller.update_profile(
        body.display_name, body.email, body.email_notifications_enabled, user, db
    )


# Permanently deletes the teacher's account and all their data
@router.delete("/account")
async def delete_account(
    request: Request,
    user: User = Depends(require_login),
    db: Session = Depends(get_db),
):
    return await auth_controller.delete_account(request, user, db)
