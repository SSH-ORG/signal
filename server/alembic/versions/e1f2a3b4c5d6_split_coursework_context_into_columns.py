"""split coursework.context into mental_model/assignment_description/rubric columns

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-08-04

"""
import re
from alembic import op
import sqlalchemy as sa

revision = 'e1f2a3b4c5d6'
down_revision = 'd0e1f2a3b4c5'
branch_labels = None
depends_on = None


# Mirrors the frontend's old extractContextSection exactly, so this one-time
# backfill reconstructs whatever a teacher had already saved the same way the
# app used to read it back — including any existing truncation, which can't
# be un-lost, but nothing here loses anything further.
def _extract_section(context, label):
    if not context:
        return ''
    pattern = re.compile(
        rf'{re.escape(label)}:\n(.*?)(?:\n\n(?:Mental Model|Assignment Description|Rubric):|$)',
        re.DOTALL,
    )
    match = pattern.search(context)
    return match.group(1).strip() if match else ''


def upgrade() -> None:
    op.add_column('coursework', sa.Column('mental_model', sa.Text(), nullable=False, server_default=''))
    op.add_column('coursework', sa.Column('assignment_description', sa.Text(), nullable=False, server_default=''))
    op.add_column('coursework', sa.Column('rubric', sa.Text(), nullable=False, server_default=''))
    op.add_column('coursework', sa.Column('include_description', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('coursework', sa.Column('include_rubric', sa.Boolean(), nullable=False, server_default='true'))

    conn = op.get_bind()
    rows = conn.execute(sa.text('SELECT coursework_id, context FROM coursework')).fetchall()
    for coursework_id, context in rows:
        conn.execute(
            sa.text(
                'UPDATE coursework SET mental_model = :mm, assignment_description = :ad, rubric = :rb '
                'WHERE coursework_id = :id'
            ),
            {
                'mm': _extract_section(context, 'Mental Model'),
                'ad': _extract_section(context, 'Assignment Description'),
                'rb': _extract_section(context, 'Rubric'),
                'id': coursework_id,
            },
        )

    op.drop_column('coursework', 'context')


def downgrade() -> None:
    op.add_column('coursework', sa.Column('context', sa.Text(), nullable=True, server_default=''))

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            'SELECT coursework_id, mental_model, assignment_description, rubric, '
            'include_description, include_rubric FROM coursework'
        )
    ).fetchall()
    for coursework_id, mental_model, assignment_description, rubric, include_description, include_rubric in rows:
        parts = []
        if mental_model:
            parts.append(f'Mental Model:\n{mental_model}')
        if include_description and assignment_description:
            parts.append(f'Assignment Description:\n{assignment_description}')
        if include_rubric and rubric:
            parts.append(f'Rubric:\n{rubric}')
        conn.execute(
            sa.text('UPDATE coursework SET context = :ctx WHERE coursework_id = :id'),
            {'ctx': '\n\n'.join(parts), 'id': coursework_id},
        )

    op.drop_column('coursework', 'include_rubric')
    op.drop_column('coursework', 'include_description')
    op.drop_column('coursework', 'rubric')
    op.drop_column('coursework', 'assignment_description')
    op.drop_column('coursework', 'mental_model')
