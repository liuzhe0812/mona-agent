from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from app.models import AppConfig, Payment, Subscription, SubscriptionStatus
from app.schemas import AdminRechargeProPromotionRequest

DEFAULT_MIN_AMOUNT = Decimal("100.00")
DEFAULT_GIFT_DAYS = 30


@dataclass(frozen=True)
class RechargeProPromotion:
    enabled: bool
    min_amount: Decimal
    gift_days: int
    start_at: datetime | None
    end_at: datetime | None
    active: bool

    @property
    def description(self) -> str:
        amount = format(self.min_amount, ".2f").rstrip("0").rstrip(".")
        return f"活动期间单笔充值满 ¥{amount}，赠送 {self.gift_days} 天 Pro；每笔均可参与"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return _aware(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return None


def _config_values(db: Session) -> dict[str, str]:
    keys = {
        "recharge_pro_promo_enabled",
        "recharge_pro_promo_min_amount",
        "recharge_pro_promo_gift_days",
        "recharge_pro_promo_start_at",
        "recharge_pro_promo_end_at",
    }
    return {
        row.key: row.value or ""
        for row in db.query(AppConfig).filter(AppConfig.key.in_(keys)).all()
    }


def recharge_pro_promotion(
    db: Session,
    *,
    now: datetime | None = None,
) -> RechargeProPromotion:
    values = _config_values(db)
    try:
        min_amount = Decimal(values.get("recharge_pro_promo_min_amount") or DEFAULT_MIN_AMOUNT)
    except InvalidOperation:
        min_amount = DEFAULT_MIN_AMOUNT
    try:
        gift_days = int(values.get("recharge_pro_promo_gift_days") or DEFAULT_GIFT_DAYS)
    except ValueError:
        gift_days = DEFAULT_GIFT_DAYS
    if min_amount <= 0:
        min_amount = DEFAULT_MIN_AMOUNT
    if gift_days <= 0 or gift_days > 365:
        gift_days = DEFAULT_GIFT_DAYS
    enabled = values.get("recharge_pro_promo_enabled") == "true"
    start_at = _parse_datetime(values.get("recharge_pro_promo_start_at"))
    end_at = _parse_datetime(values.get("recharge_pro_promo_end_at"))
    current = _aware(now) or _utcnow()
    active = enabled and (start_at is None or current >= start_at) and (
        end_at is None or current < end_at
    )
    return RechargeProPromotion(
        enabled=enabled,
        min_amount=min_amount,
        gift_days=gift_days,
        start_at=start_at,
        end_at=end_at,
        active=active,
    )


def _set_value(db: Session, key: str, value: str) -> None:
    row = db.get(AppConfig, key)
    if row is None:
        db.add(AppConfig(key=key, value=value))
    else:
        row.value = value


def save_recharge_pro_promotion(
    db: Session,
    body: AdminRechargeProPromotionRequest,
) -> RechargeProPromotion:
    _set_value(db, "recharge_pro_promo_enabled", "true" if body.enabled else "false")
    _set_value(db, "recharge_pro_promo_min_amount", format(body.min_amount, ".2f"))
    _set_value(db, "recharge_pro_promo_gift_days", str(body.gift_days))
    _set_value(
        db,
        "recharge_pro_promo_start_at",
        _aware(body.start_at).isoformat() if body.start_at else "",
    )
    _set_value(
        db,
        "recharge_pro_promo_end_at",
        _aware(body.end_at).isoformat() if body.end_at else "",
    )
    db.flush()
    return recharge_pro_promotion(db)


def _subscription_for_update(db: Session, user_id: int) -> Subscription | None:
    rows = (
        db.query(Subscription)
        .filter(Subscription.user_id == user_id)
        .with_for_update()
        .all()
    )
    if not rows:
        return None
    return max(
        rows,
        key=lambda item: _aware(item.current_period_end) or datetime.min.replace(
            tzinfo=timezone.utc
        ),
    )


def grant_recharge_pro_bonus(
    db: Session,
    payment: Payment,
    *,
    now: datetime | None = None,
) -> int:
    if payment.bonus_pro_granted_at is not None:
        return payment.bonus_pro_days
    current = _aware(now) or _utcnow()
    promotion = recharge_pro_promotion(db, now=current)
    if (
        payment.product_type != "credit_topup"
        or not promotion.active
        or Decimal(payment.amount) < promotion.min_amount
    ):
        return 0
    subscription = _subscription_for_update(db, payment.user_id)
    if subscription is None:
        subscription = Subscription(
            user_id=payment.user_id,
            status=SubscriptionStatus.ACTIVE,
            auto_renew=False,
        )
        db.add(subscription)
        db.flush()
    current_end = _aware(subscription.current_period_end)
    base = current_end if current_end and current_end > current else current
    subscription.current_period_end = base + timedelta(days=promotion.gift_days)
    subscription.status = SubscriptionStatus.ACTIVE
    subscription.cancelled_at = None
    payment.bonus_pro_days = promotion.gift_days
    payment.bonus_pro_granted_at = current
    payment.bonus_pro_revoked_at = None
    return promotion.gift_days


def revoke_recharge_pro_bonus(
    db: Session,
    payment: Payment,
    *,
    now: datetime | None = None,
) -> int:
    if (
        payment.bonus_pro_days <= 0
        or payment.bonus_pro_granted_at is None
        or payment.bonus_pro_revoked_at is not None
    ):
        return 0
    current = _aware(now) or _utcnow()
    subscription = _subscription_for_update(db, payment.user_id)
    if subscription is not None:
        current_end = _aware(subscription.current_period_end) or current
        adjusted_end = current_end - timedelta(days=payment.bonus_pro_days)
        if adjusted_end <= current:
            subscription.current_period_end = current
            subscription.status = SubscriptionStatus.EXPIRED
        else:
            subscription.current_period_end = adjusted_end
    payment.bonus_pro_revoked_at = current
    return payment.bonus_pro_days
