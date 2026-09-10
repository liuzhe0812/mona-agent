import json
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest

from app.auth import create_access_token
from app.credits import grant_topup
from app.models import (
    CreditLedger,
    CreditWallet,
    ModelPrice,
    ModelPromotion,
    ModelRequest,
    ModelRequestStatus,
    User,
)


@pytest.fixture(autouse=True)
def enable_managed_models(monkeypatch):
    from app.routers import model_access_router

    monkeypatch.setattr(model_access_router.settings, "model_access_enabled", True)
    monkeypatch.setattr(model_access_router.settings, "one_api_token", "internal-test-token")


def _managed_user(db, *, units: int = 100_000):
    user = User(email="managed@example.com", account="managed", password_hash="x")
    db.add(user)
    db.commit()
    db.refresh(user)
    grant_topup(db, user_id=user.id, units=units, reference_id="payment:managed")
    db.add(
        ModelPrice(
            model="deepseek-v4-flash",
            version=1,
            input_rate=1_000_000,
            cached_input_rate=20_000,
            output_rate=2_000_000,
            enabled=True,
        )
    )
    db.commit()
    token, _ = create_access_token(user.id)
    return user, token


def _model_token(client, account_token: str) -> str:
    response = client.post(
        "/model-access/token",
        headers={"Authorization": f"Bearer {account_token}"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _mock_upstream(monkeypatch, handler):
    from app.routers import model_access_router
    from tests.conftest import TestingSessionLocal

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        model_access_router.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )
    monkeypatch.setattr(model_access_router.settings, "one_api_token", "internal-test-token")
    monkeypatch.setattr(model_access_router.settings, "one_api_base_url", "https://one-api.test")
    monkeypatch.setattr(model_access_router, "SessionLocal", TestingSessionLocal)


def test_model_token_scope_is_required(client, db):
    _, account_token = _managed_user(db)

    denied = client.get(
        "/v1/models",
        headers={"Authorization": f"Bearer {account_token}"},
    )
    model_token = _model_token(client, account_token)
    allowed = client.get(
        "/v1/models",
        headers={"Authorization": f"Bearer {model_token}"},
    )
    account_scope_denied = client.get(
        "/credits/balance",
        headers={"Authorization": f"Bearer {model_token}"},
    )

    assert denied.status_code == 401
    assert allowed.status_code == 200
    assert account_scope_denied.status_code == 401
    assert [item["id"] for item in allowed.json()["data"]] == ["deepseek-v4-flash"]


def test_account_can_read_active_managed_model_prices(client, db):
    _, account_token = _managed_user(db)

    response = client.get(
        "/model-access/prices",
        headers={"Authorization": f"Bearer {account_token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "prices": [
            {
                "model": "deepseek-v4-flash",
                "billing_type": "token",
                "rates": {},
                "input_amount_per_million": "1",
                "cached_input_amount_per_million": "0.02",
                "output_amount_per_million": "2",
            }
        ]
    }


def test_account_catalog_is_driven_by_active_prices_and_feature_flag(client, db, monkeypatch):
    _, account_token = _managed_user(db)
    headers = {"Authorization": f"Bearer {account_token}"}

    available = client.get("/model-access/catalog", headers=headers)
    assert available.status_code == 200
    assert available.json() == {
        "available": True,
        "models": [
            {
                "id": "deepseek-v4-flash",
                "name": "deepseek-v4-flash",
                "billing_type": "token",
                "rates": {},
                "input_amount_per_million": "1",
                "cached_input_amount_per_million": "0.02",
                "output_amount_per_million": "2",
            }
        ],
    }

    from app.routers import model_access_router

    monkeypatch.setattr(model_access_router.settings, "model_access_enabled", False)
    unavailable = client.get("/model-access/catalog", headers=headers)
    assert unavailable.status_code == 200
    assert unavailable.json() == {"available": False, "models": []}


def test_active_promotion_exposes_discounted_catalog_price(client, db):
    _, account_token = _managed_user(db)
    now = datetime.now(timezone.utc)
    db.add(
        ModelPromotion(
            model="deepseek-v4-flash",
            price_multiplier_bps=5_000,
            start_at=(now - timedelta(minutes=1)).replace(tzinfo=None),
            end_at=(now + timedelta(hours=1)).replace(tzinfo=None),
            enabled=True,
        )
    )
    db.commit()

    response = client.get(
        "/model-access/catalog",
        headers={"Authorization": f"Bearer {account_token}"},
    )
    prices_response = client.get(
        "/model-access/prices",
        headers={"Authorization": f"Bearer {account_token}"},
    )

    assert response.status_code == 200
    model = response.json()["models"][0]
    assert model["promotion_label"] == "↓50%"
    assert model["discount_percent"] == 50
    assert model["input_amount_per_million"] == "0.5"
    assert model["cached_input_amount_per_million"] == "0.01"
    assert model["output_amount_per_million"] == "1"
    assert model["original_input_amount_per_million"] == "1"
    assert model["original_cached_input_amount_per_million"] == "0.02"
    assert model["original_output_amount_per_million"] == "2"
    assert prices_response.status_code == 200
    assert prices_response.json()["prices"][0] == {
        "model": "deepseek-v4-flash",
        **{key: value for key, value in model.items() if key not in {"id", "name"}},
    }


def test_managed_model_feature_flag_fails_closed(client, db, monkeypatch):
    _, account_token = _managed_user(db)
    from app.routers import model_access_router

    monkeypatch.setattr(model_access_router.settings, "model_access_enabled", False)
    response = client.post(
        "/model-access/token",
        headers={"Authorization": f"Bearer {account_token}"},
    )

    assert response.status_code == 503
    assert response.json()["error"] == "managed_model_unavailable"


def test_expired_model_access_token_is_rejected(client, db):
    from app.config import settings

    user = User(email="expired-model@example.com", account="expired-model", password_hash="x")
    db.add(user)
    db.commit()
    expired = jwt.encode(
        {
            "sub": str(user.id),
            "scope": "model_access",
            "iat": datetime.now(timezone.utc) - timedelta(minutes=20),
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
        },
        settings.jwt_access_secret,
        algorithm="HS256",
    )

    response = client.get(
        "/v1/models",
        headers={"Authorization": f"Bearer {expired}"},
    )

    assert response.status_code == 401


def test_non_streaming_request_settles_real_usage(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        assert request.headers["authorization"] == "Bearer internal-test-token"
        body = json.loads(request.content)
        assert body["user"] == f"mona-{user.id}"
        assert body["n"] == 1
        assert not {
            "api_key",
            "api_base",
            "provider",
            "user_id",
            "max_completion_tokens",
            "best_of",
        }.intersection(body)
        assert body["stream"] is False
        from tests.conftest import TestingSessionLocal

        with TestingSessionLocal() as check_db:
            assert (
                check_db.get(ModelRequest, "request-0001").status
                == ModelRequestStatus.RUNNING
            )
            current_price = (
                check_db.query(ModelPrice)
                .filter(ModelPrice.model == "deepseek-v4-flash", ModelPrice.version == 1)
                .one()
            )
            current_price.enabled = False
            check_db.add(
                ModelPrice(
                    model="deepseek-v4-flash",
                    version=2,
                    input_rate=9_000_000,
                    cached_input_rate=9_000_000,
                    output_rate=9_000_000,
                    enabled=True,
                )
            )
            check_db.commit()
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 10,
                    "prompt_tokens_details": {"cached_tokens": 20},
                },
            },
        )

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
            "n": 5,
            "api_key": "client-supplied-key",
            "api_base": "https://attacker.invalid/v1",
            "provider": "attacker",
            "user_id": "spoofed-user",
            "max_completion_tokens": 999_999,
            "best_of": 10,
            "stream_options": {"include_usage": False},
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-0001",
        },
    )

    assert response.status_code == 200
    request = db.get(ModelRequest, "request-0001")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.SETTLED
    assert (request.prompt_tokens, request.completion_tokens, request.cached_tokens) == (
        100,
        10,
        20,
    )
    assert wallet.reserved_units == 0
    assert wallet.available_units == 99_899


