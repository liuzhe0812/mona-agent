from sqlalchemy.orm import Session

from app.config import settings
from app.models import AppConfig

BALANCE_RECHARGE_KEY = "balance_recharge_enabled"
MANAGED_MODEL_KEY = "managed_model_enabled"


def _admin_flag(db: Session, key: str, *, fallback: bool) -> bool:
    row = db.get(AppConfig, key)
    if row is None:
        return fallback
    return row.value == "true"


def balance_recharge_enabled(db: Session) -> bool:
    return settings.credits_payment_enabled and _admin_flag(
        db,
        BALANCE_RECHARGE_KEY,
        fallback=settings.credits_payment_enabled,
    )


def managed_model_enabled(db: Session) -> bool:
    return settings.model_access_enabled and _admin_flag(
        db,
        MANAGED_MODEL_KEY,
        fallback=settings.model_access_enabled,
    )


def feature_flag_snapshot(db: Session) -> dict[str, bool]:
    return {
        "balance_recharge_deployment_allowed": settings.credits_payment_enabled,
        "balance_recharge_admin_enabled": _admin_flag(
            db,
            BALANCE_RECHARGE_KEY,
            fallback=settings.credits_payment_enabled,
        ),
        "balance_recharge_enabled": balance_recharge_enabled(db),
        "managed_model_deployment_allowed": settings.model_access_enabled,
        "managed_model_admin_enabled": _admin_flag(
            db,
            MANAGED_MODEL_KEY,
            fallback=settings.model_access_enabled,
        ),
        "managed_model_enabled": managed_model_enabled(db),
    }


def set_admin_feature_flags(
    db: Session,
    *,
    balance_recharge: bool,
    managed_model: bool,
) -> None:
    for key, enabled in (
        (BALANCE_RECHARGE_KEY, balance_recharge),
        (MANAGED_MODEL_KEY, managed_model),
    ):
        row = db.get(AppConfig, key)
        if row is None:
            row = AppConfig(key=key)
            db.add(row)
        row.value = "true" if enabled else "false"
