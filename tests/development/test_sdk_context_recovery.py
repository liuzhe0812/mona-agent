"""Native API-error envelopes and request-local usage stay separate from text/billing."""

import pytest

from mona.development.contracts import ExecutorId
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_events import SDKEventProjector

_MODEL = "deepseek-v4.1-flash"
_ERROR = (
    "400 prompt is too long: 1226330 tokens > 1048576 maximum "
    "(0123456789abcdef0123456789abcdef/12345678-1234-1234-1234-123456789abc)"
)


def _projector(*, executor=ExecutorId.CODEBUDDY, work_tool=True):
    projector = SDKEventProjector("fixture-session", executor=executor, work_tool=work_tool)
    projector.begin("sdk:fixture")
    return projector


def _assistant(text, *, error=None):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import TextBlock

    return sdk.AssistantMessage(content=[TextBlock(text)], model=_MODEL, error=error)


def _result(*, failed=False, result="", usage=None, errors=None):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    return sdk.ResultMessage(
        subtype="error_during_execution" if failed else "success", duration_ms=1, duration_api_ms=1,
        is_error=failed, num_turns=1, session_id="fixture-session", result=result, usage=usage, errors=errors,
    )


def _stream(event_type, **kwargs):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    return sdk.StreamEvent(uuid="fixture-event", session_id="fixture-session", event={"type": event_type, **kwargs})


@pytest.mark.parametrize("error,expected", [
    ("invalid_request", "context_window_exceeded"),
    ("authentication_failed", "authentication_required"),
    ("rate_limit", "rate_limit_exceeded"),
])
def test_official_assistant_api_error_waits_for_authoritative_failed_result(error, expected):
    projector = _projector()
    text = _ERROR if error == "invalid_request" else "Private upstream error detail"

    assert projector.consume(_assistant(text, error=error)) == []
    assert not projector.finished and not projector.uncertain
    final = projector.consume(_result(failed=True, result=text))

    assert [event.type for event in final] == ["usage.updated", "run.failed"]
    assert final[-1].payload["errorCode"] == expected
    assert text not in str(final)


@pytest.mark.parametrize("normal_assistant", [False, True])
def test_native_success_discards_temporary_error_without_showing_it(normal_assistant):
    projector = _projector()
    assert projector.consume(_assistant(_ERROR, error="invalid_request")) == []
    if normal_assistant:
        events = projector.consume(_assistant("The native request recovered."))
        assert [event.type for event in events] == ["agent.message.completed"]
        assert projector.pending_api_error is None
    final = projector.consume(_result(result="Finished after recovery."))

    assert final[-1].type == "run.completed"
    assert not any(event.type == "run.failed" for event in final)
    assert _ERROR not in str(final)
    assert projector.pending_api_error is None


def test_later_failure_does_not_reuse_error_from_an_already_recovered_request():
    projector = _projector()
    projector.consume(_assistant(_ERROR, error="invalid_request"))
    projector.consume(_assistant("Recovered."))

    final = projector.consume(_result(failed=True))

    assert final[-1].payload["errorCode"] == "native_execution_failed"


def test_next_turn_does_not_inherit_the_previous_pending_api_error():
    projector = _projector()
    projector.consume(_assistant(_ERROR, error="invalid_request"))
    projector.begin("sdk:next")

    assert projector.consume(_result(failed=True))[-1].payload["errorCode"] == "native_execution_failed"


def test_failed_result_can_classify_context_overflow_without_an_assistant_envelope():
    projector = _projector()

    final = projector.consume(_result(failed=True, errors=[_ERROR]))

    assert final[-1].payload["errorCode"] == "context_window_exceeded"
    assert _ERROR not in str(final)


@pytest.mark.parametrize("text", [_ERROR, _ERROR.replace("1226330", "1,226,330").replace("1048576", "1,048,576")])
def test_codebuddy_work_classifies_only_the_complete_unflagged_native_context_error(text):
    projector = _projector()

    assert projector.consume(_assistant(text)) == []
    assert not projector.finished
    final = projector.consume(_result(failed=True))

    assert final[-1].payload["errorCode"] == "context_window_exceeded"
    assert text not in str(final)