def test_request_settles_with_promotion_snapshot_after_campaign_stops(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    now = datetime.now(timezone.utc)
    promotion = ModelPromotion(
        model="deepseek-v4-flash",
        price_multiplier_bps=5_000,
        start_at=(now - timedelta(minutes=1)).replace(tzinfo=None),
        end_at=(now + timedelta(hours=1)).replace(tzinfo=None),
        enabled=True,
    )
    db.add(promotion)
    db.commit()
    model_token = _model_token(client, account_token)

    def handler(_request: httpx.Request):
        from tests.conftest import TestingSessionLocal

        with TestingSessionLocal() as check_db:
            reserved = check_db.get(ModelRequest, "request-promotion-snapshot")
            assert reserved.price_version == 1
            assert reserved.promotion_id == promotion.id
            assert reserved.price_multiplier_bps == 5_000
            check_db.get(ModelPromotion, promotion.id).enabled = False
            current_price = check_db.query(ModelPrice).filter(ModelPrice.version == 1).one()
            current_price.enabled = False
            check_db.add(
                ModelPrice(
                    model="deepseek-v4-flash",
                    version=2,
                    input_rate=9_000_000,
                    cached_input_rate=9_000_000,
                    output_rate=9_000_000,
                    enabled=True,
                )
            )
            check_db.commit()
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 10,
                    "prompt_tokens_details": {"cached_tokens": 20},
                },
            },
        )

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-promotion-snapshot",
        },
    )

    assert response.status_code == 200
    request = db.get(ModelRequest, "request-promotion-snapshot")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.SETTLED
    assert request.price_version == 1
    assert request.price_multiplier_bps == 5_000
    assert request.actual_units == 51
    assert wallet.available_units == 99_949
    ledger = db.query(CreditLedger).filter(CreditLedger.reference_id == request.request_id).one()
    assert ledger.metadata_json["promotion_id"] == promotion.id
    assert ledger.metadata_json["price_multiplier_bps"] == 5_000


