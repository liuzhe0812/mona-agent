import secrets
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from notebook_relay.app import create_app
from notebook_relay.config import Settings
from notebook_relay.opencode_bridge import NativeError, OpenCodeBridge
from notebook_relay.opencode_codec import FREE_MODEL


def catalog_model(**overrides):
    model = {
        "providerID": "opencode",
        "modelID": FREE_MODEL,
        "limit": {"context": 200_000},
        "variants": [
            {"id": "low", "settings": {"reasoningEffort": "low"}},
            {"id": "high", "settings": {"reasoningEffort": "high"}},
            {"id": "max", "settings": {"reasoningEffort": "max"}},
        ],
    }
    model.update(overrides)
    return model


def catalog_response(*models):
    return {"data": list(models)}


def native_settings():
    return Settings(
        api_key=SecretStr(secrets.token_urlsafe(32)),
        upstream_provider="opencode_native",
    )


async def bridge_with_transport(handler, tmp_path=None):
    bridge = OpenCodeBridge(native_settings())
    bridge.client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:9900",
    )
    if tmp_path is not None:
        bridge.root = tmp_path.resolve()
        (bridge.root / "work").mkdir()
        bridge.process = SimpleNamespace(returncode=None)
    return bridge


async def test_load_model_capabilities_selects_the_exact_provider_and_translates_fields():
    requests = []

    async def control(request):
        requests.append(request)
        return httpx.Response(200, json=catalog_response(
            {**catalog_model(), "providerID": "other"},
            {**catalog_model(), "modelID": "different-model"},
            catalog_model(variants=[
                {"id": "low", "settings": {"reasoningEffort": "low"}},
                {"id": "low-alias", "settings": {"reasoningEffort": "low"}},
                {"id": "high", "settings": {"reasoningEffort": "high"}},
                {"id": "max", "settings": {"reasoningEffort": "max"}},
                {"id": "unknown", "settings": {"reasoningEffort": "ultra"}},
            ]),
        ))

    bridge = await bridge_with_transport(control)
    try:
        assert await bridge.load_model_capabilities() == {
            "context_window": 200_000,
            "reasoning_efforts": ["low", "high", "max"],
            "default_reasoning_effort": "high",
        }
        assert [(request.method, request.url.path) for request in requests] == [
            ("GET", "/api/model"),
        ]
    finally:
        await bridge.stop()


async def test_load_model_capabilities_fails_clearly_when_provider_or_target_is_missing():
    async def control(request):
        return httpx.Response(200, json=catalog_response(
            {**catalog_model(), "providerID": "other"},
        ))

    bridge = await bridge_with_transport(control)
    try:
        with pytest.raises(NativeError) as failure:
            await bridge.load_model_capabilities()
        assert failure.value.status == 503
        assert failure.value.code == "native_model_unavailable"
        assert "官方目录中没有目标免费模型" in str(failure.value)
    finally:
        await bridge.stop()


async def test_missing_catalog_fields_do_not_create_or_retain_capabilities():
    responses = iter((
        catalog_response(catalog_model()),
        catalog_response(catalog_model(
            limit={"context": "200000"},
            variants=[{"id": "unknown", "settings": {"reasoningEffort": "ultra"}}],
        )),
    ))

    async def control(request):
        return httpx.Response(200, json=next(responses))

    bridge = await bridge_with_transport(control)
    try:
        assert await bridge.load_model_capabilities() == {
            "context_window": 200_000,
            "reasoning_efforts": ["low", "high", "max"],
            "default_reasoning_effort": "high",
        }
        assert await bridge.load_model_capabilities() == {}
        assert bridge.model_capabilities == {}
    finally:
        await bridge.stop()


async def test_models_endpoint_uses_lifespan_capabilities_and_keeps_local_models_plain(monkeypatch):
    requests = []

    async def control(request):
        requests.append(request)
        return httpx.Response(200, json=catalog_response(catalog_model()))

    async def start(bridge):
        bridge.client = httpx.AsyncClient(
            transport=httpx.MockTransport(control), base_url="http://127.0.0.1:9900",
        )
        await bridge.load_model_capabilities()

    async def stop(bridge):
        await bridge.client.aclose()

    monkeypatch.setattr(OpenCodeBridge, "start", start)
    monkeypatch.setattr(OpenCodeBridge, "stop", stop)

    settings = native_settings()
    app = create_app(settings)
    async with app.router.lifespan_context(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay",
    ) as client:
        assert (await client.get("/v1/models")).status_code == 401
        response = await client.get(
            "/v1/models",
            headers={"Authorization": "Bearer " + settings.api_key.get_secret_value()},
        )
        assert response.status_code == 200
        model = response.json()["data"][0]
        assert model["id"] == FREE_MODEL
        assert model["context_window"] == 200_000
        assert model["reasoning_efforts"] == ["low", "high", "max"]
        assert model["default_reasoning_effort"] == "high"
    assert all(request.url.path == "/api/model" for request in requests)

    local_settings = Settings(
        api_key=SecretStr(secrets.token_urlsafe(32)), models=("local-model",),
    )
    local_app = create_app(local_settings)
    async with local_app.router.lifespan_context(local_app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=local_app), base_url="http://relay",
    ) as client:
        response = await client.get(
            "/v1/models",
            headers={"Authorization": "Bearer " + local_settings.api_key.get_secret_value()},
        )
    assert response.status_code == 200
    local_model = response.json()["data"][0]
    assert local_model["id"] == "local-model"
    assert "context_window" not in local_model
    assert "reasoning_efforts" not in local_model
    assert "default_reasoning_effort" not in local_model


async def test_open_defaults_to_declared_high_preserves_low_and_rejects_undeclared_before_job(tmp_path):
    session_number = 0
    bridge = None

    async def control(request):
        nonlocal session_number
        if request.url.path == "/api/model":
            return httpx.Response(200, json=catalog_response(catalog_model()))
        if request.method == "POST" and request.url.path == "/api/session":
            session_number += 1
            return httpx.Response(200, json={"data": {"id": f"session-{session_number}"}})
        if request.method == "GET" and request.url.path == "/api/plugin":
            directory = request.url.params["location[directory]"]
            job = next(job for job in bridge.jobs.values() if str(job.directory) == directory)
            job.registered.set()
            return httpx.Response(200, json={"data": []})
        if request.method == "POST" and request.url.path.endswith("/prompt"):
            session_id = request.url.path.split("/")[3]
            job = next(job for job in bridge.jobs.values() if job.session_id == session_id)
            job.status = 200
            job.content_type = "text/event-stream; charset=utf-8"
            job.ready.set()
            return httpx.Response(200, json={})
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(200, json={})

    bridge = await bridge_with_transport(control, tmp_path)
    request = {"model": FREE_MODEL, "messages": [{"role": "user", "content": "hello"}]}
    jobs = []
    try:
        await bridge.load_model_capabilities()
        defaulted = await bridge.open(request)
        jobs.append(defaulted)
        assert defaulted.context["options"]["reasoningEffort"] == "high"

        explicit = await bridge.open({**request, "reasoning_effort": "low"})
        jobs.append(explicit)
        assert explicit.context["options"]["reasoningEffort"] == "low"

        before = set(bridge.jobs)
        with pytest.raises(NativeError) as failure:
            await bridge.open({**request, "reasoning_effort": "medium"})
        assert failure.value.status == 400
        assert failure.value.code == "unsupported_native_request"
        assert set(bridge.jobs) == before
    finally:
        bridge.process.returncode = 1
        await bridge.stop()
