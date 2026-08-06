"""
Seeds fake student submissions onto an existing coursework row, for demoing
the AI report pipeline without waiting on real Google Classroom students to
turn work in. Adds ON TOP of whatever real submissions already exist (never
touches or deletes them) until the assignment reaches --target total
submissions.

Usage (from server/, with the venv active):
    python -m app.seed
    python -m app.seed --coursework-id 24 --target 23

If no --coursework-id is given and there's exactly one assignment in the
database, that one is used. The response mix below is tailored to this
repo's current demo assignment ("explain why Earth has seasons") and is
deliberately weighted toward wrong/partial answers, so a freshly-built
class-wide report skews toward a "Needs Review" verdict — see _verdict_key
in controllers/report.py, which flags weak once flagged_count > solid_count.
If you seed a different assignment, swap the response buckets below for
answers that actually attempt that assignment's task.
"""

import argparse
import random

from app.database import SessionLocal
from app.models.coursework import Coursework
from app.models.submission import Submission

STUDENT_NAMES = [
    "Aiden Cooper", "Priya Sharma", "Marcus Bell", "Layla Haddad", "Tomás Rivera",
    "Ella Sinclair", "Devon Marsh", "Wren Alcott", "Jasper Nwosu", "Freya Lindqvist",
    "Malik Osei", "Camille Duarte", "Rowan Beckett", "Sana Iqbal", "Diego Fuentes",
    "Harper Voss", "Amina Yusuf", "Beckett Lowry", "Ivy Callahan", "Kofi Mensah",
    "Nadia Petrov",
]

# Correct: names the axial tilt as the actual cause, in complete sentences.
STRONG_RESPONSES = [
    "Earth has seasons because its axis is tilted about 23.5 degrees, so different parts of the planet get more or less direct sunlight as it orbits the sun.",
    "The tilt of Earth's axis causes seasons — when the Northern Hemisphere leans toward the sun we get summer there, and when it leans away we get winter.",
    "Seasons happen because Earth is tilted on its axis, so throughout the year different hemispheres receive sunlight at different angles.",
]

# Gestures at the tilt but stays vague about how it actually produces seasons.
PARTIAL_RESPONSES = [
    "It has something to do with the tilt of the Earth, but I'm not totally sure how that changes the temperature.",
    "The Earth is tilted so some parts get more sun than other parts, which I think causes summer and winter.",
    "Seasons change because of the tilt and the orbit, but I don't remember exactly how they work together.",
    "I think the axis being tilted matters somehow, but the sun also has to be involved for the seasons to change.",
    "The Earth tilts a little so the weather changes throughout the year.",
]

# Classic misconception: blames seasons on Earth's distance from the sun.
MISCONCEPTION_RESPONSES = [
    "Earth has seasons because it gets closer to the sun in the summer and farther away in the winter.",
    "In summer the Earth is closer to the sun, which makes it hotter, and in winter it moves farther away, which makes it colder.",
    "The seasons change because our distance from the sun changes as we orbit it.",
    "Summer happens when Earth is nearest to the sun in its orbit, and winter happens when it's farthest away.",
    "The Earth's orbit isn't a perfect circle, so when we're closer to the sun it's warmer and that's summer.",
    # Second common misconception: confuses rotation/day-night with seasons.
    "Seasons happen because the Earth spins faster in the summer and slower in the winter.",
    "The Earth rotates and that spinning is what causes the seasons to change throughout the year.",
    "Day and night cause the seasons because the Earth spinning gives us different amounts of sunlight each season.",
    "The seasons are caused by how fast the Earth rotates around the sun each day.",
]

RESPONSE_BUCKET = STRONG_RESPONSES + PARTIAL_RESPONSES + MISCONCEPTION_RESPONSES


def seed_submissions(coursework_id: int | None, target: int) -> None:
    db = SessionLocal()
    try:
        if coursework_id is not None:
            coursework = db.get(Coursework, coursework_id)
            if not coursework:
                print(f"No coursework with id {coursework_id}.")
                return
        else:
            all_coursework = db.query(Coursework).all()
            if len(all_coursework) != 1:
                print(f"Found {len(all_coursework)} assignments — pass --coursework-id to pick one.")
                return
            coursework = all_coursework[0]

        existing = (
            db.query(Submission)
            .filter(Submission.coursework_id == coursework.coursework_id)
            .all()
        )
        existing_names = {s.student_name for s in existing if s.student_name}
        to_add = target - len(existing)
        if to_add <= 0:
            print(f"'{coursework.title}' already has {len(existing)} submission(s), >= target of {target}. Nothing to do.")
            return

        available_names = [n for n in STUDENT_NAMES if n not in existing_names]
        if to_add > len(available_names):
            print(f"Only {len(available_names)} unused fake names available, capping from {to_add}.")
            to_add = len(available_names)

        names = random.sample(available_names, k=to_add)

        # Roughly 1 in 5 new rows are unsubmitted/empty, so the demo shows a
        # realistic mix — rounded up so even a small --target still gets one.
        unsubmitted_count = max(1, round(to_add * 0.2))
        submitted_count = to_add - unsubmitted_count

        start = len(existing)
        for i, name in enumerate(names):
            if i < submitted_count:
                submission = Submission(
                    content=random.choice(RESPONSE_BUCKET),
                    coursework_id=coursework.coursework_id,
                    google_submission_id=f"seed-{coursework.coursework_id}-{start + i}",
                    google_user_id=f"seed-user-{coursework.coursework_id}-{start + i}",
                    student_name=name,
                    state="TURNED_IN",
                )
            else:
                submission = Submission(
                    content="",
                    coursework_id=coursework.coursework_id,
                    google_submission_id=f"seed-{coursework.coursework_id}-{start + i}",
                    google_user_id=f"seed-user-{coursework.coursework_id}-{start + i}",
                    student_name=name,
                    state="CREATED",
                )
            db.add(submission)

        db.commit()
        print(
            f"Added {to_add} submission(s) to '{coursework.title}' "
            f"({submitted_count} with content, {unsubmitted_count} unsubmitted) — "
            f"{len(existing) + to_add} total now."
        )
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--coursework-id", type=int, default=None,
        help="Assignment to seed (default: the only one in the database).",
    )
    parser.add_argument(
        "--target", type=int, default=23,
        help="Total submissions the assignment should have once seeding is done (default: 23).",
    )
    args = parser.parse_args()

    seed_submissions(args.coursework_id, args.target)
