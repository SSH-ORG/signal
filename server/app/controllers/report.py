import os
import re
import httpx
from groq import Groq
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.user import User
from app.models.coursework import Coursework
from app.models.report import Report

RESEND_API_URL = "https://api.resend.com/emails"

# Initialize the Groq client — free tier, no credit card required
# Uses Llama 3.3 70B which is strong enough for educational text analysis
client = Groq(api_key=os.getenv("GROQ_API_KEY"))


def generate_report(coursework_id: int, user: User, db: Session) -> dict:
    # Fetch the assignment and make sure it belongs to this teacher
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    # Can't generate a report if there are no submissions to analyze
    if not coursework.submissions:
        raise HTTPException(status_code=400, detail="No submissions found for this assignment")

    # Build the list of student submissions to send to the AI
    submissions_text = "\n\n".join([
        f"Student {i + 1}:\n{sub.content}"
        for i, sub in enumerate(coursework.submissions)
    ])

    # Detect whether the teacher's context contains a rubric so we can
    # switch the AI into criterion-by-criterion evaluation mode
    has_rubric = bool(coursework.context and "Rubric:" in coursework.context)

    context_section = (
        f"\nContext provided by the teacher:\n{coursework.context}\n"
        if coursework.context
        else ""
    )

    if has_rubric:
        # Rubric-aware prompt — forces the AI to evaluate every submission
        # against every criterion and report only what is actually in the text
        prompt = f"""You are a strict educational analyst reviewing student submissions for a teacher.
Your job is to evaluate submissions against the rubric provided and report exactly what you find — correct responses, incorrect responses, and missing understanding. Do not generalize or invent patterns that are not directly supported by the submission text.

Assignment: {coursework.title}
{context_section}
Student Submissions:
{submissions_text}

Using the rubric above, analyze the submissions and generate a report with exactly three sections using ## markdown headings, in this exact order:

## Rubric Breakdown
For each criterion in the rubric:
- State the criterion name
- Describe what a correct response looks like based on the rubric
- Describe what students actually wrote — specifically identify what was correct, what was incorrect or incomplete, and what was missing entirely
- If most students got something wrong, quote or closely paraphrase the specific error from the submissions
Do not refer to students by number or any identifier. Describe class-wide patterns only, grounded in what was actually written.

## Incorrect or Incomplete Responses
Identify the most common ways students answered incorrectly or incompletely. For each error type:
- Describe the specific mistake (what they wrote or failed to address)
- Explain why it is incorrect based on the assignment or rubric
- Estimate how widespread it is (e.g. "most students", "roughly half", "a few students")

## Next Steps
Give 2 to 4 direct, actionable steps the teacher should take in the next class. Each step must be tied to a specific error or gap you identified above. Be concrete — name the concept or criterion that needs to be revisited.

Be precise. Only report what is supported by the actual submission content. Do not pad with general observations."""

    else:
        # No rubric — evaluate correctness based on the assignment itself
        prompt = f"""You are a strict educational analyst reviewing student submissions for a teacher.
Your job is to evaluate whether students answered the assignment correctly and report exactly what you find. Do not generalize or invent patterns — every claim you make must be directly supported by what students actually wrote.

Assignment: {coursework.title}
{context_section}
Student Submissions:
{submissions_text}

Analyze the submissions and generate a report with exactly three sections using ## markdown headings, in this exact order:

## What Students Got Right
Describe what students answered correctly based on the assignment. Be specific — reference the actual content of the submissions. If no students answered correctly, say so directly.

## What Students Got Wrong or Missed
Identify every type of incorrect or incomplete response across the submissions:
- Describe the specific mistake or gap (what they wrote or failed to address)
- Explain why it is incorrect or insufficient based on the assignment
- Estimate how widespread each error is (e.g. "most students", "roughly half", "a few students")
If a submission is completely off-topic or does not answer the assignment, state that clearly.

## Next Steps
Give 2 to 4 direct, specific actions the teacher should take in the next class. Each action must address a specific error or gap you identified above. Name the concept that needs to be retaught or clarified.

Be precise and direct. Only report what is supported by the actual submission content. Do not pad with general educational observations."""

    # Send the prompt to Groq (Llama 3.3 70B) and get the report back
    # temperature=0.3 keeps responses focused and grounded — less creative drift
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )
    report_content = response.choices[0].message.content

    # Regenerating — replace the existing report's content instead of blocking,
    # since new submissions or an edited prompt/context are exactly why a
    # teacher would want to redo it. Otherwise, this is the first report.
    if coursework.report:
        report = coursework.report
        report.content = report_content
        report.created_at = func.now()
    else:
        report = Report(
            content=report_content,
            coursework_id=coursework.coursework_id,
        )
        db.add(report)

    db.commit()
    db.refresh(report)

    return {
        "report_id": report.report_id,
        "coursework_id": coursework.coursework_id,
        "content": report.content,
        "created_at": report.created_at,
    }


