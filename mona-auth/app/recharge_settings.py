from decimal import Decimal

from sqlalchemy.orm import Session

from app.models import AppConfig

CUSTOM_RECHARGE_ENABLED_KEY = "custom_recharge_enabled"
CUSTOM_RECHARGE_MIN_KEY = "custom_recharge_min_amount"
CUSTOM_RECHARGE_MAX_KEY = "custom_recharge_max_amount"
DEFAULT_CUSTOM_RECHARGE_MIN = Decimal("1.00")
DEFAULT_CUSTOM_RECHARGE_MAX = Decimal("5000.00")


def custom_recharge_settings(db: Session) -> dict[str, bool | Decimal]:
    enabled = db.get(AppConfig, CUSTOM_RECHARGE_ENABLED_KEY)
    minimum = db.get(AppConfig, CUSTOM_RECHARGE_MIN_KEY)
    maximum = db.get(AppConfig, CUSTOM_RECHARGE_MAX_KEY)
    return {
        "enabled": enabled is None or enabled.value == "true",
        "min_amount": (
            Decimal(minimum.value) if minimum else DEFAULT_CUSTOM_RECHARGE_MIN
        ),
        "max_amount": (
            Decimal(maximum.value) if maximum else DEFAULT_CUSTOM_RECHARGE_MAX
        ),
    }


def set_custom_recharge_settings(
    db: Session,
    *,
    enabled: bool,
    min_amount: Decimal,
    max_amount: Decimal,
) -> None:
    values = {
        CUSTOM_RECHARGE_ENABLED_KEY: "true" if enabled else "false",
        CUSTOM_RECHARGE_MIN_KEY: format(min_amount, ".2f"),
        CUSTOM_RECHARGE_MAX_KEY: format(max_amount, ".2f"),
    }
    for key, value in values.items():
        row = db.get(AppConfig, key)
        if row is None:
            row = AppConfig(key=key)
            db.add(row)
        row.value = value
