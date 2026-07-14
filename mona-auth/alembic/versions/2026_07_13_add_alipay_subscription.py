"""add alipay subscription tables and fields

Revision ID: alipay_sub
Revises: add_user_account
Create Date: 2026-07-13 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "alipay_sub"
down_revision: Union[str, None] = "add_user_account"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. payment_agreements
    op.create_table(
        "payment_agreements",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("agreement_no", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("alipay_user_id", sa.String(64), nullable=True),
        sa.Column("status", sa.Enum("active", "cancelled", "expired", name="agreementstatus"), nullable=False, server_default="active"),
        sa.Column("external_sign_no", sa.String(64), nullable=False, unique=True),
        sa.Column("signed_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("cancelled_at", sa.DateTime, nullable=True),
        sa.Column("cancel_reason", sa.String(255), nullable=True),
    )

    # 2. subscription_renewals
    op.create_table(
        "subscription_renewals",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("subscription_id", sa.BigInteger, sa.ForeignKey("subscriptions.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("agreement_no", sa.String(64), nullable=False),
        sa.Column("out_trade_no", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("alipay_trade_no", sa.String(64), nullable=True, index=True),
        sa.Column("amount", sa.Float, nullable=False),
        sa.Column("period_days", sa.Integer, nullable=False),
        sa.Column("status", sa.Enum("pending", "success", "failed", "retrying", name="renewalstatus"), nullable=False, server_default="pending"),
        sa.Column("retry_count", sa.Integer, server_default="0"),
        sa.Column("next_retry_at", sa.DateTime, nullable=True, index=True),
        sa.Column("paid_at", sa.DateTime, nullable=True),
        sa.Column("failure_reason", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # 3. 扩展 subscriptions 表
    op.add_column("subscriptions", sa.Column("plan_code", sa.String(32), nullable=True))
    op.add_column("subscriptions", sa.Column("auto_renew", sa.Boolean, server_default="0", nullable=False))
    op.add_column("subscriptions", sa.Column("agreement_id", sa.BigInteger, sa.ForeignKey("payment_agreements.id", ondelete="SET NULL"), nullable=True))
    op.add_column("subscriptions", sa.Column("cancelled_at", sa.DateTime, nullable=True))

    # 4. 扩展 payments 表
    op.add_column("payments", sa.Column("payment_channel", sa.String(16), server_default="xhp", nullable=False))
    op.add_column("payments", sa.Column("payment_type", sa.String(32), server_default="page", nullable=False))
    op.add_column("payments", sa.Column("alipay_trade_no", sa.String(64), nullable=True, index=True))
    op.add_column("payments", sa.Column("agreement_no", sa.String(64), nullable=True))
    op.add_column("payments", sa.Column("external_sign_no", sa.String(64), nullable=True, index=True))
    op.add_column("payments", sa.Column("plan_code", sa.String(32), nullable=True))

    # 5. duration_months 改为可空（支持终身版）
    op.alter_column("payments", "duration_months", existing_type=sa.Integer, nullable=True)

    # 6. 扩展 pricing_plans 表
    op.add_column("pricing_plans", sa.Column("period_days", sa.Integer, nullable=True))
    op.add_column("pricing_plans", sa.Column("auto_renewable", sa.Boolean, server_default="1", nullable=False))
    op.alter_column("pricing_plans", "duration_months", existing_type=sa.Integer, nullable=True)

    # 7. 预置 lifetime 套餐
    op.execute(
        "INSERT INTO pricing_plans (id, name, price, original_price, duration_months, period_days, auto_renewable, badge, sort_order, enabled) "
        "VALUES ('lifetime', '终身版', 888.00, NULL, NULL, NULL, 0, '限时', 3, 1) "
        "ON DUPLICATE KEY UPDATE name=name"
    )
    # 为已有套餐补充 period_days
    op.execute("UPDATE pricing_plans SET period_days=30 WHERE id='monthly' AND period_days IS NULL")
    op.execute("UPDATE pricing_plans SET period_days=365 WHERE id='yearly' AND period_days IS NULL")


def downgrade() -> None:
    op.drop_column("pricing_plans", "auto_renewable")
    op.drop_column("pricing_plans", "period_days")
    op.alter_column("pricing_plans", "duration_months", existing_type=sa.Integer, nullable=False)

    op.alter_column("payments", "duration_months", existing_type=sa.Integer, nullable=False)
    op.drop_column("payments", "plan_code")
    op.drop_column("payments", "external_sign_no")
    op.drop_column("payments", "agreement_no")
    op.drop_column("payments", "alipay_trade_no")
    op.drop_column("payments", "payment_type")
    op.drop_column("payments", "payment_channel")

    op.drop_column("subscriptions", "cancelled_at")
    op.drop_column("subscriptions", "agreement_id")
    op.drop_column("subscriptions", "auto_renew")
    op.drop_column("subscriptions", "plan_code")

    op.drop_table("subscription_renewals")
    op.drop_table("payment_agreements")
