from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.controllers import auth as auth_controller

# Auth router — all routes here are mounted at /auth in main.py
router = APIRouter()


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
