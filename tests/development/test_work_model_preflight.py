import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.agent.partners import AgentDefinition
from mona.agent.tools.apply_patch import ApplyPatchTool
from mona.agent.tools.exec_session import WriteStdinTool
from mona.agent.tools.filesystem import ReadFileTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.shell import ExecTool
from mona.agent.user_config import AgentUserConfig, load_agent_user_config, save_agent_user_config
from mona.config.loader import load_config, save_config
from mona.config.schema import Config
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.executors.rpc import RpcError
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.providers.native_work_tools import validate_native_work_policy, work_model_policy
from mona.session.manager import SessionManager

AUTH = {"X-Mona-Token": "synthetic-development-test"}


async def selection_client(tmp_path, monkeypatch, config, source_tools=None):
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config.agents.defaults.workspace = str(workspace)
    config.development.enabled_engines = ["codex"]
    monkeypatch.setattr("mona.config.loader.get_config_path", lambda: config_path)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-development-test")
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    save_config(config)
    runtime = DevelopmentRuntime(DevelopmentStore(tmp_path / "state.sqlite3"), SessionManager(tmp_path / "sessions"), load_config)
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    if source_tools is not None:
        app["agent_loop"] = SimpleNamespace(workspace=workspace, tools=source_tools)
    client = TestClient(TestServer(app))
    await client.start_server()
    source = {"id": "codex", "available": True, "probe": {"authentication": "ready"},
              "models": [{"id": "fixture-model", "reasoningEfforts": ["high"]}]}
    monkeypatch.setattr(runtime.native, "describe", lambda: [source])
    return client, runtime, config_path, workspace


@pytest.mark.parametrize("restriction", ["sandbox", "workspace"])
async def test_model_selection_checks_work_scope_before_saving(tmp_path, monkeypatch, restriction):
    config = Config()
    if restriction == "sandbox":
        config.tools.exec.sandbox = "restricted-fixture"
    else:
        config.tools.restrict_to_workspace = True
    client, runtime, config_path, _ = await selection_client(tmp_path, monkeypatch, config)
    before = config_path.read_bytes()
    preflight = AsyncMock()
    monkeypatch.setattr(runtime.native, "preflight_work", preflight)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "fixture-model", "effort": "high"})
        error = (await response.json())["error"]
        assert response.status == 422 and error["code"] == "native_policy_unavailable"
        assert "选择其他模型来源" in error["message"]
        assert config_path.read_bytes() == before
        preflight.assert_not_awaited()
    finally:
        await client.close()


async def test_failed_native_preflight_preserves_model_and_hides_internal_detail(tmp_path, monkeypatch):
    client, runtime, config_path, _ = await selection_client(tmp_path, monkeypatch, Config())
    before = config_path.read_bytes()
    preflight = AsyncMock(side_effect=RpcError("native_policy_unavailable", "private fixture detail"))
    monkeypatch.setattr(runtime.native, "preflight_work", preflight)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "fixture-model", "effort": "high"})
        error = (await response.json())["error"]
        assert response.status == 422 and error["code"] == "native_policy_unavailable"
        assert "private fixture detail" not in error["message"]
        assert config_path.read_bytes() == before
        assert preflight.await_count == 1
    finally:
        await client.close()


async def test_api_model_can_be_selected_when_native_workspace_restriction_is_unsupported(tmp_path, monkeypatch):
    config = Config()
    config.tools.restrict_to_workspace = True
    config.providers.openai.api_key = "synthetic-local-fixture"
    config.providers.openai.enabled_models = ["api-fixture"]
    config.providers.openai.discovered_models = [{"id": "api-fixture", "type": "chat"}]
    client, runtime, _, _ = await selection_client(tmp_path, monkeypatch, config)
    preflight = AsyncMock()
    monkeypatch.setattr(runtime.native, "preflight_work", preflight)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "mona", "provider": "openai", "model": "api-fixture"})
        assert response.status == 200
        assert load_config().agents.defaults.executor == "mona"
        assert load_config().agents.defaults.model == "api-fixture"
        preflight.assert_not_awaited()
    finally:
        await client.close()


