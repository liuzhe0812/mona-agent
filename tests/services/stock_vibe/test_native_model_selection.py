from __future__ import annotations

import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import (
    Config,
    ProviderConfig,
    StockVibeModelBinding,
    _resolve_tool_config_refs,
)
from mona.materials.auth import get_services_token, materials_auth_middleware
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime

PREFIX = "/api/stock-vibe"


def _native_binding(model: str = "account-model") -> dict:
    return {"executor": "codebuddy", "model": model, "provider": None, "effort": None}


async def _app(
    tmp_path,
    monkeypatch,
    *,
    enabled_engines: list[str] | None = None,
    model_writer=None,
    model_binding_writer=None,
):
    _resolve_tool_config_refs()
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "mona"))
    monkeypatch.delenv("MONA_SERVICES_TOKEN", raising=False)
    config = Config()
    config.stock_vibe.model_preset = None
    config.stock_vibe.model_binding = None
    config.development.enabled_engines = enabled_engines if enabled_engines is not None else ["codebuddy"]
    config.agents.defaults.model = "global-model"
    config.agents.defaults.provider = "openai"
    config.providers.openai = ProviderConfig(api_key="synthetic-placeholder")
    runtime = StockVibeRuntime(
        runtime_root=tmp_path / "no-runtime",
        data_root=tmp_path / "stock-vibe" / "native",
        config_loader=lambda: config,
    )
    writes: list[tuple[str, object]] = []

    def write_model(value: str | None) -> None:
        writes.append(("preset", value))
        if model_writer is not None:
            model_writer(config, value)
        else:
            config.stock_vibe.model_preset = value
            config.stock_vibe.model_binding = None

    def write_binding(value: dict) -> None:
        writes.append(("binding", value))
        if model_binding_writer is not None:
            model_binding_writer(config, value)
        else:
            config.stock_vibe.model_binding = StockVibeModelBinding.model_validate(value)
            config.stock_vibe.model_preset = None

    app = web.Application(middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(
        app,
        runtime=runtime,
        model_writer=write_model,
        model_binding_writer=write_binding,
        attention_writer=lambda _values: None,
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, runtime, config, writes, {"X-Mona-Token": get_services_token()}


async def test_native_binding_is_saved_and_api_selection_clears_it_without_changing_global_model(
    tmp_path, monkeypatch
):
    client, runtime, config, writes, auth = await _app(tmp_path, monkeypatch)
    global_model = config.agents.defaults.model_dump()
    provider = config.providers.openai.model_dump()
    binding = _native_binding()
    native_body = {"model_preset": None, "model_binding": binding}
    native_id = uuid.uuid4().hex

    async with client:
        initial_status = await (await client.get(PREFIX, headers=auth)).json()
        assert initial_status["model_binding"] is None

        saved = await client.put(
            PREFIX + "/model",
            headers={**auth, "X-Mona-Request-ID": native_id},
            json=native_body,
        )
        assert saved.status == 200, await saved.text()
        receipt = await saved.json()
        assert receipt["receipt"]["body"] == native_body
        assert writes == [("binding", binding)]
        assert config.stock_vibe.model_binding.model_dump(mode="json") == binding
        assert config.stock_vibe.model_preset is None
        status = await (await client.get(PREFIX, headers=auth)).json()
        assert status["model_binding"] == binding
        assert status["model_preset"] is None

        api_body = {"model_preset": "default"}
        switched = await client.put(
            PREFIX + "/model",
            headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex},
            json=api_body,
        )
        assert switched.status == 200, await switched.text()
        assert (await switched.json())["receipt"]["body"] == api_body
        assert writes[-1] == ("preset", "default")
        assert config.stock_vibe.model_binding is None
        assert config.stock_vibe.model_preset == "default"
        assert config.agents.defaults.model_dump() == global_model
        assert config.providers.openai.model_dump() == provider
    await runtime.close()


async def test_disabled_native_engine_is_rejected_without_saving(tmp_path, monkeypatch):
    client, runtime, config, writes, auth = await _app(tmp_path, monkeypatch, enabled_engines=[])
    async with client:
        response = await client.put(
            PREFIX + "/model",
            headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex},
            json={"model_preset": None, "model_binding": _native_binding()},
        )
        assert response.status == 200, await response.text()
        receipt = await response.json()
        assert receipt["status"] == "rejected"
        assert receipt["receipt"]["status_code"] == 400
        assert config.stock_vibe.model_binding is None
        assert config.stock_vibe.model_preset is None
        assert writes == []
    await runtime.close()


async def test_replaying_completed_native_selection_does_not_write_twice(tmp_path, monkeypatch):
    client, runtime, config, writes, auth = await _app(tmp_path, monkeypatch)
    request_id = uuid.uuid4().hex
    body = {"model_preset": None, "model_binding": _native_binding()}
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        first = await client.put(PREFIX + "/model", headers=headers, json=body)
        replay = await client.put(PREFIX + "/model", headers=headers, json=body)
        first_payload = await first.json()
        replay_payload = await replay.json()
        assert first.status == replay.status == 200
        assert replay_payload["receipt"] == first_payload["receipt"]
        assert writes == [("binding", body["model_binding"])]
        assert config.stock_vibe.model_binding.model == "account-model"
    await runtime.close()


async def test_unknown_native_binding_with_different_saved_value_stays_unconfirmed(tmp_path, monkeypatch):
    def commit_different_binding_then_fail(config, _value):
        config.stock_vibe.model_binding = StockVibeModelBinding.model_validate(_native_binding("other-model"))
        config.stock_vibe.model_preset = None
        raise OSError("synthetic lost confirmation")

    client, runtime, config, writes, auth = await _app(
        tmp_path,
        monkeypatch,
        model_binding_writer=commit_different_binding_then_fail,
    )
    request_id = uuid.uuid4().hex
    body = {"model_preset": None, "model_binding": _native_binding()}
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        first = await client.put(PREFIX + "/model", headers=headers, json=body)
        assert first.status == 202
        assert (await first.json())["status"] == "unknown"

        replay = await client.put(PREFIX + "/model", headers=headers, json=body)
        assert replay.status == 202
        payload = await replay.json()
        assert payload["status"] == "unknown"
        assert payload["receipt"] is None
        assert config.stock_vibe.model_binding.model == "other-model"
        assert writes == [("binding", body["model_binding"])]
    await runtime.close()
