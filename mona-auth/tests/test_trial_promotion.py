from datetime import datetime, timedelta, timezone

from app.models import AppConfig, PasswordResetCode, User


def _register(client, db, email: str, account: str) -> User:
    db.add(
        PasswordResetCode(
            email=email,
            code="123456",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
        )
    )
    db.commit()

    response = client.post(
        "/auth/register",
        json={
            "email": email,
            "account": account,
            "password": "test1234",
            "code": "123456",
        },
    )
    assert response.status_code == 200, response.text
    return db.query(User).filter_by(email=email).one()


def test_register_uses_30_day_default_without_promo(client, db):
    user = _register(client, db, "default@example.com", "defaultuser")

    assert user.trial_expires_at - user.trial_started_at == timedelta(days=30)


def test_register_uses_active_promo_days_with_naive_admin_dates(client, db):
    now = datetime.now(timezone.utc)
    db.add_all(
        [
            AppConfig(key="promo_trial_enabled", value="true"),
            AppConfig(key="promo_trial_days", value="14"),
            AppConfig(
                key="promo_trial_start_at",
                value=(now - timedelta(days=1)).replace(tzinfo=None).isoformat(),
            ),
            AppConfig(
                key="promo_trial_end_at",
                value=(now + timedelta(days=1)).replace(tzinfo=None).isoformat(),
            ),
        ]
    )
    db.commit()

    user = _register(client, db, "promo@example.com", "promouser")

    assert user.trial_expires_at - user.trial_started_at == timedelta(days=14)
