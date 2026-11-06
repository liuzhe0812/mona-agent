"""Account-scoped reasoning preferences and trusted Codex model capabilities."""

import asyncio
import json
from types import SimpleNamespace

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.codex_catalog import codex_catalog
from mona.hosted_work.contracts import NewSession, WorkError
from mona.hosted_work.desktop_api import PREFIX
from mona.hosted_work.model_access import model_context_window
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore
from mona.hosted_work.turn import WorkHook

ALICE, BOB, SID, RID = "a" * 64, "b" * 64, "1" * 32, "2" * 32


def configured(tmp_path):
    operator = tmp_path / "operator.json"
    operator.write_text(json.dumps({"hosted_work": {"codex": {"cli_path": str(tmp_path / "codex")}}}), encoding="utf-8")
    home = tmp_path / "development/native/codex"
    home.mkdir(parents=True)
    cache = home / "models_cache.json"
    cache.write_text(json.dumps({"identity": "must-not-escape", "models": [
        {"slug": "upstream-one", "context_window": 234567, "max_context_window": 999999,
         "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}, {"effort": "max"}],
         "default_reasoning_level": "low"},
        {"slug": "upstream-two", "context_window": 456789,
         "supported_reasoning_levels": [{"effort": "medium"}, {"effort": "high"}],
         "default_reasoning_level": "medium"},
    ]}), encoding="utf-8")
    config = HostedWorkConfig(enabled=True, state_dir=str(tmp_path), operator_config_path=str(operator),
        auth_origin="https://mona.example", public_origin="https://mona.example", max_concurrent_runs=4,
        models={"qwen": {"label": "Qwen", "model": "qwen-fixture", "billing_mode": "free"},
                "one": {"label": "One", "source": "codex", "model": "upstream-one", "billing_mode": "free"},
                "two": {"label": "Two", "source": "codex", "model": "upstream-two", "billing_mode": "free"}})
    return config, cache


class Auth:
    async def identity(self, token):
        if token == "alice":
            return ALICE
        if token == "bob":
            return BOB
        raise WorkError("login_required", "请先登录。", 401)


class Executor:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def execute(self, payload, _emit):
        self.calls.append(payload)
        self.started.set()
        await self.release.wait()
        return {"status": "completed", "content": "done", "workspace_saved": True, "artifacts": []}

    def cancel(self, *_args):
        self.release.set()


@pytest_asyncio.fixture
async def website(tmp_path):
    config, cache = configured(tmp_path)
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(ALICE, NewSession(request_id=SID))
    store.create_session(BOB, NewSession(request_id=SID))
    executor = Executor()
    service = WorkService(config, store, Auth(), executor)
    client = TestClient(TestServer(create_app(service)))
    await client.start_server()
    try:
        yield SimpleNamespace(config=config, cache=cache, store=store, executor=executor, service=service, client=client)
    finally:
        executor.release.set()
        await client.close()
        store.close()


def headers(token="alice"):
    return {"Authorization": "Bearer " + token, "Origin": "https://mona.example"}


async def select(client, model, effort=None, token="alice"):
    return await client.put(PREFIX + "/api/development/work-model-source", headers=headers(token),
        json={"executor": "mona", "provider": "openai", "model": model, "effort": effort})


def test_catalog_exposes_only_exact_model_capabilities(tmp_path):
    config, cache = configured(tmp_path)
    catalog = codex_catalog(config)
    assert catalog["upstream-one"].efforts == ("low", "high", "max")
    assert catalog["upstream-one"].default_effort == "low"
    assert catalog["upstream-one"].context_window == 234567
    assert "must-not-escape" not in repr(catalog)
    assert model_context_window(config.models["one"], config).tokens == 234567
    assert model_context_window(config.models["one"], config).source == "discovered"

    cache.write_text(json.dumps({"models": [
        {"slug": "upstream-one", "context_window": True,
         "supported_reasoning_levels": [{"effort": "high"}], "default_reasoning_level": "not-supported"},
        {"slug": "duplicate", "context_window": 12345}, {"slug": "duplicate", "context_window": 54321},
    ]}), encoding="utf-8")
    metadata = codex_catalog(config)
    assert metadata["upstream-one"].default_effort is None and metadata["upstream-one"].context_window is None
    assert "duplicate" not in metadata
    assert model_context_window(config.models["one"], config).source == "default"
    cache.unlink()
    assert codex_catalog(config) == {}


