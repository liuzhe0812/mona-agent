from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.auth import create_access_token
from app.credits import amount_to_units
from app.models import (
    AppConfig,
    CreditProduct,
    Payment,
    PaymentStatus,
    Subscription,
    SubscriptionStatus,
    User,
)
from app.recharge_promotion import (
    grant_recharge_pro_bonus,
    recharge_pro_promotion,
    revoke_recharge_pro_bonus,
)
from app.routers.subscribe_router import _fulfill_payment

UTC = timezone.utc


def _user(db, email: str = "promo@example.com") -> User:
    user = User(email=email, account=email.split("@")[0], password_hash="x")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _configure_promotion(
    db,
    *,
    enabled: bool = True,
    min_amount: str = "100.00",
    gift_days: int = 30,
    start_at: datetime | None = None,
    end_at: datetime | None = None,
) -> None:
    db.add_all(
        [
            AppConfig(key="recharge_pro_promo_enabled", value="true" if enabled else "false"),
            AppConfig(key="recharge_pro_promo_min_amount", value=min_amount),
            AppConfig(key="recharge_pro_promo_gift_days", value=str(gift_days)),
            AppConfig(
                key="recharge_pro_promo_start_at",
                value=start_at.isoformat() if start_at else "",
            ),
            AppConfig(
                key="recharge_pro_promo_end_at",
                value=end_at.isoformat() if end_at else "",
            ),
        ]
    )
    db.commit()


