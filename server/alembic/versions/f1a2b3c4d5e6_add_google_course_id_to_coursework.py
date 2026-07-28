"""add google_course_id to coursework

Revision ID: f1a2b3c4d5e6
Revises: d4e5f6a7b8c9
Create Date: 2026-07-27

"""
from alembic import op
import sqlalchemy as sa

revision = 'f1a2b3c4d5e6'
down_revision = 'd4e5f6a7b8c9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Store the Google Classroom course ID alongside the assignment ID so the
    # background sync job can re-fetch submissions without a teacher being present
    op.add_column('coursework', sa.Column('google_course_id', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('coursework', 'google_course_id')
