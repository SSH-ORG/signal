"""
Seeds fake student submissions onto existing coursework rows, for testing the
AI report pipeline without waiting on a real Google Classroom sync.

Usage (from server/, with the venv active):
    python -m app.seed
    python -m app.seed --count 20

Only touches coursework that has zero submissions already, so it's safe to
run again after adding new assignments — it won't duplicate data on ones
you've already seeded or synced for real.
"""

import argparse
import random

from app.database import SessionLocal
from app.models.coursework import Coursework
from app.models.submission import Submission

STUDENT_NAMES = [
    "Ava Torres", "Liam Chen", "Maya Patel", "Noah Robinson", "Zoe Kim",
    "Elijah Brooks", "Sofia Ramirez", "Mason Lee", "Grace Nguyen", "Owen Bailey",
    "Isabella Ortiz", "Lucas Ferreira", "Chloe Whitfield", "Ethan Osei", "Nina Kowalski",
    "Jaden Wright", "Amara Diallo", "Caleb Sutton", "Ruby Fitzgerald", "Theo Marchetti",
]

# Each bucket represents a different level of understanding for a "use the word
# YOLO in a sentence" style assignment, so the AI report has real variety of
# confusion themes to detect. If you seed a different assignment, swap these
# out for responses that actually attempt that assignment's task.
STRONG_RESPONSES = [
    "I decided to skip studying tonight and go to the concert instead — YOLO, right?",
    "My sister said YOLO before jumping off the high dive, and honestly I get it now.",
    "We only have one shot at this trip, so YOLO, let's book the flights.",
    "I know I should save the money, but YOLO, I'm buying the concert tickets.",
]

PARTIAL_RESPONSES = [
    "YOLO means you only live once so I said YOLO when I ate the last slice of pizza.",
    "I used YOLO in my sentence: 'YOLO is a word people say a lot.' I think that counts.",
    "My sentence is 'I will YOLO to the store today,' though I wasn't sure if that's how it's supposed to work.",
    "YOLO. That's my sentence. I know it's supposed to be longer but I wasn't sure what else to add.",
]

CONFUSED_RESPONSES = [
    "I'm not sure what YOLO means so I just wrote: 'The yolo bird flew away.'",
    "Is YOLO like a name? I wrote 'Yolo went to the park with his friends.'",
    "I didn't really get this assignment, so here's a sentence: 'Today was a normal day at school.'",
    "I don't know this word, so I looked up a random word instead and used that.",
]


def seed_submissions(count_per_assignment: int) -> None:
    db = SessionLocal()
    try:
        coursework_list = db.query(Coursework).all()

        if not coursework_list:
            print("No coursework found — sync or create an assignment first.")
            return

        total_seeded = 0

        for cw in coursework_list:
            existing_count = (
                db.query(Submission)
                .filter(Submission.coursework_id == cw.coursework_id)
                .count()
            )

            if existing_count > 0:
                print(f"Skipping '{cw.title}' — already has {existing_count} submission(s).")
                continue

            names = random.sample(STUDENT_NAMES, k=min(count_per_assignment, len(STUDENT_NAMES)))

            for i, name in enumerate(names):
                bucket = random.choice([STRONG_RESPONSES, PARTIAL_RESPONSES, CONFUSED_RESPONSES])
                content = random.choice(bucket)

                submission = Submission(
                    content=content,
                    coursework_id=cw.coursework_id,
                    google_submission_id=f"seed-{cw.coursework_id}-{i}",
                    google_user_id=f"seed-user-{cw.coursework_id}-{i}",
                    student_name=name,
                )
                db.add(submission)

            db.commit()
            print(f"Seeded {len(names)} submission(s) for '{cw.title}'.")
            total_seeded += len(names)

        print(f"Done. Seeded {total_seeded} submission(s) across {len(coursework_list)} assignment(s).")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--count",
        type=int,
        default=15,
        help="Max submissions to seed per assignment (default: 15, capped by the number of fake student names available).",
    )
    args = parser.parse_args()

    seed_submissions(args.count)
