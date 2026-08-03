import os
import httpx
from datetime import datetime
from fastapi import HTTPException
from sqlalchemy import or_, and_
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission

# Base URL for all Google Classroom API calls
CLASSROOM_BASE = "https://classroom.googleapis.com/v1"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# We only support short-answer questions and free-form assignments (Google Doc
# attachments only) — multiple choice questions aren't pulled in at all
SUPPORTED_WORK_TYPES = {"SHORT_ANSWER_QUESTION", "ASSIGNMENT"}

# A submission only counts as real, analyzable work in these states — CREATED/NEW
# means the student hasn't turned it in yet, and RECLAIMED_BY_STUDENT means they
# turned it in and then pulled it back
SUBMITTED_STATES = {"TURNED_IN", "RETURNED"}


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
    # Only handles short answers and Google Doc attachments — other attachment
    # kinds (Sheets, Slides, PDFs, YouTube, links, forms) aren't readable so we skip them

    # Short answer — student typed directly in Classroom
    short = submission.get("shortAnswerSubmission")
    if short:
        return short.get("answer")

    # File/attachment submission — only Google Docs are readable
    assignment = submission.get("assignmentSubmission")
    if assignment and assignment.get("attachments"):
        texts = []

        for attachment in assignment["attachments"]:
            drive_file = attachment.get("driveFile")
            if not drive_file:
                continue

            file_id = drive_file.get("id")

            try:
                # A Doc's Drive file ID doubles as its Docs API document ID, so this
                # only ever needs the documents.readonly scope — not full Drive access.
                # If the file isn't actually a Doc (e.g. Slides, Sheets), this call
                # fails on its own instead of needing a separate mimeType pre-check.
                doc_resp = await _get_with_refresh(
                    client,
                    f"https://docs.googleapis.com/v1/documents/{file_id}",
                    user, db,
                    timeout=10.0,
                )
                if doc_resp.status_code == 200:
                    content = _extract_doc_text(doc_resp.json()).strip()
                    if content:
                        texts.append(content)
                # A blank doc or a non-200 (wrong file type, permissions, etc.)
                # contributes nothing rather than a placeholder string — this
                # submission still gets a row (its state confirms it was turned
                # in), just with no readable content, same as a blank Google Doc.
                # A fake "[Empty document: ...]" string used to end up stored as
                # if it were real content, which both defeated the Empty
                # submission badge and would have been sent to the AI as if the
                # student had actually written that.
            except Exception:
                pass

        return "\n\n".join(texts) if texts else None

    return None


def _extract_doc_text(document: dict) -> str:
    # Walks a Docs API document's structured body and concatenates the plain text
    # of every paragraph — tables/images/section breaks are skipped since the AI
    # only needs readable prose, not layout
    pieces = []
    for element in document.get("body", {}).get("content", []):
        paragraph = element.get("paragraph")
        if not paragraph:
            continue
        for el in paragraph.get("elements", []):
            text_run = el.get("textRun")
            if text_run:
                pieces.append(text_run.get("content", ""))
    return "".join(pieces)


def _parse_due_date(cw: dict) -> datetime | None:
    # Classroom splits a due date into a dueDate {year,month,day} object and an
    # optional dueTime {hours,minutes} — no dueTime means end of day
    due_date = cw.get("dueDate")
    if not due_date:
        return None
    due_time = cw.get("dueTime") or {}
    try:
        return datetime(
            year=due_date["year"],
            month=due_date["month"],
            day=due_date["day"],
            hour=due_time.get("hours", 23),
            minute=due_time.get("minutes", 59),
        )
    except (KeyError, ValueError):
        return None


