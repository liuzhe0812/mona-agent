from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    code: str = Field(min_length=6, max_length=6)


class SendRegisterCodeRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8, max_length=128)


class DeviceBindRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)
    device_name: str | None = Field(default=None, max_length=255)


class DeviceUnbindRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)


class DeviceInfo(BaseModel):
    id: int
    device_fingerprint: str
    device_name: str | None
    last_verified: datetime | None
    bound_at: datetime

    model_config = {"from_attributes": True}


class DeviceListResponse(BaseModel):
    devices: list[DeviceInfo]


class LicenseResponse(BaseModel):
    license_jwt: str
    expires_at: datetime


class LicenseRefreshRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)


class LicenseCheckResponse(BaseModel):
    status: str
    expires_at: str | None = None
    trial: bool = False
    email: str | None = None


class CreatePaymentRequest(BaseModel):
    duration_months: int = Field(default=1, ge=1, le=12)
    payment_type: str = Field(default="alipay", pattern=r"^(alipay|wechat)$")


class PaymentInfo(BaseModel):
    id: int
    trade_order_id: str
    amount: float
    duration_months: int
    status: str
    pay_url: str | None
    paid_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class CreatePaymentResponse(BaseModel):
    trade_order_id: str
    pay_url: str
    amount: float


class PaymentListResponse(BaseModel):
    payments: list[PaymentInfo]


class SubscriptionInfo(BaseModel):
    status: str
    current_period_end: datetime | None

    model_config = {"from_attributes": True}


class AdminUserInfo(BaseModel):
    id: int
    email: str
    is_admin: bool
    trial_started_at: datetime | None
    trial_expires_at: datetime | None
    created_at: datetime
    subscription_status: str | None = None
    subscription_end: datetime | None = None

    model_config = {"from_attributes": True}


class AdminUserListResponse(BaseModel):
    users: list[AdminUserInfo]
    total: int


class AdminTrialUpdateRequest(BaseModel):
    trial_expires_at: datetime


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None


class PricingPlanInfo(BaseModel):
    id: str
    name: str
    price: float
    duration_months: int
    original_price: float | None = None
    badge: str | None = None


class ContactConfig(BaseModel):
    email: str
    wechat: str


class PricingConfigResponse(BaseModel):
    plans: list[PricingPlanInfo]
    contact: ContactConfig
    promotional_banner: str | None = None


class NotificationInfo(BaseModel):
    id: int
    title: str
    body: str
    type: str
    action_url: str | None = None
    image_url: str | None = None
    read: bool = False
    published_at: datetime | None = None
    expires_at: datetime | None = None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationInfo]


class UnreadCountResponse(BaseModel):
    unread_count: int
