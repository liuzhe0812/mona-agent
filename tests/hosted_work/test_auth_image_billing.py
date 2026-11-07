"""The isolated Auth sidecar settles image receipts once against the shared wallet."""
import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("sqlalchemy")
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mona-auth"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_image_receipt_settles_once_without_touching_text_charge(tmp_path, monkeypatch):
    # Auth settings load .env from the process cwd; never read the workspace's secrets in tests.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(tmp_path / "unused.sqlite3").replace("\\", "/"))
    from app.database import Base
    from app.errors import AuthError
    from app.models import CreditLedger, CreditWallet, User

    deploy = ROOT / "deploy/hosted-work/auth-billing"
    billing = load("app.hosted_work_billing", deploy / "hosted_work_billing.py")
    load("app.hosted_work_image_pricing", ROOT / "mona/hosted_work/image_pricing.py")
    image = load("app.hosted_work_image_billing", deploy / "hosted_work_image_billing.py")
    router = load("app.routers.hosted_work_billing_router", deploy / "hosted_work_billing_router.py")
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    price = {"kind": "image_per_image_v1", "amount_per_image": "0.000004"}
    receipt = {"sha256": "a" * 64, "image_count": 1}
    operation = "a" * 32
    request = router.ImageReserve(run_id=operation, model="gpt-image-test", reserve_units=4,
                                  price={key: value for key, value in price.items() if key != "kind"})
    assert request.price.amount_per_image == "0.000004"
    with pytest.raises(ValueError):
        router.ImageReserve(run_id=operation, model="gpt-image-test", reserve_units=0, price=request.price)
    with Session(engine, expire_on_commit=False) as db:
        db.add(User(id=1, email="test@example.invalid", password_hash="test"))
        db.add(CreditWallet(user_id=1, available_units=100, reserved_units=0, active_requests=0, version=0))
        db.commit()
        billing.reserve(db, run_id=operation, user_id=1, model="gpt-image-test", price=price, reserved=4)
        billing.dispatch(db, operation)
        result = image.settle_image(db, operation, receipt)
        assert result.status == "settled" and result.actual_units == 4
        wallet = db.get(CreditWallet, 1)
        assert (wallet.available_units, wallet.reserved_units) == (96, 0)
        assert db.query(CreditLedger).count() == 1
        assert image.settle_image(db, operation, receipt).actual_units == 4
        assert db.query(CreditLedger).count() == 1
        with pytest.raises(AuthError):
            image.settle_image(db, operation, {**receipt, "sha256": "b" * 64})
        with pytest.raises(AuthError):
            billing.settle(db, operation, receipt)
        second = "b" * 32
        billing.reserve(db, run_id=second, user_id=1, model="gpt-image-test", price=price, reserved=4)
        billing.dispatch(db, second)
        assert image.settle_image(db, second, receipt).actual_units == 4
        assert (wallet.available_units, wallet.reserved_units) == (92, 0)
        assert db.query(CreditLedger).count() == 2
        text_operation = "c" * 32
        text_price = {"input_amount_per_million": "0.1", "cached_input_amount_per_million": "0.2",
                      "output_amount_per_million": "0.3"}
        billing.reserve(db, run_id=text_operation, user_id=1, model="text-test", price=text_price, reserved=20)
        billing.dispatch(db, text_operation)
        text_usage = {"input_tokens": 10, "cached_input_tokens": 2, "output_tokens": 5}
        assert billing.settle(db, text_operation, text_usage).actual_units == 4
        assert (wallet.available_units, wallet.reserved_units) == (88, 0)
        assert db.query(CreditLedger).count() == 3
        unstarted = "d" * 32
        billing.reserve(db, run_id=unstarted, user_id=1, model="gpt-image-test", price=price, reserved=4)
        billing.dispatch(db, unstarted)
        assert image.release_image_not_started(db, unstarted).status == "released"
        assert (wallet.available_units, wallet.reserved_units) == (88, 0)
        assert db.query(CreditLedger).count() == 3
    engine.dispose()
