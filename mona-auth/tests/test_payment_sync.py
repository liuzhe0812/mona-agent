from datetime import datetime
from decimal import Decimal

import pytest

from app.alipay import alipay_service
from app.config import settings
from app.models import CreditLedger, CreditWallet, Payment, PaymentStatus, User
from app.routers.subscribe_router import _handle_trade_success_notify, sync_payment_status


@pytest.fixture
def payment(db, monkeypatch):
    monkeypatch.setattr(alipay_service, "_client", object())
    monkeypatch.setattr(alipay_service, "_enabled", True)
    monkeypatch.setattr(settings, "alipay_app_id", "test-app")
    monkeypatch.setattr(settings, "alipay_seller_id", "test-seller")
    user = User(email="sync@example.com", account="sync", password_hash="x")
    db.add(user)
    db.flush()
    order = Payment(
        user_id=user.id,
        trade_order_id="sync-credit-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        product_type="credit_topup",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(order)
    db.commit()
    return order


def paid_result():
    return {
        "code": "10000",
        "trade_status": "TRADE_SUCCESS",
        "trade_no": "sync-provider-trade",
        "total_amount": "1.00",
    }


@pytest.mark.parametrize("result", [
    {"code": "20000"},
    {"code": "40004", "sub_code": "ACQ.ACCESS_FORBIDDEN"},
    {"code": "10000", "trade_status": "UNKNOWN"},
])
def test_explicit_sync_reports_provider_errors_without_crediting(db, payment, monkeypatch, result):
    monkeypatch.setattr(alipay_service, "query_trade", lambda **_: result)
    with pytest.raises(RuntimeError, match="Payment provider"):
        sync_payment_status(db, payment, strict=True)
    assert payment.status == PaymentStatus.PENDING
    assert db.query(CreditLedger).count() == 0


@pytest.mark.parametrize("result", [
    {"code": "10000", "trade_status": "WAIT_BUYER_PAY"},
    {"code": "40004", "sub_code": "ACQ.TRADE_NOT_EXIST"},
])
def test_waiting_or_not_yet_created_trade_stays_pending(db, payment, monkeypatch, result):
    monkeypatch.setattr(alipay_service, "query_trade", lambda **_: result)
    sync_payment_status(db, payment, strict=True)
    assert payment.status == PaymentStatus.PENDING
    assert db.query(CreditLedger).count() == 0


def test_explicit_sync_reports_unavailable_provider(db, payment, monkeypatch):
    monkeypatch.setattr(alipay_service, "_enabled", False)
    with pytest.raises(RuntimeError, match="unavailable"):
        sync_payment_status(db, payment, strict=True)


@pytest.mark.asyncio
async def test_rejected_callback_can_recover_through_verified_provider_query(db, payment, monkeypatch):
    with pytest.raises(ValueError, match="seller_id mismatch"):
        await _handle_trade_success_notify(db, {
            "app_id": "test-app",
            "seller_id": "different-seller",
            "out_trade_no": payment.trade_order_id,
            "total_amount": "1.00",
        }, "sync-provider-trade")
    db.rollback()
    assert db.query(CreditLedger).count() == 0
    monkeypatch.setattr(alipay_service, "query_trade", lambda **_: paid_result())
    sync_payment_status(db, payment, strict=True)
    sync_payment_status(db, payment, strict=True)
    assert payment.status == PaymentStatus.PAID
    assert payment.fulfillment_status == "succeeded"
    assert db.query(CreditLedger).count() == 1
    assert db.query(CreditWallet).one().available_units == 1_000_000


def test_sync_reloads_fulfillment_committed_during_provider_query(db, payment, monkeypatch):
    from sqlalchemy.orm import Session

    from app.routers.subscribe_router import _fulfill_payment

    paid_at = datetime(2026, 9, 8, 9, 0)

    def query(**_):
        with Session(db.bind) as callback_db:
            callback_payment = callback_db.get(Payment, payment.id)
            _fulfill_payment(callback_db, callback_payment, "sync-provider-trade")
            callback_payment.paid_at = paid_at
            callback_db.commit()
        return paid_result()

    monkeypatch.setattr(alipay_service, "query_trade", query)
    sync_payment_status(db, payment, strict=True)
    assert payment.paid_at == paid_at
    assert db.query(CreditLedger).count() == 1
    assert db.query(CreditWallet).one().available_units == 1_000_000


def test_background_sync_recovers_paid_unfulfilled_orders_after_another_order_fails(
    db, payment, monkeypatch,
):
    from app import scheduler

    other = Payment(
        user_id=payment.user_id,
        trade_order_id="paid-unfulfilled-order",
        amount=Decimal("1.00"),
        status=PaymentStatus.PAID,
        payment_channel="alipay",
        product_type="credit_topup",
        credit_units=1_000_000,
        fulfillment_status="not_started",
    )
    db.add(other)
    db.commit()

    def query(*, out_trade_no):
        if out_trade_no == payment.trade_order_id:
            return {**paid_result(), "total_amount": "2.00"}
        return paid_result()

    # The scheduler owns and closes its session, so use a separate real session.
    from sqlalchemy.orm import sessionmaker

    monkeypatch.setattr(scheduler, "SessionLocal", sessionmaker(bind=db.bind))
    monkeypatch.setattr(alipay_service, "query_trade", query)
    scheduler.sync_pending_payments_job()
    db.expire_all()
    assert payment.status == PaymentStatus.PENDING
    assert other.fulfillment_status == "succeeded"
    assert db.query(CreditLedger).count() == 1
    assert db.query(CreditWallet).one().available_units == 1_000_000
