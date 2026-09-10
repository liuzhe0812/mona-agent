"""add worker job queue and private attachments

Revision ID: worker_jobs
Revises: recharge_pro_promo
Create Date: 2026-09-08 18:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "worker_jobs"
down_revision: Union[str, None] = "recharge_pro_promo"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

worker_attachment_status = sa.Enum("ready", name="workerattachmentstatus")
worker_job_status = sa.Enum(
    "queued", "leased", "running", "completed", "failed", "cancelled", name="workerjobstatus"
)


def upgrade() -> None:
    op.create_table(
        "worker_attachments",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", worker_attachment_status, nullable=False),
        sa.Column("storage_path", sa.String(length=512), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_worker_attachments_user_id", "worker_attachments", ["user_id"])
    op.create_table(
        "worker_jobs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("status", worker_job_status, nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("worker_id", sa.String(length=128), nullable=True),
        sa.Column("lease_token", sa.String(length=128), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_worker_jobs_user_id", "worker_jobs", ["user_id"])
    op.create_index(
        "ix_worker_jobs_status_priority_created_at",
        "worker_jobs",
        ["status", "priority", "created_at"],
    )
    op.create_index("ix_worker_jobs_user_created_at", "worker_jobs", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_worker_jobs_user_created_at", table_name="worker_jobs")
    op.drop_index("ix_worker_jobs_status_priority_created_at", table_name="worker_jobs")
    op.drop_index("ix_worker_jobs_user_id", table_name="worker_jobs")
    op.drop_table("worker_jobs")
    op.drop_index("ix_worker_attachments_user_id", table_name="worker_attachments")
    op.drop_table("worker_attachments")
    worker_job_status.drop(op.get_bind(), checkfirst=True)
    worker_attachment_status.drop(op.get_bind(), checkfirst=True)