def test_catalog_rejects_linked_cache(tmp_path):
    config, cache = configured(tmp_path)
    cache.unlink()
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"models": [{"slug": "upstream-one", "context_window": 12345}]}), encoding="utf-8")
    try:
        cache.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links unavailable")
    assert codex_catalog(config) == {}


@pytest.mark.asyncio
async def test_preferences_are_per_account_model_and_underlying_identity(website):
    client = website.client
    first = await (await client.get(PREFIX + "/api/settings", headers=headers())).json()
    rows = next(group["models"] for group in first["chat_providers"] if group["name"] == "openai")
    by_id = {row["id"]: row for row in rows}
    assert by_id["one"]["reasoning_efforts"] == ["low", "high", "max"]
    assert by_id["one"]["default_reasoning_effort"] == by_id["one"]["reasoning_effort"] == "low"
    assert by_id["one"]["context_window"] == 234567

    assert (await select(client, "one", "high")).status == 200
    assert (await select(client, "one", "low", "bob")).status == 200
    assert (await select(client, "two", "high")).status == 200
    settings = await (await client.get(PREFIX + "/api/settings", headers=headers())).json()
    rows = next(group["models"] for group in settings["chat_providers"] if group["name"] == "openai")
    by_id = {row["id"]: row for row in rows}
    assert settings["agent"]["model"] == "two" and settings["agent"]["reasoning_effort"] == "high"
    assert by_id["one"]["reasoning_effort"] == "high" and by_id["one"]["default_reasoning_effort"] == "low"
    assert (await select(client, "one", by_id["one"]["reasoning_effort"])).status == 200
    selected = await (await client.get(PREFIX + "/api/settings", headers=headers())).json()
    assert selected["agent"]["context_window_tokens"] == 234567
    assert selected["agent"]["context_window_source"] == "discovered"
    bad = await select(client, "one", "ultra")
    assert bad.status == 422 and (await bad.json())["error"]["code"] == "unsupported_reasoning_effort"
    current = await (await client.get(PREFIX + "/api/settings", headers=headers())).json()
    other = await (await client.get(PREFIX + "/api/settings", headers=headers("bob"))).json()
    assert current["agent"]["reasoning_effort"] == "high"
    assert other["agent"]["reasoning_effort"] == "low"

    # Reusing a platform ID for a different upstream model cannot reuse its preference.
    website.config.models["one"].model = "upstream-two"
    current = await (await client.get(PREFIX + "/api/settings", headers=headers())).json()
    assert current["agent"]["reasoning_effort"] == "medium"
    website.service.desktop.state.close()
    reopened = await (await client.get(PREFIX + "/api/settings", headers=headers("bob"))).json()
    assert reopened["agent"]["reasoning_effort"] == "medium"


@pytest.mark.asyncio
async def test_missing_catalog_keeps_the_window_unknown(website):
    website.cache.unlink()
    response = await select(website.client, "one")
    assert response.status == 200
    settings = await response.json()
    row = next(row for group in settings["chat_providers"] for row in group["models"] if row["id"] == "one")
    assert row["context_window"] is None and "reasoning_efforts" not in row
    assert settings["agent"]["context_window_source"] == "default"


@pytest.mark.asyncio
async def test_http_turn_freezes_effort_and_retry_does_not_redispatch(website):
    client, executor = website.client, website.executor
    assert (await select(client, "one", "high")).status == 200
    route = f"/api/work/sessions/{SID}/runs"
    body = {"request_id": RID, "model_id": "one", "text": "test"}
    accepted = await client.post(route, headers=headers(), json=body)
    assert accepted.status == 202
    await asyncio.wait_for(executor.started.wait(), 3)
    assert executor.calls[0]["effective_reasoning_effort"] == "high"
    assert (await select(client, "one", "low")).status == 200
    assert (await client.post(route, headers=headers(), json=body)).status == 202
    assert len(executor.calls) == 1
    assert website.store.run(ALICE, RID)["input"]["effective_reasoning_effort"] == "high"
    forged = await client.post(route, headers=headers(), json={**body, "effective_reasoning_effort": "max"})
    assert forged.status == 400 and len(executor.calls) == 1
    task = website.service.tasks[(ALICE, RID)]
    executor.release.set()
    await asyncio.wait_for(task, 3)


