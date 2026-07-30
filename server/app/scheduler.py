import asyncio
from datetime import datetime, date

from app.jobs.email import send_digest
from app.database import SessionLocal
from app.models.user import User

_task: asyncio.Task | None = None
# No longer syncing Classroom data here — syncing now happens on demand (see
# fetch_google_coursework/sync_course_coursework), and report generation is a
# deliberate teacher action (the Build button), never automatic. This loop
# only exists to check the digest-email schedule, so it doesn't need to tick
# every few seconds — checking every 30 minutes still reliably catches 7am UTC.
SCHEDULER_TICK_SECONDS = 1800

# Track last send dates so we only fire each digest once per day/week even if
# the loop ticks many times in the same hour
_last_daily_date: date | None = None
_last_weekly_date: date | None = None


async def _run_periodic() -> None:
    global _last_daily_date, _last_weekly_date
    while True:
        now = datetime.utcnow()
        today = now.date()

        # Daily digest — every day at 7am UTC
        if now.hour == 7 and today != _last_daily_date:
            _last_daily_date = today
            await _send_digests(window_hours=24, pref_values=("daily",))

        # Weekly digest — every Monday at 7am UTC
        if now.hour == 7 and now.weekday() == 0 and today != _last_weekly_date:
            _last_weekly_date = today
            await _send_digests(window_hours=24 * 7, pref_values=("weekly",))

        await asyncio.sleep(SCHEDULER_TICK_SECONDS)


async def _send_digests(window_hours: int, pref_values: tuple) -> None:
    label = "daily" if window_hours <= 24 else "weekly"
    db = SessionLocal()
    try:
        users = (
            db.query(User)
            .filter(User.email_notifications_enabled.is_(True))
            .filter(User.notification_preference.in_(pref_values))
            .all()
        )
        print(f"[scheduler] Sending {label} digest to {len(users)} user(s)")
        for user in users:
            try:
                await send_digest(user, db, window_hours)
            except Exception as e:
                print(f"[scheduler] Error sending {label} digest to user_id={user.user_id}: {e}")
    finally:
        db.close()


async def start_scheduler() -> None:
    global _task
    _task = asyncio.create_task(_run_periodic())
    print(f"[scheduler] Started — checking digest schedule every {SCHEDULER_TICK_SECONDS}s")


def stop_scheduler() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
        print("[scheduler] Stopped")
