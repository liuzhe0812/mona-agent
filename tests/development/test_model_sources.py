"""Model selection uses the configured source, never guesses from a model name."""
import json
import sys

import pytest

from mona.config.loader import load_config, save_config
from mona.config.schema import Config, ProviderConfig, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId
from mona.development.model_selection import coding_models, resolve_coding_model
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentError, DevelopmentStore
from mona.providers.registry import find_by_name
from mona.session.manager import SessionManager
from mona.webui import settings_api


@pytest.fixture
def config(monkeypatch):
    _resolve_tool_config_refs()
    value = Config()
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})
    value.providers.openai.api_key = "synthetic-key-never-sent"
    value.providers.openai.model = "source-test-model"
    value.providers.openai.enabled_models = ["source-test-model"]
    value.providers.cindy["custom-other"] = ProviderConfig(display_name="My Relay", api_key="synthetic-relay",
        api_base="http://127.0.0.1:9999/v1", discovered_models=[{"id": "source-test-model", "type": "chat"}, {"id": "image-test", "type": "image"}],
        enabled_models=["source-test-model"])
    return value


def test_official_sources_are_fixed_and_relays_keep_their_identity(config):
    rows = settings_api._chat_provider_rows(config)
    assert [r["name"] for r in rows[:3]] == ["mona_managed", "openai", "anthropic"]
    assert find_by_name("anthropic").backend == "anthropic"
    choices = coding_models(config)
    assert {c["provider"] for c in choices if c["model"] == "source-test-model"} == {"openai", "custom-other"}
    assert "image-test" not in {c["model"] for c in choices}
    assert "synthetic-key-never-sent" not in str(rows) + str(choices)


def test_resolve_exact_model_source_without_modifying_global_config(config):
    before = config.model_dump_json()
    value = resolve_coding_model(config, "source-test-model", "custom-other")
    assert (value.provider, value.model) == ("custom-other", "source-test-model")
    assert config.model_dump_json() == before
    with pytest.raises(DevelopmentError):
        resolve_coding_model(config, "not-configured", "openai")
    with pytest.raises(DevelopmentError):
        resolve_coding_model(config, "source-test-model", "openai", "unavailable-effort")
    config.providers.openai.enabled_models = []
    # Hiding a model changes selection presentation, not a running task's access.
    assert resolve_coding_model(config, "source-test-model", "openai").model == "source-test-model"
    with pytest.raises(DevelopmentError):
        resolve_coding_model(config, "source-test-model", "openai", require_visible=True)


def test_all_model_choices_use_mona_and_reject_legacy_engine_updates(config, monkeypatch):
    from mona.webui.settings_api import WebUISettingsError

    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    legacy_mapping = {"source-test-model": "codex"}
    config.providers.openai.model_engines = dict(legacy_mapping)
    config.providers.cindy["custom-other"].model_engines = dict(legacy_mapping)

    rows = settings_api._chat_provider_rows(config)
    choices = coding_models(config)
    assert all(model["engine"] == "mona" for row in rows for model in row["models"])
    assert all(model["engine"] == "mona" for model in choices)

    with pytest.raises(WebUISettingsError):
        settings_api.update_provider_settings({
            "provider": ["openai"],
            "model_engines": [json.dumps({"source-test-model": "claude"})],
        })
    assert config.providers.openai.model_engines == legacy_mapping
    assert config.providers.cindy["custom-other"].model_engines == legacy_mapping


def test_legacy_model_engine_mapping_is_preserved_but_not_activated(config, tmp_path):
    config_path = tmp_path / "config.json"
    config.providers.cindy["custom-other"].model_engines = {"source-test-model": "claude"}
    save_config(config, config_path)
    restored = load_config(config_path)
    assert restored.providers.cindy["custom-other"].model_engines == {"source-test-model": "claude"}
    row = next(row for row in settings_api._chat_provider_rows(restored) if row["name"] == "custom-other")
    assert next(model for model in row["models"] if model["id"] == "source-test-model")["engine"] == "mona"


