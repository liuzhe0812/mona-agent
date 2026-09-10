from __future__ import annotations

import os
from decimal import Decimal
from urllib.parse import urlparse

from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from app.alipay import alipay_service
from app.auth import create_access_token
from app.database import SessionLocal
from app.main import app
from app.models import CreditProduct, CreditWallet, User

EXPECTED_DATABASE = "mona_auth_credits_test"
SMOKE_EMAIL = "credits-payment-smoke@example.invalid"
SMOKE_PRODUCT = "payment_smoke"
ALLOWED_PAYMENT_HOSTS = {
    "openapi.alipay.com",
    "openapi-sandbox.dl.alipaydev.com",
}


def _validate_target() -> None:
    database_url = os.environ.get("MONA_AUTH_DATABASE_URL", "")
    url = make_url(database_url)
    if url.database != EXPECTED_DATABASE:
        raise RuntimeError(f"Payment smoke only permits {EXPECTED_DATABASE}")
    if url.host not in {None, "localhost", "127.0.0.1"}:
        raise RuntimeError("Payment smoke database must be local to the VPS")
    if not os.environ.get("MONA_AUTH_ALIPAY_SELLER_ID"):
        raise RuntimeError("MONA_AUTH_ALIPAY_SELLER_ID is required")
    if os.environ.get("MONA_AUTH_CREDITS_PAYMENT_ENABLED", "").lower() != "true":
        raise RuntimeError("MONA_AUTH_CREDITS_PAYMENT_ENABLED must be true for the isolated smoke")
    if not alipay_service.enabled:
        raise RuntimeError("Existing Alipay software-payment configuration is unavailable")


def _seed() -> tuple[int, str]:
    with SessionLocal() as db:
        existing = db.query(User).filter(User.email == SMOKE_EMAIL).first()
        if existing is not None:
            db.delete(existing)
            db.commit()
        product = db.get(CreditProduct, SMOKE_PRODUCT)
        if product is None:
            product = CreditProduct(code=SMOKE_PRODUCT)
            db.add(product)
        product.name = "Payment smoke"
        product.price = Decimal("0.01")
        product.credit_units = 10_000
        product.enabled = True
        product.sort_order = 999
        user = User(
            email=SMOKE_EMAIL,
            account="credits_payment_smoke",
            password_hash="smoke-only",
        )
        db.add(user)
        db.flush()
        db.add(CreditWallet(user_id=user.id, available_units=0, reserved_units=0))
        db.commit()
        token, _ = create_access_token(user.id)
        return user.id, token


def _cleanup(user_id: int) -> None:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is not None:
            db.delete(user)
        product = db.get(CreditProduct, SMOKE_PRODUCT)
        if product is not None:
            db.delete(product)
        db.commit()


def main() -> None:
    _validate_target()
    user_id, token = _seed()
    headers = {"Authorization": f"Bearer {token}"}
    body = {
        "product_code": SMOKE_PRODUCT,
        "idempotency_key": "payment-smoke-idempotency-0001",
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        first = client.post("/credits/orders", json=body, headers=headers)
        second = client.post("/credits/orders", json=body, headers=headers)
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_body = first.json()
        second_body = second.json()
        assert first_body["order_id"] == second_body["order_id"]
        payment_url = first_body["payment_url"]
        parsed = urlparse(payment_url)
        assert parsed.scheme == "https"
        assert parsed.hostname in ALLOWED_PAYMENT_HOSTS
        history = client.get("/credits/orders?limit=10", headers=headers)
        assert history.status_code == 200, history.text
        orders = history.json()["orders"]
        assert len(orders) == 1
        assert orders[0]["amount"] == "0.01"
        assert orders[0]["balance_amount"] == "0.01"
        assert orders[0]["status"] == "pending"
        print("PASS: existing Alipay configuration loaded")
        print("PASS: deterministic balance recharge order idempotency")
        print("PASS: Alipay HTTPS payment URL allowlist")
        print("PASS: recent order projection")
        print("PAYMENT SMOKE PASSED WITHOUT OPENING OR PAYING THE ORDER")
    finally:
        _cleanup(user_id)


if __name__ == "__main__":
    main()
