import asyncio
from datetime import datetime, date

from app.jobs.email import send_notifs
from app.controllers.google import fetch_google_courses, sync_course_coursework
from app.database import SessionLocal
from app.models.user import User

_task: asyncio.Task | None = None
# No longer syncing Classroom data here on a timer — syncing now happens on demand
# (see fetch_google_courses/sync_course_coursework), and report generation is a
# deliberate teacher action (the Build button), never automatic. This loop only
# exists to check the notification schedule, so it doesn't need to tick every few
# seconds — checking every 30 minutes still reliably catches 7am UTC.
SCHEDULER_TICK_SECONDS = 1800

# Track last send dates so we only fire each notification once per day/week even if
# the loop ticks many times in the same hour
_last_daily_date: date | None = None
_last_weekly_date: date | None = None


async def _run_periodic() -> None:
    global _last_daily_date, _last_weekly_date
    while True:
        now = datetime.utcnow()
        today = now.date()

        # Daily notification — every day at 7am UTC
        if now.hour == 7 and today != _last_daily_date:
            _last_daily_date = today
            await _send_notifs_batch(window_hours=24, pref_values=("daily",))

        # Weekly notification — every Monday at 7am UTC
        if now.hour == 7 and now.weekday() == 0 and today != _last_weekly_date:
            _last_weekly_date = today
            await _send_notifs_batch(window_hours=24 * 7, pref_values=("weekly",))

        await asyncio.sleep(SCHEDULER_TICK_SECONDS)


async def _send_notifs_batch(window_hours: int, pref_values: tuple) -> None:
    label = "daily" if window_hours <= 24 else "weekly"
    db = SessionLocal()
    try:
        users = (
            db.query(User)
            .filter(User.email_notifications_enabled.is_(True))
            .filter(User.notification_preference.in_(pref_values))
            .all()
        )
        print(f"[scheduler] Sending {label} notifs to {len(users)} user(s)")
        for user in users:
            try:
                # Sync this teacher's courses right before compiling their email —
                # this is the only place Classroom gets fetched on a schedule rather
                # than a teacher opening a screen, and it only happens once per day
                # (or week) for someone who explicitly opted into these emails, so
                # "ready to build" is accurate even for assignments they haven't
                # opened in Signal yet.
                live = await fetch_google_courses(user, db)
                for course in live["courses"]:
                    await sync_course_coursework(course["course_id"], course["course_name"], user, db)

                await send_notifs(user, db, window_hours)
            except Exception as e:
                print(f"[scheduler] Error sending {label} notifs to user_id={user.user_id}: {e}")
    finally:
        db.close()


async def start_scheduler() -> None:
    global _task
    _task = asyncio.create_task(_run_periodic())
    print(f"[scheduler] Started — checking notification schedule every {SCHEDULER_TICK_SECONDS}s")


def stop_scheduler() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
        print("[scheduler] Stopped")
