class TestPaymentAPI:
    def test_get_subscription_no_sub(self, client, register_and_get_token):
        token = register_and_get_token(email="pay@test.com", account="payuser")
        resp = client.get(
            "/payment/subscription",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "expired"

    def test_list_payments_empty(self, client, register_and_get_token):
        token = register_and_get_token(email="pay@test.com", account="payuser")
        resp = client.get(
            "/payment/list",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["payments"] == []

    def test_create_payment_no_xhp_config(self, client, db, register_and_get_token, monkeypatch):
        import httpx

        from app.models import PricingPlan
        from app.routers import payment_router

        token = register_and_get_token(email="pay@test.com", account="payuser")
        db.add(PricingPlan(id="monthly", name="月度会员", price=29.0, duration_months=1))
        db.commit()

        class FailingClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                del args

            async def post(self, url, **kwargs):
                del kwargs
                raise httpx.ConnectError("offline", request=httpx.Request("POST", url))

        monkeypatch.setattr(payment_router.httpx, "AsyncClient", FailingClient)
        resp = client.post(
            "/payment/create",
            json={"duration_months": 1, "payment_type": "alipay"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 502
