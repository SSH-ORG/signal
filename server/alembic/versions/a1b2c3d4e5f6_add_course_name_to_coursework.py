"""add course_name to coursework

Revision ID: a1b2c3d4e5f6
Revises: 25b24d74327c
Create Date: 2026-07-20

"""
from alembic import op
import sqlalchemy as sa

revision = 'a1b2c3d4e5f6'
down_revision = '25b24d74327c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Store the Google Classroom course name on the assignment so it's always
    # available even if the course is later archived or deleted from Classroom
    op.add_column('coursework', sa.Column('course_name', sa.Text(), nullable=True, server_default=''))


def downgrade() -> None:
    op.drop_column('coursework', 'course_name')
