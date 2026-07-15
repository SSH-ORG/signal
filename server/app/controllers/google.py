import os
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission

# Base URL for all Google Classroom API calls
CLASSROOM_BASE = "https://classroom.googleapis.com/v1"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def _auth_headers(user: User) -> dict:
    # Helper that builds the Authorization header using the teacher's stored access token
    return {"Authorization": f"Bearer {user.google_access_token}"}


async def _refresh_access_token(user: User, db: Session) -> None:
    # Access tokens expire after about an hour — use the refresh token to get a new one
    if not user.google_refresh_token:
        raise HTTPException(status_code=401, detail="Google session expired. Please log in again.")

    async with httpx.AsyncClient() as client:
        resp = await client.post(GOOGLE_TOKEN_URL, data={
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "refresh_token": user.google_refresh_token,
            "grant_type": "refresh_token",
        })

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Google session expired. Please log in again.")

    user.google_access_token = resp.json()["access_token"]
    db.commit()
    print(f"Refreshed Google access token for user_id={user.user_id}")


async def _get_with_refresh(client: httpx.AsyncClient, url: str, user: User, db: Session, **kwargs) -> httpx.Response:
    # Makes a GET request with the teacher's access token
    # If Google rejects it as expired, refreshes the token once and retries
    resp = await client.get(url, headers=_auth_headers(user), **kwargs)

    if resp.status_code == 401:
        await _refresh_access_token(user, db)
        resp = await client.get(url, headers=_auth_headers(user), **kwargs)

    return resp


async def _extract_submission_content(submission: dict, user: User, db: Session, client: httpx.AsyncClient) -> str | None:
    # Extracts readable text from a student submission
    # Handles short answers, multiple choice, and Google Doc file submissions

    # Short answer — student typed directly in Classroom
    short = submission.get("shortAnswerSubmission")
    if short:
        return short.get("answer")

    # Multiple choice — student picked an option
    mc = submission.get("multipleChoiceSubmission")
    if mc:
        return mc.get("answer")

    # File/attachment submission — student attached a Google Doc, Drive file, link, etc.
    assignment = submission.get("assignmentSubmission")
    if assignment and assignment.get("attachments"):
        texts = []

        for attachment in assignment["attachments"]:
            drive_file = attachment.get("driveFile")

            if drive_file:
                file_id = drive_file.get("id")
                title = drive_file.get("title", "Document")

                # Google Docs can be exported as plain text so the AI can read them
                # Other Drive files (Sheets, Slides, PDFs) are harder to extract — skip for now
                try:
                    export_resp = await _get_with_refresh(
                        client,
                        f"https://www.googleapis.com/drive/v3/files/{file_id}/export",
                        user, db,
                        params={"mimeType": "text/plain"},
                        timeout=10.0,
                    )
                    if export_resp.status_code == 200:
                        content = export_resp.text.strip()
                        if content:
                            texts.append(content)
                        else:
                            texts.append(f"[Empty document: {title}]")
                    else:
                        # File exists but can't be exported as text (e.g. PDF, image, Slides)
                        texts.append(f"[File submission: {title}]")
                except Exception:
                    texts.append(f"[Could not read: {title}]")

            elif attachment.get("youTubeVideo"):
                texts.append(f"[YouTube video: {attachment['youTubeVideo'].get('title', 'video')}]")
            elif attachment.get("link"):
                texts.append(f"[Link: {attachment['link'].get('url', '')}]")
            elif attachment.get("form"):
                texts.append(f"[Form: {attachment['form'].get('title', 'form')}]")

        return "\n\n".join(texts) if texts else None

    return None


async def fetch_google_coursework(user: User, db: Session) -> list:
    # Fetches all active courses and their assignments from Google Classroom
    # Returns a flat list of assignments across all courses the teacher owns
    async with httpx.AsyncClient() as client:
        # Step 1 — get all active courses where this teacher is the owner
        courses_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses",
            user, db,
            params={"teacherId": "me"},  # No state filter — return all courses regardless of status
        )

        if courses_resp.status_code != 200:
            # Print the actual Google error so we can debug it
            print("Google Classroom API error:", courses_resp.status_code, courses_resp.text)
            raise HTTPException(status_code=502, detail=f"Google Classroom API error: {courses_resp.text}")

        courses = courses_resp.json().get("courses", [])

        all_coursework = []

        # Step 2 — for each course, get all its assignments
        for course in courses:
            cw_resp = await _get_with_refresh(
                client,
                f"{CLASSROOM_BASE}/courses/{course['id']}/courseWork",
                user, db,
            )

            # A 404 here just means no assignments exist for this course — skip it
            if cw_resp.status_code == 404:
                continue

            if cw_resp.status_code != 200:
                continue

            coursework_list = cw_resp.json().get("courseWork", [])

            for cw in coursework_list:
                all_coursework.append({
                    "google_coursework_id": cw["id"],
                    "course_id": course["id"],              # Needed by the import endpoint
                    "title": cw.get("title", "Untitled"),
                    "course_name": course.get("name", ""),  # Which class this assignment belongs to
                })

    return all_coursework


async def import_google_coursework(google_coursework_id: str, course_id: str, user: User, db: Session) -> dict:
    # Imports a Google Classroom assignment into our database
    # If it was already imported before, syncs any new submissions instead of blocking

    # Check if this assignment has been imported before
    existing = db.query(Coursework).filter(
        Coursework.google_coursework_id == google_coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    async with httpx.AsyncClient() as client:
        if existing:
            # Assignment already exists — skip creating it, just sync new submissions below
            coursework = existing
        else:
            # First time importing — fetch assignment details and create a record
            cw_resp = await _get_with_refresh(
                client,
                f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}",
                user, db,
            )

            if cw_resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Failed to fetch assignment from Google Classroom")

            cw_data = cw_resp.json()

            coursework = Coursework(
                title=cw_data.get("title", "Untitled"),
                context="",  # Teacher can add rubric/context later before generating the report
                user_id=user.user_id,
                google_coursework_id=google_coursework_id,
            )
            db.add(coursework)
            db.commit()
            db.refresh(coursework)

        # Fetch all current student submissions from Google Classroom
        subs_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}/studentSubmissions",
            user, db,
        )

        if subs_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch submissions from Google Classroom")

        submissions_data = subs_resp.json().get("studentSubmissions", [])

        # Build a set of submission IDs we already have so we don't add duplicates
        existing_ids = {s.google_submission_id for s in coursework.submissions}
        new_count = 0

        for sub in submissions_data:
            # Skip if we already have this submission
            if sub["id"] in existing_ids:
                continue

            content = await _extract_submission_content(sub, user, db, client)

            # Skip submissions with no content (student hasn't turned anything in yet)
            if not content:
                continue

            submission = Submission(
                content=content,
                coursework_id=coursework.coursework_id,
                google_submission_id=sub["id"],
            )
            db.add(submission)
            new_count += 1

        db.commit()

    return {
        "coursework_id": coursework.coursework_id,
        "title": coursework.title,
        "new_submissions": new_count,
        "total_submissions": len(coursework.submissions) + new_count,
    }
