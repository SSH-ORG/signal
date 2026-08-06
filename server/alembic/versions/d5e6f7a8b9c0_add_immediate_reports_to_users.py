"""Add immediate_reports_enabled and immediate_min_submissions to users

Revision ID: d5e6f7a8b9c0
Revises: e1f2a3b4c5d6
Create Date: 2026-08-05
"""
from alembic import op
import sqlalchemy as sa

revision = 'd5e6f7a8b9c0'
down_revision = 'e1f2a3b4c5d6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Independent of notification_preference (daily/weekly reminder digests) —
    # auto-builds and emails a class-wide report once ready, instead of just
    # reminding the teacher to build it. Beta feature, off by default.
    op.add_column('users', sa.Column(
        'immediate_reports_enabled', sa.Boolean(), nullable=False, server_default='false'
    ))
    # Teacher-configurable floor for auto-build, defaulting to the same minimum
    # build_report itself enforces (see MIN_SUBMISSIONS_FOR_CLASSWIDE_REPORT)
    op.add_column('users', sa.Column(
        'immediate_min_submissions', sa.Integer(), nullable=False, server_default='5'
    ))


def downgrade() -> None:
    op.drop_column('users', 'immediate_min_submissions')
    op.drop_column('users', 'immediate_reports_enabled')
