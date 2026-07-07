import os
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from authlib.integrations.starlette_client import OAuth

from app.database import get_db
from app.models.user import User

# Create the auth router — all routes here will be prefixed with /auth in main.py
router = APIRouter()

# Set up the OAuth client using Google's OpenID Connect discovery document
# This automatically fetches Google's authorization and token endpoints
oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={
        # Scopes define what data we're requesting access to
        # offline_access gives us a refresh token so we don't need to re-login
        "scope": "openid email profile https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly https://www.googleapis.com/auth/classroom.student-submissions.students.readonly",
        "access_type": "offline",  # Required to receive a refresh token
        "prompt": "consent",       # Forces Google to show the consent screen so we always get a refresh token
    },
)


# GET /auth/google
# Redirects the teacher to Google's login page
@router.get("/google")
async def login(request: Request):
    # Build the URL Google should redirect back to after login
    redirect_uri = request.url_for("auth_callback")
    return await oauth.google.authorize_redirect(request, redirect_uri)


# GET /auth/google/callback
# Google redirects here after the teacher logs in
# We exchange the code for tokens, then find or create the user in our DB
@router.get("/google/callback", name="auth_callback")
async def callback(request: Request, db: Session = Depends(get_db)):
    # Exchange the authorization code Google sent us for actual tokens
    token = await oauth.google.authorize_access_token(request)

    # Extract the user's profile info from the ID token
    user_info = token.get("userinfo")
    if not user_info:
        raise HTTPException(status_code=400, detail="Failed to fetch user info from Google")

    google_id = user_info["sub"]  # Google's unique ID for this user

    # Check if this teacher already has an account
    existing_user = db.query(User).filter(User.google_id == google_id).first()

    if existing_user:
        # Update their tokens in case they've changed (tokens expire and rotate)
        existing_user.google_access_token = token.get("access_token")
        existing_user.google_refresh_token = token.get("refresh_token") or existing_user.google_refresh_token
        db.commit()
        user = existing_user
    else:
        # First time logging in — create a new user record
        user = User(
            google_id=google_id,
            google_access_token=token.get("access_token"),
            google_refresh_token=token.get("refresh_token"),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    # Save the user's ID in the session cookie so future requests know who they are
    request.session["user_id"] = user.user_id

    # Redirect to the frontend dashboard after successful login
    return RedirectResponse(url="http://localhost:5173")


# POST /auth/logout
# Clears the session cookie, effectively logging the teacher out
@router.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"message": "Logged out successfully"}


# GET /auth/me
# Returns the currently logged-in teacher's info
# The frontend calls this on load to check if the user is already logged in
@router.get("/me")
async def me(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")

    # If no session exists, the teacher is not logged in
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = db.query(User).filter(User.user_id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {"user_id": user.user_id, "google_id": user.google_id}
