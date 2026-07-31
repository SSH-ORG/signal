"""simplify notification_preference to daily/weekly only

Revision ID: e5f6a7b8c9d0
Revises: c9d0e1f2a3b4
Create Date: 2026-07-29

"""
from alembic import op
import sqlalchemy as sa

revision = 'e5f6a7b8c9d0'
down_revision = 'c9d0e1f2a3b4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    users = sa.table(
        'users',
        sa.column('notification_preference', sa.Text),
        sa.column('email_notifications_enabled', sa.Boolean),
    )

    # Anyone who had opted into any non-off cadence now gets the master toggle
    # turned on, so the account page toggle reflects their prior intent
    op.execute(
        users.update()
        .where(users.c.notification_preference != 'off')
        .values(email_notifications_enabled=True)
    )
    # immediate_weekly folds into weekly; immediate and off fold into daily,
    # the new default cadence shown once the toggle is turned on
    op.execute(
        users.update()
        .where(users.c.notification_preference == 'immediate_weekly')
        .values(notification_preference='weekly')
    )
    op.execute(
        users.update()
        .where(users.c.notification_preference.in_(('immediate', 'off')))
        .values(notification_preference='daily')
    )
    op.alter_column('users', 'notification_preference', server_default='daily')


def downgrade() -> None:
    op.alter_column('users', 'notification_preference', server_default='immediate')
