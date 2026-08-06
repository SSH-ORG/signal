"""Add work_type to coursework and immediate type-filter settings to users

Revision ID: a2b3c4d5e6f7
Revises: e6f7a8b9c0d1
Create Date: 2026-08-06
"""
from alembic import op
import sqlalchemy as sa

revision = 'a2b3c4d5e6f7'
down_revision = 'e6f7a8b9c0d1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Classroom's workType (ASSIGNMENT/SHORT_ANSWER_QUESTION) — captured at sync
    # time going forward so Immediate can filter on it. Null until synced.
    op.add_column('coursework', sa.Column('work_type', sa.Text(), nullable=True))

    # Which coursework types are eligible for Immediate auto-build — both true
    # by default (no filtering, matches today's behavior).
    op.add_column('users', sa.Column(
        'immediate_include_assignments', sa.Boolean(), nullable=False, server_default='true'
    ))
    op.add_column('users', sa.Column(
        'immediate_include_short_answer', sa.Boolean(), nullable=False, server_default='true'
    ))

    # No real users/teacher data exists yet — every pre-existing coursework row
    # predates work_type and would otherwise sit at null indefinitely. Clearing
    # now (cascades to submission/report) avoids reasoning about legacy null
    # rows; going forward every row gets work_type set at sync time.
    op.execute('DELETE FROM coursework')


def downgrade() -> None:
    op.drop_column('users', 'immediate_include_short_answer')
    op.drop_column('users', 'immediate_include_assignments')
    op.drop_column('coursework', 'work_type')
