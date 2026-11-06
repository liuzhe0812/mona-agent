"""Add an independent Hosted Work charge journal.

Revision ID: hosted_billing_v1
Revises: wallet_overdraft
"""
import sqlalchemy as sa
from alembic import op

revision = "hosted_billing_v1"
down_revision = "wallet_overdraft"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "hosted_work_charges",
        sa.Column("run_id", sa.String(length=32), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reserved_units", sa.BigInteger(), nullable=False),
        sa.Column("actual_units", sa.BigInteger(), nullable=True),
        sa.Column("price_json", sa.JSON(), nullable=False),
        sa.Column("usage_json", sa.JSON(), nullable=True),
        sa.Column("review_reason", sa.String(length=40), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("settled_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint("reserved_units >= 0", name="ck_hosted_charge_reserved_nonnegative"),
        sa.CheckConstraint("actual_units IS NULL OR actual_units >= 0", name="ck_hosted_charge_actual_nonnegative"),
    )
    op.create_index("ix_hosted_charge_user_created", "hosted_work_charges", ["user_id", "created_at"])
    op.create_index("ix_hosted_charge_status_updated", "hosted_work_charges", ["status", "updated_at"])


def downgrade():
    raise RuntimeError("Hosted billing records cannot be dropped by an automatic downgrade")
