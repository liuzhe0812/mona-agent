"""SDK error/decision contracts. No account, native executable or model task runs."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_worker import Worker


@dataclass
class ErrorMessage:
    error: str
    session_id: str | None = None


def completed(session_id="native-test"):
    return {"type": "result", "session_id": session_id, "subtype": "success",
            "is_error": False, "result": "已完成核对", "usage": {}}


@pytest.mark.parametrize("message", [
    ErrorMessage("PRIVATE_VENDOR_ERROR", "native-test"),
    ErrorMessage("PRIVATE_VENDOR_ERROR"),
    {"type": "error", "error": "PRIVATE_VENDOR_ERROR", "session_id": "native-test"},
])
def test_error_is_unknown_not_silent_success_and_never_forwards_private_text(message):
    projector = SDKEventProjector("native-test")
    projector.begin("sdk:first")
    events = projector.consume(message)
    assert len(events) == 1 and events[0].type == "run.unknown"
    assert events[0].native_turn_id == "sdk:first"
    assert events[0].payload["reason"] == "sdk_error_reported"
    assert events[0].payload["requiresReconciliation"] is True
    assert "PRIVATE" not in str(events)
    assert projector.uncertain and not projector.finished


def test_installed_official_codebuddy_error_class_obeys_the_same_contract():
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    projector = SDKEventProjector("native-test")
    projector.begin("sdk:first")
    events = projector.consume(sdk.ErrorMessage(error="PRIVATE_VENDOR_ERROR", session_id="native-test"))
    assert len(events) == 1 and events[0].type == "run.unknown"
    assert "PRIVATE" not in str(events)
    final = sdk.ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
        is_error=False, num_turns=1, session_id="native-test", result="已完成核对")
    assert projector.consume(final)[-1].type == "run.completed"


def test_matching_result_resolves_uncertainty_but_new_turn_starts_clean():
    projector = SDKEventProjector("native-test")
    projector.begin("sdk:first")
    assert projector.consume(ErrorMessage("PRIVATE"))[0].type == "run.unknown"
    with pytest.raises(RpcError, match="原生消息不属于当前会话"):
        projector.consume(completed("foreign-session"))
    assert projector.consume(completed())[-1].type == "run.completed"
    assert projector.finished
    assert projector.consume(ErrorMessage("late-error")) == []
    projector.begin("sdk:second")
    assert not projector.uncertain and not projector.finished
    assert projector.consume(completed())[-1].native_turn_id == "sdk:second"


def test_foreign_or_background_error_does_not_change_current_turn():
    projector = SDKEventProjector("native-test")
    projector.begin("sdk:first")
    with pytest.raises(RpcError):
        projector.consume(ErrorMessage("PRIVATE", "foreign-session"))
    assert projector.consume({"type": "error", "parent_tool_use_id": "child", "error": "PRIVATE"}) == []
    assert not projector.uncertain
    assert projector.consume(completed())[-1].type == "run.completed"


def worker_for_turn(tmp_path):
    worker = Worker()
    worker.start = {"cwd": str(tmp_path), "readonly": False, "hostCollaboration": True,
                    "permissionMode": "ask"}
    worker.sdk = SimpleNamespace(
        PermissionResultAllow=lambda **kwargs: SimpleNamespace(behavior="allow", **kwargs),
        PermissionResultDeny=lambda **kwargs: SimpleNamespace(behavior="deny", **kwargs))
    worker.active = "sdk:first"
    worker.projector = SDKEventProjector("native-test", host_collaboration=True)
    worker.projector.begin(worker.active)
    return worker


async def decision(worker, kind):
    if kind == "host":
        return await worker.host_collaboration({"action": "list"})
    if kind == "question":
        return await worker.permission("AskUserQuestion", {"questions": [{"question": "目标环境？"}]}, None)
    return await worker.permission("Bash", {"command": "echo test-only"}, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["permission", "question", "host"])
@pytest.mark.parametrize("change", ["closed", "next_turn", "uncertain", "completed"])
async def test_delayed_reply_cannot_authorize_a_changed_turn(tmp_path, kind, change):
    worker = worker_for_turn(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    replies = {"permission": "accept", "question": {"question-0": ["测试环境"]},
               "host": {"content": [{"type": "text", "text": "OLD_RESULT"}]}}
    async def ask(method, params):
        assert params["turnId"] == "sdk:first"
        entered.set()
        await release.wait()
        return replies[kind]
    worker.ask = ask
    task = asyncio.create_task(decision(worker, kind))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        if change == "closed":
            worker.closing.set()
        elif change == "next_turn":
            worker.active = "sdk:second"
            worker.projector.begin(worker.active)
        elif change == "uncertain":
            worker.projector.consume(ErrorMessage("PRIVATE"))
        else:
            worker.projector.consume(completed())
        release.set()
        reply = await asyncio.wait_for(task, 1)
        if kind == "host":
            assert reply.get("isError") is True and "OLD_RESULT" not in str(reply)
        else:
            assert reply.behavior == "deny"
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["permission", "question", "host"])
async def test_current_reply_is_still_consumed_without_restarting_task(tmp_path, kind):
    worker = worker_for_turn(tmp_path)
    requests = []
    async def ask(method, params):
        requests.append((method, params))
        return {"permission": "accept", "question": {"question-0": ["测试环境"]},
                "host/collaboration": {"content": [{"type": "text", "text": "CURRENT_RESULT"}]}}[method]
    worker.ask = ask
    result = await decision(worker, kind)
    assert len(requests) == 1 and requests[0][1]["turnId"] == worker.active
    assert (result.get("isError", False) is False) if kind == "host" else result.behavior == "allow"


@pytest.mark.asyncio
async def test_uncertain_turn_cannot_accept_immediate_file_or_host_permissions(tmp_path):
    worker = worker_for_turn(tmp_path)
    worker.projector.consume(ErrorMessage("PRIVATE"))
    async def never_ask(*_args):
        raise AssertionError("Unknown work cannot issue another host request")
    worker.ask = never_ask
    for name, args in [("Read", {"file_path": "a.py"}), ("Write", {"file_path": "a.py", "content": "test"}),
                       ("mcp__mona_development__development_collaboration", {"action": "start"})]:
        assert (await worker.permission(name, args, None)).behavior == "deny"
    assert (await worker.host_collaboration({"action": "list"}))["isError"] is True


@pytest.mark.asyncio
async def test_official_sdk_registers_separate_session_bound_tools(tmp_path):
    pytest.importorskip("codebuddy_agent_sdk")
    from mona.development.executors.host_tools import HOST_SERVER, HOST_TOOL

    servers = []
    for index in range(2):
        worker = Worker()
        worker.start = {"executor": "codebuddy", "cwd": str(tmp_path),
            "executable": str(tmp_path / "not-launched.exe"),
            "nativeSessionId": f"official-sdk-session-{index}", "readonly": False,
            "context": "test project", "model": None, "resume": False, "hostCollaboration": True,
            "permissionMode": "ask"}
        # Build with the real installed SDK; never connect or start its CLI.
        worker.build_options(worker.start)
        worker.active = f"sdk:turn-{index}"
        worker.projector.begin(worker.active)
        async def ask(method, params, expected=worker.active):
            assert method == "host/collaboration" and params["turnId"] == expected
            return {"content": [{"type": "text", "text": expected}]}
        worker.ask = ask
        server = worker.options.mcp_servers[HOST_SERVER]["server"]
        servers.append((server, worker.active))
        listing = await server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert [tool["name"] for tool in listing["result"]["tools"]] == [HOST_TOOL]

    assert servers[0][0] is not servers[1][0]
    for server, expected in servers:
        response = await server.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": HOST_TOOL, "arguments": {"action": "list"}}})
        assert response["result"]["content"] == [{"type": "text", "text": expected}]