@pytest.mark.parametrize("text,executor,work_tool", [
    ("Here is the reported error: " + _ERROR, ExecutorId.CODEBUDDY, True),
    ("```\n" + _ERROR + "\n```", ExecutorId.CODEBUDDY, True),
    (_ERROR + "\nI will investigate it.", ExecutorId.CODEBUDDY, True),
    (_ERROR.replace("1226330", "1000"), ExecutorId.CODEBUDDY, True),
    (_ERROR, ExecutorId.CODEBUDDY, False),
    (_ERROR, ExecutorId.CLAUDE, True),
])
def test_ordinary_error_discussion_and_other_routes_remain_assistant_content(text, executor, work_tool):
    projector = _projector(executor=executor, work_tool=work_tool)

    events = projector.consume(_assistant(text))

    assert [event.type for event in events] == ["agent.message.completed"]
    assert events[0].payload["text"] == text
    assert projector.pending_api_error is None


def test_error_inside_a_tool_result_is_not_treated_as_an_assistant_api_error():
    projector = _projector()
    projector.tool_ids.add("recorded-tool")

    events = projector.consume({"type": "user", "content": [{
        "type": "tool_result", "tool_use_id": "recorded-tool", "content": _ERROR,
    }]})

    assert events[0].type == "tool.completed"
    assert events[0].payload["content"] == _ERROR
    assert projector.pending_api_error is None


@pytest.mark.parametrize("executor,expected", [(ExecutorId.CLAUDE, 1_249_369), (ExecutorId.CODEBUDDY, 626_777)])
def test_request_usage_respects_the_native_executor_cache_semantics(executor, expected):
    projector = _projector(executor=executor)
    assert projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 0, "output_tokens": 0},
    })) == []
    assert projector.context_tokens is None

    measured = projector.consume(_stream("message_delta", usage={
        "input_tokens": 626_483, "cache_read_input_tokens": 622_592, "output_tokens": 294,
    }))
    assert measured[0].payload == {"contextTokens": expected}
    projector.consume(_stream("message_delta", usage={
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
    }))
    assert projector.context_tokens == expected


def test_new_request_with_zero_or_missing_usage_does_not_inherit_previous_context():
    projector = _projector()
    projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 10},
    }))
    assert projector.context_tokens == 10

    assert projector.consume(_stream("message_start", message={
        "id": "request-2", "model": _MODEL, "usage": {"input_tokens": 0, "output_tokens": 0},
    })) == []
    assert projector.consume(_stream("message_delta", usage={"output_tokens": 4})) == []
    assert projector.context_tokens is None


def test_cumulative_result_billing_does_not_replace_last_request_context():
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import Usage

    projector = _projector()
    projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 80000},
    }))
    final = projector.consume(_result(usage=Usage(input_tokens=39_187_361, output_tokens=1000)))
    usage = next(event.payload for event in final if event.type == "usage.updated")

    assert usage["contextTokens"] == 80000
    assert usage["usage"]["input_tokens"] == 39_187_361


def test_missing_result_input_count_does_not_become_real_zero_or_a_cache_only_context():
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import Usage

    projector = _projector()
    final = projector.consume(_result(usage=Usage(input_tokens=0, output_tokens=0, cache_read_input_tokens=39_187_361)))
    usage = next(event.payload for event in final if event.type == "usage.updated")

    assert "contextTokens" not in usage
    assert "input_tokens" not in usage["usage"]
    assert "output_tokens" not in usage["usage"]
    assert usage["usage"]["cache_read_input_tokens"] == 39_187_361
    projector.begin("sdk:next")
    blank = projector.consume(_result(usage=Usage()))
    assert next(event.payload for event in blank if event.type == "usage.updated")["usage"] is None


