from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    code: str = Field(min_length=6, max_length=6)
    account: str = Field(min_length=2, max_length=32, pattern=r"^[\u4e00-\u9fa5a-zA-Z0-9_]+$")


class SendRegisterCodeRequest(BaseModel):
    email: EmailStr
    account: str = Field(min_length=2, max_length=32, pattern=r"^[\u4e00-\u9fa5a-zA-Z0-9_]+$")


class LoginRequest(BaseModel):
    account: str  # Can be account name or email
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


class ChangePasswordRequest(BaseModel):
    old_password: str
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
    account: str | None = None


class CreatePaymentRequest(BaseModel):
    duration_months: int = Field(default=1, ge=1, le=12)
    payment_type: str = Field(default="alipay", pattern=r"^(alipay|wechat)$")


class PaymentInfo(BaseModel):
    id: int
    trade_order_id: str
    amount: float
    duration_months: int | None = None
    plan_code: str | None = None
    status: str
    pay_url: str | None
    paid_at: datetime | None
    created_at: datetime
    payment_channel: str = "xhp"
    payment_type: str = "page"

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
    plan_code: str | None = None
    auto_renew: bool = False
    agreement_status: str | None = None
    cancelled_at: datetime | None = None

    model_config = {"from_attributes": True}


# ── 支付宝订阅相关 ──

class SubscribeRequest(BaseModel):
    plan_code: str = Field(..., pattern=r"^(monthly|quarterly|yearly)$")
    payment_method: str = Field(..., pattern=r"^(alipay_periodic|alipay_page)$")


class SubscribeResponse(BaseModel):
    order_id: int
    trade_order_id: str
    payment_url: str
    payment_method: str
    qr_code: str | None = None  # 当面付二维码内容
    expires_at: datetime


class OrderStatusResponse(BaseModel):
    order_id: int
    status: str  # pending / paid / failed
    subscription: SubscriptionInfo | None = None


class CancelAutoRenewRequest(BaseModel):
    reason: str | None = None


class CancelAutoRenewResponse(BaseModel):
    cancelled_at: datetime
    current_period_end: datetime | None
    message: str


class RenewalInfo(BaseModel):
    id: int
    out_trade_no: str
    amount: float
    period_days: int
    status: str
    paid_at: datetime | None
    failure_reason: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RenewalListResponse(BaseModel):
    renewals: list[RenewalInfo]


class AdminUserInfo(BaseModel):
    id: int
    email: str
    account: str | None = None
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


class AdminAccountUpdateRequest(BaseModel):
    account: str = Field(min_length=2, max_length=32, pattern=r"^[\u4e00-\u9fa5a-zA-Z0-9_]+$")


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None


class PricingPlanInfo(BaseModel):
    id: str
    name: str
    price: float
    duration_months: int | None = None
    period_days: int | None = None
    auto_renewable: bool = True
    original_price: float | None = None
    badge: str | None = None


class ContactConfig(BaseModel):
    email: str
    wechat: str


class PromoTrialInfo(BaseModel):
    enabled: bool
    days: int = 0
    end_at: str | None = None


class PricingConfigResponse(BaseModel):
    plans: list[PricingPlanInfo]
    contact: ContactConfig
    promotional_banner: str | None = None
    promo_trial: PromoTrialInfo | None = None


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
