"""Codex Work retains native tools only with a verified per-operation boundary."""

import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.development.context import ProjectContext
from mona.development.contracts import Binding, DevelopmentSession, ExecutorId
from mona.development.executors.base import SessionStart
from mona.development.executors.codex import CodexExecutor, _Thread
from mona.development.executors.codex_policy import (
    CodexProfile,
    _fixed_config,
    cleanup_codex_work_profile,
    prepare_codex_profile,
    prepare_codex_work_profile,
    validate_work_rule_sources,
)
from mona.development.executors.rpc import RpcError


def profile_fixture(tmp_path):
    root = tmp_path / "work"
    root.mkdir()
    executable = tmp_path / "native.exe"
    executable.write_bytes(b"fixture")
    profile = prepare_codex_profile(executable, tmp_path / "native-home", root, environment={})
    (profile.home / "models_cache.json").write_text(json.dumps({"models": [{
        "slug": "native-test", "shell_type": "unified_exec", "apply_patch_tool_type": "freeform",
        "experimental_supported_tools": ["unsupported-extra"],
    }]}), encoding="utf8")
    return root, executable, profile


@pytest.mark.parametrize("native_tools", [(), ("exec_command", "write_stdin", "apply_patch", "view_image")])
def test_work_catalog_keeps_only_authorized_native_basics(tmp_path, native_tools):
    root, executable, base = profile_fixture(tmp_path)
    profile, path = prepare_codex_work_profile(executable, base.home, root, native_tools=native_tools)
    model = json.loads(path.read_text(encoding="utf8"))["models"][0]
    assert model["shell_type"] == ("unified_exec" if native_tools else "disabled")
    assert model["apply_patch_tool_type"] == ("freeform" if native_tools else None)
    assert model["experimental_supported_tools"] == [] and model["node_repl_disabled"]
    assert profile.work_native_tools == native_tools
    assert profile.work_auth_home == base.home
    assert profile.home.parent == base.home / "work" and profile.home != base.home
    assert profile.environment["CODEX_HOME"] == str(profile.home)
    assert not (profile.home / "auth.json").exists()
    assert any(arg == f"features.shell_tool={'true' if native_tools else 'false'}" for arg in profile.command)
    assert json.loads((base.home / "models_cache.json").read_text())["models"][0]["shell_type"] == "unified_exec"
    cleanup_codex_work_profile(profile)
    assert not profile.home.exists() and base.home.exists()


def test_work_isolates_code_rules_without_modifying_them(tmp_path):
    root, executable, profile = profile_fixture(tmp_path)
    rules = profile.home / "rules" / "default.rules"
    rules.parent.mkdir()
    rules.write_text("nonempty rule fixture", encoding="utf8")
    work, catalog = prepare_codex_work_profile(executable, profile.home, root,
                                             native_tools=("exec_command", "write_stdin"))
    assert catalog.exists() and catalog.parent == work.home
    validate_work_rule_sources(effective_reply(work), work, {"requirements": None})
    assert rules.read_text() == "nonempty rule fixture"
    assert not list(profile.home.glob(".mona-work-models-*.json"))
    assert not (work.home / "rules").exists()
    cleanup_codex_work_profile(work)
    assert rules.read_text() == "nonempty rule fixture"


def test_work_still_rejects_rules_in_its_own_profile_and_cleans_only_that_profile(tmp_path):
    root, executable, base = profile_fixture(tmp_path)
    profile, _ = prepare_codex_work_profile(executable, base.home, root,
                                          native_tools=("exec_command", "write_stdin"))
    (profile.home / "rules").mkdir()
    (profile.home / "rules" / "default.rules").write_text("unverified Work rule", encoding="utf8")
    with pytest.raises(RpcError) as failure:
        validate_work_rule_sources(effective_reply(profile), profile, {"requirements": None})
    assert failure.value.code == "native_exec_rules_conflict"
    with pytest.raises(RpcError) as cleanup:
        cleanup_codex_work_profile(replace(profile, home=base.home))
    assert cleanup.value.code == "native_home_cleanup_failed" and base.home.exists()
    cleanup_codex_work_profile(profile)
    assert not profile.home.exists() and base.home.exists()


