"""支付宝订阅相关接口测试

覆盖：
- 套餐查询（含 period_days、auto_renewable 字段）
- 订阅状态查询（含 auto_renew、agreement_status 字段）
- 创建订阅（支付宝未启用时返回 503）
- 订单状态查询
- 取消自动续费（无订阅时返回 404）
- 续费记录查询
- 支付宝回调验签失败处理
- admin 订单/续费/协议列表
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.models import (
    AgreementStatus,
    Payment,
    PaymentAgreement,
    PaymentStatus,
    PricingPlan,
    Subscription,
    SubscriptionRenewal,
    SubscriptionStatus,
)


def _register_and_get_token(client, db, email: str = "sub@test.com", account: str = "subuser") -> str:
    from app.models import PasswordResetCode

    code = "123456"
    db.add(
        PasswordResetCode(
            email=email,
            code=code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
        )
    )
    db.commit()
    resp = client.post(
        "/auth/register",
        json={"email": email, "password": "test1234", "code": code, "account": account},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _seed_plans(db):
    """预置套餐"""
    plans = [
        PricingPlan(id="monthly", name="月度会员", price=29.0, duration_months=1, period_days=30, auto_renewable=True, sort_order=1),
        PricingPlan(id="yearly", name="年度会员", price=288.0, original_price=348.0, duration_months=12, period_days=365, auto_renewable=True, badge="推荐", sort_order=2),
        PricingPlan(id="lifetime", name="终身版", price=888.0, duration_months=None, period_days=None, auto_renewable=False, badge="限时", sort_order=3),
    ]
    for p in plans:
        db.merge(p)
    db.commit()


class TestPricingConfig:
    def test_pricing_returns_period_days_and_auto_renewable(self, client, db):
        _seed_plans(db)
        resp = client.get("/config/pricing")
        assert resp.status_code == 200
        data = resp.json()
        plans = {p["id"]: p for p in data["plans"]}
        assert plans["monthly"]["period_days"] == 30
        assert plans["monthly"]["auto_renewable"] is True
        assert plans["yearly"]["period_days"] == 365
        assert plans["yearly"]["auto_renewable"] is True
        assert plans["lifetime"]["period_days"] is None
        assert plans["lifetime"]["auto_renewable"] is False


class TestSubscriptionQuery:
    def test_get_subscription_returns_extended_fields(self, client, db):
        token = _register_and_get_token(client, db)
        user = db.query(__import__("app.models", fromlist=["User"]).User).filter_by(email="sub@test.com").first()
        # 创建一个活跃订阅
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime.now(timezone.utc) + timedelta(days=30),
            plan_code="monthly",
            auto_renew=True,
        )
        db.add(sub)
        db.commit()
        db.refresh(sub)

        resp = client.get(
            "/payment/subscription",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "active"
        assert data["plan_code"] == "monthly"
        assert data["auto_renew"] is True

    def test_get_subscription_expired(self, client, db):
        token = _register_and_get_token(client, db, email="sub2@test.com", account="subuser2")
        resp = client.get(
            "/payment/subscription",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "expired"


class TestSubscribe:
    def test_subscribe_alipay_disabled(self, client, db):
        _seed_plans(db)
        token = _register_and_get_token(client, db, email="sub3@test.com", account="subuser3")
        # alipay_service.enabled 为 False（未配置密钥）
        resp = client.post(
            "/payment/subscribe",
            json={"plan_code": "monthly", "payment_method": "alipay_periodic"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 503
        assert resp.json()["error"] == "alipay_disabled"

    def test_subscribe_already_subscribed(self, client, db):
        _seed_plans(db)
        token = _register_and_get_token(client, db, email="sub4@test.com", account="subuser4")
        user = db.query(__import__("app.models", fromlist=["User"]).User).filter_by(email="sub4@test.com").first()
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime.now(timezone.utc) + timedelta(days=30),
            plan_code="monthly",
        )
        db.add(sub)
        db.commit()

        resp = client.post(
            "/payment/subscribe",
            json={"plan_code": "monthly", "payment_method": "alipay_page"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "already_subscribed"

    def test_subscribe_plan_not_found(self, client, db):
        _seed_plans(db)
        token = _register_and_get_token(client, db, email="sub5@test.com", account="subuser5")
        resp = client.post(
            "/payment/subscribe",
            json={"plan_code": "nonexistent", "payment_method": "alipay_page"},
            headers={"Authorization": f"Bearer {token}"},
        )
        # plan_code pattern 不匹配，会被 pydantic 拒绝
        assert resp.status_code == 422


class TestCancelAutoRenew:
    def test_cancel_no_subscription(self, client, db):
        token = _register_and_get_token(client, db, email="sub6@test.com", account="subuser6")
        resp = client.post(
            "/payment/cancel-auto-renew",
            json={"reason": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"] == "no_subscription"

    def test_cancel_idempotent(self, client, db):
        token = _register_and_get_token(client, db, email="sub7@test.com", account="subuser7")
        user = db.query(__import__("app.models", fromlist=["User"]).User).filter_by(email="sub7@test.com").first()
        # 已经是 auto_renew=False 的订阅
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime.now(timezone.utc) + timedelta(days=30),
            plan_code="monthly",
            auto_renew=False,
            cancelled_at=datetime.now(timezone.utc),
        )
        db.add(sub)
        db.commit()

        resp = client.post(
            "/payment/cancel-auto-renew",
            json={"reason": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert "已关闭" in resp.json()["message"]


class TestRenewals:
    def test_list_renewals_empty(self, client, db):
        token = _register_and_get_token(client, db, email="sub8@test.com", account="subuser8")
        resp = client.get(
            "/payment/renewals",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["renewals"] == []


class TestAlipayNotify:
    def test_notify_verify_fail(self, client, db):
        """无签名或签名错误时返回 fail"""
        resp = client.post(
            "/payment/alipay/notify",
            data={"notify_type": "cycle_sign", "status": "VERIFIED", "agreement_no": "test"},
        )
        assert resp.text == "fail"


class TestAdminEndpoints:
    def test_admin_list_orders(self, client, db, admin_user):
        # 创建一个订单
        from app.models import User
        user = User(email="order@test.com", account="orderuser", password_hash="x")
        db.add(user)
        db.commit()
        db.refresh(user)
        payment = Payment(
            user_id=user.id,
            trade_order_id="test_order_1",
            amount=29.0,
            duration_months=1,
            plan_code="monthly",
            status=PaymentStatus.PAID,
            payment_channel="alipay",
            payment_type="page",
            paid_at=datetime.now(timezone.utc),
        )
        db.add(payment)
        db.commit()

        # admin 登录
        from app.auth import create_access_token
        token, _ = create_access_token(admin_user.id)

        resp = client.get(
            "/admin/orders",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1
        order = next(o for o in data["orders"] if o["trade_order_id"] == "test_order_1")
        assert order["amount"] == 29.0
        assert order["payment_channel"] == "alipay"

    def test_admin_list_renewals(self, client, db, admin_user):
        from app.auth import create_access_token
        from app.models import User
        user = User(email="renewal@test.com", account="renewaluser", password_hash="x")
        db.add(user)
        db.commit()
        db.refresh(user)
        sub = Subscription(
            user_id=user.id,
            status=SubscriptionStatus.ACTIVE,
            current_period_end=datetime.now(timezone.utc) + timedelta(days=30),
            plan_code="monthly",
            auto_renew=True,
        )
        db.add(sub)
        db.commit()
        db.refresh(sub)
        renewal = SubscriptionRenewal(
            subscription_id=sub.id,
            agreement_no="test_agreement",
            out_trade_no="recur_test_1",
            amount=29.0,
            period_days=30,
        )
        db.add(renewal)
        db.commit()

        token, _ = create_access_token(admin_user.id)
        resp = client.get(
            "/admin/renewals",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1

    def test_admin_list_agreements(self, client, db, admin_user):
        from app.auth import create_access_token
        from app.models import User
        user = User(email="agree@test.com", account="agreeuser", password_hash="x")
        db.add(user)
        db.commit()
        db.refresh(user)
        agreement = PaymentAgreement(
            user_id=user.id,
            agreement_no="2020123456789",
            status=AgreementStatus.ACTIVE,
            external_sign_no="sign_test_1",
        )
        db.add(agreement)
        db.commit()

        token, _ = create_access_token(admin_user.id)
        resp = client.get(
            "/admin/agreements",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1
