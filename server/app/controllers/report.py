import os
import re
import random
import httpx
import groq
from groq import Groq
from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.sql import func

from app.models.user import User
from app.models.coursework import Coursework
from app.models.submission import Submission
from app.models.report import Report
from app.controllers.google import fetch_course_roster, SUBMITTED_STATES

RESEND_API_URL = "https://api.resend.com/emails"

# A class-wide report needs enough real submissions to meaningfully compare
# across students — see build_report
MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT = 5
# Ceiling on how many submissions go into a single class-wide analysis — past
# this, one prompt starts costing a lot of tokens per call and the AI's
# per-student accuracy degrades with a long list of names to track, even
# within the model's context window. See build_report for how the excess is
# disclosed rather than silently dropped.
MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT = 50

# Initialize the Groq client — free tier, no credit card required
# Uses Llama 3.3 70B which is strong enough for educational text analysis
client = Groq(api_key=os.getenv("GROQ_API_KEY"))


def _call_groq(prompt: str) -> str:
    # Without this try/except, a rate limit, outage, or timeout from Groq — or a
    # response with no completions at all, which can happen without Groq raising
    # anything — propagates unhandled, FastAPI returns a generic 500 with a
    # plain-text (non-JSON) body, and the frontend has nothing to show but a
    # vague failure message. temperature=0.3 keeps responses focused and
    # grounded — less creative drift.
    try:
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return response.choices[0].message.content
    except groq.RateLimitError:
        raise HTTPException(status_code=503, detail="The AI service has hit its usage limit.")
    except (groq.APIConnectionError, groq.APITimeoutError, groq.InternalServerError):
        raise HTTPException(status_code=503, detail="The AI service is temporarily unavailable.")
    except (groq.GroqError, IndexError, AttributeError):
        raise HTTPException(status_code=502, detail="The AI service returned an error.")


_BULLET_NUMBER_RE = re.compile(r'^([-*])\s*(\d+)\s*$')
_GROUP_LABEL_RE = re.compile(r'^\*\*[^*]+:\*\*')

# What to write back in place of a section that ends up with nobody left in
# it, keyed by the heading it belongs to — mirrors the "if none, write: ..."
# fallback text the prompt itself asks the AI to use in this exact situation
_EMPTY_FALLBACK_BY_HEADING = {
    'Flagged Students': 'No students flagged.',
    'Common Misconceptions': 'No common misconceptions found.',
    'Solid Themes': 'No solid themes found.',
}


def _resolve_student_references(content: str, ordered_submissions: list) -> str:
    # build_report labels each submission with its real, permanent submission_id
    # (not a position in the list) and tells the AI to reference students only by
    # that same ID — swap each one back to a display name here, once, right after
    # generation. Every downstream renderer (app + email) keeps working
    # unmodified, since the stored report ends up looking exactly as if the AI
    # had written the name itself.
    #
    # Because the ID is looked up directly (a dict keyed on submission_id) rather
    # than treated as a position in ordered_submissions, this stays correct no
    # matter how the set of real submissions changes later — there's no index to
    # drift, since nothing here depends on anyone's position in a list at all.
    #
    # The AI occasionally references an ID we never actually gave it — inventing
    # a student who doesn't exist, even alongside correctly discussing the real
    # ones. There's no student to resolve that to, so rather than leave a bare,
    # confusing number floating in the report (which is what used to happen),
    # that reference — and, if it was the only thing in its group, the whole
    # now-empty group — is dropped entirely. A teacher should never see a
    # name-matching failure; they should just see an accurate report of the
    # real students only.
    submission_by_id = {sub.submission_id: sub for sub in ordered_submissions}

    def resolve(submission_id: int) -> str | None:
        sub = submission_by_id.get(submission_id)
        return (sub.student_name or f'Submission #{sub.submission_id}') if sub else None

    lines = content.split('\n')
    current_heading = None
    output = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        heading_match = re.match(r'^#+\s*(.+)$', stripped)
        if heading_match:
            current_heading = heading_match.group(1).strip()
            output.append(line)
            i += 1
            continue

        # Only Flagged Students, Common Misconceptions, and Solid Themes ever
        # legitimately contain a student reference — everywhere else (Class
        # Summary, Summary Details, Next Steps), a line that happens to look
        # like "- 3" is just whatever the AI actually wrote there and must be
        # left alone, not treated as a student number to resolve or strip
        in_scored_section = current_heading is not None and any(
            heading in current_heading for heading in _EMPTY_FALLBACK_BY_HEADING
        )

        if in_scored_section and _GROUP_LABEL_RE.match(stripped):
            # A "**Misconception:**"/"**Theme:**" label followed by its own
            # bulleted students — collect only the real ones, drop the whole
            # group (label included) if none of its students turn out to be real
            group_students = []
            j = i + 1
            while j < len(lines):
                bullet_match = _BULLET_NUMBER_RE.match(lines[j].strip())
                if not bullet_match:
                    break
                name = resolve(int(bullet_match.group(2)))
                if name:
                    group_students.append(f"- {name}")
                j += 1
            if group_students:
                output.append(line)
                output.extend(group_students)
            i = j
            continue

        if in_scored_section:
            bullet_match = _BULLET_NUMBER_RE.match(stripped)
            if bullet_match:
                # A flat numbered bullet not under a **Label:** group (e.g. Flagged Students)
                name = resolve(int(bullet_match.group(2)))
                if name:
                    output.append(f"{bullet_match.group(1)} {name}")
                i += 1
                continue

        output.append(line)
        i += 1

    resolved = '\n'.join(output)

    # If every reference in one of these three sections turned out to be
    # invalid, the section is left with nothing under its heading — replace
    # it with the same fallback text the prompt uses when the AI itself
    # correctly reports no one qualifies, so it reads the same either way
    sections = _split_sections(resolved)
    for heading, fallback in _EMPTY_FALLBACK_BY_HEADING.items():
        for section in sections:
            if heading in section['heading'] and not section['body'].strip():
                resolved = resolved.replace(f"## {section['heading']}\n", f"## {section['heading']}\n{fallback}\n", 1)

    return resolved


