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
            title = drive_file.get("title", "Document")

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
                    texts.append(content if content else f"[Empty document: {title}]")
                else:
                    texts.append(f"[Could not read: {title}]")
            except Exception:
                texts.append(f"[Could not read: {title}]")

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
    # Fetches every student in a course, returning {google_user_id: full_name}.
    # Paginated — a large class's roster can exceed a single page. Requires the
    # classroom.rosters.readonly scope; returns {} if that hasn't been granted.
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
            name = student.get("profile", {}).get("name", {}).get("fullName")
            if uid and name:
                roster[uid] = name

        page_token = page.get("nextPageToken")
        if not page_token:
            break

    return roster


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


async def fetch_google_coursework(user: User, db: Session) -> dict:
    # Fetches all active courses and their assignments from Google Classroom
    # Returns every active course (even ones with no assignments yet) alongside
    # a flat list of assignments across all courses the teacher owns
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

        # A course explicitly reported as ARCHIVED is a real signal from Google
        # (not an inference from absence) — clean up anything synced from it
        archived_gc_course_ids = [c["id"] for c in all_courses if c.get("courseState") == "ARCHIVED"]
        _cleanup_archived_courses(archived_gc_course_ids, user, db)

        # Only show courses in Google's ACTIVE state — anything else (ARCHIVED,
        # PROVISIONED — created but not yet accepted, DECLINED, SUSPENDED) isn't
        # something a teacher can meaningfully open and sync assignments from
        courses = [c for c in all_courses if c.get("courseState") == "ACTIVE"]

        all_coursework = []
        failed_course_names = []  # Courses whose coursework fetch genuinely failed (not just empty)

        # Deletion reconciliation and a roster fetch both used to run here on every single
        # visit to this screen, for every course — real, duplicated work, since the exact
        # same reconciliation already runs the moment a teacher opens that course's
        # Coursework screen, and student_count isn't shown anywhere on this screen anyway.
        # Dropping both removed the redundant network round-trip chain that was causing a
        # multi-second load delay on every Courses visit.

        # Step 2 — for each course, get all its assignments. Paginated — a class's
        # coursework list can exceed a single page over the course of a semester.
        for course in courses:
            coursework_list = []
            page_token = None
            fetch_failed = False

            while True:
                cw_resp = await _get_with_refresh(
                    client,
                    f"{CLASSROOM_BASE}/courses/{course['id']}/courseWork",
                    user, db,
                    params={"pageToken": page_token} if page_token else {},
                )

                # A 404 here just means no assignments exist for this course — skip it
                if cw_resp.status_code == 404:
                    break

                if cw_resp.status_code != 200:
                    # A real failure (not "no assignments yet") — log it and flag the
                    # course so the teacher isn't shown an empty class that's actually broken
                    print(f"Failed to fetch coursework for course {course['id']} ({course.get('name')}): {cw_resp.status_code} {cw_resp.text}")
                    fetch_failed = True
                    break

                page = cw_resp.json()
                coursework_list.extend(page.get("courseWork", []))

                page_token = page.get("nextPageToken")
                if not page_token:
                    break

            if fetch_failed:
                failed_course_names.append(course.get("name", "Untitled course"))

            # Only short-answer questions and free-form assignments are supported
            coursework_list = [cw for cw in coursework_list if cw.get("workType") in SUPPORTED_WORK_TYPES]

            # Only show published assignments — DRAFT isn't visible to students yet
            # (so there's nothing to sync), and DELETED is, per Google's own docs,
            # still returned to the teacher for a while after being removed
            coursework_list = [cw for cw in coursework_list if cw.get("state") == "PUBLISHED"]

            for cw in coursework_list:
                due_date = _parse_due_date(cw)
                all_coursework.append({
                    "google_coursework_id": cw["id"],
                    "course_id": course["id"],              # Needed by the import endpoint
                    "title": cw.get("title", "Untitled"),
                    "description": cw.get("description", ""),  # Pre-fills the teacher's context field
                    "course_name": course.get("name", ""),  # Which class this assignment belongs to
                    "due_date": due_date.isoformat() if due_date else None,
                    "created_at": cw.get("creationTime"),  # Always present — Classroom's own ISO timestamp
                })

        # Every active course, regardless of whether it has any assignments yet —
        # the Classes page lists all of these; AssignmentsPage shows an empty
        # state for ones with nothing in all_coursework
        courses_out = [
            {
                "course_id": course["id"],
                "course_name": course.get("name", ""),
            }
            for course in courses
        ]

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

    return {"courses": courses_out, "coursework": all_coursework, "failed_courses": failed_course_names}


async def sync_coursework(
    google_coursework_id: str,
    course_id: str,
    user: User,
    db: Session,
    context: str | None = None,
    course_name: str = "",
    due_date: str | None = None,
    student_count: int | None = None,
    roster: dict | None = None,
) -> dict:
    # Syncs a Google Classroom assignment into our database
    # If it was already synced before, syncs any new submissions instead of blocking
    # due_date/student_count are optional — pass them through when the caller already
    # has fresh values (e.g. from fetch_google_coursework) to avoid re-fetching them here

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
            # due_date/student_count aren't "created once" facts like context — they can
            # genuinely change (a teacher extends a deadline, the roster grows), so these
            # always take the freshest value passed in rather than only backfilling
            if due_date is not None:
                coursework.due_date = parsed_due_date
            if student_count is not None:
                coursework.student_count = student_count
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
                student_count=student_count,
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


async def sync_course_coursework(course_id: str, course_name: str, user: User, db: Session) -> dict:
    # Syncs every published assignment in one course at once — this is what makes
    # syncing automatic: it runs whenever a teacher opens or revisits that course's
    # Coursework screen, instead of requiring a manual first click per assignment
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

        # Same reconciliation as fetch_google_coursework — the while loop above only
        # exits normally on full success (it raises otherwise), so the live list here
        # is known-complete and safe to reconcile against
        live_ids = {cw["id"] for cw in coursework_list}
        await _reconcile_missing_coursework(course_id, course_name, live_ids, user, db, client)

        coursework_list = [
            cw for cw in coursework_list
            if cw.get("workType") in SUPPORTED_WORK_TYPES and cw.get("state") == "PUBLISHED"
        ]

        # Fetched once for the whole course and reused below — sync_coursework
        # would otherwise redundantly re-fetch the same roster for every assignment
        roster = await _fetch_course_roster(course_id, user, db, client)
        student_count = len(roster) or None

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
            student_count=student_count,
            roster=roster,
        )
        synced_count += 1

    return {"synced": synced_count}
