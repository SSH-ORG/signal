"""Add analyzed_submission_count and total_submission_count to report

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-08-05
"""
from alembic import op
import sqlalchemy as sa

revision = 'e6f7a8b9c0d1'
down_revision = 'd5e6f7a8b9c0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # How many real-content submissions actually went into the AI prompt vs.
    # how many existed in total — lets the UI/email disclose when a report was
    # built from only the first MAX_SUBMISSIONS_FOR_CLASSWIDE_REPORT of a
    # larger class, instead of silently describing "the class" from a subset.
    op.add_column('report', sa.Column(
        'analyzed_submission_count', sa.Integer(), nullable=False, server_default='0'
    ))
    op.add_column('report', sa.Column(
        'total_submission_count', sa.Integer(), nullable=False, server_default='0'
    ))


def downgrade() -> None:
    op.drop_column('report', 'total_submission_count')
    op.drop_column('report', 'analyzed_submission_count')
