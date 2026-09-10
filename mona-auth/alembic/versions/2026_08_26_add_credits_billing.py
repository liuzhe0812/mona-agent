"""add credits billing tables and payment fulfillment fields

Revision ID: credits_billing
Revises: alipay_sub
Create Date: 2026-08-26 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "credits_billing"
down_revision: Union[str, None] = "alipay_sub"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "payments",
        "amount",
        existing_type=sa.Float(),
        type_=sa.Numeric(12, 2),
        existing_nullable=False,
    )
    op.alter_column(
        "pricing_plans",
        "price",
        existing_type=sa.Numeric(10, 2),
        type_=sa.Numeric(12, 2),
        existing_nullable=False,
    )
    op.alter_column(
        "pricing_plans",
        "original_price",
        existing_type=sa.Numeric(10, 2),
        type_=sa.Numeric(12, 2),
        existing_nullable=True,
    )
    op.alter_column(
        "subscription_renewals",
        "amount",
        existing_type=sa.Float(),
        type_=sa.Numeric(12, 2),
        existing_nullable=False,
    )

    op.add_column(
        "payments",
        sa.Column(
            "product_type",
            sa.String(32),
            nullable=False,
            server_default="subscription",
        ),
    )
    op.add_column("payments", sa.Column("product_code", sa.String(64), nullable=True))
    op.add_column("payments", sa.Column("credit_units", sa.BigInteger, nullable=True))
    op.add_column(
        "payments",
        sa.Column(
            "fulfillment_status",
            sa.String(32),
            nullable=False,
            server_default="not_started",
        ),
    )
    op.add_column(
        "payments",
        sa.Column(
            "refund_status",
            sa.String(32),
            nullable=False,
            server_default="not_requested",
        ),
    )
    op.add_column("payments", sa.Column("refunded_units", sa.BigInteger, nullable=True))
    op.add_column("payments", sa.Column("refunded_at", sa.DateTime, nullable=True))
    op.execute(
        "UPDATE payments SET fulfillment_status='succeeded' "
        "WHERE LOWER(CAST(status AS CHAR))='paid'"
    )
    op.drop_index("ix_payments_alipay_trade_no", table_name="payments")
    op.create_index(
        "ix_payments_alipay_trade_no",
        "payments",
        ["alipay_trade_no"],
        unique=True,
    )

    op.create_table(
        "credit_wallets",
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("available_units", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("reserved_units", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("active_requests", sa.Integer, nullable=False, server_default="0"),
        sa.Column("version", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.CheckConstraint("available_units >= 0", name="ck_credit_wallet_available_nonnegative"),
        sa.CheckConstraint("reserved_units >= 0", name="ck_credit_wallet_reserved_nonnegative"),
        sa.CheckConstraint("active_requests >= 0", name="ck_credit_wallet_active_nonnegative"),
        mysql_engine="InnoDB",
    )
    op.execute(
        "INSERT INTO credit_wallets "
        "(user_id, available_units, reserved_units, active_requests, version) "
        "SELECT id, 0, 0, 0, 0 FROM users"
    )

    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("delta_units", sa.BigInteger, nullable=False),
        sa.Column(
            "event_type",
            sa.Enum("TOPUP", "USAGE", "REFUND", "ADJUSTMENT", name="crediteventtype"),
            nullable=False,
        ),
        sa.Column("reference_id", sa.String(128), nullable=False),
        sa.Column("balance_after", sa.BigInteger, nullable=False),
        sa.Column("metadata_json", sa.JSON, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("event_type", "reference_id"),
        mysql_engine="InnoDB",
    )
    op.create_index("ix_credit_ledger_user_id", "credit_ledger", ["user_id"])

    op.create_table(
        "credit_products",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("credit_units", sa.BigInteger, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.CheckConstraint("price > 0", name="ck_credit_product_price_positive"),
        sa.CheckConstraint("credit_units > 0", name="ck_credit_product_units_positive"),
        mysql_engine="InnoDB",
    )

    op.create_table(
        "model_prices",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("input_rate", sa.BigInteger, nullable=False),
        sa.Column("cached_input_rate", sa.BigInteger, nullable=False),
        sa.Column("output_rate", sa.BigInteger, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("effective_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("model", "version"),
        sa.CheckConstraint("input_rate >= 0", name="ck_model_price_input_nonnegative"),
        sa.CheckConstraint(
            "cached_input_rate >= 0", name="ck_model_price_cached_input_nonnegative"
        ),
        sa.CheckConstraint("output_rate >= 0", name="ck_model_price_output_nonnegative"),
        mysql_engine="InnoDB",
    )
    op.create_index("ix_model_prices_model", "model_prices", ["model"])

    op.create_table(
        "model_requests",
        sa.Column("request_id", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "RESERVED",
                "RUNNING",
                "SETTLED",
                "RELEASED",
                "UNCERTAIN",
                name="modelrequeststatus",
            ),
            nullable=False,
            server_default="RESERVED",
        ),
        sa.Column("reserved_units", sa.BigInteger, nullable=False),
        sa.Column("actual_units", sa.BigInteger, nullable=True),
        sa.Column("prompt_tokens", sa.BigInteger, nullable=True),
        sa.Column("completion_tokens", sa.BigInteger, nullable=True),
        sa.Column("cached_tokens", sa.BigInteger, nullable=True),
        sa.Column("price_version", sa.Integer, nullable=False),
        sa.Column("upstream_request_id", sa.String(128), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("settled_at", sa.DateTime, nullable=True),
        sa.CheckConstraint("reserved_units > 0", name="ck_model_request_reserved_positive"),
        sa.CheckConstraint(
            "actual_units IS NULL OR actual_units >= 0",
            name="ck_model_request_actual_nonnegative",
        ),
        mysql_engine="InnoDB",
    )
    op.create_index("ix_model_requests_user_id", "model_requests", ["user_id"])
    op.create_index(
        "ix_model_requests_status_created_at",
        "model_requests",
        ["status", "created_at"],
    )

    op.create_table(
        "model_gateway_locks",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("active_requests", sa.Integer, nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.CheckConstraint(
            "active_requests >= 0", name="ck_model_gateway_active_nonnegative"
        ),
        mysql_engine="InnoDB",
    )
    op.execute("INSERT INTO model_gateway_locks (id) VALUES (1)")


def downgrade() -> None:
    op.drop_table("model_gateway_locks")
    op.drop_index("ix_model_requests_status_created_at", table_name="model_requests")
    op.drop_table("model_requests")
    op.drop_table("model_prices")
    op.drop_table("credit_products")
    op.drop_table("credit_ledger")
    op.drop_table("credit_wallets")

    op.drop_index("ix_payments_alipay_trade_no", table_name="payments")
    op.create_index(
        "ix_payments_alipay_trade_no",
        "payments",
        ["alipay_trade_no"],
        unique=False,
    )
    op.drop_column("payments", "fulfillment_status")
    op.drop_column("payments", "credit_units")
    op.drop_column("payments", "product_code")
    op.drop_column("payments", "product_type")
    op.drop_column("payments", "refunded_at")
    op.drop_column("payments", "refunded_units")
    op.drop_column("payments", "refund_status")

    op.alter_column(
        "subscription_renewals",
        "amount",
        existing_type=sa.Numeric(12, 2),
        type_=sa.Float(),
        existing_nullable=False,
    )
    op.alter_column(
        "pricing_plans",
        "original_price",
        existing_type=sa.Numeric(12, 2),
        type_=sa.Numeric(10, 2),
        existing_nullable=True,
    )
    op.alter_column(
        "pricing_plans",
        "price",
        existing_type=sa.Numeric(12, 2),
        type_=sa.Numeric(10, 2),
        existing_nullable=False,
    )
    op.alter_column(
        "payments",
        "amount",
        existing_type=sa.Numeric(12, 2),
        type_=sa.Float(),
        existing_nullable=False,
    )
