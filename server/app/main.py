import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from dotenv import load_dotenv

from app.routes import auth, google, coursework, report

# Load environment variables from .env file
load_dotenv()

# redirect_slashes=False prevents FastAPI from redirecting /route to /route/
# That redirect breaks CORS because the browser doesn't send credentials on redirects
app = FastAPI(redirect_slashes=False)

# Session middleware — stores a signed cookie in the browser so we know who's logged in
# The SESSION_SECRET is used to sign the cookie so it can't be tampered with
app.add_middleware(SessionMiddleware, secret_key=os.getenv("SESSION_SECRET"))

# CORS middleware — allows the React frontend (running on port 5173) to talk to this API
# Without this, the browser would block all requests from the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # React dev server
    allow_credentials=True,                   # Required so session cookies are sent with requests
    allow_methods=["*"],                      # Allow GET, POST, DELETE, etc.
    allow_headers=["*"],
)

# Register the auth router — all auth routes will be available at /auth/...
app.include_router(auth.router, prefix="/auth")

# Google Classroom sync routes — /api/google/...
app.include_router(google.router, prefix="/api/google")

# Imported coursework routes — /api/coursework/...
app.include_router(coursework.router, prefix="/api/coursework")

# Report routes — /api/coursework/{id}/report
# Nested under coursework since a report always belongs to one assignment
app.include_router(report.router, prefix="/api/coursework/{coursework_id}/report")


# Health check endpoint — used to confirm the server is running
@app.get("/health")
def health():
    return {"status": "ok"}
