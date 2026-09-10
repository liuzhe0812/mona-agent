from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from threading import Barrier

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import credits
from app.credits import (
    active_request_counter_snapshot,
    adjust_credits,
    grant_topup,
    reconcile_wallets,
    recover_stale_requests,
    release_request,
    reserve_request,
)
from app.database import Base
from app.errors import AuthError
from app.models import (
    CreditLedger,
    CreditWallet,
    ModelGatewayLock,
    ModelRequest,
    ModelRequestStatus,
    Payment,
    PaymentStatus,
    User,
)
from app.routers import subscribe_router
from app.routers.subscribe_router import _handle_trade_success_notify

EXPECTED_DATABASE = "mona_auth_credits_test"


def _sessions():
    database_url = os.environ.get("MONA_TEST_DATABASE_URL", "")
    if not database_url:
        raise RuntimeError("MONA_TEST_DATABASE_URL is required")
    url = make_url(database_url)
    if url.database != EXPECTED_DATABASE:
        raise RuntimeError(f"Acceptance runner only permits {EXPECTED_DATABASE}")
    if url.host not in {None, "localhost", "127.0.0.1"}:
        raise RuntimeError("Acceptance database must be reached through the local VPS")
    engine = create_engine(database_url, pool_size=30, max_overflow=10, pool_pre_ping=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with sessions() as db:
        db.add(ModelGatewayLock(id=1))
        db.commit()
    return engine, sessions


def _new_user(db, suffix: str, *, admin: bool = False) -> User:
    user = User(
        email=f"credits-{suffix}@example.invalid",
        account=f"credits_{suffix}",
        password_hash="acceptance-only",
        is_admin=admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _release_all(sessions, request_ids: list[str]) -> None:
    with sessions() as db:
        for request_id in request_ids:
            release_request(db, request_id=request_id, error_code="acceptance_cleanup")
        db.commit()


def check_concurrent_balance(sessions) -> None:
    credits.settings.model_access_max_user_concurrency = 100
    credits.settings.model_access_max_global_concurrency = 100
    with sessions() as db:
        user = _new_user(db, "balance")
        grant_topup(db, user_id=user.id, units=1_000, reference_id="acceptance:balance")
        db.commit()
        user_id = user.id

    barrier = Barrier(10)

    def reserve(index: int) -> str:
        with sessions() as db:
            barrier.wait()
            try:
                reserve_request(
                    db,
                    request_id=f"acceptance-balance-{index}",
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
    assert results.count("ok") == 5, results
    assert results.count("insufficient_credits") == 5, results
    with sessions() as db:
        wallet = db.get(CreditWallet, user_id)
        assert (wallet.available_units, wallet.reserved_units) == (0, 1_000)
        request_ids = [row.request_id for row in db.query(ModelRequest).all()]
    _release_all(sessions, request_ids)


def check_global_capacity(sessions) -> None:
    credits.settings.model_access_max_user_concurrency = 1
    credits.settings.model_access_max_global_concurrency = 3
    user_ids: list[int] = []
    with sessions() as db:
        for index in range(10):
            user = _new_user(db, f"capacity_{index}")
            grant_topup(
                db,
                user_id=user.id,
                units=10,
                reference_id=f"acceptance:capacity:{index}",
            )
            db.commit()
            user_ids.append(user.id)

    barrier = Barrier(10)

    def reserve(index: int) -> str:
        with sessions() as db:
            barrier.wait()
            try:
                reserve_request(
                    db,
                    request_id=f"acceptance-capacity-{index}",
                    user_id=user_ids[index],
                    model="managed-model",
                    reserved_units=1,
                    price_version=1,
                )
                db.commit()
                return "ok"
            except AuthError as exc:
                db.rollback()
                return exc.error

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(reserve, range(10)))
    assert results.count("ok") == 3, results
    assert results.count("model_capacity_exceeded") == 7, results
    _release_all(
        sessions,
        [f"acceptance-capacity-{index}" for index, result in enumerate(results) if result == "ok"],
    )


def check_duplicate_request(sessions) -> None:
    credits.settings.model_access_max_user_concurrency = 100
    credits.settings.model_access_max_global_concurrency = 100
    with sessions() as db:
        user = _new_user(db, "duplicate")
        grant_topup(db, user_id=user.id, units=1_000, reference_id="acceptance:duplicate")
        db.commit()
        user_id = user.id

    barrier = Barrier(20)

    def reserve(_: int) -> str:
        with sessions() as db:
            barrier.wait()
            try:
                reserve_request(
                    db,
                    request_id="acceptance-shared-request",
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
    assert results.count("ok") == 1, results
    assert results.count("request_already_exists") == 19, results
    with sessions() as db:
        wallet = db.get(CreditWallet, user_id)
        assert (wallet.available_units, wallet.reserved_units) == (900, 100)
        assert db.query(ModelRequest).filter_by(request_id="acceptance-shared-request").count() == 1
    _release_all(sessions, ["acceptance-shared-request"])


def check_payment_callback(sessions) -> None:
    subscribe_router.settings.alipay_app_id = "acceptance-app"
    subscribe_router.settings.alipay_seller_id = "acceptance-seller"
    with sessions() as db:
        user = _new_user(db, "payment")
        payment = Payment(
            user_id=user.id,
            trade_order_id="acceptance-credit-order",
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
        "out_trade_no": "acceptance-credit-order",
        "total_amount": "10.00",
        "app_id": "acceptance-app",
        "seller_id": "acceptance-seller",
    }
    barrier = Barrier(20)

    def callback(_: int) -> None:
        with sessions() as db:
            barrier.wait()
            asyncio.run(
                _handle_trade_success_notify(db, data, "acceptance-alipay-trade")
            )

    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(callback, range(20)))
    with sessions() as db:
        assert db.get(CreditWallet, user_id).available_units == 10_000
        assert db.query(CreditLedger).filter_by(reference_id="payment:acceptance-credit-order").count() == 1


def check_adjustment(sessions) -> None:
    with sessions() as db:
        admin = _new_user(db, "adjust_admin", admin=True)
        user = _new_user(db, "adjust_user")
        db.add(CreditWallet(user_id=user.id, available_units=0, reserved_units=0))
        db.commit()
        admin_id, user_id = admin.id, user.id

    barrier = Barrier(20)

    def adjust(_: int) -> None:
        with sessions() as db:
            barrier.wait()
            adjust_credits(
                db,
                user_id=user_id,
                delta_units=500,
                reference_id="adjustment:acceptance-concurrent",
                reason="acceptance concurrent retry",
                admin_user_id=admin_id,
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(adjust, range(20)))
    with sessions() as db:
        assert db.get(CreditWallet, user_id).available_units == 500
        assert db.query(CreditLedger).filter_by(reference_id="adjustment:acceptance-concurrent").count() == 1


def check_stale_recovery(sessions) -> None:
    credits.settings.model_access_reserved_stale_seconds = 60
    credits.settings.model_access_running_stale_seconds = 60
    credits.settings.model_access_max_user_concurrency = 1
    credits.settings.model_access_max_global_concurrency = 100
    with sessions() as db:
        reserved_user = _new_user(db, "stale_reserved")
        running_user = _new_user(db, "stale_running")
        for index, user in enumerate((reserved_user, running_user), start=1):
            grant_topup(db, user_id=user.id, units=100, reference_id=f"acceptance:stale:{index}")
            reserve_request(
                db,
                request_id=f"acceptance-stale-{index}",
                user_id=user.id,
                model="managed-model",
                reserved_units=10,
                price_version=1,
            )
        old = datetime.now(timezone.utc) - timedelta(minutes=5)
        db.get(ModelRequest, "acceptance-stale-1").created_at = old
        running = db.get(ModelRequest, "acceptance-stale-2")
        running.created_at = old
        running.status = ModelRequestStatus.RUNNING
        db.commit()
        reserved_user_id = reserved_user.id
        running_user_id = running_user.id

    with sessions() as db:
        result = recover_stale_requests(db)
        db.commit()
        assert result == {"released": 1, "uncertain": 1}
        assert db.get(CreditWallet, reserved_user_id).available_units == 100
        assert db.get(CreditWallet, running_user_id).reserved_units == 10
        release_request(db, request_id="acceptance-stale-2", error_code="acceptance_cleanup")
        db.commit()


def main() -> None:
    engine, sessions = _sessions()
    checks = [
        ("concurrent balance", check_concurrent_balance),
        ("global capacity", check_global_capacity),
        ("duplicate request", check_duplicate_request),
        ("payment callback", check_payment_callback),
        ("adjustment retry", check_adjustment),
        ("stale recovery", check_stale_recovery),
    ]
    try:
        for label, check in checks:
            check(sessions)
            print(f"PASS: {label}")
        with sessions() as db:
            assert reconcile_wallets(db) == []
            assert active_request_counter_snapshot(db)["ok"] is True
        print("PASS: wallet reconciliation")
        print("PASS: active request counters")
        print("MYSQL ACCEPTANCE PASSED")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
