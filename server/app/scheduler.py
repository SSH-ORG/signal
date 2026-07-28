import asyncio
from app.jobs.sync import sync_submissions_and_reports

# Handle to the background task so we can cancel it on shutdown
_task: asyncio.Task | None = None

SYNC_INTERVAL_SECONDS = 30  # temporary: 30 seconds for testing


async def _run_periodic() -> None:
    print("[scheduler] First sync starting now...")
    while True:
        try:
            await sync_submissions_and_reports()
        except Exception as e:
            print(f"[scheduler] Unexpected error in sync job: {e}")
        print(f"[scheduler] Next sync in {SYNC_INTERVAL_SECONDS}s")
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)


async def start_scheduler() -> None:
    global _task
    _task = asyncio.create_task(_run_periodic())
    print(f"[scheduler] Started — syncing every {SYNC_INTERVAL_SECONDS}s")


def stop_scheduler() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
        print("[scheduler] Stopped")
