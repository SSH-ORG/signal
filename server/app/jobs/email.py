import os
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.controllers.google import SUBMITTED_STATES
from app.controllers.report import (
    FONT_STACK, INK, MUTED, COLOR, _email_shell, _footer_reminder_html, MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT,
)

RESEND_API_URL = "https://api.resend.com/emails"


# ── HTML helpers ─────────────────────────────────────────────────────────────

def _days_ago(due_date, now) -> str:
    days = max(0, (now.date() - due_date.date()).days)
    if days == 0:
        return "due today"
    return f"{days} day{'s' if days != 1 else ''} past due"


def _assignment_card_html(cw, frontend_url: str, now, *, is_first: bool, is_last: bool) -> str:
    # Every enrolled student has a row now (see sync_coursework), whether or
    # not they've submitted — total enrolled is just the row count, and the
    # "submitted" half must filter to submitted states specifically
    total_count = len(cw.submissions)
    submitted_count = sum(1 for s in cw.submissions if s.state in SUBMITTED_STATES)
    build_url = f"{frontend_url}/?coursework_id={cw.coursework_id}"

    meta_parts = []
    if cw.course_name:
        meta_parts.append(cw.course_name)
    meta_parts.append(f"{submitted_count} of {total_count} submitted")
    meta_parts.append(_days_ago(cw.due_date, now) if cw.due_date else "no due date")
    meta_html = "<br>".join(meta_parts)

    top = 0 if is_first else 18
    bottom = 0 if is_last else 12
    border = "" if is_last else f"border-bottom:1.5px solid {COLOR['purple']['border']};"

    return f"""
<tr>
  <td style="padding:{top}px 0 {bottom}px;{border}font-family:{FONT_STACK};">
    <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:{INK};mso-line-height-rule:exactly;line-height:22px;">{cw.title}</p>
    <p style="margin:0;font-size:13px;font-style:italic;color:{MUTED};mso-line-height-rule:exactly;line-height:20px;">{meta_html}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-collapse:separate;">
      <tr>
        <td align="center" bgcolor="{COLOR['purple']['text']}" style="background:{COLOR['purple']['text']};border-radius:7px;padding:10px 20px;">
          <a href="{build_url}" style="display:block;font-family:{FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.06em;mso-line-height-rule:exactly;line-height:18px;">BUILD</a>
        </td>
      </tr>
    </table>
  </td>
</tr>"""


def _ready_to_build_ordered(coursework_list):
    # Most recently due first; undated ones (not produced by the query today,
    # but handled here in case that ever changes) sink to the bottom, oldest
    # created first — same tiebreaker AssignmentsPage uses for undated items
    dated = sorted((cw for cw in coursework_list if cw.due_date), key=lambda cw: cw.due_date, reverse=True)
    undated = sorted((cw for cw in coursework_list if not cw.due_date), key=lambda cw: cw.coursework_id)
    return dated + undated


def _ready_to_build_body_html(coursework_list, frontend_url: str, now) -> str:
    # One purple-outlined table holding every assignment, no separate banner
    # row — each button links straight to that assignment's own build screen
    ordered = _ready_to_build_ordered(coursework_list)
    rows = "".join(
        _assignment_card_html(cw, frontend_url, now, is_first=(i == 0), is_last=(i == len(ordered) - 1))
        for i, cw in enumerate(ordered)
    )
    border_color = COLOR['purple']['border']
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-top:22px;border-collapse:separate;border-spacing:0;">
  <tr>
    <td style="padding:18px 16px;background:#ffffff;font-family:{FONT_STACK};border-left:2px solid {border_color};border-right:2px solid {border_color};border-top:2px solid {border_color};border-bottom:2px solid {border_color};border-radius:10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
        {rows}
      </table>
    </td>
  </tr>
</table>"""


def _ready_to_build_email_html(coursework_list, frontend_url: str, now) -> str:
    titles = [cw.title for cw in coursework_list]
    title = titles[0] if len(titles) == 1 else "Build a report on these assignments"
    preheader = ", ".join(titles) + " &mdash; submissions are in"
    body_html = _ready_to_build_body_html(coursework_list, frontend_url, now)
    return _email_shell(title, "", body_html, preheader, _footer_reminder_html())


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

    # Assignments whose due date fell within the window and still have no
    # report — `context` is assembled from 3 real columns as a Python
    # property (see the Coursework model), not a column itself, so it can't
    # be filtered in SQL; the context check below happens in Python instead.
    # build_report rejects one with no mental model, description, or rubric,
    # or with fewer than MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT submissions
    # that actually have content — so a card promising a report that will
    # just error isn't "ready to build" at all
    candidates = (
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
    ready_to_build = [
        cw for cw in candidates
        if cw.context and cw.context.strip()
        and sum(1 for s in cw.submissions if s.content and s.content.strip()) >= MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT
    ]

    if not ready_to_build:
        print(f"[email] Nothing ready to build for user_id={user.user_id} — skipping")
        return False

    n = len(ready_to_build)
    subject = f"Ready to build: {ready_to_build[0].title}" if n == 1 else f"{n} assignments are ready for a report"
    html = _ready_to_build_email_html(ready_to_build, frontend_url, now)

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
