import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission

# Base URL for all Google Classroom API calls
CLASSROOM_BASE = "https://classroom.googleapis.com/v1"


def _auth_headers(user: User) -> dict:
    # Helper that builds the Authorization header using the teacher's stored access token
    return {"Authorization": f"Bearer {user.google_access_token}"}


def _extract_submission_content(submission: dict) -> str | None:
    # Google Classroom returns different submission types depending on the assignment
    # We try to extract readable text from whichever type it is

    # Short answer assignments — the student typed a response directly
    short = submission.get("shortAnswerSubmission")
    if short:
        return short.get("answer")

    # Multiple choice assignments — the student picked an option
    mc = submission.get("multipleChoiceSubmission")
    if mc:
        return mc.get("answer")

    # File-based assignments — student attached a Google Doc, Drive file, etc.
    # We can't read file contents without extra Google Drive API calls (out of scope for now)
    # So we just note that a file was submitted
    assignment = submission.get("assignmentSubmission")
    if assignment and assignment.get("attachments"):
        attachments = assignment["attachments"]
        titles = []
        for a in attachments:
            # Try to get a meaningful label from whichever attachment type it is
            if a.get("driveFile"):
                titles.append(a["driveFile"].get("title", "Drive file"))
            elif a.get("youTubeVideo"):
                titles.append(a["youTubeVideo"].get("title", "YouTube video"))
            elif a.get("link"):
                titles.append(a["link"].get("url", "Link"))
            elif a.get("form"):
                titles.append(a["form"].get("title", "Form"))
        return f"[File submission: {', '.join(titles)}]" if titles else "[File submission]"

    return None


async def fetch_google_coursework(user: User) -> list:
    # Fetches all active courses and their assignments from Google Classroom
    # Returns a flat list of assignments across all courses the teacher owns
    headers = _auth_headers(user)

    async with httpx.AsyncClient() as client:
        # Step 1 — get all active courses where this teacher is the owner
        courses_resp = await client.get(
            f"{CLASSROOM_BASE}/courses",
            headers=headers,
            params={"teacherId": "me", "courseStates": "ACTIVE"},
        )

        if courses_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch courses from Google Classroom")

        courses = courses_resp.json().get("courses", [])

        all_coursework = []

        # Step 2 — for each course, get all its assignments
        for course in courses:
            cw_resp = await client.get(
                f"{CLASSROOM_BASE}/courses/{course['id']}/courseWork",
                headers=headers,
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
    # Imports a single Google Classroom assignment and all its student submissions into our database
    headers = _auth_headers(user)

    # Don't allow importing the same assignment twice
    existing = db.query(Coursework).filter(
        Coursework.google_coursework_id == google_coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="This assignment has already been imported")

    async with httpx.AsyncClient() as client:
        # Step 1 — fetch the assignment details from Google Classroom
        cw_resp = await client.get(
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}",
            headers=headers,
        )

        if cw_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch assignment from Google Classroom")

        cw_data = cw_resp.json()

        # Step 2 — save the assignment to our database
        coursework = Coursework(
            title=cw_data.get("title", "Untitled"),
            context="",  # Teacher can add rubric/context later before generating report
            user_id=user.user_id,
            google_coursework_id=google_coursework_id,
        )
        db.add(coursework)
        db.commit()
        db.refresh(coursework)

        # Step 3 — fetch all student submissions for this assignment
        subs_resp = await client.get(
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}/studentSubmissions",
            headers=headers,
        )

        if subs_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch submissions from Google Classroom")

        submissions_data = subs_resp.json().get("studentSubmissions", [])
        imported_count = 0

        # Step 4 — save each submission to our database
        for sub in submissions_data:
            content = _extract_submission_content(sub)

            # Skip submissions with no content (student hasn't turned anything in yet)
            if not content:
                continue

            submission = Submission(
                content=content,
                coursework_id=coursework.coursework_id,
                google_submission_id=sub["id"],
            )
            db.add(submission)
            imported_count += 1

        db.commit()

    return {
        "coursework_id": coursework.coursework_id,
        "title": coursework.title,
        "submissions_imported": imported_count,
    }