@pytest.mark.asyncio
async def test_paid_retry_keeps_original_effort_and_price_snapshot(website, monkeypatch):
    from mona.config.schema import HostedWorkPrice

    model = website.config.models["one"]
    model.billing_mode = "wallet"
    model.price = HostedWorkPrice(input_amount_per_million="1", cached_input_amount_per_million="0.5",
                                  output_amount_per_million="2")
    website.config.billing_key_env = "MONA_WORK_BILLING_CAPABILITIES_TEST"
    monkeypatch.setenv(website.config.billing_key_env, "x" * 32)
    calls = []

    class Billing:
        def __init__(self, _config):
            pass

        async def reserve(self, charge, _token, reserved_model):
            calls.append(("reserve", charge, reserved_model.price.input_amount_per_million))
            return {"status": "reserved"}

        async def dispatch(self, charge):
            calls.append(("dispatch", charge))
            return {"status": "running"}

        async def settle(self, charge, usage):
            calls.append(("settle", charge, usage))
            return {"status": "settled", "actual_units": 4}

    monkeypatch.setattr("mona.hosted_work.service.HostedBilling", Billing)
    executor = website.executor
    original = executor.execute

    async def paid(payload, emit):
        result = await original(payload, emit)
        result["billing_usage"] = {"complete": True, "prompt_tokens": 2,
                                   "cached_tokens": 1, "completion_tokens": 1}
        return result

    executor.execute = paid
    client = website.client
    assert (await select(client, "one", "high")).status == 200
    route = f"/api/work/sessions/{SID}/runs"
    body = {"request_id": RID, "model_id": "one", "text": "test"}
    assert (await client.post(route, headers=headers(), json=body)).status == 202
    await asyncio.wait_for(executor.started.wait(), 3)
    assert (await select(client, "one", "low")).status == 200
    model.price.input_amount_per_million = "10"
    assert (await client.post(route, headers=headers(), json=body)).status == 202
    task = website.service.tasks[(ALICE, RID)]
    executor.release.set()
    await asyncio.wait_for(task, 3)
    assert website.store.run(ALICE, RID)["status"] == "completed"
    assert executor.calls[0]["effective_reasoning_effort"] == "high" and len(executor.calls) == 1
    assert [call[0] for call in calls] == ["reserve", "dispatch", "settle"]
    assert calls[0][2] == "1" and calls[-1][-1] == {
        "input_tokens": 2, "cached_input_tokens": 1, "output_tokens": 1,
    }


@pytest.mark.asyncio
async def test_websocket_turn_freezes_effort_across_retry(website):
    client, executor = website.client, website.executor
    assert (await select(client, "one", "high")).status == 200
    issued = await client.post(PREFIX + "/socket-ticket", headers=headers(), json={"client_id": "test-client"})
    ticket = (await issued.json())["ticket"]
    socket = await client.ws_connect(PREFIX + "/ws", params={"ticket": ticket, "client_id": "test-client"},
                                     headers={"Origin": "https://mona.example"})
    try:
        assert (await socket.receive_json())["event"] == "ready"
        frame = {"type": "message", "chat_id": SID, "input_id": "stable-input", "content": "test"}
        await socket.send_json(frame)
        async with asyncio.timeout(3):
            while (await socket.receive_json()).get("event") != "message_accepted":
                pass
            await executor.started.wait()
        assert executor.calls[0]["effective_reasoning_effort"] == "high"
        assert (await select(client, "one", "low")).status == 200
        await socket.send_json(frame)
        async with asyncio.timeout(3):
            while (await socket.receive_json()).get("event") != "message_accepted":
                pass
        assert len(executor.calls) == 1
        run_id = executor.calls[0]["run_id"]
        assert website.store.run(ALICE, run_id)["input"]["effective_reasoning_effort"] == "high"
        task = website.service.tasks[(ALICE, run_id)]
        executor.release.set()
        await asyncio.wait_for(task, 3)
    finally:
        await socket.close()


@pytest.mark.asyncio
async def test_frozen_effort_reaches_the_turn_provider(tmp_path, monkeypatch):
    from mona.config import loader
    from mona.hosted_work import turn

    config, _ = configured(tmp_path)
    monkeypatch.setattr(loader, "_current_config_path", tmp_path / "previous.json")
    observed = {}

    class Sandbox:
        def __init__(self, *_args):
            self.started = False

        async def start(self):
            self.started = True

        async def save(self):
            pass

        async def close(self):
            self.started = False

    class Provider:
        async def aclose(self):
            pass

    async def runner(current, payload, _sandbox, _provider, _emit, _authorize):
        observed["runner_effort"] = current.models[payload["model_id"]].reasoning_effort
        return {"status": "completed", "content": "done", "message": ""}

    def create(current, selection, _cwd):
        observed["provider_effort"] = selection.reasoning_effort
        observed["provider_model"] = selection.model
        return Provider()

    monkeypatch.setattr(turn, "DockerSandbox", Sandbox)
    monkeypatch.setattr(turn, "AuthClient", lambda _config: Auth())
    monkeypatch.setattr(turn, "create_provider", create)
    monkeypatch.setattr(turn, "run_turn", runner)
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    payload = {"action": "turn", "owner": ALICE, "run_id": RID, "model_id": "one", "account_token": "alice",
               "effective_reasoning_effort": "high"}
    await turn.execute_payload(config, payload, emit)
    assert observed == {"provider_effort": "high", "provider_model": "upstream-one", "runner_effort": "high"}
    assert events[-1][1]["status"] == "completed"


