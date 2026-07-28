from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission
from app.models.report import Report
from app.controllers.google import import_google_coursework, fetch_google_coursework
from app.controllers.report import generate_individual_report, generate_report
from app.jobs.email import send_immediate_email


async def sync_submissions_and_reports() -> None:
    """
    Background job — runs every 5 minutes.

    For every teacher with a Google session:
    1. Fetches all live assignments from Google Classroom (discovers new ones automatically).
    2. Auto-imports any assignment not yet in Signal — teacher never needs to import manually.
    3. Syncs new student submissions for all assignments.
    4. Auto-generates individual AI reports for any submission that doesn't have one yet.
    """
    db = SessionLocal()
    try:
        users = (
            db.query(User)
            .filter(User.google_refresh_token.isnot(None))
            .all()
        )

        print(f"[sync job] Found {len(users)} user(s) to sync")
        for user in users:
            try:
                await _sync_user(user, db)
            except Exception as e:
                print(f"[sync job] Unhandled error for user_id={user.user_id}: {e}")
    finally:
        db.close()


async def _sync_user(user: User, db: Session) -> None:
    # Step 1: Get the full live assignment list from Google Classroom
    # This is the source of truth — covers all classes and any newly added ones
    try:
        live_data = await fetch_google_coursework(user, db)
    except Exception as e:
        print(f"[sync job] Could not reach Google Classroom for user_id={user.user_id}: {e}")
        return

    live_assignments = live_data.get("coursework", [])
    print(f"[sync job] user_id={user.user_id}: found {len(live_assignments)} live assignment(s) in Google Classroom")

    if not live_assignments:
        return

    # Step 2: For every live assignment, import it if new or sync submissions if existing
    # import_google_coursework handles both cases — creating on first call, syncing on subsequent ones
    for assignment in live_assignments:
        try:
            result = await import_google_coursework(
                google_coursework_id=assignment["google_coursework_id"],
                course_id=assignment["course_id"],
                user=user,
                db=db,
                context=None,  # Falls back to the Classroom description as the AI context
                course_name=assignment["course_name"],
            )
            if result["new_submissions"] > 0:
                print(
                    f"[sync job] {result['new_submissions']} new submission(s) "
                    f"for '{result['title']}' ({assignment['course_name']})"
                )
        except HTTPException as e:
            print(f"[sync job] HTTP error for '{assignment['title']}': {e.detail}")
        except Exception as e:
            print(f"[sync job] Error for '{assignment['title']}': {e}")

    # Step 3: Auto-generate individual AI reports for any submission that doesn't have one
    unprocessed = (
        db.query(Submission)
        .join(Coursework)
        .filter(
            Coursework.user_id == user.user_id,
            Submission.individual_report.is_(None),
        )
        .all()
    )

    for sub in unprocessed:
        try:
            generate_individual_report(
                coursework_id=sub.coursework_id,
                submission_id=sub.submission_id,
                user=user,
                db=db,
            )
            print(f"[sync job] Generated report for {sub.student_name or f'submission {sub.submission_id}'}")
        except HTTPException as e:
            print(f"[sync job] HTTP error generating report for submission_id={sub.submission_id}: {e.detail}")
        except Exception as e:
            print(f"[sync job] Error generating report for submission_id={sub.submission_id}: {e}")

    # Step 4: Auto-generate class-wide reports for assignments that have submissions but no report yet
    needs_classwide = (
        db.query(Coursework)
        .outerjoin(Report, Report.coursework_id == Coursework.coursework_id)
        .filter(
            Coursework.user_id == user.user_id,
            Report.report_id.is_(None),  # no class-wide report yet
        )
        .all()
    )

    for cw in needs_classwide:
        has_submissions = db.query(Submission).filter(
            Submission.coursework_id == cw.coursework_id
        ).first()
        if not has_submissions:
            continue
        try:
            generate_report(coursework_id=cw.coursework_id, user=user, db=db)
            print(f"[sync job] Generated class-wide report for '{cw.title}' ({cw.course_name})")
            # Fire an immediate email if the teacher wants one
            pref = user.notification_preference or "immediate"
            if pref in ("immediate", "immediate_weekly"):
                db.refresh(cw)  # Load the freshly generated report
                await send_immediate_email(user, cw, db)
        except HTTPException as e:
            print(f"[sync job] HTTP error generating class-wide report for coursework_id={cw.coursework_id}: {e.detail}")
        except Exception as e:
            print(f"[sync job] Error generating class-wide report for coursework_id={cw.coursework_id}: {e}")
