"""rename submission.individual_report to student_report

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-08-01

"""
from alembic import op

revision = 'a7b8c9d0e1f2'
down_revision = 'f6a7b8c9d0e1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('submission', 'individual_report', new_column_name='student_report')


def downgrade() -> None:
    op.alter_column('submission', 'student_report', new_column_name='individual_report')
