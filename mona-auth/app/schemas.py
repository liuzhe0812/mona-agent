from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


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


class TrialActivateRequest(BaseModel):
    machine_fingerprint: str = Field(min_length=8, max_length=64)


class TrialActivateResponse(BaseModel):
    active: bool
    expires_at: datetime | None = None


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
