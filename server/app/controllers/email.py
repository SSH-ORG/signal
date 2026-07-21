import os
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework

RESEND_API_URL = "https://api.resend.com/emails"


def _convert_bold(text: str) -> str:
    # Convert **bold** to <strong> tags for email HTML
    import re
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)


def _report_to_html(title: str, content: str) -> str:
    # Convert the AI report markdown into a styled HTML email body.
    # Handles ## section headings, - bullet points, and **bold** text.

    # Split the report into sections by ## headings
    import re
    raw_sections = re.split(r'(?=##\s)', content.strip())

    sections_html = ""
    for raw in raw_sections:
        if not raw.strip():
            continue
        lines = raw.strip().split('\n')
        heading = re.sub(r'^#+\s*', '', lines[0]).strip()
        body_lines = [l for l in lines[1:] if l.strip()]

        # Group consecutive bullet lines into a single <ul>
        body_html = ""
        in_list = False
        for line in body_lines:
            is_bullet = re.match(r'^[\-\*]\s', line)
            if is_bullet:
                if not in_list:
                    body_html += '<ul style="margin: 0 0 8px; padding-left: 20px;">'
                    in_list = True
                text = re.sub(r'^[\-\*]\s', '', line)
                body_html += f'<li style="margin-bottom:4px;font-size:14px;line-height:1.6;">{_convert_bold(text)}</li>'
            else:
                if in_list:
                    body_html += '</ul>'
                    in_list = False
                body_html += f'<p style="margin:0 0 8px;font-size:14px;line-height:1.6;">{_convert_bold(line)}</p>'
        if in_list:
            body_html += '</ul>'

        sections_html += f"""
<div style="margin-bottom:28px;">
  <h2 style="font-size:15px;font-weight:700;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #f0f0f0;color:#111;">{heading}</h2>
  <div>{body_html}</div>
</div>"""

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9f9f9;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:32px auto;padding:32px 28px;background:#ffffff;border-radius:8px;border:1px solid #e8e8e8;color:#1a1a1a;">
    <div style="margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #111;">
      <p style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:0 0 8px;">Signal · AI Report</p>
      <h1 style="font-size:20px;font-weight:700;margin:0;">{title}</h1>
    </div>

    {sections_html}

    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e8;font-size:12px;color:#aaa;">
      Sent from Signal. Open the app to view, regenerate, or share this report.
    </div>
  </div>
</body>
</html>"""

    return html


async def send_report_email(coursework_id: int, to_email: str, user: User, db: Session) -> dict:
    # Fetch the assignment and confirm it belongs to this teacher
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=400, detail="No report has been generated for this assignment yet")

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    html_body = _report_to_html(coursework.title, coursework.report.content)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [to_email],
                "subject": f"Signal Report: {coursework.title}",
                "html": html_body,
            },
            timeout=15.0,
        )

    if resp.status_code not in (200, 201):
        # Surface Resend's error message to help debug key/domain issues
        try:
            detail = resp.json().get("message", "Failed to send email")
        except Exception:
            detail = "Failed to send email"
        raise HTTPException(status_code=502, detail=detail)

    return {"sent": True, "to": to_email}