async def _fetch_course_roster(course_id: str, user: User, db: Session, client: httpx.AsyncClient) -> dict:
    # Fetches every student in a course, returning {google_user_id: {"name": ..., "email": ...}}.
    # Paginated — a large class's roster can exceed a single page. name requires the
    # classroom.rosters.readonly scope; email additionally requires classroom.profile.emails —
    # emailAddress is simply omitted from Google's response without that scope granted,
    # so email ends up None for teachers who haven't re-consented since it was added.
    roster = {}
    page_token = None

    while True:
        resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/students",
            user, db,
            params={"pageToken": page_token} if page_token else {},
        )

        if resp.status_code != 200:
            break

        page = resp.json()
        for student in page.get("students", []):
            uid = student.get("userId")
            profile = student.get("profile", {})
            name = profile.get("name", {}).get("fullName")
            if uid and name:
                roster[uid] = {"name": name, "email": profile.get("emailAddress")}

        page_token = page.get("nextPageToken")
        if not page_token:
            break

    return roster


async def fetch_course_roster(course_id: str, user: User, db: Session) -> list[dict]:
    # On-demand read of a course's roster — used by report.py's send_student_report
    # to look up a student's email address (not stored anywhere) so their report
    # can be sent directly to them. A pure read, nothing saved to our database.
    async with httpx.AsyncClient() as client:
        roster = await _fetch_course_roster(course_id, user, db, client)
    return [
        {"google_user_id": uid, "name": entry["name"], "email": entry["email"]}
        for uid, entry in roster.items()
    ]


async def _reconcile_missing_coursework(
    course_id: str, course_name: str, live_ids: set, user: User, db: Session, client: httpx.AsyncClient
) -> int:
    # Google's courseWork.list silently OMITS deleted assignments entirely — it
    # does NOT return them with state=DELETED despite what the docs suggest, so
    # a stored assignment simply missing from the live list is only a candidate
    # for deletion, not proof of it. Confirmed via a direct GET on that specific
    # assignment, which DOES still report state=DELETED (or 404s) — so a fetch
    # that's incomplete for some other reason (a real API error, a workType we
    # just don't track) can never cause a false deletion.
    candidates = db.query(Coursework).filter(
        Coursework.user_id == user.user_id,
        Coursework.google_coursework_id.isnot(None),
    ).filter(
        or_(
            Coursework.google_course_id == course_id,
            and_(
                or_(Coursework.google_course_id.is_(None), Coursework.google_course_id == ""),
                Coursework.course_name == course_name,
            ),
        )
    ).all()

    removed = 0
    for row in candidates:
        if row.google_coursework_id in live_ids:
            continue  # still present live — not missing at all

        detail_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{row.google_coursework_id}",
            user, db,
        )

        confirmed_deleted = detail_resp.status_code == 404 or (
            detail_resp.status_code == 200 and detail_resp.json().get("state") == "DELETED"
        )

        if confirmed_deleted:
            print(f"Removing '{row.title}' — deleted in Google Classroom")
            db.delete(row)
            removed += 1
        # Anything else — a genuinely different state, a real API error — is left
        # alone. We only ever act on a confirmed, explicit signal.

    if removed:
        db.commit()

    return removed


def _cleanup_archived_courses(archived_gc_course_ids: list, user: User, db: Session) -> int:
    # Same explicit-signal reasoning as deleted assignments — Google directly
    # reports a course as ARCHIVED (not just absent from a fetch), so it's safe
    # to remove any assignments synced from it. A teacher who wants to keep a
    # record of a report before its class is archived can send it to themselves
    # first via the "Email report" button — that's a deliberate action on their
    # part, not something Signal does automatically on their behalf.
    # Scoped to ARCHIVED only — SUSPENDED/DECLINED/PROVISIONED are different
    # situations (a policy issue, a declined invite, an unaccepted course) and
    # aren't necessarily "this class is over," so they're left untouched.
    if not archived_gc_course_ids:
        return 0

    rows = db.query(Coursework).filter(
        Coursework.user_id == user.user_id,
        Coursework.google_course_id.in_(archived_gc_course_ids),
    ).all()

    for row in rows:
        print(f"Removing '{row.title}' — its course was archived in Google Classroom")
        db.delete(row)

    if rows:
        db.commit()

    return len(rows)


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


