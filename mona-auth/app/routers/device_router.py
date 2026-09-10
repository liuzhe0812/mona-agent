import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.license import issue_license, verify_license
from app.models import Device, Subscription, SubscriptionStatus, User
from app.schemas import (
    DeviceBindRequest,
    DeviceListResponse,
    DeviceUnbindRequest,
    LicenseRefreshRequest,
    LicenseResponse,
)

router = APIRouter(prefix="/auth/device", tags=["device"])


def _get_active_subscription(db: Session, user_id: int) -> Subscription | None:
    return (
        db.query(Subscription)
        .filter(
            Subscription.user_id == user_id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        )
        .first()
    )


@router.post("/bind", response_model=LicenseResponse)
def bind_device(
    body: DeviceBindRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = _get_active_subscription(db, user.id)
    if sub is None:
        raise AuthError("no_subscription", "Active subscription required to bind a device", status_code=403)

    existing_device = db.query(Device).filter(Device.device_fingerprint == body.device_fingerprint).first()
    if existing_device:
        if existing_device.user_id != user.id:
            raise AuthError(
                "device_bound_other", "This device is bound to another account", status_code=409
            )
        jti = uuid.uuid4().hex
        existing_device.license_jti = jti
        existing_device.device_name = body.device_name or existing_device.device_name
        existing_device.last_verified = datetime.now(timezone.utc)
        db.commit()
        license_jwt, exp = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
        return LicenseResponse(license_jwt=license_jwt, expires_at=exp)

    user_device_count = db.query(Device).filter(Device.user_id == user.id).count()
    if user_device_count >= settings.max_devices_per_user:
        raise AuthError(
            "device_limit",
            f"Maximum {settings.max_devices_per_user} devices allowed",
            status_code=403,
        )

    jti = uuid.uuid4().hex
    device = Device(
        user_id=user.id,
        device_fingerprint=body.device_fingerprint,
        device_name=body.device_name,
        license_jti=jti,
        last_verified=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()

    license_jwt, exp = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
    return LicenseResponse(license_jwt=license_jwt, expires_at=exp)


@router.post("/unbind")
def unbind_device(
    body: DeviceUnbindRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = (
        db.query(Device)
        .filter(Device.device_fingerprint == body.device_fingerprint, Device.user_id == user.id)
        .first()
    )
    if not device:
        raise AuthError("device_not_found", "Device not found in your account", status_code=404)
    db.delete(device)
    db.commit()
    return {"unbound": True}


@router.post("/refresh", response_model=LicenseResponse)
async def refresh_license(
    request: Request,
    body: LicenseRefreshRequest,
    db: Session = Depends(get_db),
):
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise AuthError("missing_token", "Authorization Bearer token required", status_code=401)
    license_jwt = auth_header[7:]

    payload = verify_license(license_jwt, body.device_fingerprint)
    if payload is None:
        raise AuthError("invalid_license", "License verification failed", status_code=401)

    sub_str = payload.get("sub", "")
    if not sub_str.startswith("user_id:"):
        raise AuthError("invalid_license", "Invalid license subject", status_code=401)
    user_id = int(sub_str.split(":")[1])

    subscription = _get_active_subscription(db, user_id)
    if subscription is None:
        raise AuthError("no_subscription", "Active subscription required", status_code=403)

    device = (
        db.query(Device)
        .filter(Device.device_fingerprint == body.device_fingerprint, Device.user_id == user_id)
        .first()
    )
    if not device:
        raise AuthError("device_not_bound", "Device is not bound to this account", status_code=404)

    device.last_verified = datetime.now(timezone.utc)
    device.license_jti = uuid.uuid4().hex
    db.commit()

    new_license_jwt, exp = issue_license(
        user_id, body.device_fingerprint, subscription.current_period_end
    )
    return LicenseResponse(license_jwt=new_license_jwt, expires_at=exp)


@router.get("/list", response_model=DeviceListResponse)
def list_devices(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    devices = db.query(Device).filter(Device.user_id == user.id).all()
    return DeviceListResponse(devices=devices)


@router.post("/bind-and-download")
def bind_and_download_license(
    body: DeviceBindRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = _get_active_subscription(db, user.id)
    if sub is None:
        raise AuthError("no_subscription", "Active subscription required to bind a device", status_code=403)

    existing_device = db.query(Device).filter(Device.device_fingerprint == body.device_fingerprint).first()
    if existing_device:
        if existing_device.user_id != user.id:
            raise AuthError(
                "device_bound_other", "This device is bound to another account", status_code=409
            )
        jti = uuid.uuid4().hex
        existing_device.license_jti = jti
        existing_device.device_name = body.device_name or existing_device.device_name
        existing_device.last_verified = datetime.now(timezone.utc)
        db.commit()
        license_jwt, _ = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
        return PlainTextResponse(
            content=license_jwt,
            media_type="text/plain",
            headers={"Content-Disposition": 'attachment; filename="mona-license.jwt"'},
        )

    user_device_count = db.query(Device).filter(Device.user_id == user.id).count()
    if user_device_count >= settings.max_devices_per_user:
        raise AuthError(
            "device_limit",
            f"Maximum {settings.max_devices_per_user} devices allowed",
            status_code=403,
        )

    jti = uuid.uuid4().hex
    device = Device(
        user_id=user.id,
        device_fingerprint=body.device_fingerprint,
        device_name=body.device_name,
        license_jti=jti,
        last_verified=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()

    license_jwt, _ = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
    return PlainTextResponse(
        content=license_jwt,
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="mona-license.jwt"'},
    )
