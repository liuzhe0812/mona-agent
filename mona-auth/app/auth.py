from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def create_access_token(user_id: int) -> tuple[str, int]:
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_access_expire_minutes)
    payload = {
        "sub": str(user_id),
        "scope": "account",
        "exp": expires,
        "iat": datetime.now(timezone.utc),
    }
    token = jwt.encode(payload, settings.jwt_access_secret, algorithm="HS256")
    return token, settings.jwt_access_expire_minutes


def create_model_access_token(user_id: int) -> tuple[str, int]:
    expires = datetime.now(timezone.utc) + timedelta(
        minutes=settings.model_access_token_expire_minutes
    )
    payload = {
        "sub": str(user_id),
        "scope": "model_access",
        "exp": expires,
        "iat": datetime.now(timezone.utc),
    }
    token = jwt.encode(payload, settings.jwt_access_secret, algorithm="HS256")
    return token, settings.model_access_token_expire_minutes


def decode_access_token(token: str, *, required_scope: str = "account") -> dict | None:
    try:
        payload = jwt.decode(token, settings.jwt_access_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
    scope = payload.get("scope")
    if required_scope == "account" and scope not in {None, "account"}:
        return None
    if required_scope != "account" and scope != required_scope:
        return None
    return payload