def test_managed_model_choices_use_mona_and_reject_legacy_engine_setting(config, monkeypatch):
    from mona.webui.settings_api import WebUISettingsError

    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": True,
        "models": [{"id": "managed-fixture", "billing_type": "token"}]})
    with pytest.raises(WebUISettingsError):
        settings_api.update_provider_settings({"provider": ["mona_managed"],
            "model_engines": [json.dumps({"managed-fixture": "codex"})]})
    row = next(row for row in settings_api._chat_provider_rows(config) if row["name"] == "mona_managed")
    assert row["models"][0]["engine"] == "mona"


@pytest.mark.parametrize(("provider", "engines"), [
    ("custom-other", {"image-test": "codex"}),
    ("custom-other", {"missing-model": "codex"}),
    ("custom-other", {"source-test-model": "pi"}),
])
def test_provider_settings_reject_legacy_model_engine_edits(config, monkeypatch, provider, engines):
    from mona.webui.settings_api import WebUISettingsError

    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)

    with pytest.raises(WebUISettingsError):
        settings_api.update_provider_settings({
            "provider": [provider],
            "model_engines": [json.dumps(engines)],
        })


@pytest.mark.asyncio
async def test_selection_is_atomic_persistent_and_does_not_start_a_task(tmp_path, config):
    runtime = DevelopmentRuntime(DevelopmentStore(tmp_path / "state.db"), SessionManager(tmp_path / "history"), lambda: config)
    root = tmp_path / "project"
    root.mkdir()
    (root / "manual.txt").write_text("preserve")
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id)
    try:
        selected = await runtime.select_model_source(session.id, session.revision, ExecutorId.MONA, "source-test-model", "custom-other", None)
        restored = DevelopmentStore(runtime.store.path).get_session(session.id)
        assert restored.model_provider == "custom-other" and restored.model == "source-test-model"
        assert not runtime.tasks and not runtime.store.list_runs(session.id)
        assert (root / "manual.txt").read_text() == "preserve"
        with pytest.raises(DevelopmentError):
            await runtime.select_model_source(session.id, selected.revision, ExecutorId.CODEBUDDY, "source-test-model", "custom-other", None)
        assert not runtime.native.hosts
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_source_discovery_has_no_project_or_native_process_side_effects(
    tmp_path, monkeypatch, config
):
    from test_workbench_api import AUTH, setup_client

    from mona.development.executors.base import ExecutorProbe
    client, runtime, _ = await setup_client(tmp_path, monkeypatch)
    runtime.config_loader = lambda: config
    runtime.native.config_loader = lambda: config
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _config: [
        ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable=sys.executable)])
    try:
        response = await client.get("/api/development/provider-executors", headers=AUTH)
        assert response.status == 200
        assert (await response.json())["executors"][0]["id"] == "codex"
        assert runtime.store.list_projects() == [] and not runtime.native.hosts and not runtime.tasks
        response = await client.get("/api/development/capabilities", headers=AUTH)
        assert response.status == 200
        executors = (await response.json())["executors"]
        mona_models = next(item["models"] for item in executors if item["id"] == "mona")
        source_choices = [model for model in mona_models if not model.get("preset")]
        assert source_choices and all(model["engine"] == "mona" for model in source_choices)
        response = await client.get("/api/development/provider-executors/codex/login", headers=AUTH)
        assert response.status == 200 and (await response.json())["state"] == "idle"
        denied = await client.post("/api/development/provider-executors/codex/probe")
        assert denied.status == 401 and not runtime.native.hosts
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_direct_creation_persists_exact_model_channel_atomically(tmp_path, monkeypatch, config):
    from test_workbench_api import AUTH, setup_client

    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    runtime.config_loader = lambda: config
    project = runtime.store.open_project(root)
    try:
        response = await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH,
            json={"executor": "mona", "model": "source-test-model", "modelProvider": "custom-other"})
        assert response.status == 200
        value = await response.json()
        restored = DevelopmentStore(runtime.store.path).get_session(value["id"])
        assert value["title"] == "新开发任务"
        assert (restored.executor, restored.model_provider, restored.model) == (ExecutorId.MONA, "custom-other", "source-test-model")
        assert not runtime.store.list_runs(value["id"]) and not runtime.tasks and not runtime.native.hosts
        assert (root / "file.txt").read_text(encoding="utf-8") == "original\n"
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_direct_native_creation_rejects_cross_provider_routes(tmp_path, monkeypatch, config, executor):
    from test_workbench_api import AUTH, setup_client

    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    runtime.config_loader = lambda: config
    project = runtime.store.open_project(root)
    try:
        response = await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH,
            json={"executor": executor, "model": "source-test-model", "modelProvider": "custom-other"})
        assert response.status == 422
        assert runtime.store.list_sessions(project.id) == []
        assert not runtime.tasks and not runtime.native.hosts
        assert (root / "file.txt").read_text(encoding="utf-8") == "original\n"
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["custom-other", ""])
async def test_cross_provider_native_source_is_rejected_without_dispatch_or_project_changes(
    tmp_path, config, provider
):
    from test_native_workbench import setup as native_setup

    runtime, project, root, adapter = await native_setup(tmp_path)
    config.development.codex_path = adapter.profile.command[0]
    config.development.enabled_engines = ["codex"]
    runtime.config_loader = lambda: config
    runtime.native.config_loader = lambda: config
    runtime.native.model_bridge.config_loader = lambda: config
    session = runtime.store.create_session(project.id)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "Existing history must remain.")
    runtime.sessions.save(transcript, fsync=True)
    history_before = json.loads(json.dumps(transcript.messages))
    session_before = runtime.store.get_session(session.id)
    hosts_before = dict(runtime.native.hosts)
    project_file_before = (root / "AGENTS.md").read_text(encoding="utf-8")
    trace_path = root / "peer-trace.jsonl"
    try:
        with pytest.raises(DevelopmentError, match="原生引擎使用自己的模型来源"):
            await runtime.select_model_source(session.id, session.revision, ExecutorId.CODEX,
                "source-test-model", provider, None)
        restored = DevelopmentStore(runtime.store.path).get_session(session.id)
        assert restored == session_before
        assert runtime.store.list_sessions(project.id) == [session_before]
        assert transcript.messages == history_before
        assert not runtime.store.list_bindings(session.id) and not runtime.store.list_runs(session.id)
        assert runtime.native.hosts == hosts_before and runtime.native.hosts[(project.id, ExecutorId.CODEX)] is adapter
        assert not runtime.tasks and not runtime.native.model_bridge._routes
        assert (root / "AGENTS.md").read_text(encoding="utf-8") == project_file_before
        assert not trace_path.exists()
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_disabled_native_creation_does_not_launch_cli_or_fall_back(tmp_path, monkeypatch, executor):
    from test_workbench_api import AUTH, setup_client, use_missing_programs

    use_missing_programs(tmp_path, monkeypatch)
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    try:
        response = await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH,
            json={"executor": executor, "model": "same-model", "modelProvider": None, "modelReasoningEffort": None})
        assert response.status == 422
        assert (await response.json())["error"]["code"] == "engine_disabled"
        assert runtime.store.list_sessions(project.id) == []
        assert not runtime.native.hosts and not runtime.tasks
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("patch", [
    {"modelProvider": "missing-channel"}, {"model": "missing-model"},
    {"executor": "codebuddy"}, {"modelReasoningEffort": "unsupported"},
])
async def test_creation_rejects_invalid_route_without_leaving_a_session(tmp_path, monkeypatch, config, patch):
    from test_workbench_api import AUTH, setup_client

    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    runtime.config_loader = lambda: config
    project = runtime.store.open_project(root)
    try:
        response = await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH,
            json={"executor": "mona", "model": "source-test-model", "modelProvider": "custom-other", **patch})
        assert response.status == 422
        assert runtime.store.list_sessions(project.id) == []
        assert not runtime.tasks and not runtime.native.hosts
    finally:
        await client.close()