async def fetch_assignment_description(google_coursework_id: str, course_id: str, user: User, db: Session) -> dict:
    # Pure read — pulls the assignment's current description directly from
    # Classroom without touching submissions/roster. Used by the "Sync
    # Description" button so a teacher can deliberately pull in a live edit
    # instead of it silently overwriting their own custom description on
    # every visit, the same way "Sync Rubric" already works.
    async with httpx.AsyncClient() as client:
        resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}",
            user, db,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch assignment from Google Classroom")

    return {"description": resp.json().get("description", "")}


async def fetch_google_courses(user: User, db: Session) -> dict:
    # Fetches every active course from Google Classroom — a live, read-only list
    # of course names only. Assignment data is fetched separately, per course,
    # only once a teacher actually opens that course (see fetch_course_coursework) —
    # this used to also pull every course's assignments here, which meant a
    # multi-second sequential chain of Google calls on every single Courses visit.
    async with httpx.AsyncClient() as client:
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

        # A course explicitly reported as ARCHIVED is a real signal from Google
        # (not an inference from absence) — clean up anything synced from it
        archived_gc_course_ids = [c["id"] for c in all_courses if c.get("courseState") == "ARCHIVED"]
        _cleanup_archived_courses(archived_gc_course_ids, user, db)

        # Only show courses in Google's ACTIVE state — anything else (ARCHIVED,
        # PROVISIONED — created but not yet accepted, DECLINED, SUSPENDED) isn't
        # something a teacher can meaningfully open and sync assignments from
        courses = [c for c in all_courses if c.get("courseState") == "ACTIVE"]

        courses_out = [
            {
                "course_id": course["id"],
                "course_name": course.get("name", ""),
            }
            for course in courses
        ]

    return {"courses": courses_out}


async def fetch_course_coursework(course_id: str, user: User, db: Session) -> dict:
    # Fetches one course's live assignment list from Google Classroom — a pure
    # read, nothing saved. Used by the Assignments screen to show titles/due
    # dates before any of them have been individually synced.
    coursework_list = []
    page_token = None
    fetch_failed = False

    async with httpx.AsyncClient() as client:
        while True:
            cw_resp = await _get_with_refresh(
                client,
                f"{CLASSROOM_BASE}/courses/{course_id}/courseWork",
                user, db,
                params={"pageToken": page_token} if page_token else {},
            )

            # A 404 here just means no assignments exist for this course — skip it
            if cw_resp.status_code == 404:
                break

            if cw_resp.status_code != 200:
                # A real failure (not "no assignments yet") — log it and flag it
                # so the teacher isn't shown an empty class that's actually broken
                print(f"Failed to fetch coursework for course {course_id}: {cw_resp.status_code} {cw_resp.text}")
                fetch_failed = True
                break

            page = cw_resp.json()
            coursework_list.extend(page.get("courseWork", []))

            page_token = page.get("nextPageToken")
            if not page_token:
                break

    # Only short-answer questions and free-form assignments are supported
    coursework_list = [cw for cw in coursework_list if cw.get("workType") in SUPPORTED_WORK_TYPES]

    # Only show published assignments — DRAFT isn't visible to students yet
    # (so there's nothing to sync), and DELETED is, per Google's own docs,
    # still returned to the teacher for a while after being removed
    coursework_list = [cw for cw in coursework_list if cw.get("state") == "PUBLISHED"]

    assignments = []
    for cw in coursework_list:
        due_date = _parse_due_date(cw)
        assignments.append({
            "google_coursework_id": cw["id"],
            "course_id": course_id,              # Needed by the sync endpoint
            "title": cw.get("title", "Untitled"),
            "description": cw.get("description", ""),  # Pre-fills the teacher's context field
            "due_date": due_date.isoformat() if due_date else None,
            "created_at": cw.get("creationTime"),  # Always present — Classroom's own ISO timestamp
        })

    return {"coursework": assignments, "failed": fetch_failed}


