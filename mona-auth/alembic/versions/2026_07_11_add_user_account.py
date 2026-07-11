"""add user account field

Revision ID: add_user_account
Revises: pricing_notif
Create Date: 2026-07-11 01:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "add_user_account"
down_revision: Union[str, None] = "pricing_notif"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("account", sa.String(32), nullable=True))
    op.create_index("ix_users_account", "users", ["account"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_account", table_name="users")
    op.drop_column("users", "account")
