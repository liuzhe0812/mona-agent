from datetime import datetime, timedelta, timezone

from app.models import PasswordResetCode


class TestRegister:
    def test_register_success(self, register_and_get_token):
        token = register_and_get_token()
        assert token

    def test_register_duplicate_email(self, client, db, register_and_get_token):
        register_and_get_token()
        db.add(
            PasswordResetCode(
                email="test@example.com",
                code="123456",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
            )
        )
        db.commit()
        resp = client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "password": "test1234",
                "code": "123456",
                "account": "testuser",
            },
        )
        assert resp.status_code == 409

    def test_register_short_password(self, client):
        resp = client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "password": "short",
                "code": "123456",
                "account": "testuser",
            },
        )
        assert resp.status_code == 422


class TestLogin:
    def test_login_success(self, client, register_and_get_token):
        register_and_get_token()
        resp = client.post("/auth/login", json={"account": "testuser", "password": "test1234"})
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_login_wrong_password(self, client, register_and_get_token):
        register_and_get_token()
        resp = client.post("/auth/login", json={"account": "testuser", "password": "wrongpassword"})
        assert resp.status_code == 401

    def test_login_nonexistent_user(self, client):
        resp = client.post("/auth/login", json={"account": "nouser", "password": "test1234"})
        assert resp.status_code == 401
