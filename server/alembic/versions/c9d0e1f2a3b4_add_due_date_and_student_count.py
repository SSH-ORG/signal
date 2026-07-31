"""add due_date and student_count to coursework

Revision ID: c9d0e1f2a3b4
Revises: b2c3d4e5f6a7
Create Date: 2026-07-29

"""
from alembic import op
import sqlalchemy as sa

revision = 'c9d0e1f2a3b4'
down_revision = 'b2c3d4e5f6a7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # due_date powers the "ready to build" prompt once an assignment's due date has passed
    op.add_column('coursework', sa.Column('due_date', sa.DateTime(), nullable=True))
    # student_count is the class's total roster size (not just who's submitted so far),
    # fetched once per course instead of redundantly per assignment
    op.add_column('coursework', sa.Column('student_count', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('coursework', 'student_count')
    op.drop_column('coursework', 'due_date')