def effective_reply(profile):
    config = {}
    for key, value in _fixed_config().items():
        target = config
        parts = key.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
    config["projects"] = {str(profile.project_root): {"trust_level": "untrusted"}}
    config.update(model_catalog_json=str(profile.work_model_catalog), web_search="disabled",
                  model_provider="mona_work_openai", model_providers={"mona_work_openai": {
                      "name": "OpenAI", "wire_api": "responses", "requires_openai_auth": True,
                      "supports_websockets": False,
                  }})
    config["features"].update(shell_tool=True, view_image=False)
    return {"config": config, "layers": [
        {"name": {"type": "user", "file": str(profile.home / "config.toml")}, "config": {}},
        {"name": {"type": "sessionFlags"}, "config": {"projects": config["projects"]}},
        {"name": {"type": "project", "dotCodexFolder": str(profile.project_root / ".codex")},
         "config": {}, "disabledReason": "untrusted"},
    ]}


@pytest.mark.parametrize("change", ["active_project", "managed_layer", "system_rules", "user_profile_rules", "requirements"])
def test_work_policy_rejects_rule_sources_that_can_bypass_approvals(tmp_path, change):
    root, _, base = profile_fixture(tmp_path)
    profile = CodexProfile(base.command, base.home, root, base.environment,
                           work_native_tools=("exec_command", "write_stdin"))
    reply = effective_reply(profile)
    requirements = {"requirements": None}
    validate_work_rule_sources(reply, profile, requirements)
    if change == "active_project":
        reply["layers"][-1].pop("disabledReason")
    elif change == "managed_layer":
        reply["layers"].append({"name": {"type": "enterpriseManaged", "id": "policy"}, "config": {}})
    elif change == "requirements":
        requirements["requirements"] = {}
    else:
        folder = tmp_path / "system" if change == "system_rules" else profile.home / "profiles" / "selected"
        (folder / "rules").mkdir(parents=True)
        (folder / "rules" / "default.rules").write_text("nonempty rule fixture")
        reply["layers"].append({"name": {"type": "system" if change == "system_rules" else "user",
                                          "file": str(folder / "config.toml")}, "config": {}})
    with pytest.raises(RpcError) as failure:
        validate_work_rule_sources(reply, profile, requirements)
    assert failure.value.code == ("native_exec_rules_conflict" if change in {"system_rules", "user_profile_rules"}
                                  else "native_policy_unavailable")


def native_host(tmp_path, handler):
    root, _, base = profile_fixture(tmp_path)
    tools = ("exec_command", "write_stdin", "apply_patch")
    profile = CodexProfile(base.command, base.home, root, base.environment,
                           work_model_catalog=base.home / "catalog.json", work_native_tools=tools)
    context = ProjectContext("work", root, (), (), (), "rules", "skills")
    session = DevelopmentSession(project_id="work", executor=ExecutorId.CODEX)
    start = SessionStart(session, context, work_prompt="Work", work_native_tools=tools,
                         work_native_permission=handler)
    binding = Binding(session_id=session.id, executor=ExecutorId.CODEX,
                      native_session_id="native-thread", working_directory=str(root))
    runtime = _Thread(binding, start, status="running", turn_id="native-turn")
    host = CodexExecutor(profile)
    host._client = SimpleNamespace(closed=False)
    host._threads[binding.native_session_id] = runtime
    host._known_bindings[binding.id] = binding.model_copy(deep=True)
    host._starts[binding.id] = start
    return host, runtime