def get_all_reports(user: User, db: Session) -> list:
    # Returns all assignments that have a generated report for this teacher
    # Used by the global Reports page in the sidebar
    coursework_list = db.query(Coursework).filter(
        Coursework.user_id == user.user_id
    ).all()

    return [
        {
            "coursework_id": cw.coursework_id,
            "title": cw.title,
            "google_coursework_id": cw.google_coursework_id,
            "course_name": cw.course_name or "",  # Stored at import time so it's available even for archived courses
            "report_id": cw.report.report_id,
            "created_at": cw.report.created_at,
        }
        for cw in coursework_list
        if cw.report
    ]


def get_report(coursework_id: int, user: User, db: Session) -> dict:
    # Returns the existing report for an assignment if one has been generated
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=404, detail="No report generated yet for this assignment")

    return {
        "report_id": coursework.report.report_id,
        "coursework_id": coursework.coursework_id,
        "content": coursework.report.content,
        "created_at": coursework.report.created_at,
    }


async def email_report(coursework_id: int, user: User, db: Session) -> dict:
    # Emails the existing report to the teacher's own address via Resend
    # Uses Resend (HTTP API) instead of Gmail so no extra OAuth scope is needed
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=400, detail="No report generated yet for this assignment")

    if not user.email:
        raise HTTPException(status_code=400, detail="No email address on file for your account")

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    html_body = _report_to_html(coursework.title, coursework.report.content)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [user.email],
                "subject": f"Signal Report: {coursework.title}",
                "html": html_body,
            },
            timeout=15.0,
        )

    if resp.status_code not in (200, 201):
        try:
            detail = resp.json().get("message", "Failed to send email")
        except Exception:
            detail = "Failed to send email"
        raise HTTPException(status_code=502, detail=detail)

    return {"sent": True, "to": user.email}


def _report_to_html(title: str, content: str) -> str:
    # Converts the AI report markdown into a styled HTML email body
    raw_sections = re.split(r'(?=##\s)', content.strip())

    sections_html = ""
    for raw in raw_sections:
        if not raw.strip():
            continue
        lines = raw.strip().split('\n')
        heading = re.sub(r'^#+\s*', '', lines[0]).strip()
        body_lines = [l for l in lines[1:] if l.strip()]

        body_html = ""
        in_list = False
        for line in body_lines:
            is_bullet = re.match(r'^[\-\*]\s', line)
            if is_bullet:
                if not in_list:
                    body_html += '<ul style="margin:0 0 8px;padding-left:20px;">'
                    in_list = True
                text = re.sub(r'^[\-\*]\s', '', line)
                text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
                body_html += f'<li style="margin-bottom:4px;font-size:14px;line-height:1.6;">{text}</li>'
            else:
                if in_list:
                    body_html += '</ul>'
                    in_list = False
                text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', line)
                body_html += f'<p style="margin:0 0 8px;font-size:14px;line-height:1.6;">{text}</p>'
        if in_list:
            body_html += '</ul>'

        sections_html += f"""
<div style="margin-bottom:28px;">
  <h2 style="font-size:15px;font-weight:700;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #f0f0f0;">{heading}</h2>
  {body_html}
</div>"""

    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f9f9f9;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:32px auto;padding:32px 28px;background:#fff;border-radius:8px;border:1px solid #e8e8e8;">
    <div style="margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #111;">
      <p style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:0 0 8px;">Signal · AI Report</p>
      <h1 style="font-size:20px;font-weight:700;margin:0;">{title}</h1>
    </div>
    {sections_html}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e8;font-size:12px;color:#aaa;">
      Sent from Signal. Open the app to regenerate or share this report.
    </div>
  </div>
</body></html>"""
