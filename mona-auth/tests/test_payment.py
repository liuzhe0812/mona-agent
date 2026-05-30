class TestPaymentAPI:
    def _register_and_get_token(self, client):
        resp = client.post(
            "/auth/register", json={"email": "pay@test.com", "password": "test1234"}
        )
        return resp.json()["access_token"]

    def test_get_subscription_no_sub(self, client):
        token = self._register_and_get_token(client)
        resp = client.get(
            "/payment/subscription",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "expired"

    def test_list_payments_empty(self, client):
        token = self._register_and_get_token(client)
        resp = client.get(
            "/payment/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["payments"] == []

    def test_create_payment_no_xhp_config(self, client):
        token = self._register_and_get_token(client)
        resp = client.post(
            "/payment/create",
            json={"duration_months": 1, "payment_type": "alipay"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 502