@pytest.mark.parametrize("kind", ["commandExecution", "fileChange"])
async def test_work_native_approval_uses_real_identity_and_never_grants_a_session(tmp_path, kind):
    handler = AsyncMock(return_value={"allow": True, "decision": "acceptForSession"})
    host, runtime = native_host(tmp_path, handler)
    params = {"threadId": "native-thread", "turnId": "native-turn", "itemId": "native-item",
              "command": "echo test-only", "cwd": str(runtime.start.context.root),
              "grantRoot": str(runtime.start.context.root),
              "proposedExecpolicyAmendment": ["echo"]}
    reply = await host._on_server_request("request", f"item/{kind}/requestApproval", params)
    assert reply == {"decision": "accept"}
    args = handler.call_args.args
    assert args[:3] == ("native-turn", "native-item", "exec_command" if kind == "commandExecution" else "apply_patch")
    fields = ("command", "cwd") if kind == "commandExecution" else ("grantRoot",)
    assert args[3] == {key: params[key] for key in fields}
    assert runtime.status == "running"


async def test_work_delayed_native_approval_cannot_authorize_unknown_or_unidentified_work(tmp_path):
    async def handler(*_args):
        runtime.status = "unknown"
        return {"allow": True}
    host, runtime = native_host(tmp_path, handler)
    params = {"threadId": "native-thread", "turnId": "native-turn", "itemId": "native-item",
              "command": "echo test-only", "cwd": str(runtime.start.context.root)}
    assert await host._on_server_request("request", "item/commandExecution/requestApproval", params) == {"decision": "decline"}
    runtime.status = "running"
    params.pop("itemId")
    assert await host._on_server_request("request", "item/commandExecution/requestApproval", params) == {"decision": "decline"}


async def test_work_cannot_rewrite_native_approval_parameters(tmp_path):
    handler = AsyncMock(return_value={"allow": True, "arguments": {"command": "changed command"}})
    host, runtime = native_host(tmp_path, handler)
    params = {"threadId": "native-thread", "turnId": "native-turn", "itemId": "native-item",
              "command": "echo test-only", "cwd": str(runtime.start.context.root)}
    assert await host._on_server_request("request", "item/commandExecution/requestApproval", params) == {"decision": "decline"}


async def test_work_rechecks_rules_before_any_model_dispatch(tmp_path):
    host, runtime = native_host(tmp_path, AsyncMock(return_value={"allow": True}))
    runtime.status = "idle"
    host._check_policy = AsyncMock(side_effect=RpcError("native_policy_unavailable", "unverified rules"))
    host._client.request = AsyncMock()
    with pytest.raises(RpcError) as failure:
        await host.send(runtime.binding, "input-test", "Test only")
    assert failure.value.code == "native_policy_unavailable"
    host._client.request.assert_not_called()
    assert runtime.status == "idle"


async def test_native_work_refuses_resume_instead_of_reusing_old_in_memory_rules(tmp_path):
    host, runtime = native_host(tmp_path, AsyncMock(return_value={"allow": True}))
    with pytest.raises(RpcError) as failure:
        await host._open(runtime.start, runtime.binding)
    assert failure.value.code == "native_policy_unavailable"


@pytest.mark.parametrize("version", [None, "codex/0.162.0", "codex/0.164.0-alpha.11.1"])
async def test_work_native_policy_requires_verified_version_before_dispatch(tmp_path, version):
    host, _ = native_host(tmp_path, AsyncMock(return_value={"allow": True}))
    host._version = version
    client = SimpleNamespace(request=AsyncMock(side_effect=[effective_reply(host.profile), {"requirements": None}]))
    if version == "codex/0.164.0-alpha.11.1":
        await host._check_policy(client)
        assert client.request.call_args_list[0].args == ("config/read", {"includeLayers": True, "cwd": str(host.profile.project_root)})
        assert client.request.call_args_list[1].args == ("configRequirements/read",)
    else:
        with pytest.raises(RpcError) as failure:
            await host._check_policy(client)
        assert failure.value.code == "native_policy_unavailable"
        client.request.assert_not_called()


