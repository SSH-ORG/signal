import os
import re
import httpx
from datetime import datetime, timedelta
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.report import Report

RESEND_API_URL = "https://api.resend.com/emails"

# ── Token helpers ────────────────────────────────────────────────────────────

def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(os.getenv("SESSION_SECRET", "dev-secret"))


def generate_resolve_token(submission_id: int) -> str:
    return _signer().dumps(submission_id, salt="resolve")


def verify_resolve_token(token: str, max_age_days: int = 7) -> int | None:
    try:
        return _signer().loads(token, salt="resolve", max_age=max_age_days * 86400)
    except (BadSignature, SignatureExpired):
        return None


# ── Flag detection ───────────────────────────────────────────────────────────

def get_flag_level(individual_report: str | None) -> str | None:
    if not individual_report:
        return None
    if "Misconception present" in individual_report or (
        "Misconceptions Detected" in individual_report
        and "No misconceptions detected" not in individual_report
    ):
        return "misconception"
    if "Partial understanding" in individual_report:
        return "partial"
    if any(t in individual_report for t in [
        "No engagement", "Submission was blank",
        "Submission too short", "Submission did not address",
    ]):
        return "no-engagement"
    return "on-track"


_FLAG_META = {
    "misconception":  ("Misconception", "#d93025", "#fff0f0"),
    "partial":        ("Partial",       "#e67e22", "#fff8f0"),
    "no-engagement":  ("No response",  "#7f8c8d", "#f5f5f5"),
    "on-track":       ("On track",     "#27ae60", "#f0fff4"),
}

_FLAG_SEVERITY = {"misconception": 0, "no-engagement": 1, "partial": 2, "on-track": 3}


# ── HTML helpers ─────────────────────────────────────────────────────────────

def _one_liner(individual_report: str | None) -> str:
    if not individual_report:
        return "No report generated."
    match = re.search(
        r'## 📋 Submission Summary\n(.+?)(?=\n---|\n##|$)',
        individual_report, re.DOTALL,
    )
    if match:
        text = match.group(1).strip()
        sentences = re.split(r'(?<=[.!?])\s+', text)
        return sentences[0][:160] if sentences else text[:160]
    lines = [l.strip() for l in individual_report.split('\n') if l.strip() and not l.startswith('#')]
    return lines[0][:160] if lines else "See full report in Signal."


def _student_row_html(sub, server_url: str) -> str:
    name = sub.student_name or f"Student {sub.submission_id}"
    note = _one_liner(sub.individual_report)
    level = get_flag_level(sub.individual_report)
    label, color, bg = _FLAG_META.get(level, ("Unknown", "#888", "#f5f5f5"))
    token = generate_resolve_token(sub.submission_id)
    resolve_url = f"{server_url}/api/resolve/{sub.submission_id}/{token}"
    mailto = "mailto:?subject=Checking%20in%20on%20your%20recent%20assignment"
    return f"""
<tr>
  <td style="padding:12px 0;border-bottom:1px solid #f4f4f4;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <strong style="font-size:14px;color:#111;">{name}</strong>
        <span style="display:inline-block;margin-left:8px;font-size:11px;font-weight:700;
                     color:{color};background:{bg};border-radius:100px;padding:2px 8px;">{label}</span>
        <p style="margin:4px 0 0;font-size:13px;color:#555;line-height:1.5;">{note}</p>
      </td>
      <td style="text-align:right;white-space:nowrap;vertical-align:top;padding-left:16px;">
        <a href="{mailto}"
           style="display:inline-block;font-size:12px;font-weight:600;color:#333;
                  background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;
                  padding:4px 10px;text-decoration:none;margin-right:6px;">Email student</a>
        <a href="{resolve_url}"
           style="display:inline-block;font-size:12px;font-weight:600;color:#27ae60;
                  background:#f0fff4;border:1px solid #b7ebc8;border-radius:6px;
                  padding:4px 10px;text-decoration:none;">Resolve ✓</a>
      </td>
    </tr></table>
  </td>
</tr>"""


