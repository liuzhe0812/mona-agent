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


class CheckoutRequest(BaseModel):
    success_url: str
    cancel_url: str


class CheckoutResponse(BaseModel):
    checkout_url: str


class PortalRequest(BaseModel):
    return_url: str


class PortalResponse(BaseModel):
    portal_url: str


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
