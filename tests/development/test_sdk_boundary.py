"""Contract/security tests; fixture messages never count as vendor CLI acceptance."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

import pytest

from mona.development.contracts import ExecutorId, PermissionMode
from mona.development.executors import sdk_worker
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_policy import prepare_sdk_profile
from mona.development.executors.sdk_worker import (
    Worker,
    _sdk_permission_mode,
    _supported_permission_modes,
)


class _SDKOptionsWithBypass:
    def __init__(self, permission_mode: Literal["default", "bypassPermissions"] = "default"):
        self.permission_mode = permission_mode


class _SDKOptionsWithoutDeclaredBypass:
    def __init__(self, permission_mode: str = "default"):
        self.permission_mode = permission_mode


class _SDKBuildOptions:
    def __init__(self, *, cwd=None, setting_sources=None, mcp_servers=None, hooks=None, can_use_tool=None,
                 extra_args=None, include_partial_messages=None, resume=None,
                 permission_mode: Literal["default", "bypassPermissions"] = "default", allowed_tools=None,
                 disallowed_tools=None, env=None, model=None, stderr=None, cli_path=None,
                 strict_mcp_config=None, settings=None, plugins=None, system_prompt=None, tools=None,
                 session_id=None, effort=None, skills=None, codebuddy_code_path=None):
        values = locals()
        for name, value in values.items():
            if name != "self":
                setattr(self, name, value)


class _SDKBuildClient:
    def __init__(self, *, options):
        self.options = options


def _build_sdk_options(monkeypatch, tmp_path, executor, *, readonly=False, host_collaboration=False, is_subagent=False,
                       platform="linux", design_resources=False):
    def tool(name, description, schema):
        return lambda callback: {"name": name, "description": description, "schema": schema, "callback": callback}

    sdk = SimpleNamespace(
        ClaudeAgentOptions=_SDKBuildOptions,
        CodeBuddyAgentOptions=_SDKBuildOptions,
        ClaudeSDKClient=_SDKBuildClient,
        CodeBuddySDKClient=_SDKBuildClient,
        AppendSystemPrompt=lambda *, append: SimpleNamespace(append=append),
        HookMatcher=lambda **kwargs: SimpleNamespace(**kwargs),
        tool=tool,
        create_sdk_mcp_server=lambda **kwargs: kwargs,
    )
    monkeypatch.setattr(sdk_worker, "sdk_version", lambda _executor: "fixture")
    monkeypatch.setattr(sdk_worker.sys, "platform", platform)
    monkeypatch.setattr(sdk_worker.importlib, "import_module", lambda _name: sdk)
    worker = Worker()
    worker.build_options({
        "executor": executor.value,
        "cwd": str(tmp_path),
        "executable": str(tmp_path / "sdk"),
        "nativeSessionId": "native-session",
        "permissionMode": PermissionMode.ASK.value,
        "readonly": readonly,
        "isSubagent": is_subagent,
        "context": "PROJECT_CONTEXT",
        "model": None,
        "effort": None,
        "resume": False,
        "hostCollaboration": host_collaboration,
        "hostDesignResources": design_resources,
    })
    return worker.options


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.parametrize("readonly,is_subagent", [(True, False), (False, True), (True, True)])
def test_shared_design_resource_does_not_enable_private_skills_or_child_delegation(monkeypatch, tmp_path, executor, readonly, is_subagent):
    from mona.development.executors.host_tools import HOST_SERVER, SDK_DESIGN_TOOL
    options = _build_sdk_options(monkeypatch, tmp_path, executor, readonly=readonly,
                                 is_subagent=is_subagent, design_resources=True)
    assert options.allowed_tools == [SDK_DESIGN_TOOL]
    assert set(options.mcp_servers) == {HOST_SERVER}
    assert [tool["name"] for tool in options.mcp_servers[HOST_SERVER]["tools"]] == ["development_design_resource"]
    assert options.setting_sources == [] and "Skill" in options.disallowed_tools
    if executor == ExecutorId.CLAUDE:
        assert options.skills == [] and options.plugins == []


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
def test_sdk_subagent_context_declares_no_nested_delegation_and_has_no_host_tool(monkeypatch, tmp_path, executor):
    options = _build_sdk_options(monkeypatch, tmp_path, executor, is_subagent=True)
    context = options.system_prompt["append"] if executor == ExecutorId.CLAUDE else options.system_prompt.append
    assert context == f"PROJECT_CONTEXT\n\n{sdk_worker.SUBAGENT_INSTRUCTIONS}"
    assert options.mcp_servers == {} and options.allowed_tools == []
    assert {"Task", "Agent"}.issubset(options.disallowed_tools)


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.parametrize("platform", ["win32", "linux"])
@pytest.mark.parametrize("is_subagent", [False, True])
def test_windows_terminal_guidance_is_only_appended_for_codebuddy(monkeypatch, tmp_path, executor, platform, is_subagent):
    options = _build_sdk_options(monkeypatch, tmp_path, executor, platform=platform,
                                 readonly=is_subagent, is_subagent=is_subagent)
    context = options.system_prompt["append"] if executor == ExecutorId.CLAUDE else options.system_prompt.append
    expected = "PROJECT_CONTEXT"
    if is_subagent:
        expected += f"\n\n{sdk_worker.SUBAGENT_INSTRUCTIONS}"
    if executor == ExecutorId.CODEBUDDY and platform == "win32":
        expected += f"\n\n{sdk_worker.CODEBUDDY_WINDOWS_INSTRUCTIONS}"
    if executor == ExecutorId.CODEBUDDY and is_subagent:
        expected += f"\n\n{sdk_worker.CODEBUDDY_READONLY_INSTRUCTIONS}"
    assert context == expected
    assert options.tools is None and "tools" not in options.extra_args
    assert not {"Bash", "PowerShell"}.intersection(options.disallowed_tools)
    assert options.permission_mode == "default"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["Agent", "Task"])
async def test_sdk_native_agent_permission_is_denied_even_in_full_access(tmp_path, tool):
    worker = _permission_worker(tmp_path, "full_access")
    worker.start["isSubagent"] = True
    async def unexpected_approval(*_args):
        raise AssertionError("A subtask cannot authorize nested delegation")
    worker.ask = unexpected_approval
    assert isinstance(await worker.permission(tool, {}, None), _PermissionDeny)


def test_sdk_supported_permission_modes_follow_native_constructor_literal():
    assert _supported_permission_modes(_SDKOptionsWithBypass) == ["ask", "auto", "full_access"]
    assert _supported_permission_modes(_SDKOptionsWithoutDeclaredBypass) == ["ask", "auto"]


@pytest.mark.parametrize("mode", [PermissionMode.ASK, PermissionMode.AUTO])
def test_sdk_ask_and_auto_use_host_mediated_default(mode):
    assert _sdk_permission_mode({"permissionMode": mode.value, "readonly": False}, _SDKOptionsWithBypass) == "default"


def test_sdk_full_access_requires_explicit_native_type_support_and_readonly_stays_default():
    start = {"permissionMode": PermissionMode.FULL_ACCESS.value, "readonly": False}
    assert _sdk_permission_mode(start, _SDKOptionsWithBypass) == "bypassPermissions"
    with pytest.raises(ValueError, match="sdk_contract_incompatible"):
        _sdk_permission_mode(start, _SDKOptionsWithoutDeclaredBypass)
    assert _sdk_permission_mode({**start, "readonly": True}, _SDKOptionsWithoutDeclaredBypass) == "default"


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.parametrize(("readonly", "host_collaboration", "delegation_enabled"), [
    (False, True, True),
    (False, False, False),
    (True, True, False),
])
def test_sdk_delegation_instructions_and_host_tool_are_root_only(
    monkeypatch, tmp_path, executor, readonly, host_collaboration, delegation_enabled,
):
    options = _build_sdk_options(monkeypatch, tmp_path, executor,
        readonly=readonly, host_collaboration=host_collaboration)

    if executor == ExecutorId.CLAUDE:
        context = options.system_prompt["append"]
        assert options.tools is None
    else:
        context = options.system_prompt.append
        assert "tools" not in options.extra_args

    if delegation_enabled:
        assert context == f"PROJECT_CONTEXT\n\n{sdk_worker.DELEGATION_INSTRUCTIONS}"
        assert options.allowed_tools == [sdk_worker.SDK_HOST_TOOL]
        assert set(options.mcp_servers) == {sdk_worker.HOST_SERVER}
    else:
        expected = "PROJECT_CONTEXT"
        if executor == ExecutorId.CODEBUDDY and readonly:
            expected += f"\n\n{sdk_worker.CODEBUDDY_READONLY_INSTRUCTIONS}"
        assert context == expected
        assert options.allowed_tools == []
        assert options.mcp_servers == {}

    assert {"Task", "Agent"}.issubset(options.disallowed_tools)
    assert options.permission_mode == "default"
    assert not {"Bash", "Write", "Edit"}.intersection(options.disallowed_tools)
    assert options.setting_sources == []
    if readonly:
        assert set(options.hooks) == {"PreToolUse"}
        assert len(options.hooks["PreToolUse"][0].hooks) == 1
    else:
        assert options.hooks == {}


@dataclass
class _PermissionAllow:
    updated_input: dict


@dataclass
class _PermissionDeny:
    message: str
    interrupt: bool = False


def _permission_worker(cwd: Path, mode: str, *, readonly: bool = False) -> Worker:
    worker = Worker()
    worker.sdk = SimpleNamespace(PermissionResultAllow=_PermissionAllow, PermissionResultDeny=_PermissionDeny)
    worker.start = {"cwd": str(cwd), "permissionMode": mode, "readonly": readonly}
    worker.active = "turn-1"
    worker.projector = SimpleNamespace(turn_id="turn-1", finished=False, uncertain=False, resuming=False)
    return worker


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "tool", "path_key"), [
    ("ask", "Read", "file_path"),
    ("auto", "Write", "path"),
])
async def test_sdk_external_file_access_uses_host_approval_and_canonical_target(tmp_path, mode, tool, path_key):
    root = tmp_path / "project"
    root.mkdir()
    target = tmp_path / "outside.txt"
    raw_path = str(Path("..") / target.name)
    worker = _permission_worker(root, mode)
    requests = []

    async def ask(method, params):
        requests.append((method, params))
        return "accept"

    worker.ask = ask
    result = await worker.permission(tool, {path_key: raw_path}, None)

    assert isinstance(result, _PermissionAllow)
    assert result.updated_input[path_key] == str(target.resolve())
    assert len(requests) == 1
    method, params = requests[0]
    assert method == "permission" and params["command"] == ""
    assert params["pathKey"] == path_key and params["path"] == raw_path and params[path_key] == raw_path
    assert params["filePath"] == str(target.resolve())
    assert str(target.resolve()) in params["reason"]


@pytest.mark.asyncio
async def test_sdk_auto_reviews_project_file_writes_but_ask_keeps_them_direct(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    target = root / "file.txt"
    worker = _permission_worker(root, "auto")
    requests = []

    async def ask(method, params):
        requests.append((method, params))
        return "accept"

    worker.ask = ask
    result = await worker.permission("Write", {"file_path": str(target)}, None)
    assert isinstance(result, _PermissionAllow)
    assert len(requests) == 1 and requests[0][1]["filePath"] == str(target.resolve())

    worker = _permission_worker(root, "ask")
    worker.ask = ask
    direct = await worker.permission("Write", {"file_path": str(target)}, None)
    assert isinstance(direct, _PermissionAllow)
    assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "readonly", "allowed"), [
    ("ask", True, False),
    ("full_access", False, True),
])
async def test_sdk_external_path_respects_readonly_and_full_access(tmp_path, mode, readonly, allowed):
    root = tmp_path / "project"
    root.mkdir()
    target = tmp_path / "outside.txt"
    worker = _permission_worker(root, mode, readonly=readonly)

    async def unexpected_approval(*_args):
        raise AssertionError("This permission mode must not request approval for this path")

    worker.ask = unexpected_approval
    result = await worker.permission("Read", {"file_path": str(target)}, None)
    assert isinstance(result, _PermissionAllow if allowed else _PermissionDeny)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["Bash", "Write", "Edit", "Task", "Agent"])
async def test_sdk_readonly_pre_tool_denial_does_not_end_turn_or_prevent_project_read(tmp_path, tool):
    worker = _permission_worker(tmp_path, "full_access", readonly=True)
    denied = await worker.readonly_pre_tool({"hook_event_name": "PreToolUse", "tool_name": tool,
        "tool_input": {"command": "echo forbidden", "file_path": "example.txt"}}, "call-1", {})
    assert denied["continue_"] is True
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    allowed = await worker.readonly_pre_tool({"hook_event_name": "PreToolUse", "tool_name": "Read",
        "tool_input": {"file_path": "example.txt"}}, "call-2", {})
    assert allowed["hookSpecificOutput"] == {"hookEventName": "PreToolUse", "permissionDecision": "allow",
        "updatedInput": {"file_path": str((tmp_path / "example.txt").resolve())}}
    assert worker._current_turn("turn-1")
    worker.active = None
    ended = await worker.readonly_pre_tool({"hook_event_name": "PreToolUse", "tool_name": "Read",
        "tool_input": {"file_path": "example.txt"}}, "call-3", {})
    assert ended["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.asyncio
@pytest.mark.parametrize(("tool", "arguments", "allowed"), [
    ("Read", {"file_path": "../outside.txt"}, False),
    ("Read", {}, False),
    ("Glob", {"pattern": "**/*.{py,ts}"}, True),
    ("Grep", {"pattern": "..", "glob": "*.py"}, True),
    ("Glob", {"pattern": "../**"}, False),
    ("Glob", {"pattern": "{*.py,/outside/*}"}, False),
    ("Grep", {"pattern": "x", "glob": "C:/outside/*"}, False),
    ("Glob", {"pattern": "[.][.]/*"}, False),
    ("NotebookRead", {"notebook_path": "../outside.ipynb"}, False),
    ("LS", {}, True),
])
async def test_sdk_readonly_pre_tool_resolves_scope_and_blocks_search_escape(tmp_path, tool, arguments, allowed):
    root = tmp_path / "project"
    root.mkdir()
    worker = _permission_worker(root, "ask", readonly=True)
    result = await worker.readonly_pre_tool({"hook_event_name": "PreToolUse", "tool_name": tool,
        "tool_input": arguments}, "call-1", {})
    assert result["hookSpecificOutput"]["permissionDecision"] == ("allow" if allowed else "deny")
    if allowed:
        assert result["hookSpecificOutput"]["updatedInput"]["path"] == str(root.resolve())


@pytest.mark.asyncio
async def test_sdk_external_approval_denies_if_resolved_target_changes(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    approved_target = tmp_path / "approved.txt"
    changed_target = tmp_path / "changed.txt"
    worker = _permission_worker(root, "ask")
    resolutions = iter([(root, approved_target), (root, changed_target)])
    monkeypatch.setattr(sdk_worker, "_resolve_file_path", lambda *_args: next(resolutions))

    async def accept(_method, _params):
        return "accept"

    worker.ask = accept
    result = await worker.permission("Read", {"file_path": "external-link"}, None)
    assert isinstance(result, _PermissionDeny)
    assert "路径已变化" in result.message


@dataclass
class TextBlock:
    text: str


@dataclass
class ThinkingBlock:
    thinking: str
    signature: str = "private-signature"


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: str
    is_error: bool = False


@dataclass
class AssistantMessage:
    content: list
    model: str = "fixture"
    parent_tool_use_id: str | None = None


@dataclass
class UserMessage:
    content: list


@dataclass
class StreamEvent:
    event: dict
    uuid: str = "test-event"
    session_id: str = "test-session"
    parent_tool_use_id: str | None = None


@dataclass
class ResultMessage:
    session_id: str = "test-session"
    subtype: str = "success"
    is_error: bool = False
    usage: dict = field(default_factory=dict)
    result: str = ""


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
def test_isolated_process_environment_does_not_inherit_vendor_user_settings(tmp_path, executor):
    binary = tmp_path / "vendor.exe"
    binary.write_bytes(b"not executed")
    root = tmp_path / "project"
    root.mkdir()
    source = {"PATH": "os-path", "SYSTEMROOT": "os-root", "HOME": "user-home", "PYTHONPATH": "malicious-import",
        "CLAUDE_CODE_ENTRYPOINT": "must-not-inherit", "CLAUDE_CONFIG_DIR": "private-config", "CODEBUDDY_CONFIG": "private-config",
        "OTHER_VENDOR_KEY": "not-an-auth-value", "PROJECT_KEY_REFERENCE": "synthetic-auth-value"}
    original = dict(source)
    profile = prepare_sdk_profile(executor, binary, tmp_path / "managed", root,
        credential_env="PROJECT_KEY_REFERENCE", environment=source)
    assert source == original
    assert profile.environment["HOME"] == str(tmp_path / "managed")
    assert "OTHER_VENDOR_KEY" not in profile.environment and "CLAUDE_CODE_ENTRYPOINT" not in profile.environment
    assert profile.environment["PYTHONPATH"] != "malicious-import"
    assert "synthetic-auth-value" not in repr(profile)
    assert profile.environment["ANTHROPIC_API_KEY" if executor == ExecutorId.CLAUDE else "CODEBUDDY_API_KEY"] == "synthetic-auth-value"
    if executor == ExecutorId.CODEBUDDY:
        assert profile.environment["CODEBUDDY_CONFIG_DIR"] == str(tmp_path / "managed" / ".codebuddy")
        assert profile.environment["CODEBUDDY_INTERNET_ENVIRONMENT"] == "internal"
    assert prepare_sdk_profile(executor, binary, tmp_path / "managed", root, environment={}).home == profile.home
    with pytest.raises(RpcError):
        prepare_sdk_profile(executor, binary, root / "unsafe-managed", root)


def test_text_snapshots_replace_deltas_and_thinking_is_separate_from_body_and_signature():
    p = SDKEventProjector("test-session")
    p.begin("sdk:first")
    assert not p.consume(StreamEvent({"type": "message_start", "message": {"id": "native-message"}}))
    delta = p.consume(StreamEvent({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "part"}}))
    assert delta[0].payload["itemId"] == "native-message"
    message = p.consume(AssistantMessage([ThinkingBlock("检查项目结构"), TextBlock("whole"), ToolUseBlock("tool-1", "Read", {"file_path": "a.py"})]))
    assert next(e for e in message if e.type == "agent.message.completed").payload == {"itemId": "native-message", "text": "whole"}
    assert "private-signature" not in str(message)
    assert message[0].type == "reasoning.completed"
    assert message[0].payload == {"itemId": "native-message:block:0", "text": "检查项目结构"}
    tool = p.consume(UserMessage([ToolResultBlock("tool-1", "file", True)]))
    assert tool[0].type == "tool.completed" and tool[0].payload["isError"]
    final = p.consume(ResultMessage())
    assert final[-1].type == "run.completed"
    assert final[-1].payload["turnIdentitySource"] == "host_dispatch"
    assert not p.consume(AssistantMessage([TextBlock("late")]))
    p.begin("sdk:second")
    assert not p.consume(AssistantMessage([TextBlock("background")], parent_tool_use_id="child-tool"))
    assert not p.consume(UserMessage([ToolResultBlock("tool-1", "old tool")]))


def test_claude_usage_tracks_latest_main_request_and_matches_its_runtime_window():
    p = SDKEventProjector("test-session")
    p.begin("sdk:usage")

    started = p.consume(StreamEvent({"type": "message_start", "message": {
        "id": "request-1", "model": "claude-main", "usage": {
            "input_tokens": 10, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 2,
        },
    }}, uuid="usage-start"))
    assert started[0].type == "usage.updated"
    assert started[0].payload == {"contextTokens": 16}

    delta = p.consume(StreamEvent({"type": "message_delta", "usage": {"output_tokens": 7}}, uuid="usage-delta"))
    assert delta[0].type == "usage.updated"
    assert delta[0].payload == {"contextTokens": 23}

    child = p.consume(StreamEvent({"type": "message_start", "message": {
        "id": "child-request", "model": "claude-child", "usage": {"input_tokens": 900},
    }}, parent_tool_use_id="child-tool", uuid="child-usage"))
    assert child == []
    assert p.context_tokens == 23
    assert p.primary_model == "claude-main"

    result_usage = {"input_tokens": 999, "output_tokens": 888}
    result = p.consume({"type": "result", "session_id": "test-session", "subtype": "success",
        "is_error": False, "usage": result_usage, "duration_ms": 1200,
        "modelUsage": {"claude-main": {"contextWindow": 200_000}, "claude-child": {"contextWindow": 1_000_000}}})
    usage = next(event for event in result if event.type == "usage.updated")
    assert usage.payload == {"usage": result_usage, "durationMs": 1200,
        "contextTokens": 23, "contextWindow": 200_000}


def test_claude_context_window_is_omitted_when_result_has_no_matching_runtime_model():
    p = SDKEventProjector("test-session")
    p.begin("sdk:unknown-window")
    p.consume(StreamEvent({"type": "message_start", "message": {
        "id": "request", "model": "claude-main", "usage": {"input_tokens": 5},
    }}))

    result = p.consume({"type": "result", "session_id": "test-session", "subtype": "success",
        "is_error": False, "modelUsage": {"claude-child": {"contextWindow": 200_000}}})
    usage = next(event for event in result if event.type == "usage.updated")
    assert usage.payload == {"usage": None, "durationMs": None, "contextTokens": 5}


def test_claude_missing_usage_on_a_new_request_does_not_reuse_the_previous_snapshot():
    p = SDKEventProjector("test-session")
    p.begin("sdk:missing-usage")
    p.consume(StreamEvent({"type": "message_start", "message": {
        "id": "request-1", "model": "claude-main", "usage": {"input_tokens": 5},
    }}))
    assert p.context_tokens == 5

    assert p.consume(StreamEvent({"type": "message_start", "message": {
        "id": "request-2", "model": "claude-main",
    }})) == []
    assert p.context_tokens is None
    assert p.consume(StreamEvent({"type": "message_delta", "usage": {"output_tokens": 4}})) == []


def test_streamed_reasoning_uses_exact_block_index_and_measured_duration(monkeypatch):
    from mona.development.executors import sdk_events

    instants = iter([10.25, 11.125])
    monkeypatch.setattr(sdk_events.time, "monotonic", lambda: next(instants))
    p = SDKEventProjector("test-session")
    p.begin("sdk:reasoning")
    assert not p.consume(StreamEvent({"type": "message_start", "message": {"id": "native-message"}}))

    started = p.consume(StreamEvent({"type": "content_block_start", "index": 2,
        "content_block": {"type": "thinking", "thinking": "检查项目", "signature": "PRIVATE SIGNATURE"}}, uuid="block-start"))
    assert started[0].type == "reasoning.started"
    assert started[0].payload == {"itemId": "native-message:block:2", "text": "检查项目"}
    assert "PRIVATE" not in str(started)
    delta = p.consume(StreamEvent({"type": "content_block_delta", "index": 2, "delta": {"type": "thinking_delta", "thinking": "的依赖"}}))
    assert delta[0].payload == {"itemId": "native-message:block:2", "delta": "的依赖"}
    assert not p.consume(StreamEvent({"type": "content_block_delta", "index": 2, "delta": {"type": "signature_delta", "signature": "PRIVATE"}}))
    assert not p.consume(StreamEvent({"type": "content_block_stop", "index": 1}, uuid="other-block-stop"))

    completed = p.consume(StreamEvent({"type": "content_block_stop", "index": 2}, uuid="block-stop"))
    assert completed[0].type == "reasoning.completed"
    assert completed[0].payload == {"itemId": "native-message:block:2", "durationMs": 875}


def test_streamed_tool_input_updates_one_item_and_final_snapshot_is_authoritative():
    p = SDKEventProjector("test-session")
    p.begin("sdk:tool")
    p.consume(StreamEvent({"type": "message_start", "message": {"id": "native-message"}}))

    started = p.consume(StreamEvent({"type": "content_block_start", "index": 1,
        "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash", "input": {}}},
        uuid="tool-start"))
    assert started[0].type == "tool.started"
    assert started[0].payload == {"itemId": "tool-1", "name": "Bash", "arguments": {}, "inputStreaming": True}
    assert started[0].native_event_id == "tool-1:started"
    assert "tool-1" in p.tool_ids

    first_delta = StreamEvent({"type": "content_block_delta", "index": 1,
        "delta": {"type": "input_json_delta", "partial_json": '{"command":'}}, uuid="input-1")
    delta_event = p.consume(first_delta)
    assert delta_event[0].type == "tool.input.delta"
    assert delta_event[0].payload == {"itemId": "tool-1", "delta": '{"command":'}
    assert not p.consume(first_delta)
    p.consume(StreamEvent({"type": "content_block_delta", "index": 1,
        "delta": {"type": "input_json_delta", "partial_json": '"echo ok"}'}}, uuid="input-2"))
    updated = p.consume(StreamEvent({"type": "content_block_stop", "index": 1}, uuid="tool-stop"))
    assert updated[0].type == "tool.started"
    assert updated[0].payload == {"itemId": "tool-1", "name": "Bash", "arguments": {"command": "echo ok"}, "inputStreaming": False}
    assert updated[0].native_event_id == "tool-1:input-completed"

    snapshot = p.consume(AssistantMessage([ToolUseBlock("tool-1", "Bash", {"command": "echo ok"})]))
    assert len(snapshot) == 1 and snapshot[0].type == "tool.started"
    assert snapshot[0].payload == updated[0].payload
    assert snapshot[0].native_event_id == "tool-1:authoritative"
    tool_events = [*started, *updated, *snapshot]
    assert {event.payload["itemId"] for event in tool_events} == {"tool-1"}
    assert len({event.native_event_id for event in tool_events}) == len(tool_events)

    completed = p.consume(UserMessage([ToolResultBlock("tool-1", "done")]))
    assert completed[0].type == "tool.completed"


def test_identity_mcp_and_unknown_stream_order_fail_closed():
    p = SDKEventProjector("test-session")
    p.begin("sdk:one")
    with pytest.raises(RpcError):
        p.consume(ResultMessage(session_id="other-session"))
    with pytest.raises(RpcError):
        p.consume(AssistantMessage([ToolUseBlock("bad", "mcp__unknown", {})]))
    with pytest.raises(RpcError):
        p.consume(StreamEvent({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "out of order"}}))
    with pytest.raises(RpcError):
        p.consume({"type": "system", "subtype": "init", "session_id": "test-session", "data": {"mcp_servers": [{}]}})


@pytest.mark.parametrize("final_order", [("thinking", "text"), ("text", "thinking")])
def test_split_final_blocks_keep_streamed_text_and_reasoning_identity(final_order):
    p = SDKEventProjector("test-session")
    p.begin("sdk:split-final")
    p.consume(StreamEvent({"type": "message_start", "message": {"id": "native-message"}}))
    reasoning = p.consume(StreamEvent({"type": "content_block_start", "index": 0,
        "content_block": {"type": "thinking", "thinking": "Inspect"}}, uuid="reasoning-start"))[0]
    p.consume(StreamEvent({"type": "content_block_stop", "index": 0}, uuid="reasoning-stop"))
    p.consume(StreamEvent({"type": "content_block_start", "index": 1,
        "content_block": {"type": "text", "text": ""}}))
    text = p.consume(StreamEvent({"type": "content_block_delta", "index": 1,
        "delta": {"type": "text_delta", "text": "Partial"}}, uuid="text-delta"))[0]
    finals = []
    for kind in final_order:
        finals.extend(p.consume(AssistantMessage([ThinkingBlock("Inspection complete") if kind == "thinking" else TextBlock("Full reply")])) )
    assert next(event for event in finals if event.type == "reasoning.completed").payload["itemId"] == reasoning.payload["itemId"]
    assert next(event for event in finals if event.type == "agent.message.completed").payload == {
        "itemId": text.payload["itemId"], "text": "Full reply"}
    assert "private-signature" not in str(finals)


def test_indexed_text_blocks_keep_their_position_around_a_tool_call():
    p = SDKEventProjector("test-session")
    p.begin("sdk:ordered")
    p.consume(StreamEvent({"type": "message_start", "message": {"id": "message"}}))
    first = p.consume(StreamEvent({"type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": "Before"}}))
    p.consume(StreamEvent({"type": "content_block_start", "index": 1,
        "content_block": {"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "a.py"}}}))
    last = p.consume(StreamEvent({"type": "content_block_delta", "index": 2,
        "delta": {"type": "text_delta", "text": "After"}}))
    final = p.consume(AssistantMessage([TextBlock("Before"), ToolUseBlock("read", "Read", {"file_path": "a.py"}), TextBlock("After")]))
    assert [e.type for e in final] == ["agent.message.completed", "tool.started", "agent.message.completed"]
    assert first[0].payload["itemId"] == final[0].payload["itemId"] == "message:text:0"
    assert last[0].payload["itemId"] == final[2].payload["itemId"] == "message:text:2"


def test_split_text_blocks_keep_position_before_and_after_a_tool():
    p = SDKEventProjector("test-session")
    p.begin("sdk:split-ordered")
    p.consume(StreamEvent({"type": "message_start", "message": {"id": "message"}}))
    p.consume(StreamEvent({"type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": "Before"}}, uuid="before"))
    p.consume(StreamEvent({"type": "content_block_start", "index": 1,
        "content_block": {"type": "tool_use", "id": "read", "name": "Read", "input": {}}}))
    p.consume(StreamEvent({"type": "content_block_delta", "index": 2,
        "delta": {"type": "text_delta", "text": "After"}}, uuid="after"))
    events = p.consume(AssistantMessage([TextBlock("Before full")]))
    events += p.consume(AssistantMessage([ToolUseBlock("read", "Read", {"file_path": "a.py"})]))
    events += p.consume(AssistantMessage([TextBlock("After full")]))
    assert [event.type for event in events] == ["agent.message.completed", "tool.started", "agent.message.completed"]
    assert [event.payload["itemId"] for event in events] == ["message:text:0", "read", "message:text:2"]


def test_redacted_thinking_and_signatures_never_enter_the_display_stream():
    p = SDKEventProjector("test-session")
    p.begin("sdk:redacted")
    p.consume(StreamEvent({"type": "message_start", "message": {"id": "message"}}))
    start = p.consume(StreamEvent({"type": "content_block_start", "index": 0,
        "content_block": {"type": "redacted_thinking", "data": "PRIVATE", "thinking": "PRIVATE"}}))
    assert start[0].payload == {"itemId": "message:block:0"}
    assert not p.consume(StreamEvent({"type": "content_block_delta", "index": 0,
        "delta": {"type": "thinking_delta", "thinking": "PRIVATE"}}))
