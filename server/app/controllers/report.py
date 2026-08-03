import os
import re
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
        for sub in ordered_submissions
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

    report_content = _resolve_student_references(ai_content, ordered_submissions)

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

    db.commit()
    db.refresh(report)

    return {
        "report_id": report.report_id,
        "coursework_id": coursework.coursework_id,
        "content": report.content,
        "created_at": report.created_at,
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
    subject = f"Classwide Report: {course_name} – {coursework.title}" if course_name else f"Classwide Report: {coursework.title}"
    html_body = _classwide_email_html(coursework.title, coursework.report.content, subtitle=course_name or None)

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
    subject = (
        f"{student_label} Report: {course_name} – {coursework.title}"
        if course_name else f"{student_label} Report: {coursework.title}"
    )
    html_body = _student_email_html(
        f"{student_label} — {coursework.title}", submission.student_report, subtitle=course_name or None
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

    prompt = f"""You are rewriting a teacher's diagnostic report about one student so it can be
emailed directly to that student, instead of read by the teacher.

ORIGINAL REPORT (written for the teacher, about "{student_label}"):
{submission.student_report}

Rewrite it so it speaks directly to {student_label} in second person ("you"/"your") — not
about them in the third person, and not as an instruction to their teacher. Keep the exact
same meaning, facts, and level of detail — do not invent anything new, add generic praise, or
change what was actually found. Keep the exact same 5 section headings below, in the same
order, and keep each section's content roughly the same length as the original:

## Submission Summary
## Understands
## Misconceptions
## Submission Quality
## Next Step

For every section except Next Step, simply redirect the same content at the student directly
(e.g. "This submission covers..." becomes "Your submission covers...").

For Next Step specifically: the original phrases it as the single most important thing the
teacher should do to support this student — rewrite it as the single most important thing
{student_label} should do next, addressed directly to them, as one bullet point starting with
"- ". Same underlying action, just given to the student as advice instead of to the teacher
as an instruction.

Output only the 5 sections in the exact format above — no extra commentary before or after."""

    ai_content = _call_groq(prompt)
    sections = _split_sections(ai_content)

    return {
        "submission_summary": _find_body(sections, 'Submission Summary'),
        "understands": _find_body(sections, 'Understands'),
        "misconceptions": _find_body(sections, 'Misconceptions'),
        "submission_quality": _find_body(sections, 'Submission Quality'),
        "next_step": _find_body(sections, 'Next Step'),
    }


async def send_student_report(
    coursework_id: int,
    submission_id: int,
    user: User,
    db: Session,
    submission_summary_override: str | None = None,
    understands_override: str | None = None,
    misconceptions_override: str | None = None,
    submission_quality_override: str | None = None,
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
    teacher_label = user.display_name or "your teacher"
    course_name = (coursework.course_name or "").strip()

    # Only affects this one outgoing email — submission.student_report (the
    # stored report) is never reassigned or committed here
    report_content = submission.student_report
    section_overrides = [
        ("Submission Summary", submission_summary_override),
        ("Understands", understands_override),
        ("Misconceptions", misconceptions_override),
        ("Submission Quality", submission_quality_override),
        ("Next Step", next_step_override),
    ]
    for heading, override in section_overrides:
        if override is not None and override.strip():
            report_content = _override_section_body(report_content, heading, override)

    html_body = _student_email_html(
        coursework.title,
        report_content,
        footer_note=f"Sent from {_signal_link_html()} on behalf of {teacher_label}.",
        subtitle=course_name or None,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "from": "Signal <signal@marcylab.us>",
                "to": [student_email],
                "subject": f"Feedback from {teacher_label}",
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



# ── Email rendering ──────────────────────────────────────────────────────
# Mirrors the app's own report display (ReportBody.jsx) instead of dumping
# generic markdown — same section colors/labels/badge — so a report reads
# the same whether it's opened in Signal or in an inbox. Inter is loaded
# from Google Fonts; Gmail renders linked webfonts, so this actually shows
# up as Inter there instead of silently falling back to the system font.

FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

# color/border/tint per section — mirrors SECTION_META in ReportBody.jsx.
# Tints are precomputed light hexes rather than alpha-blended at render time,
# since 8-digit hex alpha support is inconsistent across email clients.
# Icons are plain Unicode text glyphs (checkmark/x), not emoji — plain text
# renders identically everywhere with no color/font-rendering variance, and
# sections with no clean plain-text equivalent (Flagged Students, Next Steps)
# just skip the icon rather than force one in.
SECTION_STYLES = {
    "overview": {"label": "Class Summary", "icon": "", "color": "#aa3bff", "border": "#e3c6ff", "tint": "#f6ecff"},
    "flagged": {"label": "Flagged Students", "icon": "!", "color": "#d93025", "border": "#f6c6c0", "tint": "#fdecea"},
    "misconceptions": {"label": "Common Misconceptions", "icon": "✕", "color": "#e67e22", "border": "#f6d2a6", "tint": "#fff2e2"},
    "themes": {"label": "Solid Themes", "icon": "✓", "color": "#27ae60", "border": "#a9e0c1", "tint": "#e7f7ee"},
    "next-steps": {"label": "Next Steps", "icon": "&rarr;", "color": "#3b82f6", "border": "#b9d3fb", "tint": "#eaf1ff"},
    "summary": {"label": "Submission Summary", "icon": "", "color": "#6b7280", "border": "#d8dade", "tint": "#f3f4f6"},
    "understands": {"label": "Understands", "icon": "✓", "color": "#27ae60", "border": "#a9e0c1", "tint": "#e7f7ee"},
    "student-misconceptions": {"label": "Misconceptions", "icon": "✕", "color": "#e67e22", "border": "#f6d2a6", "tint": "#fff2e2"},
    "next-step": {"label": "Next Step", "icon": "", "color": "#3b82f6", "border": "#b9d3fb", "tint": "#eaf1ff"},
}


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


def _badge_html(label: str, color: str, tint: str) -> str:
    return (
        f'<span style="display:inline-block;margin-bottom:10px;font-family:{FONT_STACK};font-size:12px;'
        f'font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:{color};background:{tint};'
        f'border:1px solid {color};border-radius:100px;padding:5px 12px;">{label}</span><br>'
    )


def _section_box(key: str, body_html: str) -> str:
    meta = SECTION_STYLES[key]
    icon_html = f'<span style="margin-right:8px;">{meta["icon"]}</span>' if meta["icon"] else ""
    return f"""
<div style="margin-bottom:16px;border:1px solid {meta['border']};border-radius:10px;overflow:hidden;">
  <div style="background:{meta['color']};padding:10px 16px;">
    <span style="color:#fff;font-family:{FONT_STACK};font-weight:700;font-size:14px;">{icon_html}{meta['label']}</span>
  </div>
  <div style="padding:16px;background:#ffffff;">{body_html}</div>
</div>"""


def _chips_html(items: list, color: str, tint: str, empty_text: str) -> str:
    if not items:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:13px;color:#888;">{empty_text}</p>'
    return "".join(
        f'<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:100px;'
        f'background:{tint};border:1px solid {color};font-family:{FONT_STACK};font-size:13px;'
        f'color:#111;">{_format_line(i)}</span>'
        for i in items
    )


def _grouped_chips_html(groups: list, color: str, tint: str, empty_text: str) -> str:
    if not groups:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:13px;color:#888;">{empty_text}</p>'
    return "".join(
        f'<div style="margin-bottom:12px;"><p style="margin:0 0 6px;font-family:{FONT_STACK};font-size:13px;'
        f'font-weight:700;color:#111;">{_format_line(g["label"])}</p>{_chips_html(g["students"], color, tint, "")}</div>'
        for g in groups
    )


def _numbered_steps_html(steps: list, color: str) -> str:
    if not steps:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:13px;color:#888;">No next steps provided.</p>'
    rows = ""
    for step in steps:
        # margin-right on the icon, not flex gap — gap on a flex container is
        # unreliable across email clients and can silently collapse to 0
        marker_html = (
            f'<span style="flex-shrink:0;margin-right:8px;font-size:16px;'
            f'font-weight:700;color:{color};">&rarr;</span>'
        )
        rows += (
            f'<div style="display:flex;margin-bottom:8px;">{marker_html}'
            f'<span style="font-family:{FONT_STACK};font-size:14px;line-height:1.6;color:#111;'
            f'padding-top:1px;">{_format_line(step)}</span>'
            f'</div>'
        )
    return rows


def _icon_bullet_list_html(items: list, color: str, icon_char: str, empty_text: str) -> str:
    if not items:
        return f'<p style="margin:0;font-family:{FONT_STACK};font-size:13px;color:#888;">{empty_text}</p>'
    return "".join(
        f'<div style="display:flex;margin-bottom:6px;">'
        f'<span style="color:{color};font-weight:700;flex-shrink:0;margin-right:8px;">{icon_char}</span>'
        f'<span style="font-family:{FONT_STACK};font-size:13px;line-height:1.5;'
        f'color:#111;">{_format_line(i)}</span></div>'
        for i in items
    )


def _paragraphs_html(body: str) -> str:
    return "".join(
        f'<p style="margin:0 0 8px;font-family:{FONT_STACK};font-size:14px;line-height:1.6;'
        f'color:#111;">{_format_line(line)}</p>'
        for line in body.split('\n') if line.strip()
    )


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


def _classwide_report_body_html(content: str) -> str:
    # Mirrors ClasswideReportBody — Class Summary (with confusion badge) then
    # Flagged Students / Common Misconceptions / Solid Themes / Next Steps,
    # each shown in full rather than as a click-to-expand card like the app,
    # since email has no interactivity to expand anything.
    sections = _split_sections(content)
    overview_details = _find_body(sections, 'Summary Details') or _find_body(sections, 'Class Summary')
    flagged_body = _find_body(sections, 'Flagged Students')
    misconceptions_body = _find_body(sections, 'Common Misconceptions')
    themes_body = _find_body(sections, 'Solid Themes')
    next_steps_body = _find_body(sections, 'Next Steps')

    if not any([overview_details, flagged_body, misconceptions_body, themes_body, next_steps_body]):
        return _generic_sections_html(sections)

    flagged_names = _parse_bullets(flagged_body)
    misconception_groups = _parse_groups(misconceptions_body, 'Misconception')
    theme_groups = _parse_groups(themes_body, 'Theme')
    next_steps = _parse_bullets(next_steps_body)

    flagged_count = len(flagged_names)
    solid_count = len({s for g in theme_groups for s in g["students"]})

    if flagged_count == 0:
        tier_label, tier_color, tier_tint = "Strong Understanding", "#27ae60", "#e7f7ee"
    elif flagged_count > solid_count:
        tier_label, tier_color, tier_tint = "Needs Attention", "#d93025", "#fdecea"
    else:
        tier_label, tier_color, tier_tint = "Mixed Understanding", "#e67e22", "#fff2e2"

    summary_html = _badge_html(tier_label, tier_color, tier_tint) + _paragraphs_html(overview_details)

    html = _section_box("overview", summary_html)
    html += _section_box("flagged", _chips_html(
        flagged_names, SECTION_STYLES["flagged"]["color"], SECTION_STYLES["flagged"]["tint"], "No students flagged."
    ))
    html += _section_box("misconceptions", _grouped_chips_html(
        misconception_groups, SECTION_STYLES["misconceptions"]["color"], SECTION_STYLES["misconceptions"]["tint"],
        "No common misconceptions found.",
    ))
    html += _section_box("themes", _grouped_chips_html(
        theme_groups, SECTION_STYLES["themes"]["color"], SECTION_STYLES["themes"]["tint"], "No solid themes found."
    ))
    html += _section_box("next-steps", _numbered_steps_html(next_steps, SECTION_STYLES["next-steps"]["color"]))
    return html


def _student_report_body_html(content: str) -> str:
    # Mirrors StudentReportSummary — Submission Summary (with the quality
    # flag folded in, same as the modal) then Understands/Misconceptions
    # side by side, then Next Step with an arrow marker instead of a number
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
        f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;line-height:1.6;'
        f'color:#111;">{_format_line(summary_body.strip())}</p>'
        if summary_body else ""
    )
    if quality_issue:
        summary_html += (
            f'<div style="display:flex;margin-top:10px;">'
            f'<span style="color:#b45309;font-weight:700;flex-shrink:0;margin-right:8px;">!</span>'
            f'<span style="font-family:{FONT_STACK};font-size:13px;color:#b45309;">{quality_issue}</span>'
            f'</div>'
        )

    html = _section_box("summary", summary_html) if summary_body else ""

    understands_html = _icon_bullet_list_html(
        understands, SECTION_STYLES["understands"]["color"], "✓", "No understanding shown."
    )
    misconceptions_html = _icon_bullet_list_html(
        misconceptions, SECTION_STYLES["student-misconceptions"]["color"], "✕", "No misconceptions found."
    )
    html += f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td width="50%" style="vertical-align:top;padding-right:8px;">{_section_box("understands", understands_html)}</td>
    <td width="50%" style="vertical-align:top;padding-left:8px;">{_section_box("student-misconceptions", misconceptions_html)}</td>
  </tr>
</table>"""

    html += _section_box("next-step", _numbered_steps_html(next_steps, SECTION_STYLES["next-step"]["color"]))
    return html


def _signal_link_html() -> str:
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    return f'<a href="{frontend_url}" style="color:#111;text-decoration:underline;font-weight:600;">Signal</a>'


def _email_shell(title: str, body_html: str, footer_note: str | None = None, subtitle: str | None = None) -> str:
    subtitle_html = (
        f'<p style="font-family:{FONT_STACK};font-size:13px;font-style:italic;color:#666;margin:4px 0 0;">{subtitle}</p>'
        if subtitle else ""
    )
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:{FONT_STACK};">
  <div style="max-width:640px;margin:32px auto;padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e5e5e8;font-family:{FONT_STACK};">
    <div style="margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #111;">
      <h1 style="font-family:{FONT_STACK};font-size:20px;font-weight:700;margin:0;color:#111;">{title}</h1>
      {subtitle_html}
    </div>
    {body_html}
    <div style="margin-top:8px;padding-top:16px;border-top:1px solid #e8e8e8;font-family:{FONT_STACK};font-size:12px;color:#aaa;">
      {footer_note or f"Sent from {_signal_link_html()}."}
    </div>
  </div>
</body>
</html>"""


def _classwide_email_html(title: str, content: str, footer_note: str | None = None, subtitle: str | None = None) -> str:
    return _email_shell(title, _classwide_report_body_html(content), footer_note, subtitle)


def _student_email_html(title: str, content: str, footer_note: str | None = None, subtitle: str | None = None) -> str:
    return _email_shell(title, _student_report_body_html(content), footer_note, subtitle)


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
