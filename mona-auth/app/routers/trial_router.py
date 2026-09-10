from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import Device, Subscription, SubscriptionStatus, User
from app.schemas import LicenseCheckResponse

router = APIRouter(prefix="/license", tags=["license"])

MAX_TRIAL_DEVICE_CHANGES = 1


class BindDeviceRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=64)


def _has_active_subscription(user: User, db: Session) -> tuple[bool, datetime | None]:
    now = datetime.now(timezone.utc)
    sub = (
        db.query(Subscription)
        .filter(
            Subscription.user_id == user.id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        )
        .first()
    )
    if not sub:
        return False, None
    # Active subscription with no expiry — treat as unlimited (admin-manual)
    if sub.current_period_end is None:
        return True, None
    end = sub.current_period_end
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if end > now:
        return True, end
    return False, None


def _bind_paid_device(user: User, device_fingerprint: str, db: Session) -> str | None:
    if not device_fingerprint:
        return None
    existing = db.query(Device).filter(Device.device_fingerprint == device_fingerprint).first()
    if existing is not None:
        if existing.user_id != user.id:
            return "device_bound_other"
        existing.last_verified = datetime.now(timezone.utc)
    else:
        count = db.query(Device).filter(Device.user_id == user.id).count()
        if count >= settings.max_devices_per_user:
            return "device_limit_exceeded"
        db.add(
            Device(
                user_id=user.id,
                device_fingerprint=device_fingerprint,
                last_verified=datetime.now(timezone.utc),
            )
        )
    user.bound_device_fingerprint = device_fingerprint
    db.commit()
    return None


@router.get("/check", response_model=LicenseCheckResponse)
def check_license_status(
    device_fingerprint: str = "",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)

    # Check active subscription first. Paid users may use up to the configured
    # number of active devices and can manage them through the device list.
    has_sub, sub_end = _has_active_subscription(user, db)
    if has_sub:
        bind_error = _bind_paid_device(user, device_fingerprint, db)
        if bind_error is not None:
            return LicenseCheckResponse(
                status="device_mismatch",
                expires_at=sub_end.strftime("%Y-%m-%d") if sub_end else None,
                trial=False,
                email=user.email,
                account=user.account,
            )

        return LicenseCheckResponse(
            status="valid",
            expires_at=sub_end.strftime("%Y-%m-%d") if sub_end else None,
            trial=False,
            email=user.email,
            account=user.account,
        )

    # Check device binding for trial users
    if device_fingerprint and user.bound_device_fingerprint:
        if user.bound_device_fingerprint != device_fingerprint:
            return LicenseCheckResponse(
                status="device_mismatch",
                expires_at=None,
                trial=True,
                email=user.email,
                account=user.account,
            )

    # Check trial
    if user.trial_expires_at:
        trial_end = user.trial_expires_at
        if trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=timezone.utc)
        if trial_end > now:
            # Auto-bind device on first check if not bound
            if device_fingerprint and not user.bound_device_fingerprint:
                user.bound_device_fingerprint = device_fingerprint
                db.commit()

            return LicenseCheckResponse(
                status="valid",
                expires_at=trial_end.strftime("%Y-%m-%d"),
                trial=True,
                email=user.email,
                account=user.account,
            )
        return LicenseCheckResponse(
            status="expired",
            expires_at=trial_end.strftime("%Y-%m-%d"),
            trial=True,
            email=user.email,
            account=user.account,
        )

    return LicenseCheckResponse(
        status="missing",
        expires_at=None,
        trial=False,
        email=user.email,
        account=user.account,
    )


@router.post("/bind-device")
def bind_device(
    body: BindDeviceRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fp = body.device_fingerprint

    has_sub, _ = _has_active_subscription(user, db)
    if has_sub:
        bind_error = _bind_paid_device(user, fp, db)
        if bind_error is not None:
            raise AuthError(
                bind_error,
                "Device is bound to another account"
                if bind_error == "device_bound_other"
                else f"Maximum {settings.max_devices_per_user} devices allowed",
                status_code=403,
            )
        return {"success": True, "message": "Device bound"}

    # Already bound to this device
    if user.bound_device_fingerprint == fp:
        return {"success": True, "message": "Device already bound"}

    # Trial users: check change limit
    if user.trial_device_changes >= MAX_TRIAL_DEVICE_CHANGES:
        raise AuthError(
            "device_change_limit",
            f"Trial accounts can change device at most {MAX_TRIAL_DEVICE_CHANGES} time(s)",
            status_code=403,
        )

    user.bound_device_fingerprint = fp
    user.trial_device_changes += 1
    db.commit()

    remaining = MAX_TRIAL_DEVICE_CHANGES - user.trial_device_changes
    return {
        "success": True,
        "message": "Device bound",
        "remaining_changes": remaining,
    }