def build_report(coursework_id: int, user: User, db: Session) -> dict:
    # Fetch the assignment and make sure it belongs to this teacher
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    # Only real, readable content goes to the AI — a submission that was turned in
    # but came back empty (see sync_coursework) has nothing to analyze and is
    # surfaced to the teacher as its own "Empty submission" state instead.
    # coursework.submissions is ordered by submission_id (see the Coursework model),
    # so numbering below is stable across rebuilds without sorting here too.
    ordered_submissions = [s for s in coursework.submissions if s.content and s.content.strip()]

    if not ordered_submissions:
        raise HTTPException(status_code=400, detail="Submissions have no content")

    # A class-wide report is fundamentally about comparing across students — with
    # too few real submissions there's nothing to meaningfully compare, and the AI
    # tends to fall back on generic "classroom" language that doesn't match what
    # actually happened. Below this floor, point the teacher at individual student
    # reports instead, which are built for exactly this situation.
    if len(ordered_submissions) < MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT:
        raise HTTPException(
            status_code=400,
            detail="Not enough submissions. Build a report by student.",
        )

    # A report with nothing to compare submissions against is nearly always
    # shallow and generic — require at least a mental model, description, or
    # rubric before building one, instead of silently falling back to "no context"
    if not coursework.context or not coursework.context.strip():
        raise HTTPException(
            status_code=400,
            detail="Add a mental model, description, or rubric before building a report",
        )

    # A class-wide prompt with too many submissions in it costs a lot of tokens
    # per call and the AI's per-student accuracy degrades with a long list of
    # names to track, even within the model's context window — so only the
    # first MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT (stable order, same as above)
    # ever go to the AI. total_submission_count is the real, full count before
    # this cap — the UI/email disclose the difference rather than silently
    # describing "the class" from a subset.
    total_submission_count = len(ordered_submissions)
    analyzed_submissions = ordered_submissions[:MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT]
    analyzed_submission_count = len(analyzed_submissions)

    # Submissions are labeled with their real, permanent submission_id — not a
    # position in this list — so the number the AI hands back always identifies
    # the exact same submission, no matter how the set of real submissions
    # changes later (a position would drift; this ID never does). No student's
    # real name is ever sent to the AI provider at all. The IDs get swapped back
    # to real display names in _resolve_student_references below, once, right
    # after generation — every renderer downstream (app + email) keeps working
    # unmodified since the stored report ends up with real names either way.
    submissions_text = "\n\n".join([
        f"{sub.submission_id}: {sub.content}"
        for sub in analyzed_submissions
    ])

    context_str = coursework.context
    course_name = (coursework.course_name or "").strip()

    prompt = f"""You are an expert educator analyzing student submissions for a virtual classroom.

This report is diagnostic, not evaluative. You are NOT grading this work. You MUST NOT
assign, imply, or reference a grade or score anywhere in this report, even if a rubric is
present in the context below — a rubric here is reference material only, never a scoring
instrument. The goal is understanding what the class did and didn't grasp, so the teacher
knows what to reteach — nothing here is a mark on a student's work.

REPORT MODE: Build a CLASS-WIDE report covering all submissions.

CLASS: {course_name or "Not specified"}
ASSIGNMENT: {coursework.title}

CONTEXT:
{context_str}

The context above may include up to three labeled parts. Mental Model is the teacher's own
definition of what correct understanding looks like for this assignment — treat it as the
primary standard you compare submissions against. Assignment Description and Rubric are
supplementary reference material for understanding the task and its expectations, not
independent grading criteria — weigh them below the Mental Model whenever they'd otherwise
pull your judgment in a different direction.

STUDENT SUBMISSIONS — each one is labeled with a fixed ID number. That ID is only an
identifier/tag for this one submission — it is NOT a count, a ranking, or a quantity, and
it has no meaning relative to any other ID (a bigger or smaller ID means nothing). Whenever
you reference a student anywhere in your report (Flagged Students, Common Misconceptions,
Solid Themes), copy that exact ID back, unchanged, alone on its own bullet line (e.g. "- 482")
— never a name, never the word "Student", nothing else on that line, and never an ID that
isn't shown below:
{submissions_text}

---

CLASS-WIDE REPORT FORMAT — follow exactly, these are the ONLY 6 sections allowed:

## Class Summary
1–2 sentences, general and surface-level, giving a quick read on how the class understood
this assignment overall. No student numbers, no specific misconceptions or themes here —
save the detail for the sections below.

---

## Summary Details
1–2 short paragraphs of expanded narrative on the class's understanding as a whole — broader
patterns and context behind the surface-level summary above. Still no per-student numbers,
misconception labels, or theme labels — those belong in the sections below, this is
narrative color only.

---

## Flagged Students
A flat list of just the numbers of every student who did not demonstrate understanding.
No grouping, no reasons, just numbers, one per line:

- 3

If no students are flagged, write: No students flagged.

---

## Common Misconceptions
Group flagged students by the specific misconception or issue they share.

**Misconception:** [describe the specific wrong idea, or an issue like "Insufficient submission", in one sentence]
- 3
- 7

Repeat the **Misconception:** block for each distinct misconception found. Every number that
appears in Flagged Students must appear under exactly one misconception here.

If no students are flagged, write: No common misconceptions found.

---

## Solid Themes
Group students who demonstrated strong understanding by the theme/skill they showed it through.

**Theme:** [describe the specific thing done well, in one sentence]
- 1
- 4

Repeat the **Theme:** block for each distinct theme found. A student here should not also
appear in Flagged Students.

If no students showed strong understanding, write: No solid themes found.

---

## Next Steps
2–3 specific actionable things for the teacher to do next class based on what you saw.

- [Specific action]
- [Specific action]

---

MISCONCEPTION vs. INSUFFICIENT SUBMISSION — these are different, do not conflate them:
- A genuine attempt to answer the actual question that gets it wrong is a MISCONCEPTION —
  always group it under Common Misconceptions, since the wrong idea itself is exactly what
  the teacher needs to reteach. This includes a student who explicitly asks a clarifying
  question or says they're confused instead of attempting an answer (e.g. "I don't
  understand this") — that's a genuine, useful signal of what they don't understand, not a
  non-attempt, so group it under its own specific Common Misconceptions entry.
- Only these three cases count as an INSUFFICIENT SUBMISSION — nothing substantive to
  evaluate at all:
  - Too short: under 15 words, unless it directly and correctly answers the question
  - Off-topic: doesn't attempt to answer the actual question at all (a different subject
    entirely, or just echoes the prompt back without answering)
  - Gibberish/incoherent: not composed of real, relevant sentences (random characters,
    unrelated copy-pasted filler, nonsense)
  Group these under Common Misconceptions as their own "Insufficient submission" entry —
  never invent a separate section for them.
- If the context implies multiple distinct questions or parts and a student only answered
  some of them, say so honestly — describe exactly what was and wasn't addressed, rather
  than treating the submission as either a full misconception or fully insufficient.

EDGE CASE RULES — follow strictly no matter what:
- If ALL submissions are insufficient → Flagged Students lists everyone, Common
  Misconceptions has one group "Insufficient submission", Solid Themes says none found
- If ALL submissions show strong understanding → say so clearly in Solid Themes, Flagged
  Students and Common Misconceptions both say none
- If only 1 student is struggling → do not call it a "common" misconception, still list them
  individually under their own **Misconception:** block
- SINGLE STUDENT RULE: if there is only 1 submission total, never say "the class" or "most students"
  or imply a group — refer only to "the student" and reflect their actual performance accurately.
  If that one student was flagged, Class Summary must say so clearly, not claim understanding
- ACCURACY RULE: Class Summary must match the actual data — if every student (or the only
  student) is flagged, it cannot say the class understood the assignment. It must
  honestly reflect what happened
- Never make up students or invent submissions
- Never give generic feedback — always tie it to actual submission content
- Never grade, score, or mention rubric scoring in any section
- Class Summary and Summary Details must stay general/narrative — never reference a
  student's number, a **Misconception:** label, or a **Theme:** label in either of those two sections
- Do not use long paragraphs anywhere outside Summary Details — keep everything else scannable and concise"""

    ai_content = _call_groq(prompt)

    report_content = _resolve_student_references(ai_content, analyzed_submissions)

    # Rebuilding — replace the existing report's content instead of blocking,
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

    report.analyzed_submission_count = analyzed_submission_count
    report.total_submission_count = total_submission_count

    db.commit()
    db.refresh(report)

    return {
        "report_id": report.report_id,
        "coursework_id": coursework.coursework_id,
        "content": report.content,
        "created_at": report.created_at,
        "analyzed_submission_count": report.analyzed_submission_count,
        "total_submission_count": report.total_submission_count,
    }


def _flagged_student_count(report_content: str) -> int:
    # Counts names in the classwide report's own "Flagged Students" section — the
    # same section AssignmentDetailPage already parses (see the frontend's
    # parseFlaggedStudents). That section is always generated as part of the
    # classwide report itself, unlike individual per-student reports, which are
    # only built on-demand, one at a time, and usually don't exist for most
    # submissions — counting those instead would badly undercount.
    if not report_content:
        return 0
    for section in re.split(r"(?=##\s)", report_content):
        lines = [line for line in section.split("\n") if line.strip()]
        if not lines:
            continue
        heading = re.sub(r"^#+\s*", "", lines[0]).strip()
        if "Flagged Students" not in heading:
            continue
        body_lines = lines[1:]
        return sum(1 for line in body_lines if re.match(r"^[-*]\s", line.strip()))
    return 0


def get_all_reports(user: User, db: Session) -> list:
    # Returns all assignments that have a built report for this teacher
    # Used by the global Reports page in the sidebar
    coursework_list = db.query(Coursework).options(
        selectinload(Coursework.report)
    ).filter(Coursework.user_id == user.user_id).all()

    # A plain count, not selectinload(Coursework.submissions) — total_submissions
    # only ever needs how many students actually submitted, not their full text
    # content. Every enrolled student has a row now (see sync_coursework), so this
    # must filter to submitted states — otherwise it would count everyone, not
    # just who submitted.
    counts = dict(
        db.query(Submission.coursework_id, func.count(Submission.submission_id))
        .join(Coursework, Coursework.coursework_id == Submission.coursework_id)
        .filter(Coursework.user_id == user.user_id, Submission.state.in_(SUBMITTED_STATES))
        .group_by(Submission.coursework_id)
        .all()
    )

    return [
        {
            "coursework_id": cw.coursework_id,
            "title": cw.title,
            "google_coursework_id": cw.google_coursework_id,
            "course_name": cw.course_name or "",  # Stored at sync time so it's available even for archived courses
            "report_id": cw.report.report_id,
            "created_at": cw.report.created_at,
            "flagged_count": _flagged_student_count(cw.report.content),
            "total_submissions": counts.get(cw.coursework_id, 0),
        }
        for cw in coursework_list
        if cw.report
    ]


def get_report(coursework_id: int, user: User, db: Session) -> dict:
    # Returns the existing report for an assignment if one has been built
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not coursework.report:
        raise HTTPException(status_code=404, detail="No report built yet for this assignment")

    return {
        "report_id": coursework.report.report_id,
        "coursework_id": coursework.coursework_id,
        "content": coursework.report.content,
        "created_at": coursework.report.created_at,
        "analyzed_submission_count": coursework.report.analyzed_submission_count,
        "total_submission_count": coursework.report.total_submission_count,
        "excluded_context_note": _excluded_context_note(coursework),
    }


def delete_report(coursework_id: int, user: User, db: Session) -> dict:
    # Deletes the report for an assignment so the teacher can rebuild a fresh one
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