def _class_section_html(coursework, server_url: str) -> str:
    subs = coursework.submissions
    flagged = sorted(
        [(s, get_flag_level(s.individual_report)) for s in subs
         if get_flag_level(s.individual_report) not in ("on-track", None) and not s.resolved],
        key=lambda x: _FLAG_SEVERITY.get(x[1], 3),
    )
    on_track = [s for s in subs if get_flag_level(s.individual_report) == "on-track"]
    total = len(subs)
    flagged_count = len(flagged)
    on_track_count = len(on_track)

    # Extract the one-paragraph Class Overview from the AI report
    class_summary = ""
    if coursework.report:
        m = re.search(
            r'## 📊 Class Overview\n(.+?)(?=\n---|\n##|$)',
            coursework.report.content, re.DOTALL,
        )
        if m:
            class_summary = m.group(1).strip()

    # Flagged students block
    flagged_html = ""
    if flagged:
        rows = "".join(_student_row_html(s, server_url) for s, _ in flagged)
        flagged_html = f"""
<div style="margin-bottom:20px;">
  <p style="font-size:11px;font-weight:700;text-transform:uppercase;
             letter-spacing:0.06em;color:#d93025;margin:0 0 12px;">
    Needs Attention — {flagged_count} student{'s' if flagged_count != 1 else ''}
  </p>
  <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
</div>"""

    # AI summary box
    summary_html = ""
    if class_summary:
        summary_html = f"""
<div style="background:#f8f9fa;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
  <p style="font-size:11px;font-weight:700;text-transform:uppercase;
             letter-spacing:0.06em;color:#888;margin:0 0 6px;">AI Class Summary</p>
  <p style="font-size:13px;color:#333;line-height:1.6;margin:0;">{class_summary}</p>
</div>"""

    # On track summary line
    on_track_html = ""
    if on_track:
        shown = on_track[:2]
        more = on_track_count - 2
        names = ", ".join(s.student_name or f"Student {s.submission_id}" for s in shown)
        more_text = f" + {more} more on track" if more > 0 else ""
        on_track_html = f"""
<p style="font-size:13px;color:#27ae60;margin:0;">
  <span style="font-weight:600;">On track:</span> {names}{more_text}
</p>"""

    flagged_badge = (
        f'<span style="font-size:11px;font-weight:700;color:#d93025;background:#fff0f0;'
        f'border-radius:100px;padding:2px 8px;margin-left:8px;">{flagged_count} flagged</span>'
        if flagged_count > 0 else ""
    )
    on_track_badge = (
        f'<span style="font-size:11px;font-weight:700;color:#27ae60;background:#f0fff4;'
        f'border-radius:100px;padding:2px 8px;margin-left:6px;">{on_track_count} on track</span>'
        if on_track_count > 0 else ""
    )

    return f"""
<div style="margin-bottom:20px;border:1px solid #e8e8e8;border-radius:10px;overflow:hidden;">
  <div style="background:#f8f9fa;padding:14px 18px;border-bottom:1px solid #e8e8e8;">
    <p style="margin:0;font-size:15px;font-weight:700;color:#111;">{coursework.title}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#888;">
      {coursework.course_name or 'Class'} &middot; {total} submission{'s' if total != 1 else ''}
      {flagged_badge}{on_track_badge}
    </p>
  </div>
  <div style="padding:18px;">
    {flagged_html}
    {summary_html}
    {on_track_html}
  </div>
</div>"""


