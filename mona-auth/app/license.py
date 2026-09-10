import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import jwt

from app.config import settings


def issue_license(
    user_id: int,
    device_fingerprint: str,
    subscription_end: datetime | None = None,
) -> tuple[str, datetime]:
    now = datetime.now(timezone.utc)
    license_max_expiry = now + timedelta(days=settings.license_expire_days)

    if subscription_end and subscription_end > now:
        if subscription_end.tzinfo is None:
            subscription_end = subscription_end.replace(tzinfo=timezone.utc)
        exp = min(subscription_end, license_max_expiry)
    else:
        exp = license_max_expiry

    fp_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()
    jti = uuid.uuid4().hex

    payload = {
        "sub": f"user_id:{user_id}",
        "fp": fp_hash,
        "plan": "pro",
        "exp": exp,
        "iat": now,
        "jti": jti,
    }

    token = jwt.encode(payload, settings.license_private_key, algorithm="RS256")
    return token, exp


def verify_license(token: str, device_fingerprint: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.license_public_key, algorithms=["RS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

    fp_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()
    if payload.get("fp") != fp_hash:
        return None

    return payload
