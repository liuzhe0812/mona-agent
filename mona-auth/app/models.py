import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

SQLITE_BIGINT_PK = BigInteger().with_variant(Integer, "sqlite")


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "active"
    EXPIRED = "expired"


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    FAILED = "failed"


class AgreementStatus(str, enum.Enum):
    ACTIVE = "active"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class RenewalStatus(str, enum.Enum):
    PENDING = "pending"
    SUCCESS = "success"
    FAILED = "failed"
    RETRYING = "retrying"


class CreditEventType(str, enum.Enum):
    TOPUP = "topup"
    USAGE = "usage"
    REFUND = "refund"
    ADJUSTMENT = "adjustment"


class ModelRequestStatus(str, enum.Enum):
    RESERVED = "reserved"
    RUNNING = "running"
    SETTLED = "settled"
    RELEASED = "released"
    UNCERTAIN = "uncertain"


class WorkerJobStatus(str, enum.Enum):
    QUEUED = "queued"
    LEASED = "leased"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WorkerAttachmentStatus(str, enum.Enum):
    READY = "ready"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    account: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(default=False)
    trial_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    trial_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bound_device_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    trial_device_changes: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    subscriptions: Mapped[list["Subscription"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    devices: Mapped[list["Device"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    payments: Mapped[list["Payment"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    agreements: Mapped[list["PaymentAgreement"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), nullable=False, default=SubscriptionStatus.EXPIRED
    )
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 支付宝订阅扩展字段
    plan_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    auto_renew: Mapped[bool] = mapped_column(default=False)
    agreement_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("payment_agreements.id", ondelete="SET NULL"), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="subscriptions")
    agreement: Mapped["PaymentAgreement | None"] = relationship()
    renewals: Mapped[list["SubscriptionRenewal"]] = relationship(
        back_populates="subscription", cascade="all, delete-orphan"
    )


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("device_fingerprint"),)

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_fingerprint: Mapped[str] = mapped_column(String(255), nullable=False)
    device_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    license_jti: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_verified: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bound_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="devices")


class PasswordResetCode(Base):
    __tablename__ = "password_reset_codes"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class UsedDeviceTrial(Base):
    __tablename__ = "used_device_trials"
    __table_args__ = (UniqueConstraint("device_fingerprint"),)

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    device_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    trade_order_id: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, index=True
    )
    xhp_order_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    duration_months: Mapped[int | None] = mapped_column(nullable=True)
    plan_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[PaymentStatus] = mapped_column(
        Enum(PaymentStatus), nullable=False, default=PaymentStatus.PENDING
    )
    pay_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # 支付宝扩展字段
    payment_channel: Mapped[str] = mapped_column(String(16), default="xhp")  # alipay / xhp
    payment_type: Mapped[str] = mapped_column(
        String(32), default="page"
    )  # page / periodic_sign / periodic_deduct
    alipay_trade_no: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True, index=True
    )
    agreement_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    external_sign_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    product_type: Mapped[str] = mapped_column(String(32), default="subscription")
    product_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    credit_units: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    fulfillment_status: Mapped[str] = mapped_column(String(32), default="not_started")
    refund_status: Mapped[str] = mapped_column(String(32), default="not_requested")
    refunded_units: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bonus_pro_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bonus_pro_granted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bonus_pro_revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped["User"] = relationship(back_populates="payments")


class PaymentAgreement(Base):
    __tablename__ = "payment_agreements"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agreement_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    alipay_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[AgreementStatus] = mapped_column(
        Enum(AgreementStatus), nullable=False, default=AgreementStatus.ACTIVE
    )
    external_sign_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    signed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped["User"] = relationship(back_populates="agreements")


class SubscriptionRenewal(Base):
    __tablename__ = "subscription_renewals"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    subscription_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("subscriptions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agreement_no: Mapped[str] = mapped_column(String(64), nullable=False)
    out_trade_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    period_days: Mapped[int] = mapped_column(nullable=False)
    status: Mapped[RenewalStatus] = mapped_column(
        Enum(RenewalStatus), nullable=False, default=RenewalStatus.PENDING
    )
    retry_count: Mapped[int] = mapped_column(default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    subscription: Mapped["Subscription"] = relationship(back_populates="renewals")


class PricingPlan(Base):
    __tablename__ = "pricing_plans"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    original_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    duration_months: Mapped[int | None] = mapped_column(nullable=True)
    period_days: Mapped[int | None] = mapped_column(nullable=True)
    auto_renewable: Mapped[bool] = mapped_column(default=True)
    badge: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_order: Mapped[int] = mapped_column(default=0)
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class AppConfig(Base):
    __tablename__ = "app_config"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    body: Mapped[str] = mapped_column(String(512), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    action_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    published: Mapped[bool] = mapped_column(default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class NotificationRead(Base):
    __tablename__ = "notification_reads"
    __table_args__ = (UniqueConstraint("user_id", "notification_id"),)

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    notification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    read_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CreditWallet(Base):
    __tablename__ = "credit_wallets"
    __table_args__ = (
        CheckConstraint("available_units >= 0", name="ck_credit_wallet_available_nonnegative"),
        CheckConstraint("reserved_units >= 0", name="ck_credit_wallet_reserved_nonnegative"),
        CheckConstraint("active_requests >= 0", name="ck_credit_wallet_active_nonnegative"),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    available_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    reserved_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    active_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class CreditLedger(Base):
    __tablename__ = "credit_ledger"
    __table_args__ = (UniqueConstraint("event_type", "reference_id"),)

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    delta_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    event_type: Mapped[CreditEventType] = mapped_column(Enum(CreditEventType), nullable=False)
    reference_id: Mapped[str] = mapped_column(String(128), nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CreditProduct(Base):
    __tablename__ = "credit_products"
    __table_args__ = (
        CheckConstraint("price > 0", name="ck_credit_product_price_positive"),
        CheckConstraint("credit_units > 0", name="ck_credit_product_units_positive"),
    )

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    credit_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    enabled: Mapped[bool] = mapped_column(nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ModelPrice(Base):
    __tablename__ = "model_prices"
    __table_args__ = (
        UniqueConstraint("model", "version"),
        CheckConstraint("input_rate >= 0", name="ck_model_price_input_nonnegative"),
        CheckConstraint("cached_input_rate >= 0", name="ck_model_price_cached_input_nonnegative"),
        CheckConstraint("output_rate >= 0", name="ck_model_price_output_nonnegative"),
    )

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    input_rate: Mapped[int] = mapped_column(BigInteger, nullable=False)
    cached_input_rate: Mapped[int] = mapped_column(BigInteger, nullable=False)
    output_rate: Mapped[int] = mapped_column(BigInteger, nullable=False)
    billing_type: Mapped[str] = mapped_column(String(16), nullable=False, default="token")
    rates_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    enabled: Mapped[bool] = mapped_column(nullable=False, default=False)
    effective_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ModelPromotion(Base):
    __tablename__ = "model_promotions"
    __table_args__ = (
        UniqueConstraint("model", name="uq_model_promotions_model"),
        CheckConstraint(
            "price_multiplier_bps > 0 AND price_multiplier_bps < 10000",
            name="ck_model_promotion_multiplier_range",
        ),
        CheckConstraint("end_at > start_at", name="ck_model_promotion_time_range"),
        Index(
            "ix_model_promotions_model_window",
            "model",
            "enabled",
            "start_at",
            "end_at",
        ),
    )

    id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, primary_key=True, autoincrement=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    price_multiplier_bps: Mapped[int] = mapped_column(Integer, nullable=False)
    start_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
    )
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ModelRequest(Base):
    __tablename__ = "model_requests"
    __table_args__ = (
        Index("ix_model_requests_status_created_at", "status", "created_at"),
        CheckConstraint("reserved_units > 0", name="ck_model_request_reserved_positive"),
        CheckConstraint(
            "actual_units IS NULL OR actual_units >= 0",
            name="ck_model_request_actual_nonnegative",
        ),
        CheckConstraint(
            "price_multiplier_bps > 0 AND price_multiplier_bps <= 10000",
            name="ck_model_request_multiplier_range",
        ),
    )

    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[ModelRequestStatus] = mapped_column(
        Enum(ModelRequestStatus), nullable=False, default=ModelRequestStatus.RESERVED
    )
    reserved_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    actual_units: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cached_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    price_version: Mapped[int] = mapped_column(Integer, nullable=False)
    promotion_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("model_promotions.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    price_multiplier_bps: Mapped[int] = mapped_column(Integer, nullable=False, default=10_000)
    billing_type: Mapped[str] = mapped_column(String(16), nullable=False, default="token")
    request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    upstream_channel_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    upstream_request_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    usage_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    settled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ModelGatewayLock(Base):
    __tablename__ = "model_gateway_locks"
    __table_args__ = (
        CheckConstraint("active_requests >= 0", name="ck_model_gateway_active_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    active_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class WorkerAttachment(Base):
    __tablename__ = "worker_attachments"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[WorkerAttachmentStatus] = mapped_column(
        Enum(WorkerAttachmentStatus, values_callable=lambda enum: [member.value for member in enum]), nullable=False, default=WorkerAttachmentStatus.READY
    )
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class WorkerJob(Base):
    __tablename__ = "worker_jobs"
    __table_args__ = (
        Index("ix_worker_jobs_status_priority_created_at", "status", "priority", "created_at"),
        Index("ix_worker_jobs_user_created_at", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[WorkerJobStatus] = mapped_column(
        Enum(WorkerJobStatus, values_callable=lambda enum: [member.value for member in enum]), nullable=False, default=WorkerJobStatus.QUEUED
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

