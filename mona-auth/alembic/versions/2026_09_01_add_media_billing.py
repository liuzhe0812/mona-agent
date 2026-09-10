"""add image and video billing fields

Revision ID: media_billing
Revises: credits_billing
Create Date: 2026-09-01 10:30:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "media_billing"
down_revision: Union[str, None] = "credits_billing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_prices",
        sa.Column("billing_type", sa.String(16), nullable=False, server_default="token"),
    )
    op.add_column("model_prices", sa.Column("rates_json", sa.JSON, nullable=True))
    op.add_column(
        "model_requests",
        sa.Column("billing_type", sa.String(16), nullable=False, server_default="token"),
    )
    op.add_column("model_requests", sa.Column("request_hash", sa.String(64), nullable=True))
    op.add_column(
        "model_requests", sa.Column("upstream_channel_id", sa.BigInteger, nullable=True)
    )
    op.add_column("model_requests", sa.Column("usage_json", sa.JSON, nullable=True))
    op.add_column("model_requests", sa.Column("result_json", sa.JSON, nullable=True))
    op.add_column("model_requests", sa.Column("last_polled_at", sa.DateTime, nullable=True))


def downgrade() -> None:
    op.drop_column("model_requests", "last_polled_at")
    op.drop_column("model_requests", "result_json")
    op.drop_column("model_requests", "usage_json")
    op.drop_column("model_requests", "upstream_channel_id")
    op.drop_column("model_requests", "request_hash")
    op.drop_column("model_requests", "billing_type")
    op.drop_column("model_prices", "rates_json")
    op.drop_column("model_prices", "billing_type")
