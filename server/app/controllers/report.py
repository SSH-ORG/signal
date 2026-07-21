import os
from groq import Groq
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.user import User
from app.models.coursework import Coursework
from app.models.report import Report
from app.controllers import gmail as gmail_controller

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
    # Emails the existing report for an assignment to the teacher's own address
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=404, detail="No report made yet for this assignment")

    if not user.email:
        raise HTTPException(status_code=400, detail="No email address on file for your account")

    html_body = gmail_controller.build_report_email_html(coursework.title, coursework.report.content)
    await gmail_controller.send_email(user, db, subject=coursework.title, html_body=html_body)

    return {"sent": True}
