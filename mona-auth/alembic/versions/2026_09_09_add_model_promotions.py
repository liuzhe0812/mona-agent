"""add model discount promotions

Revision ID: model_promotions
Revises: worker_jobs
Create Date: 2026-09-09 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "model_promotions"
down_revision: Union[str, None] = "worker_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "model_promotions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("price_multiplier_bps", sa.Integer(), nullable=False),
        sa.Column("start_at", sa.DateTime(), nullable=False),
        sa.Column("end_at", sa.DateTime(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("disabled_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "price_multiplier_bps > 0 AND price_multiplier_bps < 10000",
            name="ck_model_promotion_multiplier_range",
        ),
        sa.CheckConstraint("end_at > start_at", name="ck_model_promotion_time_range"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_model_promotions_model_window",
        "model_promotions",
        ["model", "enabled", "start_at", "end_at"],
    )
    op.add_column(
        "model_requests",
        sa.Column("promotion_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "model_requests",
        sa.Column(
            "price_multiplier_bps",
            sa.Integer(),
            nullable=False,
            server_default="10000",
        ),
    )
    op.create_index("ix_model_requests_promotion_id", "model_requests", ["promotion_id"])
    op.create_foreign_key(
        "fk_model_requests_promotion_id",
        "model_requests",
        "model_promotions",
        ["promotion_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_model_request_multiplier_range",
        "model_requests",
        "price_multiplier_bps > 0 AND price_multiplier_bps <= 10000",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_model_request_multiplier_range",
        "model_requests",
        type_="check",
    )
    op.drop_constraint(
        "fk_model_requests_promotion_id",
        "model_requests",
        type_="foreignkey",
    )
    op.drop_index("ix_model_requests_promotion_id", table_name="model_requests")
    op.drop_column("model_requests", "price_multiplier_bps")
    op.drop_column("model_requests", "promotion_id")
    op.drop_index("ix_model_promotions_model_window", table_name="model_promotions")
    op.drop_table("model_promotions")
