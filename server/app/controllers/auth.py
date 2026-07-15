import os
from fastapi import HTTPException
from fastapi.responses import RedirectResponse
from authlib.integrations.starlette_client import OAuth
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.models.user import User

# Set up the Google OAuth client
# authlib handles the redirect, token exchange, and user info fetching for us
oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={
        # Request access to Google profile, email, and Classroom data
        # We include Classroom scopes now so teachers don't have to re-authenticate later
        "scope": (
            "openid email profile "
            "https://www.googleapis.com/auth/classroom.courses.readonly "
            "https://www.googleapis.com/auth/classroom.coursework.me.readonly "
            "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly "
            "https://www.googleapis.com/auth/drive.readonly"  # Needed to read Google Doc submission content
        ),
        "access_type": "offline",  # Gives us a refresh token so we don't lose access when the access token expires
        "prompt": "consent",       # Forces Google to always return a refresh token
    },
)


# Redirects the teacher to Google's login page
async def google_login(request: Request):
    redirect_uri = request.url_for("auth_callback")
    # access_type must be passed here directly — authlib does not forward it from
    # client_kwargs into the actual authorization URL, so it was silently dropped
    # and Google never issued a refresh_token
    return await oauth.google.authorize_redirect(request, redirect_uri, access_type="offline", prompt="consent")


# Called after Google redirects back — exchanges the code for tokens
# Then finds or creates the teacher in the database and sets their session
async def google_callback(request: Request, db: Session):
    # Exchange the one-time authorization code for access and refresh tokens
    token = await oauth.google.authorize_access_token(request)

    user_info = token.get("userinfo")
    if not user_info:
        raise HTTPException(status_code=400, detail="Failed to fetch user info from Google")

    google_id = user_info["sub"]  # Google's permanent unique ID for this user

    # Check if this teacher has logged in before
    existing_user = db.query(User).filter(User.google_id == google_id).first()

    if existing_user:
        # Refresh their stored tokens — access tokens expire, so we always update them
        existing_user.google_access_token = token.get("access_token")
        # Only overwrite refresh token if Google returned a new one (it won't always)
        existing_user.google_refresh_token = token.get("refresh_token") or existing_user.google_refresh_token
        db.commit()
        user = existing_user
    else:
        # First login — create a new record for this teacher
        user = User(
            google_id=google_id,
            google_access_token=token.get("access_token"),
            google_refresh_token=token.get("refresh_token"),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    # Save the user's ID in their session cookie
    request.session["user_id"] = user.user_id

    # Send them to the frontend dashboard
    return RedirectResponse(url="http://localhost:5173")


# Clears the session cookie — logs the teacher out
async def logout(request: Request):
    request.session.clear()
    return {"message": "Logged out successfully"}


# Returns the currently logged-in teacher's basic info
# The frontend calls this on page load to check if the session is still active
async def get_me(request: Request, db: Session):
    user_id = request.session.get("user_id")

    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = db.query(User).filter(User.user_id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {"user_id": user.user_id, "google_id": user.google_id}