def _payment(db, user: User, *, amount: str, trade_order_id: str) -> Payment:
    payment = Payment(
        user_id=user.id,
        trade_order_id=trade_order_id,
        amount=Decimal(amount),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        product_code="custom_recharge",
        credit_units=amount_to_units(Decimal(amount)),
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    return payment


def _subscription(db, user_id: int) -> Subscription | None:
    return db.query(Subscription).filter(Subscription.user_id == user_id).first()


def test_disabled_or_outside_window_never_grants_bonus(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    user = _user(db)
    payment = _payment(db, user, amount="100.00", trade_order_id="promo-disabled")

    _configure_promotion(
        db,
        enabled=False,
        start_at=now - timedelta(days=1),
        end_at=now + timedelta(days=1),
    )
    assert recharge_pro_promotion(db, now=now).active is False
    assert grant_recharge_pro_bonus(db, payment, now=now) == 0
    assert _subscription(db, user.id) is None

    db.query(AppConfig).filter(AppConfig.key == "recharge_pro_promo_enabled").one().value = "true"
    db.query(AppConfig).filter(AppConfig.key == "recharge_pro_promo_start_at").one().value = (
        (now + timedelta(days=1)).isoformat()
    )
    db.commit()
    assert recharge_pro_promotion(db, now=now).active is False
    assert grant_recharge_pro_bonus(db, payment, now=now) == 0
    assert _subscription(db, user.id) is None

    db.query(AppConfig).filter(AppConfig.key == "recharge_pro_promo_start_at").one().value = (
        (now - timedelta(days=2)).isoformat()
    )
    db.query(AppConfig).filter(AppConfig.key == "recharge_pro_promo_end_at").one().value = (
        (now - timedelta(days=1)).isoformat()
    )
    db.commit()
    assert recharge_pro_promotion(db, now=now).active is False
    assert grant_recharge_pro_bonus(db, payment, now=now) == 0
    assert _subscription(db, user.id) is None


def test_payment_at_threshold_grants_fixed_days_and_activates_pro(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db)
    payment = _payment(db, user, amount="100.00", trade_order_id="promo-threshold")

    assert grant_recharge_pro_bonus(db, payment, now=now) == 30
    db.commit()

    subscription = _subscription(db, user.id)
    assert subscription is not None
    assert subscription.status == SubscriptionStatus.ACTIVE
    assert subscription.current_period_end == now.replace(tzinfo=None) + timedelta(days=30)
    assert payment.bonus_pro_days == 30
    assert payment.bonus_pro_granted_at == now.replace(tzinfo=None)


def test_amount_above_threshold_does_not_scale_bonus_days(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db, "promo-200@example.com")
    payment = _payment(db, user, amount="200.00", trade_order_id="promo-200")

    assert grant_recharge_pro_bonus(db, payment, now=now) == 30
    db.commit()

    subscription = _subscription(db, user.id)
    assert subscription is not None
    assert subscription.current_period_end == now.replace(tzinfo=None) + timedelta(days=30)


def test_amount_below_threshold_does_not_grant_bonus(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db, "promo-99@example.com")
    payment = _payment(db, user, amount="99.99", trade_order_id="promo-99")

    assert grant_recharge_pro_bonus(db, payment, now=now) == 0
    db.commit()

    assert _subscription(db, user.id) is None
    assert payment.bonus_pro_days == 0
    assert payment.bonus_pro_granted_at is None


def test_different_qualifying_orders_can_each_grant_bonus(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db, "promo-repeat@example.com")
    first = _payment(db, user, amount="100.00", trade_order_id="promo-repeat-1")
    second = _payment(db, user, amount="100.00", trade_order_id="promo-repeat-2")

    assert grant_recharge_pro_bonus(db, first, now=now) == 30
    db.commit()
    assert grant_recharge_pro_bonus(db, second, now=now) == 30
    db.commit()

    subscription = _subscription(db, user.id)
    assert subscription is not None
    assert subscription.current_period_end == now.replace(tzinfo=None) + timedelta(days=60)
    assert first.bonus_pro_days == second.bonus_pro_days == 30


def test_same_order_is_idempotent_when_fulfillment_callback_repeats(db):
    _configure_promotion(db)
    user = _user(db, "promo-idempotent@example.com")
    payment = _payment(db, user, amount="100.00", trade_order_id="promo-idempotent")

    _fulfill_payment(db, payment, "alipay-trade-idempotent")
    db.commit()
    first_end = _subscription(db, user.id).current_period_end
    first_bonus_at = payment.bonus_pro_granted_at

    _fulfill_payment(db, payment, "alipay-trade-idempotent")
    db.commit()

    subscription = _subscription(db, user.id)
    assert subscription is not None
    assert subscription.current_period_end == first_end
    assert payment.bonus_pro_days == 30
    assert payment.bonus_pro_granted_at == first_bonus_at


def test_existing_member_is_extended_from_current_period_end(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db, "promo-existing@example.com")
    db.add(
        Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=now.replace(tzinfo=None) + timedelta(days=10),
        )
    )
    db.commit()
    payment = _payment(db, user, amount="100.00", trade_order_id="promo-existing")

    assert grant_recharge_pro_bonus(db, payment, now=now) == 30
    db.commit()

    subscription = _subscription(db, user.id)
    assert subscription is not None
    assert subscription.current_period_end == now.replace(tzinfo=None) + timedelta(days=40)
    assert subscription.status == SubscriptionStatus.ACTIVE


def test_refund_reclaims_bonus_days_and_is_idempotent(db):
    now = datetime(2026, 9, 1, 12, tzinfo=UTC)
    _configure_promotion(db)
    user = _user(db, "promo-refund@example.com")
    payment = _payment(db, user, amount="100.00", trade_order_id="promo-refund")
    assert grant_recharge_pro_bonus(db, payment, now=now) == 30
    db.commit()

    assert revoke_recharge_pro_bonus(db, payment, now=now) == 30
    db.commit()
    first_end = _subscription(db, user.id).current_period_end
    assert first_end == now.replace(tzinfo=None)
    assert _subscription(db, user.id).status == SubscriptionStatus.EXPIRED
    assert payment.bonus_pro_revoked_at == now.replace(tzinfo=None)

    assert revoke_recharge_pro_bonus(db, payment, now=now + timedelta(days=1)) == 0
    db.commit()
    assert _subscription(db, user.id).current_period_end == first_end
    assert payment.bonus_pro_days == 30


def test_products_endpoint_exposes_active_recharge_promotion(client, db):
    _configure_promotion(db, min_amount="120.00", gift_days=14)
    db.add(
        CreditProduct(
            code="starter",
            name="充值 ¥10",
            price=Decimal("10.00"),
            credit_units=amount_to_units(Decimal("10.00")),
            enabled=True,
        )
    )
    db.commit()

    response = client.get("/credits/products")

    assert response.status_code == 200, response.text
    promotion = response.json()["promotion"]
    assert promotion["enabled"] is True
    assert promotion["active"] is True
    assert Decimal(promotion["min_amount"]) == Decimal("120.00")
    assert promotion["gift_days"] == 14
    assert "每笔均可参与" in promotion["description"]


def test_admin_can_save_and_read_recharge_promotion_config(client, db, admin_user):
    token, _ = create_access_token(admin_user.id)
    headers = {"Authorization": f"Bearer {token}"}
    start_at = "2026-09-05T00:00:00Z"
    end_at = "2026-09-30T00:00:00Z"

    response = client.put(
        "/admin/recharge-pro-promotion",
        headers=headers,
        json={
            "enabled": True,
            "min_amount": "150.00",
            "gift_days": 15,
            "start_at": start_at,
            "end_at": end_at,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is True
    assert body["active"] is False
    assert Decimal(body["min_amount"]) == Decimal("150.00")
    assert body["gift_days"] == 15
    assert body["start_at"].startswith("2026-09-05T00:00:00")
    assert body["end_at"].startswith("2026-09-30T00:00:00")

    read = client.get("/admin/recharge-pro-promotion", headers=headers)
    assert read.status_code == 200
    assert read.json() == body
    assert db.get(AppConfig, "recharge_pro_promo_enabled").value == "true"
    assert db.get(AppConfig, "recharge_pro_promo_min_amount").value == "150.00"
