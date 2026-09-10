"""add recharge promotion order fields

Revision ID: recharge_pro_promo
Revises: media_billing
Create Date: 2026-09-01 13:30:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "recharge_pro_promo"
down_revision: Union[str, None] = "media_billing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "payments",
        sa.Column("bonus_pro_days", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column("payments", sa.Column("bonus_pro_granted_at", sa.DateTime, nullable=True))
    op.add_column("payments", sa.Column("bonus_pro_revoked_at", sa.DateTime, nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "bonus_pro_revoked_at")
    op.drop_column("payments", "bonus_pro_granted_at")
    op.drop_column("payments", "bonus_pro_days")