def test_streaming_final_usage_is_settled(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)
    stream_body = (
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request):
        return httpx.Response(200, text=stream_body, headers={"content-type": "text/event-stream"})

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
            "stream": True,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-0002",
        },
    )

    assert response.status_code == 200
    assert "data: [DONE]" in response.text
    request = db.get(ModelRequest, "request-0002")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.SETTLED
    assert wallet.reserved_units == 0
    assert wallet.available_units == 99_940


def test_insufficient_credits_never_calls_upstream(client, db, monkeypatch):
    _, account_token = _managed_user(db, units=1)
    model_token = _model_token(client, account_token)
    called = False

    def handler(request: httpx.Request):
        nonlocal called
        called = True
        return httpx.Response(200, json={})

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-0003",
        },
    )

    assert response.status_code == 402
    assert response.json()["error"] == "insufficient_credits"
    assert called is False


def test_duplicate_request_id_does_not_call_upstream_twice(client, db, monkeypatch):
    _, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)
    calls = 0

    def handler(request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    _mock_upstream(monkeypatch, handler)
    headers = {
        "Authorization": f"Bearer {model_token}",
        "X-Request-ID": "request-0004",
    }
    body = {
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "hello"}],
        "max_tokens": 100,
    }

    first = client.post("/v1/chat/completions", json=body, headers=headers)
    second = client.post("/v1/chat/completions", json=body, headers=headers)
    changed = client.post(
        "/v1/chat/completions",
        json={**body, "model": "different-model"},
        headers=headers,
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert changed.status_code == 409
    assert calls == 1


@pytest.mark.parametrize("request_id", [None, "bad id", "short"])
def test_missing_or_invalid_request_id_never_calls_upstream(
    request_id, client, db, monkeypatch
):
    _, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)
    called = False

    def handler(request: httpx.Request):
        nonlocal called
        called = True
        return httpx.Response(200, json={})

    _mock_upstream(monkeypatch, handler)
    headers = {"Authorization": f"Bearer {model_token}"}
    if request_id is not None:
        headers["X-Request-ID"] = request_id
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers=headers,
    )

    assert response.status_code == 422
    assert called is False


def test_connect_failure_releases_reservation(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        raise httpx.ConnectError("connection refused", request=request)

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-connect-failure",
        },
    )

    assert response.status_code == 502
    request = db.get(ModelRequest, "request-connect-failure")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.RELEASED
    assert (wallet.available_units, wallet.reserved_units) == (100_000, 0)


def test_ambiguous_upstream_failure_keeps_reservation(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        raise httpx.ReadTimeout("response timed out", request=request)

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-ambiguous-failure",
        },
    )

    assert response.status_code == 502
    request = db.get(ModelRequest, "request-ambiguous-failure")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert wallet.reserved_units == request.reserved_units


def test_request_id_collision_does_not_leak_other_user_status(client, db, monkeypatch):
    first_user, first_account_token = _managed_user(db)
    first_model_token = _model_token(client, first_account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    _mock_upstream(monkeypatch, handler)
    headers = {
        "Authorization": f"Bearer {first_model_token}",
        "X-Request-ID": "request-cross-user",
    }
    body = {
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "hello"}],
        "max_tokens": 100,
    }
    assert client.post("/v1/chat/completions", json=body, headers=headers).status_code == 200

    second_user = User(
        email="managed-second@example.com",
        account="managed-second",
        password_hash="x",
    )
    db.add(second_user)
    db.commit()
    grant_topup(
        db,
        user_id=second_user.id,
        units=100_000,
        reference_id="payment:managed-second",
    )
    db.commit()
    second_account_token, _ = create_access_token(second_user.id)
    second_model_token = _model_token(client, second_account_token)
    collision = client.post(
        "/v1/chat/completions",
        json=body,
        headers={
            "Authorization": f"Bearer {second_model_token}",
            "X-Request-ID": "request-cross-user",
        },
    )

    assert collision.status_code == 409
    assert collision.json() == {
        "error": "request_conflict",
        "detail": "Request ID is already in use",
    }
    assert db.get(ModelRequest, "request-cross-user").user_id == first_user.id