@pytest.mark.parametrize("streamed", [False, True])
@pytest.mark.parametrize("parent", [None, "native-read"])
def test_work_native_tools_have_started_and_completed_events(streamed, parent):
    projector = SDKEventProjector("fixture-session", executor=ExecutorId.CODEBUDDY,
                                  work_tool=True, native_tools=["Read"])
    projector.begin("sdk:fixture")
    block = {"type": "tool_use", "id": "native-read", "name": "Read", "input": {"file_path": "report.txt"}}
    if streamed:
        projector.consume({"type": "stream_event", "session_id": "fixture-session", "event": {
            "type": "message_start", "message": {"id": "message-1"}}})
        events = projector.consume({"type": "stream_event", "session_id": "fixture-session", "event": {
            "type": "content_block_start", "index": 0, "content_block": block}})
    else:
        events = projector.consume({"type": "assistant", "content": [block]})
    assert [(event.type, event.payload["itemId"]) for event in events] == [("tool.started", "native-read")]
    result = projector.consume({"type": "user", "parent_tool_use_id": parent, "content": [{
        "type": "tool_result", "tool_use_id": "native-read", "content": "file contents"}]})
    assert [(event.type, event.payload["itemId"], event.payload["content"]) for event in result] == [
        ("tool.completed", "native-read", "file contents")]


def test_work_native_result_cannot_be_reassigned_to_a_different_parent_or_tool():
    projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Read"])
    projector.begin("sdk:fixture")
    projector.consume({"type": "assistant", "content": [{"type": "tool_use", "id": "native-read",
        "name": "Read", "input": {"file_path": "report.txt"}}]})
    assert projector.consume({"type": "user", "parent_tool_use_id": "foreign-parent", "content": [{
        "type": "tool_result", "tool_use_id": "native-read", "content": "foreign"}]}) == []
    assert projector.consume({"type": "user", "parent_tool_use_id": "native-read", "content": [{
        "type": "tool_result", "tool_use_id": "foreign-tool", "content": "foreign"}]}) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("fragment_start", ["f", "9", "A", "  "])
async def test_workbuddy_large_native_result_survives_stdout_fragments(monkeypatch, fragment_start):
    import json
    from types import SimpleNamespace

    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk._message_parser import parse_message
    from codebuddy_agent_sdk.transport import SubprocessTransport

    from mona.development.executors import codebuddy_transport

    start = {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "native-read", "name": "Read", "input": {"file_path": "image.png"}}]}}
    content = "A" * 400_000 + fragment_start + "A" * 399_999
    block = ({"type": "text", "text": content} if fragment_start.isspace() else
             {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": content}})
    result = {"type": "user", "parent_tool_use_id": "native-read", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "native-read", "is_error": False,
         "content": [block]}]}}
    final = {"type": "result", "session_id": "fixture-session", "subtype": "success", "is_error": False}
    frame = json.dumps(result)
    # A pipe chunk beginning with a JSON-looking character is still part of this frame.
    cut = frame.index(content[:100]) + 400_000

    async def stdout():
        yield json.dumps(start) + "\n" + frame[:cut]
        yield frame[cut:cut + 100_000]
        yield frame[cut + 100_000:] + "\n" + json.dumps(final)

    async def connect(transport):
        transport._process = SimpleNamespace(returncode=0)
        transport._stdout_stream = stdout()

    monkeypatch.setattr(codebuddy_transport, "workbuddy_cli_launcher", lambda _: "fixture-launcher")
    monkeypatch.setattr(SubprocessTransport, "connect", connect)
    monkeypatch.setenv("ELECTRON_RUN_AS_NODE", "1")
    transport = codebuddy_transport.desktop_transport("fixture-entry", options=sdk.CodeBuddyAgentOptions())
    await transport.connect()
    messages = [message async for message in transport.read_messages()]
    assert [message["type"] for message in messages] == ["assistant", "user", "result"]
    assert messages[1] == result
    projector = SDKEventProjector("fixture-session", executor=ExecutorId.CODEBUDDY,
                                  work_tool=True, native_tools=["Read"])
    projector.begin("sdk:fixture")
    events = [event for message in messages for event in projector.consume(parse_message(message))]
    completed = [event for event in events if event.type == "tool.completed"]
    assert len(completed) == 1 and completed[0].payload["itemId"] == "native-read"
    assert events[-1].type == "run.completed"


@pytest.mark.asyncio
async def test_workbuddy_stdout_frame_limit_counts_utf8_across_fragments(monkeypatch):
    from mona.development.executors import codebuddy_transport

    monkeypatch.setattr(codebuddy_transport, "MAX_NATIVE_FRAME_BYTES", 32)

    async def stdout():
        yield '{"text":"'
        yield "图" * 9
        yield '"}\n'

    with pytest.raises(RpcError) as error:
        [line async for line in codebuddy_transport._stdout_json_lines(stdout())]
    assert error.value.code == "rpc_frame_too_large" and error.value.outcome_unknown