@pytest.mark.asyncio
async def test_hosted_provider_forwards_effort_to_codex_turn_start(tmp_path, monkeypatch):
    import sys

    from mona.config.schema import Config
    from mona.development.contracts import ExecutorId
    from mona.development.executors.codex import CodexExecutor
    from mona.development.executors.codex_policy import CodexProfile
    from mona.hosted_work.native_provider import HostedNativeWorkProvider

    root = tmp_path / "workspace"
    root.mkdir()
    catalog = tmp_path / "catalog.json"
    catalog.write_text("{}", encoding="utf-8")
    config = Config()
    config.agents.defaults.executor = "codex"
    config.development.enabled_engines = ["codex"]
    config.development.codex_path = sys.executable
    profile = CodexProfile((sys.executable,), tmp_path / "native-home", root.resolve(), {}, work_model_catalog=catalog)

    class FakeRpc:
        def __init__(self):
            self.closed = False
            self.calls = []

        async def request(self, method, params=None, **_kwargs):
            self.calls.append((method, params))
            if method == "account/read":
                return {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True}
            if method == "thread/start":
                return {"thread": {"id": "thread", "cwd": params["cwd"], "turns": [], "status": {"type": "idle"}},
                        "instructionSources": [], "sandbox": {"type": "readOnly"},
                        "approvalPolicy": params["approvalPolicy"], "approvalsReviewer": params["approvalsReviewer"]}
            if method == "turn/start":
                return {"turn": {"id": "turn"}}
            raise AssertionError("unexpected RPC method: " + method)

        async def close(self):
            self.closed = True

    rpc = FakeRpc()

    async def start(host):
        host._client = rpc
        return rpc

    async def check_policy(_host, _client):
        pass

    monkeypatch.setattr(CodexExecutor, "_ensure_started", start)
    monkeypatch.setattr(CodexExecutor, "_check_policy", check_policy)
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda _config: [
        SimpleNamespace(executor=ExecutorId.CODEX, state="detected", executable=sys.executable)
    ])
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile",
                        lambda *_args, **_kwargs: (profile, catalog))
    provider = HostedNativeWorkProvider(config, root)
    try:
        await provider._start([{"role": "system", "content": "Mona"}, {"role": "user", "content": "test"}],
                              [], "native-fixture", "high")
        thread = next(params for method, params in rpc.calls if method == "thread/start")
        sent = next(params for method, params in rpc.calls if method == "turn/start")
        assert thread["model"] == "native-fixture" and sent["effort"] == "high"
    finally:
        provider._done = True
        await provider.aclose()
    assert rpc.closed


@pytest.mark.asyncio
async def test_progress_attributes_context_to_actual_model_provider():
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    hook = WorkHook(emit, payload={"model_id": "one"},
                    runtime=SimpleNamespace(selection=SimpleNamespace(source="codex")))
    await hook._transport_progress("", token_usage={"context_tokens": 100, "context_window_tokens": 234567})
    assert events[0][1]["token_usage"] == {"context_tokens": 100, "context_window_tokens": 234567,
                                            "context_model": "one", "context_provider": "openai"}


@pytest.mark.asyncio
async def test_subagent_uses_the_frozen_model_provider_and_effort(tmp_path):
    from unittest.mock import AsyncMock

    from mona.agent.hook import AgentHook
    from mona.hosted_work.subagent_spec import build_subagent_factory
    from tests.hosted_work.test_subagent_spec import _fixture

    ctx, payload, sandbox, emit, origin = _fixture(tmp_path)
    ctx.selection.source = "codex"
    factory, _children = build_subagent_factory(ctx, payload, sandbox, None, emit, None)
    spec = await factory("child-1", "Inspect", origin, AgentHook(), AsyncMock())
    assert spec.context_provider == "openai" and spec.reasoning_effort == "high"
    ctx.selection.source = "mona"
    other = await factory("child-2", "Inspect", origin, AgentHook(), AsyncMock())
    assert other.context_provider == "mona_managed"