def test_database_failure_never_calls_upstream(client, db, monkeypatch):
    _, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)
    called = False

    def handler(request: httpx.Request):
        nonlocal called
        called = True
        return httpx.Response(200, json={})

    _mock_upstream(monkeypatch, handler)
    from app.routers import model_access_router

    monkeypatch.setattr(
        model_access_router,
        "_reserve",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    with pytest.raises(RuntimeError, match="database unavailable"):
        client.post(
            "/v1/chat/completions",
            json={
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 100,
            },
            headers={
                "Authorization": f"Bearer {model_token}",
                "X-Request-ID": "request-database-failure",
            },
        )

    assert called is False


def test_upstream_error_releases_reservation_without_leaking_body(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(500, json={"secret": "upstream-internal-detail"})

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-upstream-error",
        },
    )

    assert response.status_code == 500
    assert response.json() == {
        "error": {"type": "upstream_error", "message": "Model request failed"}
    }
    assert db.get(ModelRequest, "request-upstream-error").status == ModelRequestStatus.RELEASED
    assert db.get(CreditWallet, user.id).reserved_units == 0


def test_success_without_usage_becomes_uncertain(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
        )

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-missing-usage",
        },
    )

    assert response.status_code == 200
    request = db.get(ModelRequest, "request-missing-usage")
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert db.get(CreditWallet, user.id).reserved_units == request.reserved_units


@pytest.mark.parametrize("status_code", [401, 402, 429])
def test_upstream_rejection_releases_reservation(client, db, monkeypatch, status_code):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(status_code, json={"internal": "must-not-leak"})

    _mock_upstream(monkeypatch, handler)
    request_id = f"request-upstream-{status_code}"
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": request_id,
        },
    )

    assert response.status_code == status_code
    assert "must-not-leak" not in response.text
    assert db.get(ModelRequest, request_id).status == ModelRequestStatus.RELEASED
    assert db.get(CreditWallet, user.id).reserved_units == 0


def test_invalid_success_payload_becomes_uncertain(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            content=b"not-json",
            headers={"content-type": "application/json"},
        )

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 100,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-invalid-json",
        },
    )

    assert response.status_code == 502
    request = db.get(ModelRequest, "request-invalid-json")
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert db.get(CreditWallet, user.id).reserved_units == request.reserved_units


def test_usage_above_reservation_becomes_uncertain(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 50_000, "completion_tokens": 0},
            },
        )

    _mock_upstream(monkeypatch, handler)
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 1,
        },
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "request-usage-overage",
        },
    )

    assert response.status_code == 200
    request = db.get(ModelRequest, "request-usage-overage")
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert request.error_code == "usage_exceeds_reservation"
    assert db.get(CreditWallet, user.id).reserved_units == request.reserved_units


class BrokenStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        raise httpx.ReadError("stream interrupted")


class BrokenBeforeOutputStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        if False:
            yield b""
        raise httpx.ReadError("stream failed before output")


def test_stream_interruption_after_output_becomes_uncertain(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            stream=BrokenStream(),
            headers={"content-type": "text/event-stream"},
        )

    _mock_upstream(monkeypatch, handler)
    with pytest.raises(Exception, match="stream interrupted"):
        client.post(
            "/v1/chat/completions",
            json={
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 100,
                "stream": True,
            },
            headers={
                "Authorization": f"Bearer {model_token}",
                "X-Request-ID": "request-stream-interrupted",
            },
        )

    request = db.get(ModelRequest, "request-stream-interrupted")
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert db.get(CreditWallet, user.id).reserved_units == request.reserved_units


def test_stream_failure_before_output_still_becomes_uncertain(client, db, monkeypatch):
    user, account_token = _managed_user(db)
    model_token = _model_token(client, account_token)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            stream=BrokenBeforeOutputStream(),
            headers={"content-type": "text/event-stream"},
        )

    _mock_upstream(monkeypatch, handler)
    with pytest.raises(Exception, match="stream failed before output"):
        client.post(
            "/v1/chat/completions",
            json={
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 100,
                "stream": True,
            },
            headers={
                "Authorization": f"Bearer {model_token}",
                "X-Request-ID": "request-stream-before-output",
            },
        )

    request = db.get(ModelRequest, "request-stream-before-output")
    assert request.status == ModelRequestStatus.UNCERTAIN
    assert db.get(CreditWallet, user.id).reserved_units == request.reserved_units