@pytest.mark.parametrize("name", ["Write", "Agent", "Task", "Skill", "mcp__foreign__call"])
def test_work_projector_rejects_native_tools_outside_allowed_set(name):
    from mona.development.executors.rpc import RpcError

    # A malformed supplied list cannot authorize native subagents or an external MCP.
    projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Read", name])
    projector.begin("sdk:fixture")
    if name == "Write":
        projector.native_tools = frozenset({"Read"})
    with pytest.raises(RpcError) as error:
        projector.consume({"type": "assistant", "content": [{
            "type": "tool_use", "id": "blocked", "name": name, "input": {}}]})
    assert error.value.code == "native_policy_violation"


@pytest.mark.parametrize("provisional", ["", "mcp__", "mcp__mona_work__", "mona_tool", "skill_reference_read"])
def test_work_stream_tool_names_wait_for_authoritative_envelope(provisional):
    from mona.development.executors.host_tools import SDK_WORK_TOOL

    projector = SDKEventProjector("native-test", work_tool=True)
    projector.begin("sdk:fixture")
    projector.consume({"type": "stream_event", "session_id": "native-test", "event": {
        "type": "message_start", "message": {"id": "message"}}})
    events = projector.consume({"type": "stream_event", "session_id": "native-test", "event": {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "tool_use", "id": "real-tool-id", "name": provisional, "input": {}}}})
    assert events == []
    assert "real-tool-id" not in projector.tool_ids
    events = projector.consume({"type": "assistant", "content": [
        {"type": "tool_use", "id": "real-tool-id", "name": SDK_WORK_TOOL,
         "input": {"tool": "skill_reference_read", "arguments": {"skill": "mona-pptx", "ref_path": "source-images.md"}}}]})
    assert [event.type for event in events] == ["tool.started"]
    assert events[0].payload["name"] == SDK_WORK_TOOL
    assert events[0].payload["arguments"]["tool"] == "skill_reference_read"


def test_provisional_unknown_tool_does_not_authorize_final_disallowed_call():
    projector = SDKEventProjector("native-test", work_tool=True, native_tools=["Read"])
    projector.begin("sdk:fixture")
    projector.consume({"type": "stream_event", "session_id": "native-test", "event": {
        "type": "message_start", "message": {"id": "message"}}})
    assert projector.consume({"type": "stream_event", "session_id": "native-test", "event": {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "tool_use", "id": "blocked-id", "name": "Write", "input": {}}}}) == []
    with pytest.raises(RpcError) as error:
        projector.consume({"type": "assistant", "content": [
            {"type": "tool_use", "id": "blocked-id", "name": "Write", "input": {"content": "PRIVATE_BODY"}}]})
    assert error.value.code == "native_policy_violation"
    assert error.value.rejected_tool == "Write" and error.value.tool_event_stage == "assistant"
    assert "PRIVATE_BODY" not in str(error.value)


@pytest.mark.asyncio
async def test_work_native_hook_uses_authoritative_id_and_host_permission():
    from unittest.mock import AsyncMock

    from mona.development.executors.host_tools import SDK_WORK_TOOL
    from mona.development.executors.sdk_worker import Worker

    worker = Worker()
    worker.start = {"workPrompt": "work", "workNativeTools": ["Read"]}
    worker.active = "sdk:fixture"
    worker.projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Read"])
    worker.projector.begin(worker.active)
    worker.ask = AsyncMock(return_value={"allow": True, "arguments": {"file_path": "resolved-report.txt"}})
    data = {"hook_event_name": "PreToolUse", "session_id": "fixture-session",
            "tool_use_id": "real-item", "tool_name": "Read", "tool_input": {"file_path": "report.txt"}}
    result = await worker.work_native_pre_tool(data, "real-item", None)
    assert result["hookSpecificOutput"] == {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                             "updatedInput": {"file_path": "resolved-report.txt"}}
    worker.ask.assert_awaited_once_with("work/native-permission", {"turnId": "sdk:fixture", "itemId": "real-item",
        "toolName": "Read", "arguments": {"file_path": "report.txt"}})
    worker.ask.reset_mock()
    for changed, item in [({**data, "tool_name": "Write"}, "real-item"),
                          ({**data, "session_id": "other-session"}, "real-item"),
                          (data, "different-item"), (data, "")]:
        denied = await worker.work_native_pre_tool(changed, item, None)
        assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert await worker.work_native_pre_tool({**data, "tool_name": SDK_WORK_TOOL}, None, None) == {"continue_": True}
    worker.ask.assert_not_awaited()


