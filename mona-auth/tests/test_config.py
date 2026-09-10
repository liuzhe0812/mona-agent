import pytest


def test_get_pricing_config(client):
    res = client.get("/config/pricing")
    assert res.status_code == 200
    data = res.json()
    assert "plans" in data
    assert "contact" in data
    assert data["contact"]["email"]


def test_readiness_checks_credit_schema(client):
    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_production_runtime_rejects_weak_jwt_secret(monkeypatch):
    from app.config import settings, validate_runtime_settings

    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "jwt_access_secret", "short-secret")

    with pytest.raises(RuntimeError, match="JWT secret"):
        validate_runtime_settings()


def test_readiness_fails_when_enabled_model_gateway_is_down(client, monkeypatch):
    import httpx

    from app import main

    monkeypatch.setattr(main.settings, "model_access_enabled", True)
    monkeypatch.setattr(
        main.httpx,
        "get",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            httpx.ConnectError("connection refused")
        ),
    )

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["detail"] == "Managed model dependency is unavailable"
