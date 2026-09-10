from datetime import datetime, timedelta, timezone

from app.auth import create_access_token
from app.model_promotions import active_model_promotion, promotion_state
from app.models import ModelPrice, ModelPromotion, User


def _admin_headers(db):
    admin = User(
        email="promotion-admin@example.com",
        account="promotion-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.add(
        ModelPrice(
            model="discount-model",
            version=1,
            input_rate=1_000_000,
            cached_input_rate=20_000,
            output_rate=2_000_000,
            enabled=True,
        )
    )
    db.commit()
    token, _ = create_access_token(admin.id)
    return {"Authorization": f"Bearer {token}"}


def test_promotion_resolver_uses_utc_half_open_window(db):
    start = datetime(2026, 9, 9, 0, 0, tzinfo=timezone.utc)
    promotion = ModelPromotion(
        model="discount-model",
        price_multiplier_bps=5_000,
        start_at=start.replace(tzinfo=None),
        end_at=(start + timedelta(hours=1)).replace(tzinfo=None),
        enabled=True,
    )
    db.add(promotion)
    db.commit()

    assert active_model_promotion(db, "discount-model", now=start - timedelta(microseconds=1)) is None
    assert active_model_promotion(db, "discount-model", now=start).id == promotion.id
    assert active_model_promotion(
        db,
        "discount-model",
        now=start + timedelta(hours=1) - timedelta(microseconds=1),
    ).id == promotion.id
    assert active_model_promotion(db, "discount-model", now=start + timedelta(hours=1)) is None
    assert promotion_state(promotion, now=start + timedelta(hours=1)) == "ended"


def test_admin_updates_one_promotion_row_and_toggles_it(client, db):
    headers = _admin_headers(db)
    start = datetime.now(timezone.utc) - timedelta(minutes=1)
    end = start + timedelta(hours=1)
    created = client.put(
        "/admin/credits/model-promotions",
        headers=headers,
        json={
            "model": "discount-model",
            "discount_percent": 50,
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "enabled": True,
        },
    )

    assert created.status_code == 200
    payload = created.json()
    assert payload["label"] == "↓50%"
    assert payload["price_multiplier_bps"] == 5_000
    assert payload["state"] == "active"
    updated = client.put(
        "/admin/credits/model-promotions",
        headers=headers,
        json={
            "model": "discount-model",
            "discount_percent": 30,
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "enabled": False,
        },
    )
    reenabled = client.put(
        "/admin/credits/model-promotions",
        headers=headers,
        json={
            "model": "discount-model",
            "discount_percent": 30,
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "enabled": True,
        },
    )

    assert updated.status_code == 200
    assert updated.json()["id"] == payload["id"]
    assert updated.json()["state"] == "disabled"
    assert reenabled.status_code == 200
    assert reenabled.json()["id"] == payload["id"]
    assert reenabled.json()["label"] == "↓30%"
    listed = client.get("/admin/credits/model-promotions", headers=headers)
    assert listed.status_code == 200
    assert len(listed.json()["promotions"]) == 1
    disabled = client.post(
        f"/admin/credits/model-promotions/{payload['id']}/disable",
        headers=headers,
    )
    assert disabled.status_code == 200
    assert disabled.json()["state"] == "disabled"