@pytest.mark.parametrize("executor", ["codex", "codebuddy", "mona"])
async def test_switching_other_models_does_not_wait_for_official_catalog(tmp_path, monkeypatch, executor):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog
    from mona.webui import settings_api

    config = Config()
    config.providers.openai.api_key = "synthetic-local-fixture"
    config.providers.openai.enabled_models = ["api-fixture"]
    config.providers.openai.discovered_models = [{"id": "api-fixture", "type": "chat"}]
    client, runtime, _, _ = await selection_client(tmp_path, monkeypatch, config)
    if executor == "codebuddy":
        saved = load_config()
        saved.development.enabled_engines.append("codebuddy")
        save_config(saved)
        monkeypatch.setattr(runtime.native, "describe", lambda: [{
            "id": "codebuddy", "available": True, "probe": {"authentication": "ready"},
            "models": [{"id": "fixture-model", "reasoningEfforts": ["high"]}],
        }])
    cached = {"available": True, "models": [{"id": "official-visible", "billing_type": "token"}]}
    monkeypatch.setattr(managed_catalog, "_cache", cached)
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", managed_catalog.managed_model_catalog)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", lambda *_args, **_kwargs: pytest.fail("selection must use the cached catalogue"))
    preflight = AsyncMock()
    monkeypatch.setattr(runtime.native, "preflight_work", preflight)
    body = ({"executor": executor, "model": "fixture-model", "effort": "high"}
            if executor != "mona" else {"executor": "mona", "provider": "openai", "model": "api-fixture"})
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH, json=body)
        payload = await response.json()
        assert response.status == 200 and payload["agent"]["executor"] == executor
        official = next(row for row in payload["chat_providers"] if row["name"] == "mona_managed")
        assert [model["id"] for model in official["models"]] == ["official-visible"]
        assert preflight.await_count == (0 if executor == "mona" else 1)
    finally:
        await client.close()


async def test_official_model_selection_refreshes_stale_catalog_before_saving(tmp_path, monkeypatch):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog
    from mona.webui import settings_api

    client, _, config_path, _ = await selection_client(tmp_path, monkeypatch, Config())
    before = config_path.read_bytes()
    calls = []

    def fetch(_command, *, timeout):
        calls.append(timeout)
        return {"available": True, "models": [{"id": "official-current", "billing_type": "token"}]}

    monkeypatch.setattr(managed_catalog, "_cache", {"available": True, "models": [{"id": "official-retired"}]})
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", managed_catalog.managed_model_catalog)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", fetch)
    try:
        stale = await client.put("/api/development/work-model-source", headers=AUTH, json={
            "executor": "mona", "provider": "mona_managed", "model": "official-retired"})
        assert stale.status == 422 and config_path.read_bytes() == before
        current = await client.put("/api/development/work-model-source", headers=AUTH, json={
            "executor": "mona", "provider": "mona_managed", "model": "official-current"})
        assert current.status == 200
        assert load_config().agents.defaults.model == "official-current"
        assert calls == [3]
    finally:
        await client.close()


async def test_official_model_selection_reports_unavailable_without_changing_settings(tmp_path, monkeypatch):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog

    client, _, config_path, _ = await selection_client(tmp_path, monkeypatch, Config())
    before = config_path.read_bytes()
    calls = []

    def unavailable(_command, *, timeout):
        calls.append(timeout)
        raise TimeoutError("offline fixture")

    monkeypatch.setattr(managed_catalog, "_cache", {"available": False, "models": []})
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", unavailable)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH, json={
            "executor": "mona", "provider": "mona_managed", "model": "official-current"})
        assert response.status == 422 and (await response.json())["error"]["code"] == "managed_catalog_unavailable"
        assert config_path.read_bytes() == before and calls == [3]
    finally:
        await client.close()


async def test_slow_official_lookup_cannot_overwrite_a_newer_model_choice(tmp_path, monkeypatch):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog
    from mona.webui import settings_api

    config = Config()
    config.providers.openai.api_key = "synthetic-local-fixture"
    config.providers.openai.enabled_models = ["api-fixture"]
    config.providers.openai.discovered_models = [{"id": "api-fixture", "type": "chat"}]
    client, _, _, _ = await selection_client(tmp_path, monkeypatch, config)
    entered, release = threading.Event(), threading.Event()

    def slow_catalog(_command, *, timeout):
        entered.set()
        assert release.wait(5)
        return {"available": True, "models": [{"id": "official-current", "billing_type": "token"}]}

    monkeypatch.setattr(managed_catalog, "_cache", {"available": False, "models": []})
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", managed_catalog.managed_model_catalog)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", slow_catalog)
    older = asyncio.create_task(client.put("/api/development/work-model-source", headers=AUTH, json={
        "executor": "mona", "provider": "mona_managed", "model": "official-current"}))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        newer = await asyncio.wait_for(client.put("/api/development/work-model-source", headers=AUTH, json={
            "executor": "mona", "provider": "openai", "model": "api-fixture"}), 3)
        assert newer.status == 200
        release.set()
        assert (await asyncio.wait_for(older, 3)).status == 409
        assert load_config().agents.defaults.model == "api-fixture"
    finally:
        release.set()
        await asyncio.gather(older, return_exceptions=True)
        await client.close()


async def test_api_model_selection_does_not_block_the_gateway_event_loop(tmp_path, monkeypatch):
    from mona.webui import settings_api

    config = Config()
    config.providers.openai.api_key = "synthetic-local-fixture"
    config.providers.openai.enabled_models = ["api-fixture"]
    config.providers.openai.discovered_models = [{"id": "api-fixture", "type": "chat"}]
    client, _, _, _ = await selection_client(tmp_path, monkeypatch, config)
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    payload = settings_api.settings_payload

    def slow_payload(**kwargs):
        entered.set()
        try:
            if not release.wait(5):
                raise TimeoutError("fixture release timed out")
            return payload(**kwargs)
        finally:
            finished.set()

    monkeypatch.setattr(settings_api, "settings_payload", slow_payload)
    task = asyncio.create_task(client.put("/api/development/work-model-source", headers=AUTH, json={
        "executor": "mona", "provider": "openai", "model": "api-fixture"}))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        assert not finished.is_set()
        projects = await asyncio.wait_for(client.get("/api/development/projects", headers=AUTH), 1)
        assert projects.status == 200 and not finished.is_set()
        release.set()
        assert (await task).status == 200
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        await client.close()


