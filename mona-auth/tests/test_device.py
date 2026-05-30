from datetime import datetime, timezone

from app.database import SessionLocal
from app.models import Device, Payment, PaymentStatus, Subscription, SubscriptionStatus, User


class TestDeviceAPI:
    def _register_and_get_token(self, client):
        resp = client.post(
            "/auth/register", json={"email": "device@test.com", "password": "test1234"}
        )
        return resp.json()["access_token"]

    def test_bind_without_subscription(self, client):
        token = self._register_and_get_token(client)
        resp = client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-001", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

    def test_list_devices_empty(self, client):
        token = self._register_and_get_token(client)
        resp = client.get(
            "/auth/device/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["devices"] == []

    def test_unbind_nonexistent_device(self, client):
        token = self._register_and_get_token(client)
        resp = client.post(
            "/auth/device/unbind",
            json={"device_fingerprint": "fp-nonexistent"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404

    def test_bind_with_active_subscription(self, client):
        token = self._register_and_get_token(client)

        db = SessionLocal()
        user = db.query(User).filter(User.email == "device@test.com").first()
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime(2099, 1, 1, tzinfo=timezone.utc),
        )
        db.add(sub)
        db.commit()
        db.close()

        resp = client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-001", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "license_jwt" in data
        assert "expires_at" in data

    def test_list_devices_after_bind(self, client):
        token = self._register_and_get_token(client)

        db = SessionLocal()
        user = db.query(User).filter(User.email == "device@test.com").first()
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime(2099, 1, 1, tzinfo=timezone.utc),
        )
        db.add(sub)
        db.commit()
        db.close()

        client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-001", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )

        resp = client.get(
            "/auth/device/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        devices = resp.json()["devices"]
        assert len(devices) == 1
        assert devices[0]["device_fingerprint"] == "fp-001"