@pytest.mark.parametrize("updated", [True, False])
async def test_work_auth_refresh_requires_a_new_token_for_the_original_account(tmp_path, updated):
    host, _ = native_host(tmp_path, AsyncMock())
    host._work_account_id = "work-account"
    host._work_access_token = "synthetic-old"
    host._work_auth = AsyncMock(return_value={
        "type": "chatgptAuthTokens", "accessToken": "synthetic-new" if updated else "synthetic-old",
        "chatgptAccountId": "work-account", "chatgptPlanType": None,
    })
    if updated:
        reply = await host._on_server_request("refresh", "account/chatgptAuthTokens/refresh", {
            "previousAccountId": "work-account", "reason": "unauthorized"})
        assert reply == {"accessToken": "synthetic-new", "chatgptAccountId": "work-account", "chatgptPlanType": None}
    else:
        with pytest.raises(RpcError) as failed:
            await host._on_server_request("refresh", "account/chatgptAuthTokens/refresh", {
                "previousAccountId": "work-account", "reason": "unauthorized"})
        assert failed.value.code == "native_auth_binding_unavailable"
    host._work_auth.assert_awaited_once_with(refresh=True)


async def test_work_auth_refresh_rejects_another_account_without_reading_credentials(tmp_path):
    host, _ = native_host(tmp_path, AsyncMock())
    host._work_account_id = "work-account"
    host._work_auth = AsyncMock()
    with pytest.raises(RpcError) as failed:
        await host._on_server_request("refresh", "account/chatgptAuthTokens/refresh", {"previousAccountId": "other"})
    assert failed.value.code == "native_auth_binding_unavailable"
    host._work_auth.assert_not_awaited()


@pytest.mark.parametrize("ready", [True, False])
async def test_work_preflight_checks_an_isolated_profile_without_creating_a_turn(tmp_path, monkeypatch, ready):
    from mona.config.schema import Config
    from mona.development.native_manager import NativeExecutorManager

    root, executable, _ = profile_fixture(tmp_path)
    home = tmp_path / "native" / "codex"
    prepare_codex_profile(executable, home, root, environment={})
    (home / "models_cache.json").write_text(json.dumps({"models": [{"slug": "native-test"}]}), encoding="utf8")
    (home / "rules").mkdir()
    rules = home / "rules" / "default.rules"
    rules.write_text("existing Code rules", encoding="utf8")
    manager = NativeExecutorManager.__new__(NativeExecutorManager)
    manager.store = SimpleNamespace(path=tmp_path / "state.sqlite3")
    manager.config_loader = Config
    manager._settings_changing, manager._preparing = False, 0
    hosts = []

    class ProbeHost:
        def __init__(self, profile):
            self.profile = profile
            self.shutdown = AsyncMock()
            hosts.append(self)

        async def probe(self, *, include_models=True):
            assert manager._preparing == 1
            assert include_models is False
            assert self.profile.home != home and self.profile.work_auth_home == home
            assert not (self.profile.home / "rules").exists()
            return SimpleNamespace(state="ready" if ready else "unavailable",
                                   error_code=None if ready else "native_auth_binding_unavailable")

    monkeypatch.setattr("mona.development.native_manager.CodexExecutor", ProbeHost)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _: [
        SimpleNamespace(executor=ExecutorId.CODEX, state="detected", executable=str(executable))])
    if ready:
        await manager.preflight_work(ExecutorId.CODEX, root, ("exec_command", "write_stdin"))
    else:
        with pytest.raises(RpcError) as failed:
            await manager.preflight_work(ExecutorId.CODEX, root, ("exec_command", "write_stdin"))
        assert failed.value.code == "native_auth_binding_unavailable"
    assert manager._preparing == 0 and not hosts[0].profile.home.exists()
    hosts[0].shutdown.assert_awaited_once()
    assert rules.read_text(encoding="utf8") == "existing Code rules"


async def test_work_preflight_probes_account_without_refreshing_the_model_catalog(tmp_path):
    _, _, profile = profile_fixture(tmp_path)
    host = CodexExecutor(profile)
    client = SimpleNamespace(request=AsyncMock(return_value={
        "account": {"type": "chatgpt"}, "requiresOpenaiAuth": True,
    }))
    host._ensure_started = AsyncMock(return_value=client)
    host.list_models = AsyncMock()

    result = await host.probe(include_models=False)

    assert result.state == "ready"
    client.request.assert_awaited_once_with("account/read", {"refreshToken": False})
    host.list_models.assert_not_awaited()
