from app.models import Device, Subscription, SubscriptionStatus, User


class TestDeviceAPI:
    def test_bind_without_subscription(self, client, register_and_get_token):
        token = register_and_get_token(email="device@test.com", account="deviceuser")
        resp = client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-00123", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

    def test_list_devices_empty(self, client, register_and_get_token):
        token = register_and_get_token(email="device@test.com", account="deviceuser")
        resp = client.get(
            "/auth/device/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["devices"] == []

    def test_unbind_nonexistent_device(self, client, register_and_get_token):
        token = register_and_get_token(email="device@test.com", account="deviceuser")
        resp = client.post(
            "/auth/device/unbind",
            json={"device_fingerprint": "fp-none01"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404

    def test_bind_with_active_subscription(self, client, db, register_and_get_token):
        token = register_and_get_token(email="device@test.com", account="deviceuser")

        user = db.query(User).filter(User.email == "device@test.com").first()
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=None,
        )
        db.add(sub)
        db.commit()

        resp = client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-00123", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "license_jwt" in data
        assert "expires_at" in data

    def test_list_devices_after_bind(self, client, db, register_and_get_token):
        token = register_and_get_token(email="device@test.com", account="deviceuser")

        user = db.query(User).filter(User.email == "device@test.com").first()
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=None,
        )
        db.add(sub)
        db.commit()

        client.post(
            "/auth/device/bind",
            json={"device_fingerprint": "fp-00123", "device_name": "Test Device"},
            headers={"Authorization": f"Bearer {token}"},
        )

        resp = client.get(
            "/auth/device/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        devices = resp.json()["devices"]
        assert len(devices) == 1
        assert devices[0]["device_fingerprint"] == "fp-00123"

    def test_paid_license_check_enforces_active_device_limit(
        self, client, db, register_and_get_token
    ):
        token = register_and_get_token(email="limit@test.com", account="limituser")
        user = db.query(User).filter(User.email == "limit@test.com").first()
        db.add(
            Subscription(
                user_id=user.id,
                status=SubscriptionStatus.ACTIVE,
                current_period_end=None,
            )
        )
        db.commit()
        headers = {"Authorization": f"Bearer {token}"}

        for suffix in ("00000001", "00000002", "00000003"):
            response = client.get(
                "/license/check",
                params={"device_fingerprint": suffix},
                headers=headers,
            )
            assert response.status_code == 200
            assert response.json()["status"] == "valid"

        blocked = client.get(
            "/license/check",
            params={"device_fingerprint": "00000004"},
            headers=headers,
        )
        assert blocked.status_code == 200
        assert blocked.json()["status"] == "device_mismatch"
        assert db.query(Device).filter(Device.user_id == user.id).count() == 3

        bind = client.post(
            "/license/bind-device",
            json={"device_fingerprint": "00000004"},
            headers=headers,
        )
        assert bind.status_code == 403
        assert bind.json()["error"] == "device_limit_exceeded"
