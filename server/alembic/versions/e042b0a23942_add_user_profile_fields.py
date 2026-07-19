"""add user profile fields

Revision ID: e042b0a23942
Revises: 6f6341623e8c
Create Date: 2026-07-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e042b0a23942'
down_revision: Union[str, Sequence[str], None] = '6f6341623e8c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('display_name', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('email', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('email_notifications_enabled', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'email_notifications_enabled')
    op.drop_column('users', 'email')
    op.drop_column('users', 'display_name')
