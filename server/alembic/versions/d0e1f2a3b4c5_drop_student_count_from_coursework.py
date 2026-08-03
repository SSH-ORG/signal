"""drop student_count from coursework

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-08-01

"""
from alembic import op
import sqlalchemy as sa

revision = 'd0e1f2a3b4c5'
down_revision = 'b8c9d0e1f2a3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('coursework', 'student_count')


def downgrade() -> None:
    op.add_column('coursework', sa.Column('student_count', sa.Integer(), nullable=True))
