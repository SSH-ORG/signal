import os
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework

RESEND_API_URL = "https://api.resend.com/emails"


# ── HTML helpers ─────────────────────────────────────────────────────────────

# Formats a due date the same way ReportsPage formats report build dates
# ("Jul 31, 2026") so emails read consistently with the app's own date style
def _format_due_date(due_date) -> str:
    return due_date.strftime("%b %-d, %Y")


# Assignments whose due date has passed but have no class-wide report yet —
# a nudge to go build (or, if context is still missing, add context first).
# Each one renders as a card matching the app's own item-card styling
# (AssignmentsPage/ReportsPage) — title, submission count, due date — and
# links straight back into Signal so the nudge is one click from action.
def _ready_to_build_html(coursework_list, frontend_url) -> str:
    # Most recently due first; undated ones (not produced by the query today,
    # but handled here in case that ever changes) sink to the bottom, oldest
    # created first — same tiebreaker AssignmentsPage uses for undated items
    dated = sorted((cw for cw in coursework_list if cw.due_date), key=lambda cw: cw.due_date, reverse=True)
    undated = sorted((cw for cw in coursework_list if not cw.due_date), key=lambda cw: cw.coursework_id)
    ordered = dated + undated

    cards = "".join(
        f"""
<a href="{frontend_url}" style="display:block;margin-bottom:8px;background:#fff;
                                 border:1px solid #cbc9d1;border-radius:8px;text-decoration:none;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="padding:14px 16px;vertical-align:middle;">
        <div style="font-size:15px;font-weight:600;color:#08060d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          {cw.title}
        </div>
        <div style="font-size:12px;color:#6b6375;margin-top:3px;">
          {cw.course_name or 'Class'}
          &middot; {len(cw.submissions)}{f' of {cw.student_count}' if cw.student_count else ''} submission{'s' if len(cw.submissions) != 1 else ''}
          &middot; {f'due {_format_due_date(cw.due_date)}' if cw.due_date else 'no due date'}
        </div>
      </td>
      <td width="28" style="padding:14px 16px 14px 0;vertical-align:middle;text-align:right;white-space:nowrap;">
        <span style="font-size:18px;color:#6b6375;">&rsaquo;</span>
      </td>
    </tr>
  </table>
</a>"""
        for cw in ordered
    )
    return f"""
<div style="border:1px solid #e8e8e8;border-radius:10px;overflow:hidden;">
  <div style="background:#f8f9fa;padding:14px 18px;border-bottom:1px solid #e8e8e8;">
    <p style="margin:0;font-size:13px;font-weight:700;color:#111;">
      READY TO BUILD
    </p>
  </div>
  <div style="padding:14px 18px;">
    {cards}
  </div>
</div>"""


def _full_email_html(ready_to_build_html: str, frontend_url: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f0;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:640px;margin:32px auto;padding:0 16px 32px;">

    <!-- Ready to build -->
    <div style="background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:24px 28px;">
      {ready_to_build_html}
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:24px 0 0;font-size:12px;color:#aaa;">
      <p style="margin:0 0 6px;">signal@marcylab.us</p>
      <a href="{frontend_url}" style="color:#aaa;text-decoration:underline;">
        Turn off notifications
      </a>
    </div>

  </div>
</body>
</html>"""


# ── Send functions ───────────────────────────────────────────────────────────

async def send_notifs(user: User, db: Session, window_hours: int) -> bool:
    """Email the teacher a list of assignments that are ready to build a report for."""
    if not user.email:
        return False

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        print(f"[email] RESEND_API_KEY not set — skipping notif for user_id={user.user_id}")
        return False

    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    now = datetime.utcnow()
    cutoff = now - timedelta(hours=window_hours)

    # Assignments whose due date fell within the window but still have no report
    ready_to_build = (
        db.query(Coursework)
        .filter(
            Coursework.user_id == user.user_id,
            Coursework.due_date.isnot(None),
            Coursework.due_date <= now,
            Coursework.due_date >= cutoff,
        )
        .filter(~Coursework.report.has())
        .all()
    )

    if not ready_to_build:
        print(f"[email] Nothing ready to build for user_id={user.user_id} — skipping")
        return False

    subject = "REMINDER: BUILD REPORT"

    html = _full_email_html(
        ready_to_build_html=_ready_to_build_html(ready_to_build, frontend_url),
        frontend_url=frontend_url,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [user.email],
                "subject": subject,
                "html": html,
            },
            timeout=15.0,
        )

    if resp.status_code not in (200, 201):
        print(f"[email] Resend error for user_id={user.user_id}: {resp.text}")
        return False

    print(f"[email] {'Daily' if window_hours <= 24 else 'Weekly'} notif sent to {user.email}")
    return True
