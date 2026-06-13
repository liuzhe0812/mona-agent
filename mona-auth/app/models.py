import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "active"
    EXPIRED = "expired"


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    FAILED = "failed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
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


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), nullable=False, default=SubscriptionStatus.EXPIRED
    )
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="subscriptions")


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("device_fingerprint"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
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

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class UsedDeviceTrial(Base):
    __tablename__ = "used_device_trials"
    __table_args__ = (UniqueConstraint("device_fingerprint"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    trade_order_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    xhp_order_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[float] = mapped_column(nullable=False)
    duration_months: Mapped[int] = mapped_column(default=1)
    status: Mapped[PaymentStatus] = mapped_column(
        Enum(PaymentStatus), nullable=False, default=PaymentStatus.PENDING
    )
    pay_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="payments")


class PricingPlan(Base):
    __tablename__ = "pricing_plans"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    price: Mapped[float] = mapped_column(nullable=False)
    original_price: Mapped[float | None] = mapped_column(nullable=True)
    duration_months: Mapped[int] = mapped_column(nullable=False)
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

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
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

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    notification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    read_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
