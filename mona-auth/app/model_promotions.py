from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import ModelPromotion


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def storage_utc(value: datetime) -> datetime:
    return aware_utc(value).replace(tzinfo=None)


def promotion_is_active(promotion: ModelPromotion, *, now: datetime | None = None) -> bool:
    current = aware_utc(now or utc_now())
    return (
        promotion.enabled
        and aware_utc(promotion.start_at) <= current
        and current < aware_utc(promotion.end_at)
    )


def promotion_state(promotion: ModelPromotion, *, now: datetime | None = None) -> str:
    if not promotion.enabled:
        return "disabled"
    current = aware_utc(now or utc_now())
    if current < aware_utc(promotion.start_at):
        return "scheduled"
    if current >= aware_utc(promotion.end_at):
        return "ended"
    return "active"


def discount_percent(promotion: ModelPromotion) -> int:
    return (10_000 - promotion.price_multiplier_bps) // 100


def promotion_label(promotion: ModelPromotion) -> str:
    return f"↓{discount_percent(promotion)}%"


def promotion_payload(
    promotion: ModelPromotion,
    *,
    now: datetime | None = None,
) -> dict:
    state = promotion_state(promotion, now=now)
    return {
        "id": promotion.id,
        "model": promotion.model,
        "price_multiplier_bps": promotion.price_multiplier_bps,
        "discount_percent": discount_percent(promotion),
        "label": promotion_label(promotion),
        "start_at": aware_utc(promotion.start_at),
        "end_at": aware_utc(promotion.end_at),
        "enabled": promotion.enabled,
        "state": state,
        "active": state == "active",
        "created_at": aware_utc(promotion.created_at),
        "updated_at": aware_utc(promotion.updated_at),
        "disabled_at": aware_utc(promotion.disabled_at) if promotion.disabled_at else None,
    }


def active_model_promotion(
    db: Session,
    model: str,
    *,
    now: datetime | None = None,
) -> ModelPromotion | None:
    current = aware_utc(now or utc_now())
    rows = (
        db.query(ModelPromotion)
        .filter(ModelPromotion.model == model, ModelPromotion.enabled.is_(True))
        .order_by(ModelPromotion.created_at.desc(), ModelPromotion.id.desc())
        .all()
    )
    return next((row for row in rows if promotion_is_active(row, now=current)), None)


def active_model_promotions(
    db: Session,
    models: list[str] | set[str],
    *,
    now: datetime | None = None,
) -> dict[str, ModelPromotion]:
    if not models:
        return {}
    current = aware_utc(now or utc_now())
    rows = (
        db.query(ModelPromotion)
        .filter(ModelPromotion.model.in_(models), ModelPromotion.enabled.is_(True))
        .order_by(ModelPromotion.created_at.desc(), ModelPromotion.id.desc())
        .all()
    )
    active: dict[str, ModelPromotion] = {}
    for row in rows:
        if row.model not in active and promotion_is_active(row, now=current):
            active[row.model] = row
    return active