def _excluded_context_note(coursework: Coursework) -> str | None:
    # A teacher can toggle either off in the Context tab while leaving the
    # text itself in place — easy to forget, and Auto-Send has no review step
    # to catch it, so this surfaces it on the report itself instead. Reflects
    # the assignment's current toggle state, same as the report content would
    # if rebuilt right now.
    rubric_excluded = bool(coursework.rubric and coursework.rubric.strip()) and not coursework.include_rubric
    description_excluded = (
        bool(coursework.assignment_description and coursework.assignment_description.strip())
        and not coursework.include_description
    )
    if rubric_excluded and description_excluded:
        return (
            "This assignment has a description and a rubric saved, but both are excluded from "
            "what's sent to the AI. Turn them on in the Context tab to factor them in."
        )
    if rubric_excluded:
        return (
            "This assignment has a rubric saved, but it's excluded from what's sent to the AI. "
            "Turn it on in the Context tab to factor it in."
        )
    if description_excluded:
        return (
            "This assignment has a description saved, but it's excluded from what's sent to the AI. "
            "Turn it on in the Context tab to factor it in."
        )
    return None


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
        raise HTTPException(status_code=400, detail="No report built yet for this assignment")

    if not user.email:
        raise HTTPException(status_code=400, detail="No email address on file for your account")

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    course_name = (coursework.course_name or "").strip()
    subject = f"{course_name} : {coursework.title}" if course_name else coursework.title
    # Every enrolled student has a row now (see sync_coursework); "no submission"
    # covers both never-submitted and submitted-but-empty — see report.py's
    # earlier note on why the class-wide AI report never sees either group
    total_students = len(coursework.submissions)
    no_submission_count = sum(
        1 for s in coursework.submissions
        if s.state not in SUBMITTED_STATES or not (s.content and s.content.strip())
    )
    html_body = _classwide_email_html(
        coursework.title, course_name, coursework.report.content,
        total_students, no_submission_count, coursework.coursework_id,
        coursework.report.analyzed_submission_count, coursework.report.total_submission_count,
        _excluded_context_note(coursework),
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [user.email],
                "subject": subject,
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


async def email_student_report(coursework_id: int, submission_id: int, user: User, db: Session) -> dict:
    # Emails one student's report to the teacher's own address — a teacher can
    # then forward it on to the student themselves if they want to, since
    # Classroom's API has no way to post a comment directly (checked earlier)
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

    if not submission.student_report:
        raise HTTPException(status_code=400, detail="No report built yet for this student")

    if not user.email:
        raise HTTPException(status_code=400, detail="No email address on file for your account")

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    student_label = submission.student_name or f"Student {submission.submission_id}"
    course_name = (coursework.course_name or "").strip()
    subject = f"{student_label} : {coursework.title}"
    html_body = _student_email_html(student_label, course_name, coursework.title, submission.student_report)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [user.email],
                "subject": subject,
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


def _override_section_body(content: str, heading_substring: str, new_body: str) -> str:
    # Swaps one section's body text (matched the same way findBody matches on
    # the frontend — a substring of the heading) for a teacher-edited version,
    # without touching anything else in the report. Used so a teacher tailoring
    # the Next Step wording before sending it to a student never rewrites what's
    # actually stored — only what goes out in that one email.
    raw_sections = re.split(r'(?=##\s)', content.strip())
    for i, raw in enumerate(raw_sections):
        lines = raw.strip().split('\n')
        heading = re.sub(r'^#+\s*', '', lines[0]).strip()
        if heading_substring in heading:
            # Next Step is always the last section the AI writes, so there's no
            # following section to preserve spacing before — this only replaces
            # the heading line and everything after it in this one chunk
            raw_sections[i] = f"{lines[0]}\n{new_body.strip()}"
            return "\n\n".join(s.strip() for s in raw_sections)
    return content


def draft_student_email(coursework_id: int, submission_id: int, user: User, db: Session) -> dict:
    # Generates a second-person rewrite of a student's report for a teacher to
    # review/edit before sending it to that student — done lazily, right when
    # "Email to student" is clicked, rather than cached at Build time, so it
    # always reflects whatever the report currently says (a Refresh in between
    # can never leave this stale) and nothing is spent on reports that are only
    # ever reviewed internally, not sent. Nothing here is persisted — same as
    # send_student_report below, this only ever affects what's shown/sent for
    # this one email, never submission.student_report itself.
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

    if not submission.student_report:
        raise HTTPException(status_code=400, detail="No report built yet for this student")

    student_label = submission.student_name or f"Student {submission.submission_id}"
    context_str = coursework.context

    # Submission Quality is deliberately not part of this rewrite — that's
    # teacher-facing information about whether there was enough to evaluate at
    # all, and the student-facing email never shows it (see
    # _student_suggestions_body_html), so drafting/editing it here would be
    # wasted effort and a dead-looking field with no effect on what's sent.
    #
    # Context is included here (unlike a normal rewrite) specifically so Next
    # Step can be grounded in something real when the student didn't attempt
    # the assignment — see the instruction below for why that case needs more
    # than a straight second-person translation of the original.
    prompt = f"""You are rewriting a teacher's diagnostic report about one student so it can be
emailed directly to that student, instead of read by the teacher.

ASSIGNMENT CONTEXT (needed for grounding Misconceptions/Next Step in the edge case described below):
{context_str}

ORIGINAL REPORT (written for the teacher, about "{student_label}"):
{submission.student_report}

Rewrite it so it speaks directly to {student_label} — not about them in the third person, and
not as an instruction to their teacher. Keep the exact same meaning and facts — do not invent
anything new or change what was actually found. Keep the exact same 4 section headings below,
in the same order:

## Submission Summary
## Understands
## Misconceptions
## Next Step

FIRST, check the ORIGINAL REPORT's own Submission Quality section (it won't appear in your
output, but read it before writing anything). If it says anything other than "Submission
quality is acceptable" — too short, off-topic, or unreadable — this is a non-attempt/
insufficient-submission case, and that overrides how Misconceptions happens to be phrased
there. A teacher-facing Misconceptions entry like "failed to use the word X, indicating a lack
of understanding of how to apply it" can sound like a botched attempt, but if Submission
Quality already flagged the submission itself as off-topic/insufficient, nothing was actually
attempted — do not claim, imply, or describe {student_label} as having addressed, attempted,
defined, or engaged with any assignment-specific word, concept, or term. This flag governs
Submission Summary, Misconceptions, and Next Step exactly as described in each below.

Submission Summary: this becomes the email's opening line, right after "Hi {student_label},"
— so it has to read like the first thing a teacher would actually say to this student in
person, not a restated report. Never open with "This submission..." or "Your submission..." —
that's a report opener, not a conversation starter. Lead with whatever they got right or
genuinely attempted (even partially), then transition naturally into where it breaks down, as
one short, warm, flowing blurb — not two disconnected sentences bolted together. Model the
shape exactly on this: "You've got the shape of reversal right. Where it comes apart is the
unwind: you have each frame return the node it was given, rather than the new head, which
would leave the caller holding the original first node." If there's truly nothing to credit
(an off-topic, blank, or unrelated submission) skip the lead-with-credit move — don't invent
praise that isn't there — and instead open with one plain, kind, non-judgmental line on what
actually came in, still second person, still conversational, never itemizing what's wrong
(that's Misconceptions and Next Step's job, not this line's). Second person throughout ("you"/"your").

Understands: second person, same redirection (e.g. "Correctly identifies X" becomes "You
correctly identify X") — EXCEPT if the original says there's nothing correct to point to (e.g.
"No understanding shown."). Never restate that lack back to the student — it's discouraging
and says nothing useful. Write exactly this instead, with nothing else in the section:
Nothing to point to yet.

Misconceptions: do NOT use "you" here. State each mix-up as a plain, neutral fact about the
reasoning itself — the same way you'd state that a fact is true, not that the student did
something wrong. Two hard rules:
(1) Never use a "Label:" or "Name of the issue:" structure of any kind, bolded or not — not
"Lack of X:", not "Missing Y:", nothing followed by a colon that names the problem before
explaining it. State the specific fact directly, full stop.
(2) Never state a generic rule or definition (e.g. "A complete sentence with a clear subject
and verb is necessary for correctly using an adjective" is a textbook rule, not an observation
about this student). Every item must be concretely tied to what THIS student actually wrote —
name the specific thing they said or didn't say, the way "Each recursive call returns the node
it was passed, not the new head" names the actual bug, not "Recursive functions must return
consistent types."

If the original Misconceptions/Submission Quality content is really just noting that
{student_label} didn't understand or attempt the assignment at all (not a genuine content
misconception), do NOT restate their own confusion back to them as if it were a finding —
that's clinical, not helpful. Write exactly this instead, with nothing else in the section:
You'll get there!

Next Step: a direct imperative command, starting with an action verb ("Draw...", "Write...",
"Try...", "Sketch..."), not "You should..." — e.g. "Draw a three-node list and write down what
each frame returns as the calls unwind" rather than "You should draw a three-node list...". If
the original report reflects a genuine attempt at the assignment with a real misconception,
turn the teacher's action into that same kind of direct command for {student_label} — same
underlying action, just given to the student as something to do instead of to the teacher as
an instruction, as one bullet point starting with "- ".

If instead the student didn't attempt the assignment at all, submitted something insufficient,
or said they're confused/don't understand it — do NOT tell them to seek help, ask their
teacher, or go to office hours. That's a generic, one-size-fits-all deflection that hands the
problem to someone else instead of giving the student something they can actually do, and
imposing it isn't this email's place. Instead, write ONE small, concrete, specific first step
grounded in the Context above — same direct-imperative-command voice as above, starting with
an action verb ("Sketch...", "Write...", "Try...", "Draw..."), never "You should..." and never
a description of what {student_label} should do (not "A first step for {student_label} would
be..." or "{student_label} can try..." — write the command itself, the same as if you were
giving it to any other student). The same kind of thing you'd give a student who submitted
nothing at all (a sketch, one example sentence, a single small piece to attempt), not a
restatement of what they got wrong. Make clear a rough attempt is enough to move forward. One
bullet point starting with "- ".

Output only the 4 sections in the exact format above — no extra commentary before or after."""

    ai_content = _call_groq(prompt)
    sections = _split_sections(ai_content)

    return {
        "submission_summary": _find_body(sections, 'Submission Summary'),
        "understands": _find_body(sections, 'Understands'),
        "misconceptions": _find_body(sections, 'Misconceptions'),
        "next_step": _find_body(sections, 'Next Step'),
    }


_NO_MISCONCEPTIONS_MARKERS = ("no misconceptions found",)
_NO_UNDERSTANDING_MARKERS = ("no understanding shown", "nothing to point to yet")


def _is_solid_grasp(report_content: str) -> bool:
    # A student "did well" on their own report when there was nothing to flag
    # in Misconceptions AND something real was actually credited in
    # Understands — checked directly against this one report's own text
    # rather than a classwide verdict, since a teacher can send a per-student
    # email without ever building a classwide report at all. Requiring both
    # conditions (not just an empty Misconceptions) keeps a non-attempt case
    # — whose Understands reads "Nothing to point to yet." — from being
    # misread as a strong submission just because nothing was flagged either.
    sections = _split_sections(report_content)
    misconceptions_body = _find_body(sections, 'Misconceptions').strip()
    understands_body = _find_body(sections, 'Understands').strip()
    no_misconceptions = not misconceptions_body or any(
        marker in misconceptions_body.lower() for marker in _NO_MISCONCEPTIONS_MARKERS
    )
    has_real_understanding = bool(understands_body) and not any(
        marker in understands_body.lower() for marker in _NO_UNDERSTANDING_MARKERS
    )
    return no_misconceptions and has_real_understanding


# Randomized, same reasoning as NO_SUBMISSION_SUBJECT_TEMPLATES below — avoids
# every strong student in a class getting the identical subject line. Kept
# separate from the default "Suggestions for {title}" line, which still
# undersells a student who didn't need any correcting.
SOLID_GRASP_SUBJECT_TEMPLATES = [
    "Push further: {title}",
    "Nice work: {title}",
    "Suggestions on {title}",
    "Advance: {title}",
]


def _solid_grasp_subject(title: str) -> str:
    return random.choice(SOLID_GRASP_SUBJECT_TEMPLATES).format(title=title)


async def send_student_report(
    coursework_id: int,
    submission_id: int,
    user: User,
    db: Session,
    submission_summary_override: str | None = None,
    understands_override: str | None = None,
    misconceptions_override: str | None = None,
    next_step_override: str | None = None,
) -> dict:
    # Sends one student's report directly to the student's own email — a
    # deliberate, separate action from emailing the teacher a copy, since this
    # is the "student agency" path: the student gets their own feedback without
    # the teacher acting as a manual go-between. Requires classroom.profile.emails,
    # which only takes effect after a teacher re-logs-in to grant the new scope —
    # a stale token from before it was added just returns no email, not a wrong one.
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

    if not submission.student_report:
        raise HTTPException(status_code=400, detail="No report built yet for this student")

    if not submission.google_user_id or not coursework.google_course_id:
        raise HTTPException(status_code=400, detail="Can't identify this student in Google Classroom")

    roster = await fetch_course_roster(coursework.google_course_id, user, db)
    entry = next((r for r in roster if r["google_user_id"] == submission.google_user_id), None)
    student_email = entry["email"] if entry else None

    if not student_email:
        raise HTTPException(
            status_code=400,
            detail="No email on file for this student.",
        )

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    student_label = submission.student_name or f"Student {submission.submission_id}"
    first_name = student_label.split()[0]
    course_name = (coursework.course_name or "").strip()
    # Never falls back to the raw Google account name a teacher never chose
    # to show students — if they haven't set a display name, the class name
    # reads better in "From {teacher}" than an arbitrary Google profile name.
    teacher_label = user.display_name or course_name or "your teacher"

    # Only affects this one outgoing email — submission.student_report (the
    # stored report) is never reassigned or committed here
    report_content = submission.student_report
    section_overrides = [
        ("Submission Summary", submission_summary_override),
        ("Understands", understands_override),
        ("Misconceptions", misconceptions_override),
        ("Next Step", next_step_override),
    ]
    for heading, override in section_overrides:
        if override is not None and override.strip():
            report_content = _override_section_body(report_content, heading, override)

    html_body = _student_suggestions_email_html(first_name, teacher_label, course_name, coursework.title, report_content)
    subject = (
        _solid_grasp_subject(coursework.title) if _is_solid_grasp(report_content)
        else f"Suggestions for {coursework.title}"
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": f"{teacher_label} via Signal <signal@marcylab.us>",
                "to": [student_email],
                "subject": subject,
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

    print(f"[email] Report for '{student_label}' sent directly to {student_email}")
    return {"sent": True, "to": student_email}


def build_no_submission_nudge(coursework_id: int, submission_id: int, user: User, db: Session) -> dict:
    # Builds a lightweight "how to get started" nudge for a student who hasn't
    # turned in anything readable — grounded only in the assignment's own
    # context, since there's no submission to analyze. Stored in the same
    # student_report column a real diagnostic report would use: which "kind"
    # of content a given student has is always fully determined by their own
    # has_submitted/content state, so nothing needs to tag or distinguish them.
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

    # The UI only ever offers this for empty/unsubmitted students — this is
    # the backend backstop so that can't be bypassed
    if submission.content and submission.content.strip():
        raise HTTPException(
            status_code=400, detail="This student has already submitted something — build their report instead",
        )

    if not coursework.context or not coursework.context.strip():
        raise HTTPException(
            status_code=400,
            detail="Add a mental model, description, or rubric before building a nudge",
        )

    context_str = coursework.context
    course_name = (coursework.course_name or "").strip()

    prompt = f"""You are an expert educator writing a short, encouraging first step for a
student who has not turned in this assignment yet, given directly to that student as an
instruction to follow, not a description of them or their situation.

CLASS: {course_name or "Not specified"}
ASSIGNMENT: {coursework.title}

CONTEXT:
{context_str}

The context above may include up to three labeled parts. Mental Model is the teacher's own
definition of what correct understanding looks like for this assignment — ground the first
step in it specifically, not in generic study advice.

There is no submission to analyze — do not describe what the student missed or summarize
anything, since there's nothing to summarize. Write exactly ONE bullet point: a small,
concrete, finishable-in-a-few-minutes first step that gets the student started (a sketch, a
single sentence, one definition, one small example) — something specific to this assignment's
actual content, not generic advice like "review your notes." Make clear a partial attempt is
worth turning in — this is about starting, not finishing. Write it as a direct imperative
command, starting with an action verb ("Sketch...", "Write...", "Try...", "Draw..."), not
"You should..." or "You could..." — e.g. "Sketch the list 1 -> 2 -> 3 on paper, then draw what
it should look like reversed. Write one sentence about which arrow has to change first." rather
than "You could start by sketching a list...". Starting the bullet with "- ".

- [One small, specific first step]"""

    submission.student_report = _call_groq(prompt)
    db.commit()

    return {
        "submission_id": submission.submission_id,
        "student_report": submission.student_report,
    }


# Randomized rather than a single fixed template — a class with several
# non-submitters would otherwise send the identical subject line to each one,
# which reads as an obvious form email the moment two land in the same inbox
# (e.g. a sibling, or students who compare notes). Subject stays templated
# either way — no teacher-editable subject field, per the email redesign spec.
NO_SUBMISSION_SUBJECT_TEMPLATES = [
    "Springboard for {title}",
    "Framework for {title}",
    "A place to start for {title}",
    "Suggestion for starting {title}",
    "An entry point for: {title}",
]


def _no_submission_subject(title: str) -> str:
    return random.choice(NO_SUBMISSION_SUBJECT_TEMPLATES).format(title=title)


async def send_no_submission_email(
    coursework_id: int, submission_id: int, user: User, db: Session, start_here_override: str | None = None,
) -> dict:
    # Sends the "nothing turned in" nudge directly to the student's own email —
    # same student-agency path as send_student_report, just for a student with
    # no submission to build a diagnostic report from in the first place.
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

    if not submission.student_report:
        raise HTTPException(status_code=400, detail="No nudge built yet for this student")

    if not submission.google_user_id or not coursework.google_course_id:
        raise HTTPException(status_code=400, detail="Can't identify this student in Google Classroom")

    roster = await fetch_course_roster(coursework.google_course_id, user, db)
    entry = next((r for r in roster if r["google_user_id"] == submission.google_user_id), None)
    student_email = entry["email"] if entry else None

    if not student_email:
        raise HTTPException(status_code=400, detail="No email on file for this student.")

    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email is not configured on this server")

    student_label = submission.student_name or f"Student {submission.submission_id}"
    first_name = student_label.split()[0]
    course_name = (coursework.course_name or "").strip()
    teacher_label = user.display_name or course_name or "your teacher"

    # Only affects this one outgoing email — submission.student_report (the
    # stored nudge) is never reassigned or committed here
    start_here_text = (
        start_here_override.strip() if start_here_override is not None and start_here_override.strip()
        else submission.student_report
    )

    html_body = _no_submission_email_html(first_name, teacher_label, course_name, coursework.title, start_here_text)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": f"{teacher_label} via Signal <signal@marcylab.us>",
                "to": [student_email],
                "subject": _no_submission_subject(coursework.title),
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

    print(f"[email] Nudge for '{student_label}' sent directly to {student_email}")
    return {"sent": True, "to": student_email}


# ── Email rendering ──────────────────────────────────────────────────────
# Mirrors the app's own report display (ReportBody.jsx) instead of dumping
# generic markdown — same section colors/labels/badge — so a report reads
# the same whether it's opened in Signal or in an inbox. Inter is loaded
# from Google Fonts; Gmail renders linked webfonts, so this actually shows
# up as Inter there instead of silently falling back to the system font.

FONT_STACK = "'Inter', system-ui, Arial, sans-serif"

INK = "#08060d"
MUTED = "#6b6375"
STRIP_MUTED = "#4a4453"
HAIRLINE = "#e5e4e7"
CARD_BORDER = "#cbc9d1"

# Colour tokens — glyph/text colours are one deliberate step darker than the
# border so every one clears 4.5:1 contrast on white. Never use the border
# shade as text.
COLOR = {
    "purple": {"border": "#aa3bff", "tint": "#e3c6ff", "text": "#9333ea"},
    "red": {"border": "#d93025", "tint": "#f6c6c0", "text": "#c5221f"},
    "orange": {"border": "#e67e22", "tint": "#f6d2a6", "text": "#b45309"},
    "green": {"border": "#27ae60", "tint": "#a9e0c1", "text": "#1e8449"},
    "blue": {"border": "#3b82f6", "tint": "#b9d3fb", "text": "#2563eb"},
}

# Plain Unicode/HTML-entity glyphs, not emoji — renders identically everywhere
# with no font-rendering variance. Every list item carries its own, never a
# number — the report claims no ordering.
GLYPH = {"dot": "&#9679;", "bang": "&#33;", "x": "&#10005;", "check": "&#10003;", "arrow": "&rarr;"}

# Single source of truth for verdict wording/colour — shared with the app's
# own verdict badge (see SECTION_META / verdict logic in ReportBody.jsx).
VERDICT_STYLES = {
    "strong": {"label": "Solid Understanding", "color_key": "green"},
    "mixed": {"label": "Mixed Understanding", "color_key": "orange"},
    "weak": {"label": "Needs Review", "color_key": "red"},
}


def _verdict_key(flagged_count: int, solid_count: int) -> str:
    if flagged_count == 0:
        return "strong"
    if flagged_count > solid_count:
        return "weak"
    return "mixed"


def _split_sections(content: str) -> list:
    # Same convention as splitSections in reportParsing.js
    sections = []
    for raw in re.split(r'(?=##\s)', content.strip()):
        lines = [l for l in raw.strip().split('\n') if l.strip()]
        if not lines:
            continue
        heading = re.sub(r'^#+\s*', '', lines[0]).strip()
        sections.append({"heading": heading, "body": "\n".join(lines[1:])})
    return sections


def _find_body(sections: list, heading: str) -> str:
    for s in sections:
        if heading in s["heading"]:
            return s["body"]
    return ""


def _parse_bullets(body: str) -> list:
    return [
        re.sub(r'^[-*]\s', '', line.strip())
        for line in body.split('\n')
        if re.match(r'^[-*]\s', line.strip())
    ]


def _parse_groups(body: str, label_word: str) -> list:
    label_re = re.compile(rf'^\*\*{label_word}:\*\*\s*', re.IGNORECASE)
    groups = []
    current = None
    for raw_line in body.split('\n'):
        line = raw_line.strip()
        if not line:
            continue
        if label_re.match(line):
            if current:
                groups.append(current)
            current = {"label": label_re.sub('', line), "students": []}
        elif re.match(r'^[-*]\s', line) and current:
            current["students"].append(re.sub(r'^[-*]\s', '', line))
    if current:
        groups.append(current)
    return groups


def _strip_bold(text: str) -> str:
    return re.sub(r'\*\*(.+?)\*\*', r'\1', text or '')


def _format_line(line: str) -> str:
    line = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', line)
    line = re.sub(r'^\*+\s', '', line)
    line = re.sub(r'^-+\s', '', line)
    return line


def _email_section(
    color_key: str, glyph: str, title: str, body_html: str, *,
    filled: bool = False, margin_top: int = 14, glyph_color: str | None = None,
    body_padding: str = "16px",
) -> str:
    # Outlined by default (banner white, title rule in the section's own
    # colour) — the one exception is a "filled" section (only email 5's START
    # HERE), which gets a solid coloured banner instead. Rejected an
    # all-solid design earlier: five saturated bars flatten the hierarchy so
    # the flagged number stops leading; the one exception is deliberately for
    # a single-section email where there's nothing else competing for
    # attention. Every border lives on the banner/body cells themselves, not
    # the wrapping table — a border+radius on the table AND a coloured banner
    # cell inside it draws two independent rounded boxes whose corners never
    # quite line up.
    c = COLOR[color_key]
    border_color = c["text"] if filled else c["border"]
    if filled:
        band_bg = c["text"]  # darker shade gives contrast for white banner text
        band_text = "#ffffff"
        default_glyph_color = "#ffffff"
    else:
        band_bg = "#ffffff"
        band_text = INK
        default_glyph_color = c["text"]
    gcolor = glyph_color or default_glyph_color
    glyph_html = (
        f'<span style="font-size:15px;font-weight:700;color:{gcolor};">{glyph}</span>'
        f'<span style="font-size:15px;font-weight:600;letter-spacing:0.06em;color:{band_text};">&nbsp;&nbsp;{title}</span>'
        if glyph else
        f'<span style="font-size:15px;font-weight:600;letter-spacing:0.06em;color:{band_text};">{title}</span>'
    )
    margin_style = f"margin-top:{margin_top}px;" if margin_top else ""
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;{margin_style}border-collapse:separate;border-spacing:0;">
  <tr>
    <td bgcolor="{band_bg}" style="padding:14px 16px;background:{band_bg};font-family:{FONT_STACK};border-left:2px solid {border_color};border-right:2px solid {border_color};border-top:2px solid {border_color};border-bottom:1.5px solid {border_color};border-radius:10px 10px 0 0;">
      {glyph_html}
    </td>
  </tr>
  <tr>
    <td style="padding:{body_padding};background:#ffffff;font-family:{FONT_STACK};border-left:2px solid {border_color};border-right:2px solid {border_color};border-top:0;border-bottom:2px solid {border_color};border-radius:0 0 10px 10px;">
      {body_html}
    </td>
  </tr>
</table>"""


def _name_pill_html(name: str, color_key: str) -> str:
    c = COLOR[color_key]
    return (
        f'<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 13px;border-radius:100px;'
        f'background:#ffffff;border:1.5px solid {c["border"]};font-size:13px;font-weight:600;color:{c["text"]};">'
        f'{_format_line(name)}</span>'
    )


# Past this many, a single misconception/theme group turns into a wall of
# pills — cap it and point to the classwide tab in the app, which shows the
# exact same group in full, uncapped (see ClasswideReportBody's modal)
MAX_NAMES_PER_GROUP_IN_EMAIL = 8


def _name_pills_html(names: list, color_key: str) -> str:
    shown = names[:MAX_NAMES_PER_GROUP_IN_EMAIL]
    return "".join(_name_pill_html(n, color_key) for n in shown)


def _more_names_line_html(names: list, color_key: str, coursework_id: int) -> str:
    # Plain colored text below the pill row, not another pill — a link, not a
    # boxed control, since it's just pointing at more detail, not an action.
    remaining = len(names) - MAX_NAMES_PER_GROUP_IN_EMAIL
    if remaining <= 0:
        return ""
    c = COLOR[color_key]
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    more_url = f"{frontend_url}/?coursework_id={coursework_id}"
    return (
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:12px;">'
        f'<a href="{more_url}" style="color:{c["text"]};font-weight:600;text-decoration:none;">'
        f'+{remaining} more in Signal</a></p>'
    )


def _flat_glyph_list_html(items: list, color_key: str, glyph: str, empty_text: str) -> str:
    # One glyph + one line per item — Understands/Misconceptions/Spot On/Almost
    # There. Tighter 8px gaps than the grouped/next-step lists below since
    # these are short, single-line findings, not multi-line groups.
    c = COLOR[color_key]
    if not items:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;color:{INK};">{empty_text}</p>'
    rows = ""
    last = len(items) - 1
    for i, item in enumerate(items):
        pb = 0 if i == last else 8
        rows += f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td width="18" style="width:18px;padding:0 10px {pb}px 0;vertical-align:top;font-family:{FONT_STACK};font-size:14px;font-weight:700;color:{c['text']};mso-line-height-rule:exactly;line-height:22px;">{glyph}</td>
    <td style="padding:0 0 {pb}px;vertical-align:top;font-family:{FONT_STACK};font-size:14px;color:{INK};mso-line-height-rule:exactly;line-height:22px;">{_format_line(item)}</td>
  </tr>
</table>"""
    return rows


def _next_step_list_html(items: list, empty_text: str) -> str:
    # Next Step / Next Steps — wider glyph cell, bigger glyph, 14px gaps
    # (these tend to be longer, wrapping actions, not short findings).
    c = COLOR["blue"]
    if not items:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;color:{INK};">{empty_text}</p>'
    rows = ""
    last = len(items) - 1
    for i, item in enumerate(items):
        pb = 0 if i == last else 14
        rows += f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td width="20" style="width:20px;padding:0 10px {pb}px 0;vertical-align:top;font-family:{FONT_STACK};font-size:16px;font-weight:700;color:{c['text']};mso-line-height-rule:exactly;line-height:23px;">{GLYPH['arrow']}</td>
    <td style="padding:0 0 {pb}px;vertical-align:top;font-family:{FONT_STACK};font-size:14px;color:{INK};mso-line-height-rule:exactly;line-height:23px;">{_format_line(item)}</td>
  </tr>
</table>"""
    return rows


def _single_arrow_item_html(text_html: str) -> str:
    # Try This / Start Here — always exactly one item, bigger type (16px/26)
    # than every other list, since it's the one instruction the email is
    # actually asking the reader to act on right now.
    c = COLOR["blue"]
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td width="20" style="width:20px;padding:0 10px 0 0;vertical-align:top;font-family:{FONT_STACK};font-size:17px;font-weight:700;color:{c['text']};mso-line-height-rule:exactly;line-height:26px;">{GLYPH['arrow']}</td>
    <td style="vertical-align:top;font-family:{FONT_STACK};font-size:16px;color:{INK};mso-line-height-rule:exactly;line-height:26px;">{text_html}</td>
  </tr>
</table>"""


def _grouped_pills_section_html(groups: list, color_key: str, glyph: str, empty_text: str, coursework_id: int) -> str:
    # Common Misconceptions / Solid Themes — glyph + label row, then the
    # student pills indented into the text column on their own row below it.
    if not groups:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;color:{INK};">{empty_text}</p>'
    c = COLOR[color_key]
    rows = ""
    last = len(groups) - 1
    for i, g in enumerate(groups):
        pb = 0 if i == last else 14
        pills_pb_style = f"padding:0 0 {pb}px;" if pb else ""
        rows += f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td width="18" style="width:18px;padding:0 10px 6px 0;vertical-align:top;font-family:{FONT_STACK};font-size:14px;font-weight:700;color:{c['text']};mso-line-height-rule:exactly;line-height:21px;">{glyph}</td>
    <td style="padding:0 0 6px;vertical-align:top;font-family:{FONT_STACK};font-size:14px;font-weight:600;color:{INK};mso-line-height-rule:exactly;line-height:21px;">{_format_line(g['label'])}</td>
  </tr>
  <tr>
    <td></td>
    <td style="{pills_pb_style}font-family:{FONT_STACK};">{_name_pills_html(g['students'], color_key)}{_more_names_line_html(g['students'], color_key, coursework_id)}</td>
  </tr>
</table>"""
    return rows


def _verdict_badge_html(verdict_key: str) -> str:
    v = VERDICT_STYLES[verdict_key]
    c = COLOR[v["color_key"]]
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:22px 0 18px;text-align:center;font-family:{FONT_STACK};">
      <span style="display:inline-block;background:#ffffff;border:2px solid {c['border']};border-radius:100px;padding:10px 22px;font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:{c['text']};mso-line-height-rule:exactly;line-height:19px;">{v['label'].upper()}</span>
    </td>
  </tr>
</table>"""


def _class_summary_html(class_summary_text: str, summary_details_text: str) -> str:
    # Lead paragraph (the short Class Summary) is bold/15px; the expanded
    # Summary Details narrative follows as regular 14px paragraphs.
    parts = []
    if class_summary_text.strip():
        parts.append(
            f'<p style="margin:0;font-family:{FONT_STACK};font-size:15px;font-weight:600;color:{INK};'
            f'mso-line-height-rule:exactly;line-height:24px;">{_format_line(class_summary_text.strip())}</p>'
        )
    detail_lines = [line.strip() for line in summary_details_text.split('\n') if line.strip()]
    for i, line in enumerate(detail_lines):
        margin_top = 14 if i == 0 else 12
        parts.append(
            f'<p style="margin:{margin_top}px 0 0;font-family:{FONT_STACK};font-size:14px;color:{INK};'
            f'mso-line-height-rule:exactly;line-height:23px;">{_format_line(line)}</p>'
        )
    return "".join(parts)


def _no_submission_strip_html(no_submission_count: int, coursework_id: int) -> str:
    # Own small outlined box (neutral border, not a coloured section) right
    # before the footer — omitted entirely at 0 rather than printing "0
    # students haven't submitted," which would read as a false alarm. No names
    # here (matches the app's Flagged Students card — count only, "see names on
    # the Students tab" instead) since a big non-submitting group would
    # otherwise turn this into an unbounded list.
    if no_submission_count <= 0:
        return ""
    word = "student hasn&rsquo;t" if no_submission_count == 1 else "students haven&rsquo;t"
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    students_url = f"{frontend_url}/?coursework_id={coursework_id}&view=students"
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-top:14px;border-collapse:collapse;">
  <tr>
    <td align="center" style="text-align:center;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="340" style="width:340px;max-width:100%;border-collapse:separate;border-spacing:0;">
        <tr>
          <td style="padding:14px 16px;background:#ffffff;font-family:{FONT_STACK};border:2px solid {CARD_BORDER};border-radius:10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
              <tr>
                <td width="46" valign="middle" style="width:46px;padding:0 12px 0 0;vertical-align:middle;font-family:{FONT_STACK};font-size:36px;font-weight:700;color:{INK};mso-line-height-rule:exactly;line-height:1.2;">{no_submission_count}</td>
                <td valign="middle" style="vertical-align:middle;font-family:{FONT_STACK};font-size:13px;color:{STRIP_MUTED};mso-line-height-rule:exactly;line-height:20px;">{word} submitted this. <a href="{students_url}" style="color:{COLOR['purple']['text']};font-weight:600;text-decoration:underline;">Send them an email with a point of entry</a>.</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>"""


def _generic_sections_html(sections: list) -> str:
    # Fallback when content doesn't match the expected headings — plain
    # heading + paragraph/bullet render, same as the old generic template
    html = ""
    for s in sections:
        body_html = ""
        in_list = False
        for line in s["body"].split('\n'):
            if not line.strip():
                continue
            if re.match(r'^[-*]\s', line):
                if not in_list:
                    body_html += '<ul style="margin:0 0 8px;padding-left:20px;">'
                    in_list = True
                body_html += (
                    f'<li style="margin-bottom:4px;font-family:{FONT_STACK};font-size:14px;'
                    f'line-height:1.6;">{_format_line(line)}</li>'
                )
            else:
                if in_list:
                    body_html += '</ul>'
                    in_list = False
                body_html += (
                    f'<p style="margin:0 0 8px;font-family:{FONT_STACK};font-size:14px;'
                    f'line-height:1.6;">{_format_line(line)}</p>'
                )
        if in_list:
            body_html += '</ul>'
        html += (
            f'<div style="margin-bottom:28px;"><h2 style="font-family:{FONT_STACK};font-size:15px;font-weight:700;'
            f'margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #f0f0f0;">{s["heading"]}</h2>{body_html}</div>'
        )
    return html


def _subset_disclaimer_html(analyzed_count: int, total_count: int) -> str:
    # Omitted entirely when the report covers everyone — only shows once a
    # class actually exceeded MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT (see
    # build_report), so this never reads as a false alarm on a normal class.
    if total_count <= 0 or analyzed_count >= total_count:
        return ""
    remaining = total_count - analyzed_count
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-bottom:18px;border-collapse:separate;border-spacing:0;">
  <tr>
    <td style="padding:12px 16px;background:#ffffff;font-family:{FONT_STACK};border:1.5px solid {COLOR['red']['border']};border-radius:10px;font-size:13px;color:{COLOR['red']['text']};mso-line-height-rule:exactly;line-height:19px;">
      This report reads the first {analyzed_count} of {total_count} submissions turned in. The other {remaining} aren&rsquo;t included here, but you can still build a report for any of those students individually.
    </td>
  </tr>
</table>"""


def _excluded_context_note_html(note: str | None) -> str:
    if not note:
        return ""
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-bottom:18px;border-collapse:separate;border-spacing:0;">
  <tr>
    <td style="padding:12px 16px;background:#ffffff;font-family:{FONT_STACK};border:1.5px solid {COLOR['red']['border']};border-radius:10px;font-size:13px;color:{COLOR['red']['text']};mso-line-height-rule:exactly;line-height:19px;">
      {note}
    </td>
  </tr>
</table>"""


def _classwide_report_body_html(
    content: str, total_students: int, no_submission_count: int, coursework_id: int,
    analyzed_submission_count: int = 0, total_submission_count: int = 0,
    excluded_context_note: str | None = None,
) -> str:
    # Mirrors ClasswideReportBody — Class Summary then Flagged Students /
    # Common Misconceptions / Solid Themes / Next Steps, each shown in full
    # rather than as a click-to-expand card, since email has no interactivity.
    sections = _split_sections(content)
    class_summary_text = _find_body(sections, 'Class Summary')
    summary_details_text = _find_body(sections, 'Summary Details')
    flagged_body = _find_body(sections, 'Flagged Students')
    misconceptions_body = _find_body(sections, 'Common Misconceptions')
    themes_body = _find_body(sections, 'Solid Themes')
    next_steps_body = _find_body(sections, 'Next Steps')

    if not any([class_summary_text, summary_details_text, flagged_body, misconceptions_body, themes_body, next_steps_body]):
        return _generic_sections_html(sections)

    flagged_names = _parse_bullets(flagged_body)
    misconception_groups = _parse_groups(misconceptions_body, 'Misconception')
    theme_groups = _parse_groups(themes_body, 'Theme')
    next_steps = _parse_bullets(next_steps_body)

    flagged_count = len(flagged_names)
    solid_count = len({s for g in theme_groups for s in g["students"]})
    verdict_key = _verdict_key(flagged_count, solid_count)

    html = _verdict_badge_html(verdict_key)
    html += _subset_disclaimer_html(analyzed_submission_count, total_submission_count)
    html += _excluded_context_note_html(excluded_context_note)
    html += _email_section(
        "purple", GLYPH["dot"], "CLASS SUMMARY",
        _class_summary_html(class_summary_text, summary_details_text), margin_top=0,
    )

    flagged_html = f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td align="center" style="text-align:center;font-family:{FONT_STACK};font-size:44px;font-weight:700;color:{COLOR['red']['border']};mso-line-height-rule:exactly;line-height:48px;">{flagged_count}</td>
  </tr>
  <tr>
    <td align="center" style="text-align:center;padding-top:4px;font-family:{FONT_STACK};font-size:13px;font-weight:600;color:{MUTED};mso-line-height-rule:exactly;line-height:18px;">of {total_students} students didn&rsquo;t show a sufficient understanding</td>
  </tr>
</table>"""
    html += _email_section(
        "red", GLYPH["bang"], "FLAGGED STUDENTS", flagged_html,
        glyph_color=COLOR["red"]["border"], body_padding="20px 16px 22px",
    )

    html += _email_section(
        "orange", GLYPH["x"], "COMMON MISCONCEPTIONS",
        _grouped_pills_section_html(
            misconception_groups, "orange", GLYPH["x"], "No common misconceptions found.", coursework_id,
        ),
    )
    html += _email_section(
        "green", GLYPH["check"], "SOLID THEMES",
        _grouped_pills_section_html(
            theme_groups, "green", GLYPH["check"], "No solid themes found.", coursework_id,
        ),
    )
    html += _email_section(
        "blue", GLYPH["arrow"], "NEXT STEPS",
        _next_step_list_html(next_steps, "No next steps provided."),
    )
    html += _no_submission_strip_html(no_submission_count, coursework_id)
    return html


def _student_report_body_html(content: str) -> str:
    # Mirrors StudentReportSummary — Submission Summary (with the quality
    # flag folded in, same as the modal) then Understands, Misconceptions,
    # Next Step, each its own outlined section.
    sections = _split_sections(content)
    summary_body = _find_body(sections, 'Submission Summary')
    understands_body = _find_body(sections, 'Understands')
    misconceptions_body = _find_body(sections, 'Misconceptions')
    quality_body = _find_body(sections, 'Submission Quality')
    next_step_body = _find_body(sections, 'Next Step')

    if not any([summary_body, understands_body, misconceptions_body, next_step_body]):
        return _generic_sections_html(sections)

    understands = _parse_bullets(understands_body)
    misconceptions = _parse_bullets(misconceptions_body)
    parsed_next_steps = _parse_bullets(next_step_body)
    next_steps = parsed_next_steps if parsed_next_steps else (
        [next_step_body.strip()] if next_step_body.strip() else []
    )

    quality_issue = None
    if quality_body and "acceptable" not in quality_body.lower():
        # The prompt's own instructions show bullet-formatted examples for
        # this section, and the model sometimes echoes that "- " into its
        # actual one-line answer — strip it the same way _format_line does
        quality_issue = re.sub(r'^[-*]\s+', '', _strip_bold(quality_body.strip()))

    summary_html = (
        f'<p style="margin:0;font-family:{FONT_STACK};font-size:15px;font-weight:600;color:{INK};'
        f'mso-line-height-rule:exactly;line-height:24px;">{_format_line(summary_body.strip())}</p>'
        if summary_body else ""
    )
    if quality_issue:
        rc = COLOR["red"]
        summary_html += f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-top:14px;border-collapse:separate;">
  <tr>
    <td bgcolor="#ffffff" style="padding:10px 12px;background:#ffffff;border:1px solid {rc['border']};border-radius:8px;font-family:{FONT_STACK};font-size:13px;font-weight:600;color:{rc['text']};mso-line-height-rule:exactly;line-height:19px;">
      <span style="font-weight:700;">{GLYPH['bang']}</span>&nbsp;&nbsp;{quality_issue}
    </td>
  </tr>
</table>"""

    html = _email_section("purple", GLYPH["dot"], "SUBMISSION SUMMARY", summary_html, margin_top=22) if summary_body else ""
    html += _email_section(
        "green", GLYPH["check"], "UNDERSTANDS",
        _flat_glyph_list_html(understands, "green", GLYPH["check"], "No understanding shown."),
    )
    html += _email_section(
        "orange", GLYPH["x"], "MISCONCEPTIONS",
        _flat_glyph_list_html(misconceptions, "orange", GLYPH["x"], "No misconceptions found."),
    )
    html += _email_section(
        "blue", GLYPH["arrow"], "NEXT STEP",
        _next_step_list_html(next_steps, "No next step provided."),
    )
    return html


def _student_suggestions_body_html(content: str, first_name: str) -> str:
    # Student-facing "Suggestions" email — Submission Summary becomes the
    # second-person lead, Understands/Misconceptions/Next Step are relabeled
    # Spot On/Almost There/Try This. Submission Quality is never shown here —
    # that's teacher-facing information, not something to surface to the
    # student directly.
    sections = _split_sections(content)
    summary_body = _find_body(sections, 'Submission Summary')
    understands_body = _find_body(sections, 'Understands')
    misconceptions_body = _find_body(sections, 'Misconceptions')
    next_step_body = _find_body(sections, 'Next Step')

    # Falls back to the whole body as a single item when the AI didn't use
    # bullet formatting — matters here specifically because the encouraging
    # one-liner this prompt asks for (in place of restating a student's own
    # confusion back to them) is written as a plain sentence, not a bullet;
    # without this fallback it would silently vanish instead of showing.
    parsed_understands = _parse_bullets(understands_body)
    understands = parsed_understands if parsed_understands else (
        [understands_body.strip()] if understands_body.strip() else []
    )
    parsed_misconceptions = _parse_bullets(misconceptions_body)
    misconceptions = parsed_misconceptions if parsed_misconceptions else (
        [misconceptions_body.strip()] if misconceptions_body.strip() else []
    )
    parsed_next_steps = _parse_bullets(next_step_body)
    next_steps = parsed_next_steps if parsed_next_steps else (
        [next_step_body.strip()] if next_step_body.strip() else []
    )
    try_this = next_steps[0] if next_steps else ""

    html = f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td style="padding:22px 0 0;font-family:{FONT_STACK};">
      <p style="margin:0;font-family:{FONT_STACK};font-size:16px;font-weight:700;color:{INK};mso-line-height-rule:exactly;line-height:24px;">Hi {first_name},</p>
      <p style="margin:10px 0 0;font-family:{FONT_STACK};font-size:16px;color:{INK};mso-line-height-rule:exactly;line-height:26px;">{_format_line(summary_body.strip())}</p>
    </td>
  </tr>
</table>"""
    html += _email_section(
        "green", GLYPH["check"], "SPOT ON",
        _flat_glyph_list_html(understands, "green", GLYPH["check"], "Nothing to flag here yet."), margin_top=20,
    )
    html += _email_section(
        "orange", GLYPH["x"], "ALMOST THERE",
        _flat_glyph_list_html(misconceptions, "orange", GLYPH["x"], "Nothing to flag here yet."),
    )
    if try_this:
        html += _email_section(
            "blue", GLYPH["arrow"], "TRY THIS", _single_arrow_item_html(_format_line(try_this)),
        )
    return html


def _no_submission_body_html(first_name: str, start_here_text: str) -> str:
    # Email 5 — the only email with a single, filled/solid-banner section.
    # Never a summary of what's missing: there's no submission to analyse,
    # only a lightweight first step to get started.
    html = f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
  <tr>
    <td style="padding:22px 0 0;font-family:{FONT_STACK};">
      <p style="margin:0;font-family:{FONT_STACK};font-size:16px;font-weight:700;color:{INK};mso-line-height-rule:exactly;line-height:24px;">Hi {first_name},</p>
      <p style="margin:10px 0 0;font-family:{FONT_STACK};font-size:16px;color:{INK};mso-line-height-rule:exactly;line-height:26px;">Here&rsquo;s a way to start this one. You don&rsquo;t need the whole answer to begin &mdash; a rough first attempt is worth more than a blank submission.</p>
    </td>
  </tr>
</table>"""
    html += _email_section(
        "blue", GLYPH["arrow"], "START HERE", _single_arrow_item_html(_format_line(start_here_text)),
        filled=True, margin_top=20,
    )
    return html


def _signal_link_html() -> str:
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    return f'<a href="{frontend_url}" style="color:{MUTED};text-decoration:underline;font-weight:600;">Signal</a>'


def _account_link_html() -> str:
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    return f'<a href="{frontend_url}" style="color:{MUTED};text-decoration:underline;font-weight:600;">account</a>'


def _footer_teacher_report_html() -> str:
    return f'Sent from {_signal_link_html()}.'


def _footer_classwide_report_html(coursework_id: int) -> str:
    # view=students — this line is specifically about per-student reports, so
    # it lands on that sub-tab directly instead of the classwide summary the
    # teacher is already reading in this email
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    assignment_url = f"{frontend_url}/?coursework_id={coursework_id}&view=students"
    assignment_link = (
        f'<a href="{assignment_url}" style="color:{MUTED};text-decoration:underline;font-weight:600;">'
        f'this assignment</a>'
    )
    return f'Sent from {_signal_link_html()}. See per-student reports or rebuild this report from {assignment_link}.'


def _footer_reminder_html() -> str:
    return f'Sent from {_signal_link_html()}.<br>To turn off notifications, please go to your {_account_link_html()}.'


def _footer_student_html(teacher_label: str) -> str:
    return f'Sent from {_signal_link_html()} on behalf of {teacher_label}.'


def _email_shell(title: str, subtitle_html: str, body_html: str, preheader: str, footer_html: str) -> str:
    # No outer card — an email doesn't need visual separation from "the rest
    # of the page" the way a web-app view does; the email client itself
    # already does that job. Just a plain white page with a centred 600px
    # column for line-length, and the per-section outlines doing all the
    # structural work.
    preheader_html = (
        '<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;'
        f'opacity:0;overflow:hidden;mso-hide:all;">{preheader}' + ('&zwnj;&nbsp;' * 10) + '</div>'
    )
    return f"""<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>{title}</title>
<!--[if mso]>
<style type="text/css">
  body, table, td, p, h1, a {{ font-family: Arial, sans-serif !important; }}
</style>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
<style type="text/css">
  body {{ margin:0; padding:0; background:#ffffff; -webkit-text-size-adjust:100%; }}
  table {{ border-spacing:0; }}
  @media only screen and (max-width:620px) {{
    .shell {{ width:100% !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
{preheader_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#ffffff" style="width:100%;background:#ffffff;border-collapse:collapse;">
<tr>
<td align="center" style="padding:28px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="shell" style="width:600px;margin:0 auto;border-collapse:collapse;">
  <tr>
    <td style="padding:0 20px 28px;font-family:{FONT_STACK};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding-bottom:16px;border-bottom:2px solid {INK};font-family:{FONT_STACK};">
            <h1 style="margin:0;font-size:21px;font-weight:700;letter-spacing:-0.01em;color:{INK};mso-line-height-rule:exactly;line-height:28px;">{title}</h1>
            {subtitle_html}
          </td>
        </tr>
      </table>
      {body_html}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin-top:24px;border-collapse:collapse;">
        <tr>
          <td style="padding-top:16px;border-top:1px solid {HAIRLINE};font-family:{FONT_STACK};font-size:12px;color:{MUTED};mso-line-height-rule:exactly;line-height:18px;">
            {footer_html}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</td>
</tr>
</table>
</body>
</html>"""


def _classwide_email_html(
    assignment_title: str, class_name: str, content: str, total_students: int,
    no_submission_count: int, coursework_id: int,
    analyzed_submission_count: int = 0, total_submission_count: int = 0,
    excluded_context_note: str | None = None,
) -> str:
    sections = _split_sections(content)
    flagged_count = len(_parse_bullets(_find_body(sections, 'Flagged Students')))
    misconception_count = len(_parse_groups(_find_body(sections, 'Common Misconceptions'), 'Misconception'))
    theme_groups = _parse_groups(_find_body(sections, 'Solid Themes'), 'Theme')
    solid_count = len({s for g in theme_groups for s in g["students"]})
    verdict_label = VERDICT_STYLES[_verdict_key(flagged_count, solid_count)]["label"]

    preheader = (
        f"{verdict_label} &middot; {flagged_count} of {total_students} flagged &middot; "
        f"{misconception_count} misconception{'s' if misconception_count != 1 else ''}"
    )
    subtitle_html = (
        f'<p style="margin:5px 0 0;font-family:{FONT_STACK};font-size:13px;font-style:italic;color:{MUTED};'
        f'mso-line-height-rule:exactly;line-height:18px;">{class_name}</p>' if class_name else ""
    )
    body_html = _classwide_report_body_html(
        content, total_students, no_submission_count, coursework_id,
        analyzed_submission_count, total_submission_count, excluded_context_note,
    )
    return _email_shell(
        assignment_title, subtitle_html, body_html, preheader,
        _footer_classwide_report_html(coursework_id),
    )


def _student_email_html(student_name: str, class_name: str, assignment_title: str, content: str) -> str:
    sections = _split_sections(content)
    misconception_count = len(_parse_bullets(_find_body(sections, 'Misconceptions')))
    next_step_body = _find_body(sections, 'Next Step')
    next_step_count = len(_parse_bullets(next_step_body) or ([next_step_body.strip()] if next_step_body.strip() else []))
    preheader = (
        f"{class_name} &middot; {misconception_count} misconception{'s' if misconception_count != 1 else ''} "
        f"&middot; {next_step_count} next step{'s' if next_step_count != 1 else ''}"
    )
    subtitle_html = (
        f'<p style="margin:5px 0 0;font-family:{FONT_STACK};font-size:13px;font-style:italic;color:{MUTED};'
        f'mso-line-height-rule:exactly;line-height:19px;">{class_name}</p>'
        f'<p style="margin:1px 0 0;font-family:{FONT_STACK};font-size:13px;font-style:italic;color:{MUTED};'
        f'mso-line-height-rule:exactly;line-height:19px;">{assignment_title}</p>'
    )
    body_html = _student_report_body_html(content)
    return _email_shell(student_name, subtitle_html, body_html, preheader, _footer_teacher_report_html())


def _student_suggestions_email_html(first_name: str, teacher_label: str, class_name: str, assignment_title: str, content: str) -> str:
    summary_body = _find_body(_split_sections(content), 'Submission Summary')
    first_clause = (summary_body.strip().split('.')[0].strip() + '.') if summary_body.strip() else ""
    preheader = f"From {teacher_label} &mdash; {first_clause}"
    subtitle_html = (
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:13px;color:{MUTED};'
        f'mso-line-height-rule:exactly;line-height:19px;">From '
        f'<span style="color:{MUTED};">{teacher_label}</span>&nbsp; |&nbsp; '
        f'<span style="font-style:italic;">{class_name}</span></p>'
    )
    body_html = _student_suggestions_body_html(content, first_name)
    return _email_shell(
        f"Suggestions for {assignment_title}", subtitle_html, body_html, preheader, _footer_student_html(teacher_label),
    )


def _no_submission_email_html(first_name: str, teacher_label: str, class_name: str, assignment_title: str, start_here_text: str) -> str:
    preheader = f"From {teacher_label} &mdash; one small first step, no full answer needed"
    subtitle_html = (
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:13px;color:{MUTED};'
        f'mso-line-height-rule:exactly;line-height:19px;">From '
        f'<span style="color:{MUTED};">{teacher_label}</span>&nbsp; |&nbsp; '
        f'<span style="font-style:italic;">{class_name}</span></p>'
    )
    body_html = _no_submission_body_html(first_name, start_here_text)
    return _email_shell(
        f"You haven&rsquo;t submitted {assignment_title} yet.", subtitle_html, body_html, preheader,
        _footer_student_html(teacher_label),
    )


def get_submissions_list(coursework_id: int, user: User, db: Session) -> list:
    # Returns one row per enrolled student for this assignment — submitted or not
    # (see sync_coursework) — including any AI reports already built. Used to
    # populate the Student tab, which no longer needs a separate live roster call:
    # has_submitted tells it who hasn't turned anything in, using the exact same
    # data sync already fetched, instead of cross-referencing the class roster itself.
    coursework = db.query(Coursework).filter(
        Coursework.coursework_id == coursework_id,
        Coursework.user_id == user.user_id,
    ).first()

    if not coursework:
        raise HTTPException(status_code=404, detail="Assignment not found")

    submissions = coursework.submissions

    return [
        {
            "submission_id": s.submission_id,
            "student_name": s.student_name,
            "google_user_id": s.google_user_id,
            "content": s.content,
            "student_report": s.student_report,
            "has_submitted": s.state in SUBMITTED_STATES,
        }
        for s in submissions
    ]


def build_student_report(coursework_id: int, submission_id: int, user: User, db: Session) -> dict:
    # Builds an AI report focused on a single student's submission
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

    # A submission that was turned in but came back empty (see sync_coursework) has
    # nothing to analyze — the UI disables Build for these with an explanation, this
    # is the backend backstop so that check can't be bypassed
    if not submission.content or not submission.content.strip():
        raise HTTPException(status_code=400, detail="Empty submission")

    # Same requirement as the classwide report — nothing to compare against
    # means a shallow, generic result, so this isn't allowed to run without it
    if not coursework.context or not coursework.context.strip():
        raise HTTPException(
            status_code=400,
            detail="Add a mental model, description, or rubric before building a report",
        )

    context_str = coursework.context
    course_name = (coursework.course_name or "").strip()

    # No student name or number is sent here at all — unlike the classwide report,
    # there's only ever one submission in scope, so there's nothing to disambiguate
    # and no reason to send the AI provider anything identifying at all
    prompt = f"""You are an expert educator analyzing a single student's submission for a teacher.
This report is diagnostic, not evaluative. You are NOT grading this submission. You MUST NOT
assign, imply, or reference a grade or score, even if a rubric is present in the context
below — a rubric here is reference material only, never a scoring instrument. The goal is
understanding why this student is struggling (or isn't) so the teacher knows what to do next.

REPORT MODE: Build a STUDENT report for this one submission only.

CLASS: {course_name or "Not specified"}
ASSIGNMENT: {coursework.title}

CONTEXT:
{context_str}

The context above may include up to three labeled parts. Mental Model is the teacher's own
definition of what correct understanding looks like for this assignment — treat it as the
primary standard you compare this submission against. Assignment Description and Rubric are
supplementary reference material for understanding the task and its expectations, not
independent grading criteria — weigh them below the Mental Model whenever they'd otherwise
pull your judgment in a different direction.

STUDENT SUBMISSION:
{submission.content}

---

STUDENT REPORT FORMAT — follow exactly:

## Submission Summary
One paragraph summarizing what the student submitted and whether they addressed the question.
If the assignment has multiple distinct questions or parts and this submission only answers
some of them, say so honestly here — describe exactly what was and wasn't addressed.

---

## Understands
- [Specific thing done well]

If nothing correct, write: No understanding shown.

---

## Misconceptions
- **[Misconception]:** [one sentence on what they got wrong and what the correct understanding is]

A student who explicitly asks a clarifying question or says they're confused instead of
attempting an answer (e.g. "I don't understand this") belongs here, not in Submission
Quality — that's a genuine, useful signal of what they don't understand, not insufficient work.

If none, write: No misconceptions found.

---

## Submission Quality
Flag it here ONLY if there's nothing substantive to evaluate — one of these three cases:
- Too short: under 15 words, unless it directly and correctly answers the question →
  "Submission too short to assess properly"
- Off-topic: doesn't attempt to answer the actual question at all → "Submission did not
  address the assignment"
- Gibberish/incoherent: not composed of real, relevant sentences → "Submission could not be
  assessed — not readable as a real answer"

If no issues, write: Submission quality is acceptable.

---

## Next Step
Write exactly ONE bullet point — the single most important thing the teacher should do to
support this specific student. Not several, not a paragraph: one bullet, starting with "- ",
same as the format below. This keeps a teacher building reports for multiple students from
being overloaded with a long list for each one.

- [Specific action tailored to this student]

---

EDGE CASE RULES — follow strictly:
- Under 15 words → flag as insufficient unless it directly and correctly answers the question
- Off-topic or gibberish → flag as insufficient
- NO REPETITION RULE: whenever Submission Quality flags an issue (too short, off-topic,
  gibberish), state the reason there ONCE and do not restate or re-explain it in Submission
  Summary, Understands, or Misconceptions — those sections should stay brief and
  factual (e.g. "Too little content to summarize" / "Not enough content to evaluate") rather than
  repeating why, in different words, in multiple places
- More generally, each section must add information the others haven't already covered — never
  make the same point twice across sections just to fill space
- CONSISTENCY RULE: Submission Summary and Understands must agree with each other — if Submission
  Summary states the student used a term/concept correctly, Understands must reflect that
  positively (not "No understanding shown", which is only for when nothing was
  actually done correctly). Re-read both sections before finalizing to make sure they don't
  contradict each other.
- Never make up content or invent what the student wrote
- Never give generic feedback — tie everything to what was actually in the submission
- Never grade or score this submission in any section — this report is diagnostic only
- Do not use long paragraphs anywhere — keep everything scannable and concise"""

    submission.student_report = _call_groq(prompt)

    db.commit()

    return {
        "submission_id": submission.submission_id,
        "student_report": submission.student_report,
    }
