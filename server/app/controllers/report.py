import os
import re
import httpx
from groq import Groq
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission
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

    # Format submissions — use real student names when available, number fallback otherwise
    submissions_text = "\n\n".join([
        f"Student: {sub.student_name or f'Student {i + 1}'}\nSubmission: {sub.content}"
        for i, sub in enumerate(coursework.submissions)
    ])

    context_str = coursework.context if coursework.context else "No context provided — analyze submissions based on content only."

    prompt = f"""You are an expert educator analyzing student submissions for a virtual classroom.

REPORT MODE: Generate a CLASS-WIDE report covering all submissions.

ASSIGNMENT: {coursework.title}

CONTEXT:
{context_str}

STUDENT SUBMISSIONS:
{submissions_text}

---

CLASS-WIDE REPORT FORMAT — follow exactly, these are the ONLY 6 sections allowed:

## 📊 Class Overview
1–2 sentences, general and surface-level, giving a quick read on how the class understood
this assignment overall. No student names, no specific misconceptions or themes here —
save the detail for the sections below.

---

## 🔍 Overview Details
1–2 short paragraphs of expanded narrative on the class's understanding as a whole — broader
patterns and context behind the surface-level summary above. Still no per-student names,
misconception labels, or theme labels — those belong in the sections below, this is
narrative color only.

---

## 🚩 Flagged Students
A flat list of just the names of every student who did not demonstrate understanding —
this includes misconceptions, blank/too-short/off-topic submissions, and non-attempts.
No grouping, no reasons, just names, one per line:

- [Student Name]

If no students are flagged, write: No students flagged.

---

## ⚠️ Common Misconceptions
Group flagged students by the specific misconception or issue they share.

**Misconception:** [describe the specific wrong idea, or issue like "blank submission" / "did not attempt the task", in one sentence]
- [Student Name]
- [Student Name]

Repeat the **Misconception:** block for each distinct misconception found. Every name that
appears in Flagged Students must appear under exactly one misconception here.

If no students are flagged, write: No common misconceptions detected.

---

## ✅ Solid Themes
Group students who demonstrated strong understanding by the theme/skill they showed it through.

**Theme:** [describe the specific thing done well, in one sentence]
- [Student Name]
- [Student Name]

Repeat the **Theme:** block for each distinct theme found. A student here should not also
appear in Flagged Students.

If no students showed strong understanding, write: No solid themes detected.

---

## 💡 Next Steps
2–3 specific actionable things for the teacher to do next class based on what you saw.

- [Specific action]
- [Specific action]

---

EDGE CASE RULES — follow strictly no matter what:
- Blank, too short (under 15 words unless it directly and correctly answers the question),
  off-topic, or gibberish submissions → treat as flagged, group under a misconception like
  "Did not attempt the task" — do not skip them and do not invent a separate section for them
- If ALL submissions are blank or non-attempts → Flagged Students lists everyone, Common
  Misconceptions has one group "Did not attempt the task", Solid Themes says none detected
- If ALL submissions show strong understanding → say so clearly in Solid Themes, Flagged
  Students and Common Misconceptions both say none
- If only 1 student is struggling → do not call it a "common" misconception, still list them
  individually under their own **Misconception:** block
- Never make up student names or invent submissions
- Never give generic feedback — always tie it to actual submission content
- Never grade or mention rubric scoring — this report does not grade submissions
- Class Overview and Overview Details must stay general/narrative — never repeat a student
  name, a **Misconception:** label, or a **Theme:** label in either of those two sections
- Do not use long paragraphs anywhere outside Overview Details — keep everything else scannable and concise"""

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


def _is_flagged(individual_report: str) -> bool:
    # Supports both the old prompt format and the new one so existing reports aren't re-flagged incorrectly.
    # Old format used explicit labels; new format uses section content to signal issues.

    # Old prompt format signals
    if any(term in individual_report for term in [
        "Misconception present", "Partial understanding", "No engagement"
    ]):
        return True
    # New prompt format — submission quality issues
    if any(term in individual_report for term in [
        "Submission was blank", "Submission too short", "Submission did not address"
    ]):
        return True
    # New prompt format — misconceptions section exists and is not cleared
    if "Misconceptions Detected" in individual_report and "No misconceptions detected" not in individual_report:
        return True
    return False


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
            # Count of students whose individual report shows less than full understanding
            "flagged_count": sum(
                1 for s in cw.submissions
                if s.individual_report and _is_flagged(s.individual_report)
            ),
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


