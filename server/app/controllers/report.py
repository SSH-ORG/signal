import os
from groq import Groq
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.report import Report

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

    # A report already exists — return it instead of generating a duplicate
    if coursework.report:
        raise HTTPException(status_code=400, detail="A report already exists for this assignment")

    # Build the list of student submissions to send to the AI
    submissions_text = "\n\n".join([
        f"Student {i + 1}:\n{sub.content}"
        for i, sub in enumerate(coursework.submissions)
    ])

    # Optional context the teacher provided — already labeled by the frontend
    # (Mental Model / Assignment Description / Rubric) so the model can tell
    # the teacher's own goal apart from reference material.
    context_section = (
        f"\nContext provided by the teacher:\n{coursework.context}\n"
        if coursework.context
        else ""
    )

    # Prompt sent to the AI — instructs it to act as an educational analyst
    # assessing understanding (not grading), and return exactly two sections
    # the teacher can act on. Headings use markdown ## so the frontend
    # (ReportBody in AssignmentDetailPage.jsx) can reliably split on them.
    prompt = f"""You are an educational analyst helping a teacher understand how their students are performing.
You are assessing understanding, not grading — focus on what students do and don't understand, not on scoring their work.

Assignment: {coursework.title}
{context_section}
Student Submissions:
{submissions_text}

Analyze the submissions above and generate a confusion report with exactly two sections, each formatted as a markdown heading using ##, in this exact order:

## Classwide Confusion Theme
Identify the single biggest misconception or pattern of misunderstanding shown across the submissions. Be specific about what students got wrong and why, grounded in the context above if any was provided.

## Next Steps
Give 1 to 3 concrete, specific actions the teacher can take in the next class to address that confusion.

Write clearly and concisely. This report is for the teacher, not the students."""

    # Send the prompt to Groq (Llama 3.3 70B) and get the report back
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
    )
    report_content = response.choices[0].message.content

    # Save the report to the database
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
