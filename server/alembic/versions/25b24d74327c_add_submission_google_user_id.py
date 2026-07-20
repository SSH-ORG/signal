"""add submission google_user_id

Revision ID: 25b24d74327c
Revises: e042b0a23942
Create Date: 2026-07-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '25b24d74327c'
down_revision: Union[str, Sequence[str], None] = 'e042b0a23942'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('submission', sa.Column('google_user_id', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('submission', 'google_user_id')
