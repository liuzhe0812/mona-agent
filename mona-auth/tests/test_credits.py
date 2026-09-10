from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.alipay import alipay_service
from app.auth import create_access_token
from app.config import settings
from app.credits import (
    active_request_counter_snapshot,
    adjust_credits,
    amount_to_units,
    display_amount,
    grant_topup,
    mark_request_uncertain,
    reconcile_wallets,
    recover_stale_requests,
    release_request,
    reserve_request,
    settle_request,
)
from app.errors import AuthError
from app.models import (
    AppConfig,
    CreditLedger,
    CreditProduct,
    CreditWallet,
    ModelPrice,
    ModelRequest,
    ModelRequestStatus,
    Payment,
    PaymentStatus,
    User,
)
from app.routers.subscribe_router import _handle_trade_success_notify, sync_payment_status


def _user_and_token(db, *, email: str = "credits@example.com"):
    user = User(email=email, account=email.split("@")[0], password_hash="x")
    db.add(user)
    db.commit()
    db.refresh(user)
    token, _ = create_access_token(user.id)
    return user, token


def test_rmb_balance_uses_exact_micro_yuan_units():
    assert amount_to_units(Decimal("10.00")) == 10_000_000
    assert amount_to_units(Decimal("0.000001")) == 1
    assert display_amount(10_000_000) == "10"
    assert display_amount(1) == "0.000001"
    with pytest.raises(ValueError, match="six decimal"):
        amount_to_units(Decimal("0.0000001"))


def test_alipay_page_order_has_a_fixed_checkout_timeout(monkeypatch):
    captured = {}

    class Client:
        def api_alipay_trade_page_pay(self, **kwargs):
            captured.update(kwargs)
            return "signed-order"

    monkeypatch.setattr(alipay_service, "_client", Client())
    monkeypatch.setattr(
        alipay_service,
        "_gateway",
        "https://openapi.alipay.com/gateway.do",
        raising=False,
    )

    url = alipay_service.create_page_pay_url(
        out_trade_no="timeout-order",
        total_amount=Decimal("10.00"),
        subject="Mona 余额充值",
    )

    assert captured["timeout_express"] == "30m"
    assert url == "https://openapi.alipay.com/gateway.do?signed-order"