@pytest.mark.asyncio
async def test_work_native_hook_denies_stale_or_invalid_host_permission():
    import asyncio

    from mona.development.executors.sdk_worker import Worker

    worker = Worker()
    worker.start = {"workPrompt": "work", "workNativeTools": ["Write"]}
    worker.active = "sdk:fixture"
    worker.projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Write"])
    worker.projector.begin(worker.active)
    entered, release = asyncio.Event(), asyncio.Event()

    async def ask(*_args):
        entered.set()
        await release.wait()
        return {"allow": True}

    worker.ask = ask
    data = {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "report.txt"}}
    task = asyncio.create_task(worker.work_native_pre_tool(data, "real-item", None))
    await asyncio.wait_for(entered.wait(), 1)
    worker.projector.uncertain = True
    release.set()
    result = await task
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
    worker.projector.uncertain = False
    worker.ask = lambda *_args: asyncio.sleep(0, result={"allow": True, "arguments": "invalid"})
    assert (await worker.work_native_pre_tool(data, "real-item", None))["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["error", "timeout", "cancelled"])
@pytest.mark.parametrize("entry", ["hook", "permission"])
async def test_work_native_authorization_failure_denies_without_leaking(failure, entry, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from mona.development.executors import sdk_worker

    worker = sdk_worker.Worker()
    worker.start = {"workPrompt": "work", "workNativeTools": ["Write"]}
    worker.active = "sdk:fixture"
    worker.projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Write"])
    worker.projector.begin(worker.active)
    worker.sdk = SimpleNamespace(
        PermissionResultAllow=lambda **kwargs: SimpleNamespace(behavior="allow", **kwargs),
        PermissionResultDeny=lambda **kwargs: SimpleNamespace(behavior="deny", **kwargs))
    monkeypatch.setattr(sdk_worker, "WORK_NATIVE_PERMISSION_TIMEOUT", 0.01)

    async def ask(*_args):
        if failure == "error":
            raise RuntimeError("PRIVATE_INTERNAL_DETAIL")
        if failure == "cancelled":
            raise asyncio.CancelledError
        await asyncio.Event().wait()

    worker.ask = ask
    arguments = {"file_path": "report.txt"}
    if entry == "hook":
        result = await worker.work_native_pre_tool({"hook_event_name": "PreToolUse", "tool_name": "Write",
                                                    "tool_input": arguments}, "real-item", None)
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
    else:
        result = await worker.permission("Write", arguments, SimpleNamespace(tool_use_id="real-item"))
        assert result.behavior == "deny"
    assert "PRIVATE_INTERNAL_DETAIL" not in str(result)


@pytest.mark.asyncio
async def test_work_native_permission_fallback_uses_the_real_tool_identity():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from mona.development.executors.sdk_worker import Worker

    worker = Worker()
    worker.start = {"workPrompt": "work", "workNativeTools": ["Read"]}
    worker.active = "sdk:fixture"
    worker.projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Read"])
    worker.projector.begin(worker.active)
    worker.sdk = SimpleNamespace(
        PermissionResultAllow=lambda **kwargs: SimpleNamespace(behavior="allow", **kwargs),
        PermissionResultDeny=lambda **kwargs: SimpleNamespace(behavior="deny", **kwargs))
    worker.ask = AsyncMock(return_value={"allow": True, "arguments": {"file_path": "resolved-report.txt"}})
    result = await worker.permission("Read", {"file_path": "report.txt"}, SimpleNamespace(tool_use_id="real-item"))
    assert result.behavior == "allow" and result.updated_input == {"file_path": "resolved-report.txt"}
    worker.ask.assert_awaited_once_with("work/native-permission", {"turnId": "sdk:fixture", "itemId": "real-item",
        "toolName": "Read", "arguments": {"file_path": "report.txt"}})
    worker.ask.reset_mock()
    assert (await worker.permission("Read", {"file_path": "report.txt"}, None)).behavior == "deny"
    worker.ask.assert_not_awaited()


@pytest.mark.asyncio
async def test_work_native_hook_cancellation_returns_explicit_deny():
    import asyncio

    from mona.development.executors.sdk_worker import Worker

    worker = Worker()
    worker.start = {"workPrompt": "work", "workNativeTools": ["Write"]}
    worker.active = "sdk:fixture"
    worker.projector = SDKEventProjector("fixture-session", work_tool=True, native_tools=["Write"])
    worker.projector.begin(worker.active)
    entered = asyncio.Event()

    async def ask(*_args):
        entered.set()
        await asyncio.Event().wait()

    worker.ask = ask
    task = asyncio.create_task(worker.work_native_pre_tool({"hook_event_name": "PreToolUse", "tool_name": "Write",
        "tool_input": {"file_path": "report.txt"}}, "real-item", None))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    result = await task
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize("executor,package", [("codebuddy", "codebuddy_agent_sdk"), ("claude", "claude_agent_sdk")])
@pytest.mark.parametrize("missing_hook", [False, True])
@pytest.mark.parametrize("permission_mode", ["ask", "full_access"])
def test_work_sdk_options_enable_only_authorized_native_tools(tmp_path, monkeypatch, executor, package, missing_hook, permission_mode):
    import json

    from mona.development.executors.host_tools import SDK_WORK_TOOL
    from mona.development.executors.sdk_worker import Worker

    sdk = pytest.importorskip(package)
    if missing_hook:
        monkeypatch.setattr(sdk, "HookMatcher", None)
    managed = tmp_path / "managed"
    config_dir = managed / (".codebuddy" if executor == "codebuddy" else ".claude")
    config_dir.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(managed))
    monkeypatch.setenv("CODEBUDDY_CONFIG_DIR" if executor == "codebuddy" else "CLAUDE_CONFIG_DIR", str(config_dir))
    start = {"executor": executor, "cwd": str(tmp_path), "executable": str(tmp_path / "native.exe"),
        "nativeSessionId": "fixture-session", "readonly": False, "isSubagent": False, "context": "",
        "model": None, "resume": False, "hostCollaboration": False, "hostDesignResources": False,
        "workPrompt": "test prompt", "workNativeTools": ["Read", "Bash"], "effort": None, "permissionMode": permission_mode}
    worker = Worker()
    try:
        if missing_hook:
            with pytest.raises(ValueError, match="sdk_contract_incompatible"):
                worker.build_options(start)
            return
        worker.build_options(start)
        options = worker.options
        assert options.tools == ["Read", "Bash"]
        assert options.setting_sources == [] and options.allowed_tools == [SDK_WORK_TOOL]
        assert options.permission_mode == "default"
        assert {"Skill", "Task", "Agent"}.issubset(options.disallowed_tools)
        assert options.hooks["PreToolUse"][0].hooks == [worker.work_native_pre_tool]
        assert options.hooks["PreToolUse"][0].timeout == 10.0
        settings = json.loads(options.extra_args["settings"] if executor == "codebuddy" else options.settings)
        assert settings["disableAllHooks"] is False
        assert settings["permissions"]["ask"] == ["Read", "Bash"]
        if executor == "codebuddy":
            assert options.extra_args["strict-mcp-config"] is None
        else:
            assert options.strict_mcp_config is True and options.plugins == []
        assert worker.projector.native_tools == {"Read", "Bash"}
    finally:
        worker._cleanup_work_prompt_file()


@pytest.mark.asyncio
@pytest.mark.parametrize("native_tools", [["Agent"], ["mcp__foreign__call"], ["Read", "Read"], "Read"])
async def test_work_initialize_rejects_invalid_native_tool_allowlist(tmp_path, native_tools):
    from mona.development.executors.sdk_worker import Worker

    worker = Worker()
    params = {"executor": "codebuddy", "cwd": str(tmp_path), "permissionMode": "ask",
              "workPrompt": "test prompt", "workNativeTools": native_tools}
    with pytest.raises(ValueError, match="invalid_worker_options"):
        await worker.handle("initialize", params)
