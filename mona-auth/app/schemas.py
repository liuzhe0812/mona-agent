from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, model_validator


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


class ModelAccessTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class MediaGenerationRequest(BaseModel):
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")
    prompt: str = Field(min_length=1, max_length=8000)
    input_image_urls: list[str] = Field(default_factory=list, max_length=3)
    size: str | None = Field(default=None, pattern=r"^\d{3,4}\*\d{3,4}$")
    n: int = Field(default=1, ge=1, le=6)
    resolution: Literal["480P", "720P", "1080P"] | None = None
    aspect_ratio: Literal["16:9", "9:16", "1:1", "4:3", "3:4"] | None = None
    duration: int = Field(default=5, ge=1, le=30)
    negative_prompt: str | None = Field(default=None, max_length=500)
    watermark: bool = False

    @model_validator(mode="after")
    def validate_image_size(self):
        if self.size is None:
            return self
        width, height = (int(value) for value in self.size.split("*", 1))
        pixels = width * height
        if not (512 <= width <= 2048 and 512 <= height <= 2048):
            raise ValueError("Image width and height must be between 512 and 2048")
        if not (512 * 512 <= pixels <= 2048 * 2048):
            raise ValueError("Image pixel area is outside the supported range")
        return self


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


class WorkerJobCreateRequest(BaseModel):
    job_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    kind: str = Field(min_length=2, max_length=64, pattern=r"^[a-z][a-z0-9_-]+$")
    attachment_ids: list[str] = Field(default_factory=list, max_length=16)
    options: dict[str, Any] = Field(default_factory=dict)
    priority: int = Field(default=0, ge=0, le=100)


class WorkerJobHeartbeatRequest(BaseModel):
    job_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    lease_token: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")
    progress: int = Field(default=0, ge=0, le=99)


class WorkerJobCompleteRequest(BaseModel):
    job_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    lease_token: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")
    result: dict[str, Any] = Field(default_factory=dict)


class WorkerJobFailRequest(BaseModel):
    job_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    lease_token: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")
    error_code: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_.:-]*$")


