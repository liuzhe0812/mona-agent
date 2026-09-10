from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.credits import adjust_credits, grant_topup, reserve_request
from app.database import Base
from app.errors import AuthError
from app.models import (
    CreditLedger,
    CreditWallet,
    ModelGatewayLock,
    ModelRequest,
    Payment,
    PaymentStatus,
    User,
)
from app.routers.subscribe_router import _handle_trade_success_notify

TEST_DATABASE_URL = os.environ.get("MONA_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="MONA_TEST_DATABASE_URL is required for MariaDB concurrency tests",
)


@pytest.fixture(scope="module")
def mysql_sessions():
    url = make_url(TEST_DATABASE_URL)
    if "test" not in (url.database or "").lower():
        pytest.fail("MONA_TEST_DATABASE_URL must point to a dedicated test database")
    engine = create_engine(TEST_DATABASE_URL, pool_size=20, max_overflow=10)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with sessions() as db:
        db.add(ModelGatewayLock(id=1))
        db.commit()
    yield sessions
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_concurrent_reservations_never_overdraw(mysql_sessions, monkeypatch):
    from app import credits

    monkeypatch.setattr(credits.settings, "model_access_max_user_concurrency", 100)
    monkeypatch.setattr(credits.settings, "model_access_max_global_concurrency", 100)
    with mysql_sessions() as db:
        user = User(email="mysql-wallet@example.com", account="mysql-wallet", password_hash="x")
        db.add(user)
        db.commit()
        grant_topup(db, user_id=user.id, units=1_000, reference_id="mysql-topup")
        db.commit()
        user_id = user.id

    def reserve(index: int) -> str:
        with mysql_sessions() as db:
            try:
                reserve_request(
                    db,
                    request_id=f"mysql-request-{index}",
                    user_id=user_id,
                    model="managed-model",
                    reserved_units=200,
                    price_version=1,
                )
                db.commit()
                return "ok"
            except AuthError as exc:
                db.rollback()
                return exc.error

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(reserve, range(10)))

    assert results.count("ok") == 5
    assert results.count("insufficient_credits") == 5
    with mysql_sessions() as db:
        wallet = db.get(CreditWallet, user_id)
        assert (wallet.available_units, wallet.reserved_units) == (0, 1_000)
        assert db.query(ModelRequest).count() == 5


def test_concurrent_payment_callbacks_credit_once(mysql_sessions, monkeypatch):
    from app.routers import subscribe_router

    monkeypatch.setattr(subscribe_router.settings, "alipay_app_id", "app-test")
    monkeypatch.setattr(subscribe_router.settings, "alipay_seller_id", "seller-test")
    with mysql_sessions() as db:
        user = User(email="mysql-payment@example.com", account="mysql-payment", password_hash="x")
        db.add(user)
        db.commit()
        payment = Payment(
            user_id=user.id,
            trade_order_id="mysql-credit-order",
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
        user_id = user.id

    data = {
        "out_trade_no": "mysql-credit-order",
        "total_amount": "10.00",
        "app_id": "app-test",
        "seller_id": "seller-test",
    }

    def callback(_: int) -> None:
        with mysql_sessions() as db:
            asyncio.run(_handle_trade_success_notify(db, data, "mysql-alipay-trade"))

    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(callback, range(20)))

    with mysql_sessions() as db:
        wallet = db.get(CreditWallet, user_id)
        assert wallet.available_units == 10_000
        assert db.query(CreditLedger).count() == 1


def test_concurrent_adjustment_retry_applies_once(mysql_sessions):
    with mysql_sessions() as db:
        admin = User(
            email="mysql-adjust-admin@example.com",
            account="mysql-adjust-admin",
            password_hash="x",
            is_admin=True,
        )
        user = User(
            email="mysql-adjust-user@example.com",
            account="mysql-adjust-user",
            password_hash="x",
        )
        db.add_all([admin, user])
        db.commit()
        db.add(CreditWallet(user_id=user.id, available_units=0, reserved_units=0))
        db.commit()
        admin_id = admin.id
        user_id = user.id

    def adjust(_: int) -> None:
        with mysql_sessions() as db:
            adjust_credits(
                db,
                user_id=user_id,
                delta_units=500,
                reference_id="adjustment:mysql-concurrent",
                reason="concurrent retry test",
                admin_user_id=admin_id,
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(adjust, range(20)))

    with mysql_sessions() as db:
        assert db.get(CreditWallet, user_id).available_units == 500
        assert (
            db.query(CreditLedger)
            .filter(CreditLedger.reference_id == "adjustment:mysql-concurrent")
            .count()
            == 1
        )


def test_concurrent_duplicate_request_id_reserves_once(mysql_sessions, monkeypatch):
    from app import credits

    monkeypatch.setattr(credits.settings, "model_access_max_user_concurrency", 100)
    monkeypatch.setattr(credits.settings, "model_access_max_global_concurrency", 100)
    with mysql_sessions() as db:
        user = User(
            email="mysql-duplicate-request@example.com",
            account="mysql-duplicate-request",
            password_hash="x",
        )
        db.add(user)
        db.commit()
        grant_topup(db, user_id=user.id, units=1_000, reference_id="mysql-duplicate-topup")
        db.commit()
        user_id = user.id

    def reserve(_: int) -> str:
        with mysql_sessions() as db:
            try:
                reserve_request(
                    db,
                    request_id="mysql-shared-request-id",
                    user_id=user_id,
                    model="managed-model",
                    reserved_units=100,
                    price_version=1,
                    allow_existing=False,
                )
                db.commit()
                return "ok"
            except AuthError as exc:
                db.rollback()
                return exc.error

    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(reserve, range(20)))

    assert results.count("ok") == 1
    assert results.count("request_already_exists") == 19
    with mysql_sessions() as db:
        wallet = db.get(CreditWallet, user_id)
        assert (wallet.available_units, wallet.reserved_units) == (900, 100)
        assert (
            db.query(ModelRequest)
            .filter(ModelRequest.request_id == "mysql-shared-request-id")
            .count()
            == 1
        )
