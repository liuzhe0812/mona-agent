"""add pricing and notifications

Revision ID: 2026_06_13_add_pricing_and_notifications
Revises:
Create Date: 2026-06-13 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "pricing_notif"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pricing_plans",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("price", sa.Numeric(10, 2), nullable=False),
        sa.Column("original_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("duration_months", sa.Integer, nullable=False),
        sa.Column("badge", sa.String(32), nullable=True),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    op.create_table(
        "app_config",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.String(1024), nullable=True),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("body", sa.String(512), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("action_url", sa.String(512), nullable=True),
        sa.Column("image_url", sa.String(512), nullable=True),
        sa.Column("published", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("published_at", sa.DateTime, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "notification_reads",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("notification_id", sa.BigInteger, sa.ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("read_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "notification_id"),
    )

    op.bulk_insert(
        sa.table(
            "pricing_plans",
            sa.column("id", sa.String),
            sa.column("name", sa.String),
            sa.column("price", sa.Numeric),
            sa.column("original_price", sa.Numeric),
            sa.column("duration_months", sa.Integer),
            sa.column("badge", sa.String),
            sa.column("sort_order", sa.Integer),
            sa.column("enabled", sa.Boolean),
        ),
        [
            {
                "id": "monthly",
                "name": "月度订阅",
                "price": 29.0,
                "duration_months": 1,
                "sort_order": 1,
                "enabled": True,
            },
            {
                "id": "yearly",
                "name": "年度订阅",
                "price": 288.0,
                "original_price": 348.0,
                "duration_months": 12,
                "badge": "推荐",
                "sort_order": 2,
                "enabled": True,
            },
        ],
    )

    op.bulk_insert(
        sa.table(
            "app_config",
            sa.column("key", sa.String),
            sa.column("value", sa.String),
        ),
        [
            {"key": "contact_email", "value": "support@example.com"},
            {"key": "contact_wechat", "value": "mona_support"},
            {"key": "promotional_banner", "value": None},
        ],
    )


def downgrade() -> None:
    op.drop_table("notification_reads")
    op.drop_table("notifications")
    op.drop_table("app_config")
    op.drop_table("pricing_plans")
