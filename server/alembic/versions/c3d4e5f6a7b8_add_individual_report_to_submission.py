"""add individual_report to submission

Revision ID: c3d4e5f6a7b8
Revises: a1b2c3d4e5f6
Create Date: 2026-07-22

"""
from alembic import op
import sqlalchemy as sa

revision = 'c3d4e5f6a7b8'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('submission', sa.Column('individual_report', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('submission', 'individual_report')