class WorkerAttachmentInfo(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    sha256: str
    status: str
    created_at: datetime


class WorkerJobInfo(BaseModel):
    id: str
    kind: str
    status: str
    priority: int
    progress: int
    payload: dict[str, Any]
    result: dict[str, Any] | None = None
    error_code: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class WorkerJobListResponse(BaseModel):
    jobs: list[WorkerJobInfo]


class WorkerClaimedJobInfo(WorkerJobInfo):
    lease_expires_at: datetime
    lease_token: str


class WorkerClaimResponse(BaseModel):
    job: WorkerClaimedJobInfo | None = None


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
    available_balance: str = "0"
    reserved_balance: str = "0"
    active_requests: int = 0
    wallet_updated_at: datetime | None = None

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


class RechargeProPromotionInfo(BaseModel):
    enabled: bool
    active: bool
    min_amount: Decimal
    gift_days: int
    start_at: datetime | None = None
    end_at: datetime | None = None
    description: str


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


class CreditProductInfo(BaseModel):
    code: str
    name: str
    price: Decimal
    balance_units: int
    balance_amount: str
    credit_units: int
    credits: str

    model_config = {"from_attributes": True}


class CustomRechargeInfo(BaseModel):
    enabled: bool
    min_amount: Decimal
    max_amount: Decimal


class CreditProductListResponse(BaseModel):
    recharge_enabled: bool
    custom_recharge: CustomRechargeInfo
    promotion: RechargeProPromotionInfo | None = None
    products: list[CreditProductInfo]


class CreditBalanceResponse(BaseModel):
    available_units: int
    reserved_units: int
    available_amount: str
    reserved_amount: str
    available_credits: str
    reserved_credits: str
    updated_at: datetime


class CreditLedgerInfo(BaseModel):
    id: int
    delta_units: int
    event_type: str
    reference_id: str
    balance_after: int
    delta_amount: str
    balance_after_amount: str
    delta_credits: str
    balance_after_credits: str
    metadata: dict | None = None
    created_at: datetime


class CreditLedgerListResponse(BaseModel):
    entries: list[CreditLedgerInfo]


class CreditOrderRequest(BaseModel):
    product_code: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    custom_amount: Decimal | None = Field(
        default=None,
        gt=0,
        decimal_places=2,
        max_digits=12,
    )
    idempotency_key: str = Field(
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )

    @model_validator(mode="after")
    def validate_purchase_target(self):
        if (self.product_code is None) == (self.custom_amount is None):
            raise ValueError("Provide exactly one recharge product or custom amount")
        return self


class CreditOrderResponse(BaseModel):
    order_id: int
    trade_order_id: str
    payment_url: str
    expires_at: datetime


class CreditOrderStatusResponse(BaseModel):
    order_id: int
    status: str
    fulfillment_status: str
    balance_units: int
    balance_amount: str
    credit_units: int
    bonus_pro_days: int = 0
    bonus_pro_revoked: bool = False


class CreditOrderHistoryItem(BaseModel):
    order_id: int
    trade_order_id: str
    product_code: str | None
    amount: Decimal
    status: str
    fulfillment_status: str
    balance_units: int
    balance_amount: str
    credit_units: int
    credits: str
    bonus_pro_days: int = 0
    bonus_pro_revoked: bool = False
    payment_url: str | None
    created_at: datetime
    paid_at: datetime | None


class CreditOrderHistoryResponse(BaseModel):
    orders: list[CreditOrderHistoryItem]
    has_more: bool


class CreditUsageDailyPoint(BaseModel):
    date: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    spent_units: int
    spent_amount: str
    spent_credits: str


class CreditUsageModelItem(BaseModel):
    model: str
    billing_type: str = "token"
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    total_tokens: int
    spent_units: int
    spent_amount: str
    spent_credits: str
    request_count: int


class CreditUsageRecentItem(BaseModel):
    request_id: str
    model: str
    billing_type: str = "token"
    status: str
    prompt_tokens: int | None
    completion_tokens: int | None
    cached_tokens: int | None
    total_tokens: int | None
    spent_amount: str | None
    reserved_amount: str
    spent_credits: str | None
    reserved_credits: str
    created_at: datetime
    settled_at: datetime | None
    usage: dict | None = None
    result: dict | None = None


class CreditUsageResponse(BaseModel):
    period_days: int
    today_tokens: int
    period_tokens: int
    period_spent_units: int
    period_spent_amount: str
    period_spent_credits: str
    settled_request_count: int
    model_count: int
    pending_request_count: int
    pending_reserved_amount: str
    pending_reserved_credits: str
    daily: list[CreditUsageDailyPoint]
    by_model: list[CreditUsageModelItem]
    recent: list[CreditUsageRecentItem]
    updated_at: datetime


class AdminCreditProductRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    price: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    credit_units: int | None = Field(default=None, gt=0, le=1_000_000_000_000_000)
    enabled: bool = False
    sort_order: int = 0


class AdminCustomRechargeSettingsRequest(BaseModel):
    enabled: bool
    min_amount: Decimal = Field(ge=Decimal("0.01"), decimal_places=2, max_digits=12)
    max_amount: Decimal = Field(ge=Decimal("0.01"), decimal_places=2, max_digits=12)

    @model_validator(mode="after")
    def validate_amount_range(self):
        if self.max_amount < self.min_amount:
            raise ValueError("Maximum amount must not be less than minimum amount")
        return self


class AdminRechargeProPromotionRequest(BaseModel):
    enabled: bool
    min_amount: Decimal = Field(ge=Decimal("0.01"), decimal_places=2, max_digits=12)
    gift_days: int = Field(ge=1, le=365)
    start_at: datetime | None = None
    end_at: datetime | None = None

    @model_validator(mode="after")
    def validate_window(self):
        if self.start_at and self.end_at and self.end_at <= self.start_at:
            raise ValueError("Promotion end time must be after start time")
        return self


class AdminModelPriceRequest(BaseModel):
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")
    input_rate: int = Field(ge=0, le=1_000_000_000_000_000)
    cached_input_rate: int = Field(ge=0, le=1_000_000_000_000_000)
    output_rate: int = Field(ge=0, le=1_000_000_000_000_000)
    billing_type: Literal["token", "image", "video"] = "token"
    rates: dict[str, int] = Field(default_factory=dict)
    enabled: bool = False

    @model_validator(mode="after")
    def validate_media_rates(self):
        if self.billing_type == "token":
            return self
        allowed = {
            "image": {
                "qima_input_1k",
                "qima_input_2k",
                "qima_output_1k",
                "qima_output_2k",
            },
            "video": {
                "video_ratio_480p",
                "video_ratio_720p",
                "video_ratio_1080p",
            },
        }[self.billing_type]
        if not self.rates or not set(self.rates).issubset(allowed):
            raise ValueError("Provide supported media billing rates")
        if any(
            isinstance(value, bool) or value <= 0 or value > 1_000_000_000_000_000
            for value in self.rates.values()
        ):
            raise ValueError("Media billing rates must be positive integer units")
        return self


class AdminModelPromotionRequest(BaseModel):
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")
    discount_percent: int = Field(ge=1, le=99)
    start_at: datetime
    end_at: datetime
    enabled: bool = True

    @model_validator(mode="after")
    def validate_window(self):
        if self.start_at.tzinfo is None or self.end_at.tzinfo is None:
            raise ValueError("Promotion times must include a timezone")
        if self.end_at <= self.start_at:
            raise ValueError("Promotion end must be after start")
        return self


class AdminCreditAdjustmentRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    delta_units: int = Field(ge=-1_000_000_000_000_000, le=1_000_000_000_000_000)
    reason: str = Field(min_length=3, max_length=255)


class AdminModelRequestResolution(BaseModel):
    action: Literal["release", "settle"]
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    cached_tokens: int | None = Field(default=None, ge=0)
    actual_units: int | None = Field(default=None, ge=0, le=1_000_000_000_000_000)
    usage: dict | None = None
    reason: str = Field(min_length=3, max_length=255)


class AdminCreditRefundRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


class AdminBillingFeatureFlagsRequest(BaseModel):
    balance_recharge_enabled: bool
    managed_model_enabled: bool


class AdminGatewayChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    channel_type: Literal[8, 17, 36, 44]
    api_key: str | None = Field(default=None, min_length=8, max_length=8192)
    base_url: str = Field(default="", max_length=512)
    models: str = Field(min_length=1, max_length=2048)
    group: str = Field(default="default", min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    priority: int = Field(default=0, ge=-1_000_000, le=1_000_000)
    enabled: bool = False


class AdminGatewayModelDiscoveryRequest(BaseModel):
    channel_id: int | None = Field(default=None, gt=0)
    channel_type: Literal[8, 17, 36, 44]
    api_key: str | None = Field(default=None, min_length=8, max_length=8192)
    base_url: str = Field(default="", max_length=512)