async def test_selection_preserves_unrelated_config_changes_during_preflight(tmp_path, monkeypatch):
    config = Config()
    config.providers.openai.api_key = "${MONA_PREFLIGHT_FIXTURE_KEY}"
    monkeypatch.setenv("MONA_PREFLIGHT_FIXTURE_KEY", "synthetic-value")
    client, runtime, _, _ = await selection_client(tmp_path, monkeypatch, config)

    async def preflight(*_args):
        changed = load_config()
        changed.agents.defaults.temperature = 0.37
        save_config(changed)

    preflight_mock = AsyncMock(side_effect=preflight)
    monkeypatch.setattr(runtime.native, "preflight_work", preflight_mock)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "fixture-model", "effort": "high"})
        assert response.status == 200
        saved = load_config()
        assert saved.agents.defaults.temperature == 0.37
        assert saved.agents.defaults.executor == "codex" and saved.agents.defaults.native_model == "fixture-model"
        assert saved.providers.openai.api_key == "${MONA_PREFLIGHT_FIXTURE_KEY}"
        assert preflight_mock.await_count == 1
    finally:
        await client.close()


@pytest.mark.parametrize("change", ["workspace", "engine", "grants", "model"])
async def test_selection_rejects_changed_execution_settings_during_preflight(tmp_path, monkeypatch, change):
    client, runtime, _, _ = await selection_client(tmp_path, monkeypatch, Config())

    async def preflight(*_args):
        if change == "grants":
            save_agent_user_config("mona", {"granted_tools": []}, expected_revision=None)
            return
        changed = load_config()
        if change == "workspace":
            changed.tools.restrict_to_workspace = True
        elif change == "engine":
            changed.development.codex_path = str(tmp_path / "new-executable")
        else:
            changed.agents.defaults.model = "other-model"
        save_config(changed)

    preflight_mock = AsyncMock(side_effect=preflight)
    monkeypatch.setattr(runtime.native, "preflight_work", preflight_mock)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "fixture-model", "effort": "high"})
        assert response.status == 409 and (await response.json())["error"]["code"] == "conflict"
        saved = load_config()
        assert saved.agents.defaults.executor == "mona"
        if change == "workspace":
            assert saved.tools.restrict_to_workspace
        elif change == "engine":
            assert saved.development.codex_path == str(tmp_path / "new-executable")
        elif change == "grants":
            assert load_agent_user_config("mona").granted_tools == []
        else:
            assert saved.agents.defaults.model == "other-model"
        assert preflight_mock.await_count == 1
    finally:
        await client.close()


def test_policy_snapshot_reloads_mona_grants_without_mutating_running_tools(tmp_path, monkeypatch):
    tools = ToolRegistry()
    for tool in (ReadFileTool(workspace=tmp_path), ApplyPatchTool(workspace=tmp_path),
                 ExecTool(working_dir=str(tmp_path)), WriteStdinTool()):
        tools.register(tool)
    tools.set_allowed_tool_names({"read_file"})
    monkeypatch.setattr("mona.agent.partners.AgentRegistry", lambda: SimpleNamespace(
        require=lambda _: AgentDefinition(id="mona", display_name="Mona")))
    monkeypatch.setattr("mona.agent.user_config.load_agent_user_config",
                        lambda _: AgentUserConfig(granted_tools=["write_stdin"]))

    policy = work_model_policy(Config(), "codex", tmp_path, tools)
    assert {"exec_command", "write_stdin", "view_image"} <= set(validate_native_work_policy(Config(), policy))
    assert not tools.is_permitted("exec") and tools.is_permitted("read_file")


async def test_selection_uses_registered_tools_and_keeps_existing_permissions(tmp_path, monkeypatch):
    tools = ToolRegistry()
    tools.register(ReadFileTool(workspace=tmp_path))
    tools.set_allowed_tool_names({"read_file"})
    client, runtime, config_path, workspace = await selection_client(tmp_path, monkeypatch, Config(), tools)
    before = config_path.read_bytes()
    preflight = AsyncMock()
    monkeypatch.setattr(runtime.native, "preflight_work", preflight)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "fixture-model", "effort": "high"})
        assert response.status == 422 and (await response.json())["error"]["code"] == "native_policy_unavailable"
        assert config_path.read_bytes() == before and workspace.is_dir()
        assert tools.is_permitted("read_file") and not tools.is_permitted("exec")
        preflight.assert_not_awaited()
    finally:
        await client.close()