def test_new_user_balance_is_zero(client, db):
    user, token = _user_and_token(db)

    response = client.get(
        "/credits/balance",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() | {"updated_at": "ignored"} == {
            "available_units": 0,
            "reserved_units": 0,
            "available_amount": "0",
            "reserved_amount": "0",
            "available_credits": "0",
        "reserved_credits": "0",
        "updated_at": "ignored",
    }
    assert response.json()["updated_at"]
    assert db.get(CreditWallet, user.id) is not None


def test_product_list_exposes_effective_recharge_switch(client, db, monkeypatch):
    monkeypatch.setattr(settings, "credits_payment_enabled", True)
    db.add(
        CreditProduct(
            code="starter",
            name="充值 ¥10",
            price=Decimal("10.00"),
            credit_units=10_000_000,
            enabled=True,
        )
    )
    db.add(AppConfig(key="balance_recharge_enabled", value="false"))
    db.commit()

    disabled = client.get("/credits/products")
    assert disabled.status_code == 200
    assert disabled.json()["recharge_enabled"] is False
    assert disabled.json()["custom_recharge"] == {
        "enabled": True,
        "min_amount": "1.00",
        "max_amount": "5000.00",
    }

    db.get(AppConfig, "balance_recharge_enabled").value = "true"
    db.commit()

    enabled = client.get("/credits/products")
    assert enabled.status_code == 200
    assert enabled.json()["recharge_enabled"] is True


def test_topup_is_idempotent(db):
    user, _ = _user_and_token(db)

    grant_topup(db, user_id=user.id, units=10_000, reference_id="payment:1")
    db.commit()
    grant_topup(db, user_id=user.id, units=10_000, reference_id="payment:1")
    db.commit()

    wallet = db.get(CreditWallet, user.id)
    assert wallet.available_units == 10_000
    assert db.query(CreditLedger).count() == 1


def test_reserve_settle_and_release_are_idempotent(db):
    user, _ = _user_and_token(db)
    grant_topup(db, user_id=user.id, units=20_000, reference_id="payment:2")
    request = reserve_request(
        db,
        request_id="req-1",
        user_id=user.id,
        model="deepseek-v4-flash",
        reserved_units=8_000,
        price_version=1,
    )
    db.commit()

    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (12_000, 8_000)
    assert request.status == ModelRequestStatus.RESERVED

    settle_request(
        db,
        request_id="req-1",
        actual_units=3_000,
        prompt_tokens=1_000,
        completion_tokens=200,
        cached_tokens=100,
    )
    db.commit()
    settle_request(
        db,
        request_id="req-1",
        actual_units=3_000,
        prompt_tokens=1_000,
        completion_tokens=200,
        cached_tokens=100,
    )
    db.commit()

    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (17_000, 0)
    assert db.query(CreditLedger).count() == 2

    reserve_request(
        db,
        request_id="req-2",
        user_id=user.id,
        model="deepseek-v4-flash",
        reserved_units=5_000,
        price_version=1,
    )
    db.commit()
    release_request(db, request_id="req-2", error_code="upstream_unavailable")
    db.commit()
    release_request(db, request_id="req-2", error_code="upstream_unavailable")
    db.commit()

    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (17_000, 0)


def test_usage_summary_aggregates_only_settled_requests(client, db):
    user, token = _user_and_token(db, email="usage@example.com")
    grant_topup(db, user_id=user.id, units=20_000_000, reference_id="payment:usage")
    reserve_request(
        db,
        request_id="usage-request-one",
        user_id=user.id,
        model="deepseek-chat",
        reserved_units=6_000_000,
        price_version=1,
    )
    db.commit()
    settle_request(
        db,
        request_id="usage-request-one",
        actual_units=2_500_000,
        prompt_tokens=1_000,
        completion_tokens=250,
        cached_tokens=100,
    )
    db.commit()
    reserve_request(
        db,
        request_id="usage-request-two",
        user_id=user.id,
        model="deepseek-reasoner",
        reserved_units=4_000_000,
        price_version=1,
    )
    db.commit()
    settle_request(
        db,
        request_id="usage-request-two",
        actual_units=1_500_000,
        prompt_tokens=400,
        completion_tokens=100,
        cached_tokens=0,
    )
    db.commit()
    reserve_request(
        db,
        request_id="usage-request-pending",
        user_id=user.id,
        model="deepseek-chat",
        reserved_units=1_000_000,
        price_version=1,
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.get(ModelRequest, "usage-request-one").created_at = now
    db.get(ModelRequest, "usage-request-two").created_at = now - timedelta(days=1)
    db.get(ModelRequest, "usage-request-pending").created_at = now
    db.commit()

    response = client.get(
        "/credits/usage?tz_offset_minutes=480",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["period_days"] == 30
    assert payload["period_tokens"] == 1_750
    assert payload["period_spent_amount"] == "4"
    assert payload["period_spent_credits"] == "4"
    assert payload["settled_request_count"] == 2
    assert payload["model_count"] == 2
    assert payload["pending_request_count"] == 1
    assert payload["pending_reserved_amount"] == "1"
    assert payload["pending_reserved_credits"] == "1"
    assert len(payload["daily"]) == 30
    assert sum(day["total_tokens"] for day in payload["daily"]) == 1_750
    assert payload["by_model"][0] == {
        "model": "deepseek-chat",
        "billing_type": "token",
        "prompt_tokens": 1_000,
        "completion_tokens": 250,
        "cached_tokens": 100,
        "total_tokens": 1_250,
        "spent_units": 2_500_000,
        "spent_amount": "2.5",
        "spent_credits": "2.5",
        "request_count": 1,
    }
    pending = next(
        item for item in payload["recent"] if item["request_id"] == "usage-request-pending"
    )
    assert pending["status"] == "reserved"
    assert pending["total_tokens"] is None
    assert pending["reserved_amount"] == "1"
    assert pending["reserved_credits"] == "1"


def test_reservation_rejects_insufficient_credits(db):
    user, _ = _user_and_token(db)

    with pytest.raises(AuthError) as error:
        reserve_request(
            db,
            request_id="req-insufficient",
            user_id=user.id,
            model="deepseek-v4-pro",
            reserved_units=1,
            price_version=1,
        )

    assert error.value.error == "insufficient_credits"
    assert db.query(ModelRequest).count() == 0


def test_settlement_above_reservation_becomes_uncertain(db):
    user, _ = _user_and_token(db)
    grant_topup(db, user_id=user.id, units=5_000, reference_id="payment:3")
    reserve_request(
        db,
        request_id="req-over",
        user_id=user.id,
        model="deepseek-v4-pro",
        reserved_units=5_000,
        price_version=1,
    )
    db.commit()

    request = settle_request(
        db,
        request_id="req-over",
        actual_units=5_001,
        prompt_tokens=1,
        completion_tokens=1,
    )
    db.commit()

    assert request.status == ModelRequestStatus.UNCERTAIN
    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (0, 5_000)
    assert db.query(CreditLedger).count() == 1


def test_create_credit_order_uses_server_product_price(client, db, monkeypatch):
    user, token = _user_and_token(db)
    db.add(
        CreditProduct(
            code="starter",
            name="Starter",
            price=Decimal("10.00"),
            credit_units=10_000_000,
            enabled=True,
        )
    )
    db.commit()

    from app.routers import credits_router

    monkeypatch.setattr(credits_router.settings, "credits_payment_enabled", True)
    monkeypatch.setattr(credits_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(credits_router.alipay_service, "_enabled", True)
    pay_url_calls = 0

    def create_page_pay_url(**_):
        nonlocal pay_url_calls
        pay_url_calls += 1
        return "https://pay.example/order"

    monkeypatch.setattr(
        credits_router.alipay_service,
        "create_page_pay_url",
        create_page_pay_url,
    )

    order_body = {
        "product_code": "starter",
        "idempotency_key": "checkoutattempt0001",
    }
    response = client.post(
        "/credits/orders",
        json=order_body,
        headers={"Authorization": f"Bearer {token}"},
    )
    repeated = client.post(
        "/credits/orders",
        json=order_body,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert repeated.status_code == 200
    assert repeated.json()["order_id"] == response.json()["order_id"]
    assert pay_url_calls == 1
    assert db.query(Payment).count() == 1
    payment = db.query(Payment).filter(Payment.user_id == user.id).one()
    assert payment.amount == Decimal("10.00")
    assert payment.credit_units == 10_000_000
    assert payment.product_type == "credit_topup"
    history = client.get(
        "/credits/orders?limit=10",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert history.status_code == 200
    assert history.json()["has_more"] is False
    assert history.json()["orders"][0] == {
        "order_id": payment.id,
        "trade_order_id": payment.trade_order_id,
        "product_code": "starter",
        "amount": "10.00",
        "status": "pending",
        "fulfillment_status": "not_started",
        "balance_units": 10_000_000,
        "balance_amount": "10",
            "credit_units": 10_000_000,
            "credits": "10",
            "bonus_pro_days": 0,
            "bonus_pro_revoked": False,
            "payment_url": "https://pay.example/order",
        "created_at": payment.created_at.isoformat(),
        "paid_at": None,
    }
    for _ in range(10):
        status = client.get(
            f"/credits/orders/{payment.id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert status.status_code == 200
        assert status.json()["status"] == "pending"
    assert db.query(CreditLedger).count() == 0


def test_create_custom_credit_order_uses_admin_range_and_exact_amount(
    client,
    db,
    monkeypatch,
):
    user, token = _user_and_token(db, email="custom-recharge@example.com")
    from app.routers import credits_router

    monkeypatch.setattr(credits_router.settings, "credits_payment_enabled", True)
    monkeypatch.setattr(credits_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(credits_router.alipay_service, "_enabled", True)
    checkout_calls = []

    def create_page_pay_url(**kwargs):
        checkout_calls.append(kwargs)
        return "https://pay.example/custom-order"

    monkeypatch.setattr(
        credits_router.alipay_service,
        "create_page_pay_url",
        create_page_pay_url,
    )
    headers = {"Authorization": f"Bearer {token}"}
    order = {
        "custom_amount": "12.34",
        "idempotency_key": "customcheckout0001",
    }

    response = client.post("/credits/orders", json=order, headers=headers)
    repeated = client.post("/credits/orders", json=order, headers=headers)
    conflict = client.post(
        "/credits/orders",
        json={**order, "custom_amount": "12.35"},
        headers=headers,
    )
    out_of_range = client.post(
        "/credits/orders",
        json={"custom_amount": "0.99", "idempotency_key": "customcheckout0002"},
        headers=headers,
    )

    assert response.status_code == 200
    assert repeated.status_code == 200
    assert repeated.json()["order_id"] == response.json()["order_id"]
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "order_conflict"
    assert out_of_range.status_code == 422
    assert out_of_range.json()["error"] == "custom_recharge_out_of_range"
    assert len(checkout_calls) == 1
    assert checkout_calls[0]["total_amount"] == Decimal("12.34")
    payment = db.query(Payment).filter(Payment.user_id == user.id).one()
    assert payment.amount == Decimal("12.34")
    assert payment.credit_units == 12_340_000
    assert payment.product_code == "custom_recharge"


def test_admin_configures_custom_recharge_range(client, db):
    admin = User(
        email="custom-settings-admin@example.com",
        account="custom-settings-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}

    initial = client.get("/admin/credits/recharge-settings", headers=headers)
    updated = client.put(
        "/admin/credits/recharge-settings",
        json={"enabled": False, "min_amount": "5.00", "max_amount": "2000.00"},
        headers=headers,
    )
    invalid = client.put(
        "/admin/credits/recharge-settings",
        json={"enabled": True, "min_amount": "100.00", "max_amount": "10.00"},
        headers=headers,
    )

    assert initial.status_code == 200
    assert initial.json() == {
        "enabled": True,
        "min_amount": "1.00",
        "max_amount": "5000.00",
    }
    assert updated.status_code == 200
    assert updated.json() == {
        "enabled": False,
        "min_amount": "5.00",
        "max_amount": "2000.00",
    }
    assert invalid.status_code == 422
    assert client.get("/credits/products").json()["custom_recharge"] == {
        "enabled": False,
        "min_amount": "5.00",
        "max_amount": "2000.00",
    }


def test_credit_order_feature_flag_fails_closed(client, db, monkeypatch):
    _, token = _user_and_token(db, email="disabled-credit-order@example.com")
    db.add(
        CreditProduct(
            code="disabled_test",
            name="Disabled test",
            price=Decimal("10.00"),
            credit_units=10_000_000,
            enabled=True,
        )
    )
    db.commit()
    from app.routers import credits_router

    monkeypatch.setattr(credits_router.settings, "credits_payment_enabled", False)
    monkeypatch.setattr(credits_router.alipay_service, "_enabled", True)

    response = client.post(
        "/credits/orders",
        json={
            "product_code": "disabled_test",
            "idempotency_key": "disabledattempt01",
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 503
    assert response.json()["error"] == "credit_payments_disabled"
    assert db.query(Payment).count() == 0


@pytest.mark.asyncio
async def test_credit_payment_fulfillment_is_idempotent(db, monkeypatch):
    user, _ = _user_and_token(db)
    payment = Payment(
        user_id=user.id,
        trade_order_id="credit_order_1",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()

    data = {
        "out_trade_no": payment.trade_order_id,
        "total_amount": "10.00",
        "app_id": "",
        "seller_id": "seller-test",
    }
    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    for _ in range(100):
        await _handle_trade_success_notify(db, data, "alipay_trade_1")

    db.refresh(payment)
    wallet = db.get(CreditWallet, user.id)
    assert payment.status == PaymentStatus.PAID
    assert payment.fulfillment_status == "succeeded"
    assert wallet.available_units == 10_000
    assert db.query(CreditLedger).count() == 1


@pytest.mark.asyncio
async def test_credit_payment_rejects_amount_mismatch(db, monkeypatch):
    user, _ = _user_and_token(db)
    payment = Payment(
        user_id=user.id,
        trade_order_id="credit_order_2",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()

    with pytest.raises(ValueError, match="total_amount mismatch"):
        from app.routers import subscribe_router

        monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
        await _handle_trade_success_notify(
            db,
            {
                "out_trade_no": payment.trade_order_id,
                "total_amount": "1.00",
                "app_id": "",
                "seller_id": "seller-test",
            },
            "alipay_trade_2",
        )

    db.rollback()
    db.refresh(payment)
    assert payment.status == PaymentStatus.PENDING
    assert db.query(CreditLedger).count() == 0


@pytest.mark.asyncio
async def test_unknown_paid_order_is_rejected_for_retry(db):
    with pytest.raises(ValueError, match="Unknown payment order"):
        await _handle_trade_success_notify(
            db,
            {
                "out_trade_no": "missing-order",
                "total_amount": "10.00",
                "app_id": "app-test",
                "seller_id": "seller-test",
            },
            "missing-trade",
        )

    assert db.query(CreditLedger).count() == 0


def test_global_capacity_limit_is_enforced(db, monkeypatch):
    from app import credits

    monkeypatch.setattr(credits.settings, "model_access_max_global_concurrency", 1)
    first, _ = _user_and_token(db, email="capacity-1@example.com")
    second, _ = _user_and_token(db, email="capacity-2@example.com")
    grant_topup(db, user_id=first.id, units=100, reference_id="capacity:1")
    grant_topup(db, user_id=second.id, units=100, reference_id="capacity:2")
    reserve_request(
        db,
        request_id="capacity-request-1",
        user_id=first.id,
        model="managed-model",
        reserved_units=10,
        price_version=1,
    )
    db.commit()

    with pytest.raises(AuthError) as error:
        reserve_request(
            db,
            request_id="capacity-request-2",
            user_id=second.id,
            model="managed-model",
            reserved_units=10,
            price_version=1,
        )

    assert error.value.error == "model_capacity_exceeded"
    assert active_request_counter_snapshot(db) == {
        "ok": True,
        "model_requests": 1,
        "wallets": 1,
        "gateway": 1,
    }


def test_stale_request_recovery_releases_or_marks_uncertain(db, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app import credits

    monkeypatch.setattr(credits.settings, "model_access_reserved_stale_seconds", 60)
    monkeypatch.setattr(credits.settings, "model_access_running_stale_seconds", 60)
    reserved_user, _ = _user_and_token(db, email="stale-reserved@example.com")
    running_user, _ = _user_and_token(db, email="stale-running@example.com")
    for index, user in enumerate((reserved_user, running_user), start=1):
        grant_topup(db, user_id=user.id, units=100, reference_id=f"stale:{index}")
        reserve_request(
            db,
            request_id=f"stale-request-{index}",
            user_id=user.id,
            model="managed-model",
            reserved_units=10,
            price_version=1,
        )
    running = db.get(ModelRequest, "stale-request-2")
    running.status = ModelRequestStatus.RUNNING
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    db.get(ModelRequest, "stale-request-1").created_at = old
    running.created_at = old
    db.commit()

    result = recover_stale_requests(db)
    db.commit()

    assert result == {"released": 1, "uncertain": 1}
    assert db.get(ModelRequest, "stale-request-1").status == ModelRequestStatus.RELEASED
    assert db.get(ModelRequest, "stale-request-2").status == ModelRequestStatus.UNCERTAIN
    assert db.get(CreditWallet, reserved_user.id).available_units == 100
    assert db.get(CreditWallet, running_user.id).reserved_units == 10
    assert active_request_counter_snapshot(db)["ok"] is True


def test_adjustment_and_reconciliation_are_auditable(db):
    admin = User(
        email="credits-admin@example.com",
        account="credits-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(email="adjusted@example.com", account="adjusted", password_hash="x")
    db.add_all([admin, user])
    db.commit()

    adjust_credits(
        db,
        user_id=user.id,
        delta_units=500,
        reference_id="adjustment:test",
        reason="customer support correction",
        admin_user_id=admin.id,
    )
    db.commit()

    assert reconcile_wallets(db) == []
    wallet = db.get(CreditWallet, user.id)
    wallet.available_units += 1
    db.commit()
    assert reconcile_wallets(db)[0]["difference"] == 1


def test_admin_can_sync_a_pending_credit_order(client, db, monkeypatch):
    from app.routers import admin_credits_router

    admin = User(
        email="sync-admin@example.com",
        account="sync-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(email="sync-user@example.com", account="sync-user", password_hash="x")
    db.add_all([admin, user])
    db.commit()
    payment = Payment(
        user_id=user.id,
        trade_order_id="credit_sync_order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    token, _ = create_access_token(admin.id)

    def sync(session, order):
        order.status = PaymentStatus.PAID
        order.fulfillment_status = "succeeded"
        session.commit()

    monkeypatch.setattr(admin_credits_router, "sync_payment_status", sync)

    response = client.post(
        f"/admin/credits/payments/{payment.id}/sync",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "payment_id": payment.id,
        "status": "paid",
        "fulfillment_status": "succeeded",
    }


def test_admin_can_refund_unused_credit_purchase(client, db, monkeypatch):
    admin = User(
        email="refund-admin@example.com",
        account="refund-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(email="refund-user@example.com", account="refund-user", password_hash="x")
    db.add_all([admin, user])
    db.commit()
    payment = Payment(
        user_id=user.id,
        trade_order_id="credit_refund_order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PAID,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000,
        fulfillment_status="succeeded",
    )
    db.add(payment)
    grant_topup(
        db,
        user_id=user.id,
        units=10_000,
        reference_id="payment:credit_refund_order",
    )
    db.commit()
    token, _ = create_access_token(admin.id)

    from app.routers import admin_credits_router

    refund_calls = 0

    def refund(**_):
        nonlocal refund_calls
        refund_calls += 1
        return {"code": "10000"}

    monkeypatch.setattr(admin_credits_router.alipay_service, "refund", refund)
    response = client.post(
        f"/admin/credits/payments/{payment.id}/refund",
        json={"reason": "customer requested full refund"},
        headers={"Authorization": f"Bearer {token}"},
    )
    repeated = client.post(
        f"/admin/credits/payments/{payment.id}/refund",
        json={"reason": "customer requested full refund"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert repeated.status_code == 200
    assert refund_calls == 1
    db.refresh(payment)
    assert payment.refund_status == "succeeded"
    assert db.get(CreditWallet, user.id).available_units == 0
    assert db.query(CreditLedger).filter(CreditLedger.event_type == "REFUND").count() == 1


def test_admin_adjustment_api_is_idempotent(client, db):
    admin = User(
        email="adjustment-admin@example.com",
        account="adjustment-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="adjustment-user@example.com",
        account="adjustment-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    token, _ = create_access_token(admin.id)
    body = {
        "idempotency_key": "support-case-1001",
        "delta_units": 500,
        "reason": "customer support correction",
    }
    headers = {"Authorization": f"Bearer {token}"}

    first = client.post(
        f"/admin/credits/users/{user.id}/adjustments", json=body, headers=headers
    )
    second = client.post(
        f"/admin/credits/users/{user.id}/adjustments", json=body, headers=headers
    )
    conflicting = client.post(
        f"/admin/credits/users/{user.id}/adjustments",
        json={**body, "delta_units": 501},
        headers=headers,
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert conflicting.status_code == 409
    assert conflicting.json()["error"] == "reference_conflict"
    assert db.get(CreditWallet, user.id).available_units == 500
    assert (
        db.query(CreditLedger)
        .filter(CreditLedger.event_type == "ADJUSTMENT")
        .count()
        == 1
    )


def test_refund_is_rejected_after_credits_are_reserved(client, db, monkeypatch):
    admin = User(
        email="spent-refund-admin@example.com",
        account="spent-refund-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="spent-refund-user@example.com",
        account="spent-refund-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    payment = Payment(
        user_id=user.id,
        trade_order_id="spent-refund-order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PAID,
        payment_channel="alipay",
        product_type="credit_topup",
        credit_units=10_000,
        fulfillment_status="succeeded",
    )
    db.add(payment)
    grant_topup(
        db,
        user_id=user.id,
        units=10_000,
        reference_id="payment:spent-refund-order",
    )
    reserve_request(
        db,
        request_id="spent-refund-request",
        user_id=user.id,
        model="managed-model",
        reserved_units=1,
        price_version=1,
    )
    db.commit()
    token, _ = create_access_token(admin.id)
    from app.routers import admin_credits_router

    refund_calls = 0

    def refund(**_):
        nonlocal refund_calls
        refund_calls += 1
        return {"code": "10000"}

    monkeypatch.setattr(admin_credits_router.alipay_service, "refund", refund)
    response = client.post(
        f"/admin/credits/payments/{payment.id}/refund",
        json={"reason": "customer requested full refund"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 409
    assert response.json()["error"] == "refund_balance_spent"
    assert refund_calls == 0
    assert payment.refund_status == "not_requested"


def test_regular_user_cannot_access_credit_admin_api(client, db):
    _, token = _user_and_token(db, email="non-admin@example.com")

    response = client.get(
        "/admin/credits/reconciliation",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    assert response.json()["error"] == "forbidden"


def test_user_cannot_read_another_users_credit_order(client, db):
    first_user, first_token = _user_and_token(db, email="order-owner-a@example.com")
    second_user, _ = _user_and_token(db, email="order-owner-b@example.com")
    payment = Payment(
        user_id=second_user.id,
        trade_order_id="private-credit-order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()

    response = client.get(
        f"/credits/orders/{payment.id}?reconcile=true",
        headers={"Authorization": f"Bearer {first_token}"},
    )

    assert response.status_code == 404
    assert response.json()["error"] == "order_not_found"
    assert payment.user_id != first_user.id


def test_credit_order_reconcile_fulfills_and_credits_once(client, db, monkeypatch):
    from app.routers import subscribe_router

    user, token = _user_and_token(db, email="reconcile-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="reconcile-credit-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="custom_recharge",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)

    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(subscribe_router.alipay_service, "_enabled", True)
    query_calls = 0

    def query_trade(**_):
        nonlocal query_calls
        query_calls += 1
        return {
            "code": "10000",
            "trade_status": "TRADE_SUCCESS",
            "trade_no": "reconcile-alipay-trade",
            "total_amount": "1.00",
        }

    monkeypatch.setattr(subscribe_router.alipay_service, "query_trade", query_trade)
    headers = {"Authorization": f"Bearer {token}"}

    first = client.get(f"/credits/orders/{payment.id}?reconcile=true", headers=headers)
    second = client.get(f"/credits/orders/{payment.id}?reconcile=true", headers=headers)

    assert first.status_code == 200
    assert first.json() == {
        "order_id": payment.id,
        "status": "paid",
        "fulfillment_status": "succeeded",
        "balance_units": 1_000_000,
        "balance_amount": "1",
        "credit_units": 1_000_000,
        "bonus_pro_days": 0,
        "bonus_pro_revoked": False,
    }
    assert second.status_code == 200
    assert second.json() == first.json()
    db.refresh(payment)
    wallet = db.get(CreditWallet, user.id)
    ledger = db.query(CreditLedger).one()
    assert query_calls == 1
    assert payment.status == PaymentStatus.PAID
    assert payment.fulfillment_status == "succeeded"
    assert wallet.available_units == 1_000_000
    assert ledger.delta_units == 1_000_000
    assert ledger.reference_id == "payment:reconcile-credit-order"


def test_credit_order_status_is_read_only_by_default(client, db, monkeypatch):
    from app.routers import subscribe_router

    user, token = _user_and_token(db, email="default-readonly-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="default-readonly-credit-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="custom_recharge",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    calls = 0

    def sync(*_):
        nonlocal calls
        calls += 1

    monkeypatch.setattr(subscribe_router, "sync_payment_status", sync)
    response = client.get(
        f"/credits/orders/{payment.id}",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert calls == 0
    assert db.query(CreditLedger).count() == 0


def test_credit_order_reconcile_skips_non_alipay_payment(client, db, monkeypatch):
    from app.routers import subscribe_router

    user, token = _user_and_token(db, email="non-alipay-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="non-alipay-credit-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PENDING,
        payment_channel="xhp",
        product_type="credit_topup",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    calls = 0

    def sync(*_):
        nonlocal calls
        calls += 1

    monkeypatch.setattr(subscribe_router, "sync_payment_status", sync)
    response = client.get(
        f"/credits/orders/{payment.id}?reconcile=true",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert calls == 0
    assert db.query(CreditLedger).count() == 0


def test_credit_order_reconcile_failure_rolls_back_and_hides_error(client, db, monkeypatch):
    from app.routers import subscribe_router

    user, token = _user_and_token(db, email="failed-reconcile-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="failed-reconcile-credit-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()

    monkeypatch.setattr(subscribe_router.alipay_service, "_enabled", True)
    query_calls = 0

    def query_trade(**_):
        nonlocal query_calls
        query_calls += 1
        raise RuntimeError("private Alipay response")

    monkeypatch.setattr(subscribe_router.alipay_service, "query_trade", query_trade)
    response = client.get(
        f"/credits/orders/{payment.id}?reconcile=true",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 503
    assert query_calls == 1
    assert response.json() == {
        "error": "credit_payment_reconciliation_failed",
        "detail": "Unable to reconcile payment status",
    }
    assert "private Alipay response" not in response.text
    db.refresh(payment)
    assert payment.status == PaymentStatus.PENDING
    assert db.query(CreditLedger).count() == 0


def test_alipay_notify_validates_identity_and_fulfills_credit_order(
    client, db, monkeypatch
):
    user, _ = _user_and_token(db, email="notify-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="notify-credit-order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()

    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(
        subscribe_router.alipay_service,
        "verify_callback",
        lambda _: True,
    )
    form = {
        "sign": "test-signature",
        "sign_type": "RSA2",
        "app_id": "app-test",
        "seller_id": "seller-test",
        "trade_status": "TRADE_SUCCESS",
        "out_trade_no": payment.trade_order_id,
        "trade_no": "notify-alipay-trade",
        "total_amount": "10.00",
    }

    response = client.post("/payment/alipay/notify", data=form)

    assert response.status_code == 200
    assert response.text == "success"
    db.refresh(payment)
    assert payment.fulfillment_status == "succeeded"
    assert db.get(CreditWallet, user.id).available_units == 10_000


def test_alipay_notify_rejects_wrong_seller(client, db, monkeypatch):
    from app.routers import subscribe_router

    user, _ = _user_and_token(db, email="wrong-seller@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="wrong-seller-order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(
        subscribe_router.alipay_service,
        "verify_callback",
        lambda _: True,
    )

    response = client.post(
        "/payment/alipay/notify",
        data={
            "sign": "test-signature",
            "sign_type": "RSA2",
            "app_id": "app-test",
            "seller_id": "wrong-seller",
            "trade_status": "TRADE_SUCCESS",
            "out_trade_no": payment.trade_order_id,
            "trade_no": "wrong-seller-trade",
            "total_amount": "10.00",
        },
    )

    assert response.status_code == 200
    assert response.text == "fail"
    assert db.query(CreditLedger).count() == 0
    db.refresh(payment)
    assert payment.status == PaymentStatus.PENDING


def test_pending_credit_order_tracks_alipay_closed_state(db, monkeypatch):
    from app.routers import subscribe_router

    user, _ = _user_and_token(db, email="closed-credit@example.com")
    payment = Payment(
        user_id=user.id,
        trade_order_id="closed-credit-order",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000_000,
        fulfillment_status="not_started",
    )
    db.add(payment)
    db.commit()
    monkeypatch.setattr(subscribe_router.alipay_service, "_enabled", True)
    monkeypatch.setattr(
        subscribe_router.alipay_service,
        "query_trade",
        lambda **_: {"code": "10000", "trade_status": "TRADE_CLOSED"},
    )

    sync_payment_status(db, payment)

    db.refresh(payment)
    assert payment.status == PaymentStatus.FAILED
    assert payment.fulfillment_status == "not_started"
    assert db.query(CreditLedger).count() == 0


def test_cycle_sign_notify_does_not_require_trade_seller_field(client, db, monkeypatch):
    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(
        subscribe_router.alipay_service,
        "verify_callback",
        lambda _: True,
    )

    response = client.post(
        "/payment/alipay/notify",
        data={
            "sign": "test-signature",
            "sign_type": "RSA2",
            "app_id": "app-test",
            "notify_type": "cycle_sign",
            "status": "UNKNOWN",
        },
    )

    assert response.status_code == 200
    assert response.text == "success"


def test_alipay_notify_rejects_invalid_rsa2_signature(client, db, monkeypatch):
    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(
        subscribe_router.alipay_service,
        "verify_callback",
        lambda _: False,
    )

    response = client.post(
        "/payment/alipay/notify",
        data={
            "sign": "invalid-signature",
            "sign_type": "RSA2",
            "app_id": "app-test",
            "seller_id": "seller-test",
            "trade_status": "TRADE_SUCCESS",
            "out_trade_no": "unknown",
            "trade_no": "unknown-trade",
            "total_amount": "10.00",
        },
    )

    assert response.status_code == 200
    assert response.text == "fail"
    assert db.query(CreditLedger).count() == 0


@pytest.mark.asyncio
async def test_alipay_trade_number_cannot_credit_two_orders(db, monkeypatch):
    first_user, _ = _user_and_token(db, email="trade-first@example.com")
    second_user, _ = _user_and_token(db, email="trade-second@example.com")
    first = Payment(
        user_id=first_user.id,
        trade_order_id="credit-trade-first",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    second = Payment(
        user_id=second_user.id,
        trade_order_id="credit-trade-second",
        amount=Decimal("10.00"),
        status=PaymentStatus.PENDING,
        product_type="credit_topup",
        credit_units=10_000,
        fulfillment_status="not_started",
    )
    db.add_all([first, second])
    db.commit()
    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    await _handle_trade_success_notify(
        db,
        {
            "out_trade_no": first.trade_order_id,
            "total_amount": "10.00",
            "app_id": "",
            "seller_id": "seller-test",
        },
        "shared-alipay-trade",
    )

    with pytest.raises(ValueError, match="already attached"):
        await _handle_trade_success_notify(
            db,
            {
                "out_trade_no": second.trade_order_id,
                "total_amount": "10.00",
                "app_id": "",
                "seller_id": "seller-test",
            },
            "shared-alipay-trade",
        )

    db.rollback()
    assert db.get(CreditWallet, first_user.id).available_units == 10_000
    assert db.get(CreditWallet, second_user.id) is None


def test_admin_manages_server_side_product_and_versioned_model_price(client, db, monkeypatch):
    admin = User(
        email="catalog-admin@example.com",
        account="catalog-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}
    from app.routers import admin_credits_router

    class UnavailableOneApi:
        is_success = False

    monkeypatch.setattr(
        admin_credits_router.httpx,
        "get",
        lambda *_args, **_kwargs: UnavailableOneApi(),
    )

    product = client.put(
        "/admin/credits/products/starter",
        json={
            "name": "Starter",
            "price": "10.00",
            "enabled": True,
            "sort_order": 1,
        },
        headers=headers,
    )
    mismatched_product = client.put(
        "/admin/credits/products/legacy_points",
        json={
            "name": "Legacy points",
            "price": "10.00",
            "credit_units": 1_000_000,
            "enabled": True,
            "sort_order": 2,
        },
        headers=headers,
    )
    first_price = client.post(
        "/admin/credits/model-prices",
        json={
            "model": "managed-model",
            "input_rate": 100,
            "cached_input_rate": 10,
            "output_rate": 200,
            "enabled": True,
        },
        headers=headers,
    )
    second_price = client.post(
        "/admin/credits/model-prices",
        json={
            "model": "managed-model",
            "input_rate": 110,
            "cached_input_rate": 11,
            "output_rate": 220,
            "enabled": True,
        },
        headers=headers,
    )

    assert product.status_code == 200
    assert mismatched_product.status_code == 422
    public_product = client.get("/credits/products").json()["products"][0]
    assert public_product["code"] == "starter"
    assert public_product["balance_units"] == 10_000_000
    assert public_product["balance_amount"] == "10"
    assert db.get(CreditProduct, "starter").credit_units == 10_000_000
    assert first_price.json()["version"] == 1
    assert second_price.json()["version"] == 2
    status = client.get("/admin/credits/status", headers=headers)
    assert status.status_code == 200
    assert status.json() == {
        "credit_payments_enabled": False,
        "model_access_enabled": False,
        "balance_recharge_deployment_allowed": False,
        "balance_recharge_admin_enabled": False,
        "balance_recharge_enabled": False,
        "managed_model_deployment_allowed": False,
        "managed_model_admin_enabled": False,
        "managed_model_enabled": False,
        "alipay_configured": False,
        "one_api_configured": False,
        "one_api_admin_configured": False,
        "one_api_reachable": False,
        "enabled_products": 1,
        "enabled_models": 1,
        "total_available_amount": "0",
        "total_reserved_amount": "0",
        "today_recharge_amount": "0.00",
        "pending_refunds": 0,
    }
    disabled_flags = client.put(
        "/admin/credits/feature-flags",
        json={"balance_recharge_enabled": False, "managed_model_enabled": False},
        headers=headers,
    )
    blocked_flags = client.put(
        "/admin/credits/feature-flags",
        json={"balance_recharge_enabled": True, "managed_model_enabled": False},
        headers=headers,
    )
    assert disabled_flags.status_code == 200
    assert blocked_flags.status_code == 409
    prices = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == "managed-model")
        .order_by(ModelPrice.version)
        .all()
    )
    assert [price.enabled for price in prices] == [False, True]

    listed_prices = client.get("/admin/credits/model-prices", headers=headers).json()[
        "prices"
    ]
    assert listed_prices[0]["deletable"] is False
    assert listed_prices[1]["deletable"] is True
    active_delete = client.delete(
        f"/admin/credits/model-prices/{prices[1].id}",
        headers=headers,
    )
    old_delete = client.delete(
        f"/admin/credits/model-prices/{prices[0].id}",
        headers=headers,
    )
    assert active_delete.status_code == 409
    assert old_delete.status_code == 200

    third_price = client.post(
        "/admin/credits/model-prices",
        json={
            "model": "managed-model",
            "input_rate": 120,
            "cached_input_rate": 12,
            "output_rate": 240,
            "enabled": False,
        },
        headers=headers,
    )
    assert third_price.json()["version"] == 3
    latest = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == "managed-model", ModelPrice.version == 3)
        .one()
    )
    enabled = client.post(
        f"/admin/credits/model-prices/{latest.id}/enable",
        headers=headers,
    )
    assert enabled.status_code == 200
    db.refresh(latest)
    assert latest.enabled is True

    db.add(
        ModelRequest(
            request_id="used-price-version",
            user_id=admin.id,
            model="managed-model",
            status=ModelRequestStatus.RELEASED,
            reserved_units=1,
            price_version=2,
        )
    )
    db.commit()
    used_price = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == "managed-model", ModelPrice.version == 2)
        .one()
    )
    used_delete = client.delete(
        f"/admin/credits/model-prices/{used_price.id}",
        headers=headers,
    )
    assert used_delete.status_code == 409

    disabled = client.post(
        "/admin/credits/models/managed-model/disable",
        headers=headers,
    )

    assert disabled.status_code == 200
    assert db.query(ModelPrice).filter(ModelPrice.enabled.is_(True)).count() == 0
    latest_delete = client.delete(
        f"/admin/credits/model-prices/{latest.id}",
        headers=headers,
    )
    assert latest_delete.status_code == 200


def test_admin_can_disable_model_with_slash_in_name(client, db):
    admin = User(
        email="slash-model-admin@example.com",
        account="slash-model-admin",
        password_hash="x",
        is_admin=True,
    )
    price = ModelPrice(
        model="ZHIPU/GLM-5.3-Flash",
        version=1,
        input_rate=100,
        cached_input_rate=10,
        output_rate=200,
        enabled=True,
    )
    db.add_all([admin, price])
    db.commit()
    token, _ = create_access_token(admin.id)

    response = client.post(
        "/admin/credits/models/ZHIPU%2FGLM-5.3-Flash/disable",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {"model": "ZHIPU/GLM-5.3-Flash", "enabled": False}
    db.refresh(price)
    assert price.enabled is False


def test_admin_credit_status_summarizes_wallets_and_today_recharge(client, db):
    admin = User(
        email="funds-summary-admin@example.com",
        account="funds-summary-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="funds-summary-user@example.com",
        account="funds-summary-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    db.add(
        CreditWallet(
            user_id=user.id,
            available_units=12_500_000,
            reserved_units=750_000,
        )
    )
    db.add(
        Payment(
            user_id=user.id,
            trade_order_id="funds-summary-paid-order",
            amount=Decimal("50.00"),
            status=PaymentStatus.PAID,
            product_type="credit_topup",
            fulfillment_status="succeeded",
            refund_status="processing",
            paid_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
    )
    db.commit()
    token, _ = create_access_token(admin.id)
    response = client.get(
        "/admin/credits/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_available_amount"] == "12.5"
    assert payload["total_reserved_amount"] == "0.75"
    assert payload["today_recharge_amount"] == "50.00"
    assert payload["pending_refunds"] == 1


def test_admin_resolves_uncertain_request_by_releasing_reservation(client, db):
    admin = User(
        email="resolve-admin@example.com",
        account="resolve-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="resolve-user@example.com",
        account="resolve-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    grant_topup(db, user_id=user.id, units=100, reference_id="resolve-topup")
    reserve_request(
        db,
        request_id="resolve-uncertain-request",
        user_id=user.id,
        model="managed-model",
        reserved_units=10,
        price_version=1,
    )
    mark_request_uncertain(
        db,
        request_id="resolve-uncertain-request",
        error_code="missing_usage",
    )
    db.commit()
    token, _ = create_access_token(admin.id)

    response = client.post(
        "/admin/credits/requests/resolve-uncertain-request/resolve",
        json={"action": "release", "reason": "verified no upstream usage"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "released"
    assert db.get(CreditWallet, user.id).available_units == 100
    assert db.get(CreditWallet, user.id).reserved_units == 0


def test_admin_enables_recharge_only_when_deployment_gate_and_dependencies_are_ready(
    client,
    db,
    monkeypatch,
):
    admin = User(
        email="flags-admin@example.com",
        account="flags-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.add(
        CreditProduct(
            code="recharge_10",
            name="Recharge 10",
            price=Decimal("10.00"),
            credit_units=10_000_000,
            enabled=True,
        )
    )
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}
    from app.routers import admin_credits_router

    class UnavailableOneApi:
        is_success = False

    monkeypatch.setattr(settings, "credits_payment_enabled", True)
    monkeypatch.setattr(settings, "model_access_enabled", False)
    monkeypatch.setattr(settings, "alipay_seller_id", "seller-test")
    monkeypatch.setattr(admin_credits_router.alipay_service, "_enabled", True)
    monkeypatch.setattr(
        admin_credits_router.httpx,
        "get",
        lambda *_args, **_kwargs: UnavailableOneApi(),
    )

    response = client.put(
        "/admin/credits/feature-flags",
        json={"balance_recharge_enabled": True, "managed_model_enabled": False},
        headers=headers,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["balance_recharge_deployment_allowed"] is True
    assert payload["balance_recharge_admin_enabled"] is True
    assert payload["balance_recharge_enabled"] is True
    assert client.get("/ready").json()["credit_payments_enabled"] is True


def test_admin_lists_credit_users_and_refundable_topups(client, db):
    admin = User(
        email="wallet-admin@example.com",
        account="wallet-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="wallet-user@example.com",
        account="wallet-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    grant_topup(db, user_id=user.id, units=3_000_000, reference_id="wallet-admin-topup")
    payment = Payment(
        user_id=user.id,
        trade_order_id="credit-admin-list-payment",
        amount=Decimal("10.00"),
        status=PaymentStatus.PAID,
        payment_channel="alipay",
        product_type="credit_topup",
        product_code="starter",
        credit_units=10_000_000,
        fulfillment_status="succeeded",
        refund_status="not_requested",
    )
    db.add(payment)
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}

    users = client.get(
        "/admin/credits/users?search=wallet-user",
        headers=headers,
    )
    payments = client.get("/admin/credits/payments", headers=headers)

    assert users.status_code == 200
    assert users.json()["users"] == [
        {
            "user_id": user.id,
            "account": "wallet-user",
                "email": "wallet-user@example.com",
                "available_balance": "3",
                "reserved_balance": "0",
                "available_credits": "3",
            "reserved_credits": "0",
            "active_requests": 0,
            "updated_at": users.json()["users"][0]["updated_at"],
        }
    ]
    assert payments.status_code == 200
    listed = payments.json()["payments"][0]
    assert listed["payment_id"] == payment.id
    assert listed["amount"] == "10.00"
    assert listed["balance_amount"] == "10"
    assert listed["credits"] == "10"
    assert listed["refundable"] is True
    assert "payment_url" not in listed


def test_admin_settles_uncertain_request_with_verified_usage(client, db):
    admin = User(
        email="settle-admin@example.com",
        account="settle-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(
        email="settle-user@example.com",
        account="settle-user",
        password_hash="x",
    )
    db.add_all([admin, user])
    db.commit()
    db.add(
        ModelPrice(
            model="managed-model",
            version=1,
            input_rate=1_000_000,
            cached_input_rate=100_000,
            output_rate=2_000_000,
            enabled=False,
        )
    )
    grant_topup(db, user_id=user.id, units=1_000, reference_id="settle-topup")
    reserve_request(
        db,
        request_id="settle-uncertain-request",
        user_id=user.id,
        model="managed-model",
        reserved_units=100,
        price_version=1,
    )
    mark_request_uncertain(
        db,
        request_id="settle-uncertain-request",
        error_code="missing_usage",
    )
    db.commit()
    token, _ = create_access_token(admin.id)

    response = client.post(
        "/admin/credits/requests/settle-uncertain-request/resolve",
        json={
            "action": "settle",
            "prompt_tokens": 50,
            "completion_tokens": 10,
            "cached_tokens": 0,
            "reason": "verified against upstream bill",
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "settled"
    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (930, 0)
    assert (
        db.query(CreditLedger)
        .filter(CreditLedger.reference_id == "settle-uncertain-request")
        .one()
        .delta_units
        == -70
    )