def delete_report(coursework_id: int, user: User, db: Session) -> dict:
    # Deletes the report for an assignment so the teacher can regenerate a fresh one
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=404, detail="No report to delete")

    db.delete(coursework.report)
    db.commit()
    return {"deleted": True}


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


def get_submissions_list(coursework_id: int, user: User, db: Session) -> list:
    # Returns all submissions for an assignment, including any individual AI reports
    # Used to populate the Individual tab on the Assignment Detail page
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    return [
        {
            "submission_id": s.submission_id,
            "student_name": s.student_name,
            "content": s.content,
            "individual_report": s.individual_report,
        }
        for s in coursework.submissions
    ]


def generate_individual_report(coursework_id: int, submission_id: int, user: User, db: Session) -> dict:
    # Generates an AI report focused on a single student's submission
    # Evaluates what they got right/wrong and gives a specific recommendation for that student
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    submission = db.query(Submission).filter(
        Submission.submission_id == submission_id,
        Submission.coursework_id == coursework_id,
    ).first()

    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    student_label = submission.student_name or f"Student {submission.submission_id}"
    has_rubric = bool(coursework.context and "Rubric:" in coursework.context)
    context_str = coursework.context if coursework.context else "No context provided — analyze submission based on content only."

    # Grade section only appears when a rubric was actually provided
    grade_section = """## 📝 Grade
**Grade:** [Score based on rubric]
**Justification:** [2–3 sentences explaining the grade based on rubric criteria]

---

""" if has_rubric else ""

    rubric_rule = (
        "- Rubric exists: include the Grade section"
        if has_rubric
        else "- No rubric provided: skip the Grade section entirely — do not mention grading at all"
    )

    prompt = f"""You are an expert educator analyzing a single student's submission for a teacher.

REPORT MODE: Generate an INDIVIDUAL report for {student_label} only.

ASSIGNMENT: {coursework.title}

CONTEXT:
{context_str}

STUDENT SUBMISSION:
Student: {student_label}
Submission: {submission.content}

---

INDIVIDUAL REPORT FORMAT — follow exactly:

## 👤 Student: {student_label}

## 📋 Submission Summary
One paragraph summarizing what the student submitted and whether they addressed the question.

---

## ✅ What They Got Right
- [Specific thing done well]

If nothing correct, write: No correct understanding demonstrated.

---

## ❌ Misconceptions Detected
- **[Misconception]:** [one sentence on what they got wrong and what the correct understanding is]

If none, write: No misconceptions detected.

---

## ⚠️ Submission Quality
Flag any issues with the submission itself:
- Blank → "Submission was blank — no analysis possible"
- Too short → "Submission too short to assess properly"
- Off topic → "Submission did not address the assignment"
- Copied/AI generated → "Submission shows signs of not being original work"

If no issues, write: Submission quality is acceptable.

---

{grade_section}## 💡 Recommended Next Steps
2–3 specific things the teacher should do to support this specific student.

- [Specific action tailored to this student]
- [Specific action tailored to this student]

---

EDGE CASE RULES — follow strictly:
- Blank submission → write "Submission was blank — no analysis possible" in Submission Quality, skip all other analysis
- Under 15 words → flag as insufficient unless it directly and correctly answers the question
- Off-topic or gibberish → flag as insufficient
- Never make up content or invent what the student wrote
- Never give generic feedback — tie everything to what was actually in the submission
{rubric_rule}
- Never grade without a rubric
- Do not use long paragraphs anywhere — keep everything scannable and concise"""

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )

    submission.individual_report = response.choices[0].message.content
    db.commit()

    return {
        "submission_id": submission.submission_id,
        "individual_report": submission.individual_report,
    }