async def sync_coursework(
    google_coursework_id: str,
    course_id: str,
    user: User,
    db: Session,
    context: str | None = None,
    course_name: str = "",
    due_date: str | None = None,
    roster: dict | None = None,
) -> dict:
    # Syncs a Google Classroom assignment into our database
    # If it was already synced before, syncs any new submissions instead of blocking
    # due_date is optional — pass it through when the caller already has a fresh
    # value (e.g. sync_course_coursework, which fetches the whole course's
    # coursework list anyway) to avoid re-fetching it here

    # Check if this assignment has been synced before
    existing = db.query(Coursework).filter(
        Coursework.google_coursework_id == google_coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    parsed_due_date = datetime.fromisoformat(due_date) if due_date else None

    async with httpx.AsyncClient() as client:
        if existing:
            # Assignment already exists — skip creating it, just sync new submissions below
            # Context is never touched here — use PATCH /api/coursework/{id} to edit it
            coursework = existing
            # Backfills course_name and google_course_id for rows created before these
            # columns were added — only overwrites when a real value comes in
            if course_name and coursework.course_name != course_name:
                coursework.course_name = course_name
            if course_id and not coursework.google_course_id:
                coursework.google_course_id = course_id
            # due_date isn't a "created once" fact like context — it can genuinely
            # change (a teacher extends a deadline), so it always takes the
            # freshest value passed in rather than only backfilling
            if due_date is not None:
                coursework.due_date = parsed_due_date
            db.commit()
        else:
            # First time syncing — fetch assignment details and create a record
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
                google_course_id=course_id,  # Stored so the background job can re-sync without a teacher being present
                course_name=course_name,      # Stored so it's available even if the course is later archived
                # Falls back to parsing the freshly-fetched courseWork detail directly,
                # in case the caller didn't already have a live due date on hand
                due_date=parsed_due_date if due_date is not None else _parse_due_date(cw_data),
            )
            db.add(coursework)
            db.commit()
            db.refresh(coursework)

        # Reuses a pre-fetched roster when the caller already has one (e.g. syncing
        # every assignment in a course at once shares a single roster fetch instead
        # of repeating it per assignment) — otherwise fetches it fresh here.
        # Paginated, since a large class's roster can exceed a single page. Requires
        # classroom.rosters.readonly scope — falls back to {} if not granted yet
        if roster is None:
            roster = await _fetch_course_roster(course_id, user, db, client)

        # Fetch all current student submissions from Google Classroom
        subs_resp = await _get_with_refresh(
            client,
            f"{CLASSROOM_BASE}/courses/{course_id}/courseWork/{google_coursework_id}/studentSubmissions",
            user, db,
        )

        if subs_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch submissions from Google Classroom")

        submissions_data = subs_resp.json().get("studentSubmissions", [])

        # One row per entry Google returns — that's every enrolled student, whether
        # or not they've submitted anything (state tells us which). Kept live on every
        # sync instead of writing a row once and ignoring it afterward, so a student
        # editing/resubmitting after their first sync is actually picked up, and a
        # non-submitter is something we already know rather than a separate roster
        # cross-reference the frontend has to fetch and compute itself.
        existing_by_google_id = {s.google_submission_id: s for s in coursework.submissions}
        newly_submitted_count = 0

        for sub in submissions_data:
            state = sub.get("state")
            user_id = sub.get("userId")
            updated_at = sub.get("updateTime")
            is_submitted = state in SUBMITTED_STATES
            existing = existing_by_google_id.get(sub["id"])

            if existing:
                was_submitted = existing.state in SUBMITTED_STATES
                if not is_submitted:
                    # Not turned in (still a draft), or pulled back since we last
                    # looked — clear stale content rather than leave old work visible.
                    # Also clear any previously-built individual report: it analyzed
                    # content that no longer represents this submission, and leaving
                    # it in place would keep showing a "view report" row instead of
                    # the Empty submission state the current data actually calls for.
                    existing.content = ""
                    existing.student_report = None
                elif updated_at != existing.google_updated_at:
                    # Only re-extract content (a real Docs API fetch) when Google
                    # reports this submission actually changed since last sync —
                    # otherwise every sync would re-fetch every student's unchanged
                    # work, every time a teacher opens the page. Same reasoning as
                    # above — a previously-built report is now stale against
                    # whatever the new content turns out to be, so clear it too.
                    existing.content = await _extract_submission_content(sub, user, db, client) or ""
                    existing.student_report = None
                if is_submitted and not was_submitted:
                    newly_submitted_count += 1
                existing.state = state
                existing.google_updated_at = updated_at
                if existing.student_name is None and user_id:
                    entry = roster.get(user_id)
                    if entry:
                        existing.student_name = entry["name"]
            else:
                content = (await _extract_submission_content(sub, user, db, client) or "") if is_submitted else ""
                submission = Submission(
                    content=content,
                    coursework_id=coursework.coursework_id,
                    google_submission_id=sub["id"],
                    google_user_id=user_id,
                    student_name=roster.get(user_id, {}).get("name"),  # None if roster fetch failed or student not found
                    state=state,
                    google_updated_at=updated_at,
                )
                db.add(submission)
                if is_submitted:
                    newly_submitted_count += 1

        db.commit()

    total_submissions = sum(1 for s in coursework.submissions if s.state in SUBMITTED_STATES)

    return {
        "coursework_id": coursework.coursework_id,
        "title": coursework.title,
        "new_submissions": newly_submitted_count,
        "total_submissions": total_submissions,
    }


