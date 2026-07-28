"""Add notification_preference to users and resolved to submission

Revision ID: b2c3d4e5f6a7
Revises: f1a2b3c4d5e6
Create Date: 2026-07-28
"""
from alembic import op
import sqlalchemy as sa

revision = 'b2c3d4e5f6a7'
down_revision = 'f1a2b3c4d5e6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # notification_preference replaces the boolean email_notifications_enabled toggle
    # with a 5-way choice: immediate | daily | weekly | immediate_weekly | off
    op.add_column('users', sa.Column(
        'notification_preference', sa.Text(), nullable=False, server_default='immediate'
    ))
    # resolved lets teachers dismiss a flagged student from future email digests
    op.add_column('submission', sa.Column(
        'resolved', sa.Boolean(), nullable=False, server_default='false'
    ))


def downgrade() -> None:
    op.drop_column('users', 'notification_preference')
    op.drop_column('submission', 'resolved')
