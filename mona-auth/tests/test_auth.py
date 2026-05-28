class TestRegister:
    def test_register_success(self, client):
        resp = client.post(
            "/auth/register", json={"email": "test@example.com", "password": "test1234"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_register_duplicate_email(self, client):
        client.post(
            "/auth/register", json={"email": "test@example.com", "password": "test1234"}
        )
        resp = client.post(
            "/auth/register", json={"email": "test@example.com", "password": "test1234"}
        )
        assert resp.status_code == 409

    def test_register_short_password(self, client):
        resp = client.post(
            "/auth/register", json={"email": "test@example.com", "password": "short"}
        )
        assert resp.status_code == 422


class TestLogin:
    def test_login_success(self, client):
        client.post(
            "/auth/register", json={"email": "test@example.com", "password": "test1234"}
        )
        resp = client.post(
            "/auth/login", json={"email": "test@example.com", "password": "test1234"}
        )
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_login_wrong_password(self, client):
        client.post(
            "/auth/register", json={"email": "test@example.com", "password": "test1234"}
        )
        resp = client.post(
            "/auth/login", json={"email": "test@example.com", "password": "wrongpassword"}
        )
        assert resp.status_code == 401

    def test_login_nonexistent_user(self, client):
        resp = client.post(
            "/auth/login", json={"email": "no@example.com", "password": "test1234"}
        )
        assert resp.status_code == 401