async def sync_course_coursework(course_id: str, course_name: str, user: User, db: Session) -> dict:
    # Syncs every published assignment in one course at once. Interactive syncing
    # (opening a course/assignment in Signal) now happens per-assignment, only when
    # a teacher actually opens it — see sync_coursework. This bulk version is used
    # solely by the background notification scheduler, so nothing here blocks a
    # teacher's page load; the loop below stays sequential on purpose since these
    # calls share one database session, which isn't safe to use concurrently
    async with httpx.AsyncClient() as client:
        coursework_list = []
        page_token = None

        while True:
            cw_resp = await _get_with_refresh(
                client,
                f"{CLASSROOM_BASE}/courses/{course_id}/courseWork",
                user, db,
                params={"pageToken": page_token} if page_token else {},
            )

            if cw_resp.status_code == 404:
                break

            if cw_resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Failed to fetch assignments from Google Classroom")

            page = cw_resp.json()
            coursework_list.extend(page.get("courseWork", []))

            page_token = page.get("nextPageToken")
            if not page_token:
                break

        # The while loop above only exits normally on full success (it raises
        # otherwise), so the live list here is known-complete and safe to reconcile
        # against — catches assignments deleted in Classroom since they were last synced
        live_ids = {cw["id"] for cw in coursework_list}
        await _reconcile_missing_coursework(course_id, course_name, live_ids, user, db, client)

        coursework_list = [
            cw for cw in coursework_list
            if cw.get("workType") in SUPPORTED_WORK_TYPES and cw.get("state") == "PUBLISHED"
        ]

        # Fetched once for the whole course and reused below — sync_coursework
        # would otherwise redundantly re-fetch the same roster for every assignment
        roster = await _fetch_course_roster(course_id, user, db, client)

    synced_count = 0
    for cw in coursework_list:
        due_date = _parse_due_date(cw)
        await sync_coursework(
            google_coursework_id=cw["id"],
            course_id=course_id,
            user=user,
            db=db,
            course_name=course_name,
            due_date=due_date.isoformat() if due_date else None,
            roster=roster,
        )
        synced_count += 1

    return {"synced": synced_count}
