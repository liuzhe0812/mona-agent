"""make model promotions one row per model

Revision ID: promotion_singleton
Revises: model_promotions
Create Date: 2026-09-09 00:30:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "promotion_singleton"
down_revision: Union[str, None] = "model_promotions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_promotions",
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    op.create_unique_constraint(
        "uq_model_promotions_model",
        "model_promotions",
        ["model"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_model_promotions_model",
        "model_promotions",
        type_="unique",
    )
    op.drop_column("model_promotions", "updated_at")