def _full_email_html(
    digest_title: str,
    date_str: str,
    classes_count: int,
    total_students: int,
    total_flagged: int,
    total_on_track: int,
    class_sections: str,
    frontend_url: str,
) -> str:
    classes_label = f"{classes_count} class{'es' if classes_count != 1 else ''}"
    attention_label = (
        f"{total_flagged} student{'s' if total_flagged != 1 else ''} "
        f"{'need' if total_flagged != 1 else 'needs'} attention"
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
      <h1 style="font-size:20px;font-weight:700;color:#fff;margin:0 0 6px;">{digest_title}</h1>
      <p style="font-size:13px;color:#aaa;margin:0;">
        {date_str} &nbsp;&middot;&nbsp; {classes_label} &nbsp;&middot;&nbsp; {attention_label}
      </p>
    </div>

    <!-- Stats bar -->
    <div style="background:#fff;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="text-align:center;padding:20px 0;border-right:1px solid #e8e8e8;">
            <p style="font-size:30px;font-weight:700;color:#111;margin:0;">{total_students}</p>
            <p style="font-size:10px;color:#888;margin:4px 0 0;text-transform:uppercase;
                      letter-spacing:0.06em;">Total students</p>
          </td>
          <td style="text-align:center;padding:20px 0;border-right:1px solid #e8e8e8;">
            <p style="font-size:30px;font-weight:700;color:#d93025;margin:0;">{total_flagged}</p>
            <p style="font-size:10px;color:#888;margin:4px 0 0;text-transform:uppercase;
                      letter-spacing:0.06em;">Need attention</p>
          </td>
          <td style="text-align:center;padding:20px 0;">
            <p style="font-size:30px;font-weight:700;color:#27ae60;margin:0;">{total_on_track}</p>
            <p style="font-size:10px;color:#888;margin:4px 0 0;text-transform:uppercase;
                      letter-spacing:0.06em;">On track</p>
          </td>
        </tr>
      </table>
    </div>

    <!-- Class sections -->
    <div style="background:#fff;border:1px solid #e8e8e8;border-top:none;
                border-radius:0 0 10px 10px;padding:24px 28px;">
      {class_sections}
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

async def send_digest(user: User, db: Session, window_hours: int) -> bool:
    """Gather reports from the last `window_hours` and email a digest to the teacher."""
    if not user.email:
        return False

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        print(f"[email] RESEND_API_KEY not set — skipping digest for user_id={user.user_id}")
        return False

    server_url = os.getenv("SERVER_URL", "http://localhost:8000")
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)

    # Only include assignments whose class-wide report was generated in the window
    coursework_list = (
        db.query(Coursework)
        .join(Report, Report.coursework_id == Coursework.coursework_id)
        .filter(
            Coursework.user_id == user.user_id,
            Report.created_at >= cutoff,
        )
        .all()
    )

    if not coursework_list:
        print(f"[email] No reports in window for user_id={user.user_id} — skipping")
        return False

    total_students = sum(len(cw.submissions) for cw in coursework_list)
    if total_students == 0:
        return False

    total_flagged = sum(
        1 for cw in coursework_list for s in cw.submissions
        if get_flag_level(s.individual_report) not in ("on-track", None) and not s.resolved
    )
    total_on_track = total_students - total_flagged

    class_sections = "".join(_class_section_html(cw, server_url) for cw in coursework_list)

    today = datetime.utcnow().strftime("%-d %B %Y")
    if window_hours <= 24:
        subject = f"Your daily Signal summary — {today}"
        digest_title = "Daily Class Summary"
    else:
        subject = f"Your weekly Signal summary — {today}"
        digest_title = "Weekly Class Summary"

    html = _full_email_html(
        digest_title=digest_title,
        date_str=today,
        classes_count=len(coursework_list),
        total_students=total_students,
        total_flagged=total_flagged,
        total_on_track=total_on_track,
        class_sections=class_sections,
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

    print(f"[email] {'Daily' if window_hours <= 24 else 'Weekly'} digest sent to {user.email}")
    return True


async def send_immediate_email(user: User, coursework, db: Session) -> bool:
    """Send an immediate report-ready email when a class-wide report finishes."""
    if not user.email:
        return False

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        return False

    server_url = os.getenv("SERVER_URL", "http://localhost:8000")
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")

    subs = coursework.submissions
    total_students = len(subs)
    total_flagged = sum(
        1 for s in subs
        if get_flag_level(s.individual_report) not in ("on-track", None) and not s.resolved
    )
    total_on_track = total_students - total_flagged

    class_section = _class_section_html(coursework, server_url)
    today = datetime.utcnow().strftime("%-d %B %Y")

    html = _full_email_html(
        digest_title="Report Ready",
        date_str=today,
        classes_count=1,
        total_students=total_students,
        total_flagged=total_flagged,
        total_on_track=total_on_track,
        class_sections=class_section,
        frontend_url=frontend_url,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [user.email],
                "subject": f"Signal report ready — {coursework.title}",
                "html": html,
            },
            timeout=15.0,
        )

    if resp.status_code not in (200, 201):
        print(f"[email] Resend error (immediate) for user_id={user.user_id}: {resp.text}")
        return False

    print(f"[email] Immediate email sent to {user.email} for '{coursework.title}'")
    return True
