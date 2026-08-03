"""add state and google_updated_at to submission

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-08-01

"""
from alembic import op
import sqlalchemy as sa

revision = 'b8c9d0e1f2a3'
down_revision = 'a7b8c9d0e1f2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('submission', sa.Column('state', sa.Text(), nullable=True))
    op.add_column('submission', sa.Column('google_updated_at', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('submission', 'google_updated_at')
    op.drop_column('submission', 'state')
