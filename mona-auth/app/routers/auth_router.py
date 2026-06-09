import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth import create_access_token, hash_password, verify_password
from app.config import settings
from app.database import get_db
from app.email import send_register_code_email, send_reset_code_email
from app.errors import AuthError
from app.middleware import limiter
from app.models import PasswordResetCode, UsedDeviceTrial, User
from app.schemas import (
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SendRegisterCodeRequest,
    TokenResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/send-register-code")
@limiter.limit("3/minute")
def send_register_code(
    request: Request,
    body: SendRegisterCodeRequest,
    db: Session = Depends(get_db),
):
    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        # Don't reveal whether email is already registered
        return {"message": "If the email is available, a verification code has been sent"}

    code = f"{random.randint(0, 999999):06d}"
    now = datetime.now(timezone.utc)
    record = PasswordResetCode(
        email=body.email,
        code=code,
        expires_at=now + timedelta(minutes=settings.password_reset_code_expire_minutes),
    )
    db.add(record)
    db.commit()

    try:
        send_register_code_email(body.email, code)
    except Exception:
        raise AuthError("email_send_failed", "Failed to send email, please try later", status_code=500)

    return {"message": "If the email is available, a verification code has been sent"}


@router.post("/register", response_model=TokenResponse)
@limiter.limit("5/minute")
def register(
    request: Request,
    body: RegisterRequest,
    device_fingerprint: str = "",
    db: Session = Depends(get_db),
):
    # Verify email code
    now = datetime.now(timezone.utc)
    verify_code = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.email == body.email,
            PasswordResetCode.code == body.code,
            PasswordResetCode.used == False,  # noqa: E712
            PasswordResetCode.expires_at > now,
        )
        .order_by(PasswordResetCode.created_at.desc())
        .first()
    )
    if not verify_code:
        raise AuthError("invalid_code", "Invalid or expired verification code", status_code=400)

    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise AuthError("email_exists", "This email is already registered", status_code=409)

    # Mark code as used
    verify_code.used = True

    # Check if this device has already used a trial
    device_used_trial = False
    if device_fingerprint:
        existing_device = (
            db.query(UsedDeviceTrial)
            .filter(UsedDeviceTrial.device_fingerprint == device_fingerprint)
            .first()
        )
        if existing_device:
            device_used_trial = True

    now = datetime.now(timezone.utc)
    if device_used_trial:
        # Device already used trial — no trial period
        user = User(
            email=body.email,
            password_hash=hash_password(body.password),
            bound_device_fingerprint=device_fingerprint or None,
        )
    else:
        user = User(
            email=body.email,
            password_hash=hash_password(body.password),
            trial_started_at=now,
            trial_expires_at=now + timedelta(days=settings.trial_days),
            bound_device_fingerprint=device_fingerprint or None,
        )

    db.add(user)
    db.commit()
    db.refresh(user)

    # Record device trial usage
    if device_fingerprint and not device_used_trial:
        device_record = UsedDeviceTrial(
            device_fingerprint=device_fingerprint,
            user_id=user.id,
        )
        db.add(device_record)
        db.commit()

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(request: Request, body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise AuthError("invalid_credentials", "Invalid email or password", status_code=401)

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.post("/forgot-password")
@limiter.limit("3/minute")
def forgot_password(request: Request, body: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user:
        # Don't reveal whether email exists
        return {"message": "If the email exists, a verification code has been sent"}

    code = f"{random.randint(0, 999999):06d}"
    now = datetime.now(timezone.utc)
    reset = PasswordResetCode(
        email=body.email,
        code=code,
        expires_at=now + timedelta(minutes=settings.password_reset_code_expire_minutes),
    )
    db.add(reset)
    db.commit()

    try:
        send_reset_code_email(body.email, code)
    except Exception:
        raise AuthError("email_send_failed", "Failed to send email, please try later", status_code=500)

    return {"message": "If the email exists, a verification code has been sent"}


@router.post("/reset-password")
@limiter.limit("5/minute")
def reset_password(request: Request, body: ResetPasswordRequest, db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    reset_code = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.email == body.email,
            PasswordResetCode.code == body.code,
            PasswordResetCode.used == False,  # noqa: E712
            PasswordResetCode.expires_at > now,
        )
        .order_by(PasswordResetCode.created_at.desc())
        .first()
    )

    if not reset_code:
        raise AuthError("invalid_code", "Invalid or expired verification code", status_code=400)

    user = db.query(User).filter(User.email == body.email).first()
    if not user:
        raise AuthError("user_not_found", "User not found", status_code=404)

    reset_code.used = True
    user.password_hash = hash_password(body.new_password)
    db.commit()

    return {"message": "Password has been reset successfully"}
