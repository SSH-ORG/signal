"""drop submission.resolved column (dead — only used by the removed resolve-link email flow)

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-07-31

"""
from alembic import op
import sqlalchemy as sa

revision = 'f6a7b8c9d0e1'
down_revision = 'e5f6a7b8c9d0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('submission', 'resolved')


def downgrade() -> None:
    op.add_column('submission', sa.Column('resolved', sa.Boolean(), nullable=False, server_default='false'))
