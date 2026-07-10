import os
from google import genai
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.coursework import Coursework
from app.models.report import Report

# Initialize the Gemini client with our API key
# Using gemini-2.0-flash — fast and capable enough for report generation
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


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

    # Build the list of student submissions to send to Gemini
    submissions_text = "\n\n".join([
        f"Student {i + 1}:\n{sub.content}"
        for i, sub in enumerate(coursework.submissions)
    ])

    # Optional context the teacher provided (rubric, learning goals, answer key)
    context_section = (
        f"\nAssignment Context (rubric / learning goals provided by the teacher):\n{coursework.context}\n"
        if coursework.context
        else ""
    )

    # Prompt sent to Gemini — instructs it to act as an educational analyst
    # and return a structured confusion report the teacher can act on
    prompt = f"""You are an educational analyst helping a teacher understand how their students are performing.

Assignment: {coursework.title}
{context_section}
Student Submissions:
{submissions_text}

Analyze the submissions above and generate a class-wide confusion report. Your report should include:

1. **Overall Understanding** — A brief summary of how well the class understood the material overall.
2. **Common Misconceptions** — List the top misconceptions or errors you see across multiple students. Be specific.
3. **Concepts Students Grasped Well** — What did most students get right?
4. **Action Steps for the Teacher** — Concrete, specific suggestions the teacher can take in the next class to address the confusion.

Write clearly and concisely. This report is for the teacher, not the students."""

    # Send the prompt to Gemini and get the report back
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=prompt,
    )
    report_content = response.text

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
