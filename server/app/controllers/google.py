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


async def fetch_rubric(google_coursework_id: str, course_id: str, user: User, db: Session) -> dict:
    # Fetches the structured rubric (criteria + point levels) from Google Classroom
    # Returns a formatted text string ready to paste into the context/rubric field
    async with httpx.AsyncClient() as client:
        resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}/rubrics",
            user, db,
        )

    if resp.status_code == 404:
        # Assignment exists but has no rubric attached
        return {"rubric_text": None}

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch rubric from Google Classroom")

    rubrics = resp.json().get("rubrics", [])

    if not rubrics:
        return {"rubric_text": None}

    # Google Classroom only allows one rubric per assignment — take the first
    rubric = rubrics[0]
    criteria = rubric.get("criteria", [])

    if not criteria:
        return {"rubric_text": None}

    # Format each criterion and its scoring levels into readable text for the AI
    lines = ["Rubric:"]
    for criterion in criteria:
        title = criterion.get("title", "Untitled Criterion")
        description = criterion.get("description", "")
        levels = criterion.get("levels", [])

        # Sort levels by points descending so highest score appears first
        levels_sorted = sorted(levels, key=lambda l: l.get("points", 0), reverse=True)
        max_points = levels_sorted[0].get("points", 0) if levels_sorted else 0

        lines.append(f"\n{title} ({max_points} points)")
        if description:
            lines.append(f"  {description}")

        for level in levels_sorted:
            level_title = level.get("title", "")
            level_desc = level.get("description", "")
            pts = level.get("points", 0)
            level_line = f"  - {level_title} ({pts} pts)"
            if level_desc:
                level_line += f": {level_desc}"
            lines.append(level_line)

    return {"rubric_text": "\n".join(lines)}


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

        all_courses = courses_resp.json().get("courses", [])

        # Skip archived courses — teachers don't need to see or import from them
        courses = [c for c in all_courses if c.get("courseState") != "ARCHIVED"]

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
                    "description": cw.get("description", ""),  # Pre-fills the teacher's context field
                    "course_name": course.get("name", ""),  # Which class this assignment belongs to
                })

    # Reconcile stored course_name against live Classroom data on every load — covers
    # rows whose course_name was never saved correctly (e.g. a past import bug) or
    # whose class was renamed since import. Only touches rows still in the live list,
    # so classes that are actually archived keep their last-known name instead of
    # being overwritten.
    live_names = {cw["google_coursework_id"]: cw["course_name"] for cw in all_coursework}
    if live_names:
        stored = db.query(Coursework).filter(
            Coursework.user_id == user.user_id,
            Coursework.google_coursework_id.in_(live_names.keys()),
        ).all()
        changed = False
        for row in stored:
            live_name = live_names[row.google_coursework_id]
            if live_name and row.course_name != live_name:
                row.course_name = live_name
                changed = True
        if changed:
            db.commit()

    return all_coursework


async def import_google_coursework(
    google_coursework_id: str,
    course_id: str,
    user: User,
    db: Session,
    context: str | None = None,
    course_name: str = "",
) -> dict:
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
            # Context is never touched here — use PATCH /api/coursework/{id} to edit it
            coursework = existing
            # Backfills course_name for rows created before it was passed in (e.g. the
            # frontend bug that dropped it on sync) — only overwrites when a real name
            # comes in, so rows for classes archived since import keep their last-known name
            if course_name and coursework.course_name != course_name:
                coursework.course_name = course_name
                db.commit()
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

            # Use the context the teacher reviewed/edited on the Assignment Detail screen
            # Falls back to the raw Classroom description if none was passed in
            coursework = Coursework(
                title=cw_data.get("title", "Untitled"),
                context=context if context is not None else cw_data.get("description", "") or "",
                user_id=user.user_id,
                google_coursework_id=google_coursework_id,
                course_name=course_name,  # Stored so it's available even if the course is later archived
            )
            db.add(coursework)
            db.commit()
            db.refresh(coursework)

        # Fetch the class roster so we can store each student's real name with their submission
        # Requires classroom.rosters.readonly scope — falls back to None if not granted yet
        roster_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/students",
            user, db,
        )
        roster = {}
        if roster_resp.status_code == 200:
            for student in roster_resp.json().get("students", []):
                uid = student.get("userId")
                name = student.get("profile", {}).get("name", {}).get("fullName")
                if uid and name:
                    roster[uid] = name

        # Fetch all current student submissions from Google Classroom
        subs_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}/studentSubmissions",
            user, db,
        )

        if subs_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch submissions from Google Classroom")

        submissions_data = subs_resp.json().get("studentSubmissions", [])

        # Build a lookup of existing submissions so we can skip duplicates and backfill names
        existing_by_google_id = {s.google_submission_id: s for s in coursework.submissions}
        new_count = 0

        # Backfill student_name on submissions that were synced before the roster feature existed
        if roster:
            for existing_sub in coursework.submissions:
                if existing_sub.student_name is None and existing_sub.google_user_id:
                    existing_sub.student_name = roster.get(existing_sub.google_user_id)

        for sub in submissions_data:
            # Skip if we already have this submission
            if sub["id"] in existing_by_google_id:
                continue

            content = await _extract_submission_content(sub, user, db, client)

            # Skip submissions with no content (student hasn't turned anything in yet)
            if not content:
                continue

            user_id = sub.get("userId")
            submission = Submission(
                content=content,
                coursework_id=coursework.coursework_id,
                google_submission_id=sub["id"],
                google_user_id=user_id,
                student_name=roster.get(user_id),  # None if roster fetch failed or student not found
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
