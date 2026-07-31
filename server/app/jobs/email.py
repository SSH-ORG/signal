import os
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework

RESEND_API_URL = "https://api.resend.com/emails"


# ── HTML helpers ─────────────────────────────────────────────────────────────

# Assignments whose due date has passed but have no class-wide report yet —
# a nudge to go build (or, if context is still missing, add context first).
# Shows each assignment's submission count so the teacher can judge whether
# there's enough in yet to be worth building from.
def _ready_to_build_html(coursework_list) -> str:
    rows = "".join(
        f"""
<tr>
  <td style="padding:10px 0;border-bottom:1px solid #f4f4f4;">
    <strong style="font-size:14px;color:#111;">{cw.title}</strong>
    <p style="margin:2px 0 0;font-size:12px;color:#888;">
      {cw.course_name or 'Class'} &middot; {len(cw.submissions)} submission{'s' if len(cw.submissions) != 1 else ''}
      {f' of {cw.student_count}' if cw.student_count else ''}
    </p>
  </td>
</tr>"""
        for cw in coursework_list
    )
    count = len(coursework_list)
    return f"""
<div style="border:1px solid #e8e8e8;border-radius:10px;overflow:hidden;">
  <div style="background:#f8f9fa;padding:14px 18px;border-bottom:1px solid #e8e8e8;">
    <p style="margin:0;font-size:13px;font-weight:700;color:#111;">
      Ready to build — {count} assignment{'s' if count != 1 else ''}
    </p>
  </div>
  <div style="padding:4px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
  </div>
</div>"""


def _full_email_html(
    notif_title: str,
    date_str: str,
    ready_to_build_count: int,
    ready_to_build_html: str,
    frontend_url: str,
) -> str:
    meta_line = (
        f"{date_str} &nbsp;&middot;&nbsp; "
        f"{ready_to_build_count} assignment{'s' if ready_to_build_count != 1 else ''} ready to build"
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f0;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:640px;margin:32px auto;padding:0 16px 32px;">

    <!-- Header -->
    <div style="background:#111;border-radius:10px 10px 0 0;padding:24px 28px;">
      <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;
                color:#666;margin:0 0 8px;">Signal</p>
      <h1 style="font-size:20px;font-weight:700;color:#fff;margin:0 0 6px;">{notif_title}</h1>
      <p style="font-size:13px;color:#aaa;margin:0;">{meta_line}</p>
    </div>

    <!-- Ready to build -->
    <div style="background:#fff;border:1px solid #e8e8e8;border-top:none;
                border-radius:0 0 10px 10px;padding:24px 28px;">
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

    today = now.strftime("%-d %B %Y")
    notif_title = "Daily Signal Reminder" if window_hours <= 24 else "Weekly Signal Reminder"
    subject = f"Ready to build — {today}"

    html = _full_email_html(
        notif_title=notif_title,
        date_str=today,
        ready_to_build_count=len(ready_to_build),
        ready_to_build_html=_ready_to_build_html(ready_to_build),
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
