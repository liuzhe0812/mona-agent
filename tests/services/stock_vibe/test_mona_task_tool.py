from __future__ import annotations

import hashlib
import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from mona.agent.tools.context import RequestContext, ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.stock_vibe import StockVibeTaskTool
from mona.config import loader as config_loader
from mona.config.schema import Config, _resolve_tool_config_refs
from mona.materials.auth import materials_auth_middleware
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime


def _private_app_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    app_data = tmp_path / "private-mona-app-data"
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(app_data))
    monkeypatch.setattr(config_loader, "_current_config_path", app_data / "config.json")
    return app_data


@asynccontextmanager
async def _host(handler):
    server = TestServer(web.Application())
    server.app.router.add_route("*", "/{path:.*}", handler)
    await server.start_server()
    try:
        yield server.port
    finally:
        await server.close()


def _context(port: int, *, job_id: str | None = None, workflow_run_id: str | None = None) -> ToolContext:
    return ToolContext(
        config=None,
        workspace="test-workspace",
        services_port=port,
        agent_id="mona",
        job_id=job_id,
        workflow_run_id=workflow_run_id,
    )


def _research_args() -> dict[str, str]:
    return {
        "action": "submit_research",
        "symbol": "600000.SH",
        "start_date": "2025-01-02",
        "end_date": "2025-01-10",
        "question": "核对固定区间的行情事实。",
        "mode": "swing",
    }


@pytest.mark.asyncio
async def test_tool_is_not_discovered_and_internal_adapter_requires_trusted_write_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app_data = _private_app_data(tmp_path, monkeypatch)
    requests = []

    async def handler(request: web.Request) -> web.Response:
        requests.append(request.path)
        return web.json_response({"status": "unexpected"})

    async with _host(handler) as port:
        ctx = _context(port)
        assert StockVibeTaskTool not in ToolLoader().discover()
        tool = StockVibeTaskTool(ctx)
        tool.set_context(RequestContext(channel="test", chat_id="chat", message_id=None,
                                        metadata={"job_id": "untrusted-model-field"}))
        result = await tool.execute(**_research_args())
        assert "可信" in result
        assert requests == []
        assert not (app_data / "stock-vibe" / "tool-outbox").exists()
        assert not (app_data / "stock-execution").exists()


@pytest.mark.asyncio
async def test_lost_submit_receipt_is_reconciled_after_recreation_without_second_post(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app_data = _private_app_data(tmp_path, monkeypatch)
    calls: list[dict] = []

    async def handler(request: web.Request) -> web.Response:
        record = {"method": request.method, "path": request.path,
                  "token": request.headers.get("X-Mona-Token")}
        if request.method == "POST":
            record["body"] = await request.json()
            calls.append(record)
            # The host accepted the start request but its HTTP receipt is lost.
            request.transport.close()
            return web.Response(text="lost receipt")
        calls.append(record)
        if request.path.startswith("/api/stock-vibe/requests/"):
            request_id = request.path.rsplit("/", 1)[-1]
            return web.json_response({"request_id": request_id, "status": "unknown",
                                      "error_category": "native_unconfirmed"})
        return web.json_response({"error": "not_found"}, status=404)

    monkeypatch.setattr("mona.agent.tools.stock_vibe.get_services_token", lambda: "local-test-token")
    async with _host(handler) as port:
        ctx = _context(port)
        first = StockVibeTaskTool(ctx)
        origin = RequestContext(channel="websocket", chat_id="research-room", message_id="msg-stable-01")
        first.set_context(origin)
        response = json.loads(await first.execute(**_research_args()))

        # Simulate a new tool instance after restart; the durable O_EXCL marker
        # means it may query the stable request but cannot post a second task.
        restarted = StockVibeTaskTool(ctx)
        restarted.set_context(origin)
        response_after_restart = json.loads(await restarted.execute(**_research_args()))

    post_calls = [call for call in calls if call["method"] == "POST"]
    get_calls = [call for call in calls if call["method"] == "GET"]
    assert len(post_calls) == 1
    assert len(get_calls) == 2
    assert all(call["token"] == "local-test-token" for call in calls)
    assert post_calls[0]["path"] == "/api/stock-vibe/swarm/runs"
    assert post_calls[0]["body"]["preset_name"] == "mona_ashare_research"
    user_vars = post_calls[0]["body"]["user_vars"]
    assert set(user_vars) == {"symbol", "start_date", "end_date", "question"}
    assert "波段（3、5、10 个交易日）" in user_vars["question"]
    request_ids = {path["path"].rsplit("/", 1)[-1] for path in get_calls}
    assert len(request_ids) == 1
    request_id = request_ids.pop()
    assert len(request_id) == 32 and all(ch in "0123456789abcdef" for ch in request_id)
    assert response["result"]["status"] == "unknown"
    assert response_after_restart["result"]["request_id"] == request_id
    marker_path = app_data / "stock-vibe" / "tool-outbox" / f"{request_id}.json"
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    assert set(marker) == {"request_id", "payload_sha256"}
    assert marker["payload_sha256"] == hashlib.sha256(
        # Marker digest is an irreversible identity/payload digest; question text is not persisted.
        json.dumps({"actor": "mona", "identity": {"kind": "message", "id": "msg-stable-01"},
                    "action": "submit_research", "payload": {
                        "method": "POST", "path": "/swarm/runs", "payload": post_calls[0]["body"]}},
                   ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()
    assert "核对固定区间" not in marker_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_fixed_query_and_cancel_routes_preserve_host_objects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app_data = _private_app_data(tmp_path, monkeypatch)
    calls: list[tuple[str, str, str | None]] = []

    async def handler(request: web.Request) -> web.Response:
        calls.append((request.method, request.path, request.headers.get("X-Mona-Token")))
        if request.method == "POST":
            if request.path.endswith("/swarm/runs"):
                return web.json_response({"request_id": request.headers.get("X-Mona-Request-ID"),
                                          "status": "completed", "receipt": {"status_code": 200,
                                          "body": {"id": "swarm_accepted"}}, "source": {"snapshot_id": "fixture"}})
            return web.json_response({"request_id": request.headers.get("X-Mona-Request-ID"),
                                      "status": "completed", "receipt": {"status_code": 200,
                                      "body": {"session_id": "session_1"}}, "source": None})
        return web.json_response({"native": {"id": request.path.rsplit("/", 1)[-1]},
                                  "source": {"snapshot_id": "sha256:test-fixture"}})

    monkeypatch.setattr("mona.agent.tools.stock_vibe.get_services_token", lambda: "local-test-token")
    async with _host(handler) as port:
        ctx = _context(port)
        tool = StockVibeTaskTool(ctx)
        tool.set_context(RequestContext(channel="websocket", chat_id="room", message_id="submit-1"))
        submitted = json.loads(await tool.execute(**_research_args()))
        assert submitted["result"]["receipt"]["body"]["id"] == "swarm_accepted"
        assert "不表示研究报告已完成" in submitted["notice"]

        for kind, value, route in (
            ("request", "a" * 32, "/requests/" + "a" * 32),
            ("swarm", "swarm_1", "/swarm/runs/swarm_1"),
            ("session", "session_1", "/sessions/session_1"),
            ("operation", "operation_1", "/operations/operation_1"),
        ):
            result = json.loads(await tool.execute(action="query", query_kind=kind, object_id=value))
            assert result["result"]["native"]["id"] == value
            assert calls[-1][0:2] == ("GET", "/api/stock-vibe" + route)

        # Trusted job identity is available to named subagent tools.
        tool = StockVibeTaskTool(_context(port, job_id="job-trusted-1"))
        tool.set_context(RequestContext(channel="subagent", chat_id="room"))
        result = json.loads(await tool.execute(action="cancel", query_kind="session", object_id="session_1"))
        assert result["result"]["receipt"]["body"]["session_id"] == "session_1"
        assert calls[-1][0:2] == ("POST", "/api/stock-vibe/sessions/session_1/cancel")

        before = len(calls)
        denied = await tool.execute(action="cancel", query_kind="operation", object_id="operation_1")
        assert "只支持" in denied
        assert len(calls) == before
    assert not (app_data / "stock-execution").exists()


@asynccontextmanager
async def _research_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, unknown_create=False, unknown_send=False):
    """Exercise the real authenticated Host/contracts/ledger, isolating only native execution."""
    _private_app_data(tmp_path, monkeypatch)
    _resolve_tool_config_refs()
    runtime = StockVibeRuntime(runtime_root=tmp_path / "no-runtime", data_root=tmp_path / "native",
                               config_loader=Config)
    state = {"posts": [], "reads": [], "receipts": {}, "messages": [], "attempt": None, "session": None}
    source = {"data_root_sha256": "a" * 64, "instance_id": "b" * 32,
              "snapshot_id": "sha256:" + "c" * 64, "patches": []}

    def native(request: httpx.Request):
        path = request.url.path
        if request.method == "POST":
            request_id = request.headers["X-Mona-Request-ID"]
            assert len(request_id) == 32
            if path == "/upload":
                state["posts"].append((path, request_id, request.content))
                body = {"file_path": "uploads/" + "d" * 32 + ".txt", "filename": "资料.txt"}
            else:
                payload = json.loads(request.content)
                state["posts"].append((path, request_id, payload))
                if path == "/sessions":
                    state["session"] = {"session_id": "session_1", "last_attempt_id": None}
                    body = {"session_id": "session_1"}
                elif path == "/sessions/session_1/messages":
                    attempt_id = "attempt_" + str(len(state["messages"]) + 1)
                    state["session"]["last_attempt_id"] = attempt_id
                    state["attempt"] = {"session_id": "session_1", "attempt_id": attempt_id,
                                        "status": "running", "summary": None}
                    state["messages"].append({"role": "user", "content": payload["content"],
                                              "linked_attempt_id": attempt_id,
                                              "metadata": {key: payload[key] for key in ("research", "attachments") if key in payload}})
                    body = {"session_id": "session_1", "attempt_id": attempt_id}
                else:
                    raise AssertionError(path)
            if not (unknown_create and path == "/sessions" or unknown_send and path.endswith("/messages")):
                state["receipts"][request_id] = {"request_id": request_id, "status": "completed",
                                                  "receipt": {"status_code": 200, "body": body}}
            return httpx.Response(200, json=body)
        state["reads"].append(str(request.url))
        if path.startswith("/mona/requests/"):
            record = state["receipts"].get(path.rsplit("/", 1)[-1])
            return httpx.Response(200 if record else 404, json=record or {})
        if path == "/sessions/session_1":
            return httpx.Response(200, json=state["session"])
        if path == "/sessions":
            return httpx.Response(200, json=state.get("recent", []))
        if path == "/sessions/session_1/messages":
            return httpx.Response(200, json=state["messages"])
        if path.startswith("/mona/sessions/session_1/attempts/"):
            return httpx.Response(200, json=state["attempt"])
        raise AssertionError(path)

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as client:
            yield client

    monkeypatch.setattr(runtime, "lease", lease)
    monkeypatch.setattr(runtime, "source_identity", lambda: source)
    app = web.Application(middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(app, runtime=runtime)
    async with TestServer(app) as server:
        yield server.port, state


def _session_tool(port: int, workspace: Path, message_id="research-1", chat_id="room"):
    context = _context(port)
    context.workspace = str(workspace)
    tool = StockVibeTaskTool(context)
    tool.set_context(RequestContext(channel="websocket", chat_id=chat_id, message_id=message_id,
                                    session_key="websocket:" + chat_id))
    return tool


@pytest.mark.asyncio
async def test_general_research_real_host_contract_attachment_followup_and_report(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "资料.txt").write_text("原始财报依据", encoding="utf-8")
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        tool = _session_tool(port, workspace)
        started = json.loads(await tool.execute(action="start_research", question="现金流支持盈利吗？",
                                                symbol="002460", mode="medium", task="fundamental",
                                                attachments=["资料.txt"]))
        assert started["session_id"] == "session_1" and started["attempt_id"] == "attempt_1"
        assert started["status"] == "accepted" and "尚未完成" in started["notice"]
        posts = state["posts"]
        assert [row[0] for row in posts] == ["/sessions", "/upload", "/sessions/session_1/messages"]
        assert len({row[1] for row in posts}) == 3
        assert posts[0][2]["config"]["mona_workbench"] == {"symbol": "002460.SZ", "mode": "medium", "task": "fundamental"}
        assert "原始财报依据".encode() in posts[1][2]
        assert posts[2][2]["research"] == {"symbol": "002460.SZ", "mode": "medium"}
        assert posts[2][2]["attachments"][0]["filename"] == "资料.txt"

        # Reading a completed HTTP receipt must still expose the running native attempt.
        running = json.loads(await tool.execute(action="read_research"))
        assert running["status"] == "running" and running["report"] is None
        before = len(posts)
        blocked = json.loads(await tool.execute(action="continue_research", question="继续"))
        assert blocked["status"] == "running" and blocked["submission"] == "not_sent"
        assert "本次追问尚未提交" in blocked["notice"]
        assert len(posts) == before

        state["attempt"].update(status="completed", summary="利润增长，但现金流缺少支持。",
                                grounding_validation={"valid": True})
        state["messages"].append({"role": "assistant", "content": "完整报告", "linked_attempt_id": "attempt_1",
                                  "tool_trail": [{"tool": "read_file", "output": "已读取资料中的现金流数据"}]})
        report = json.loads(await tool.execute(action="read_research"))
        assert report["status"] == "completed" and report["report"] == "利润增长，但现金流缺少支持。"
        assert report["tool_trail"][0]["tool"] == "read_file"
        assert report["grounding_validation"]["valid"] is True

        # A recreated tool in the same trusted conversation continues the native Session.
        continued_tool = _session_tool(port, workspace, message_id="followup-2")
        continued = json.loads(await continued_tool.execute(action="continue_research", question="现金流哪里有问题？"))
        assert continued["session_id"] == "session_1" and continued["attempt_id"] == "attempt_3"
        assert len([row for row in posts if row[0] == "/sessions"]) == 1
        assert len([row for row in posts if row[0] == "/upload"]) == 1
        assert posts[-1][2]["research"] == posts[2][2]["research"]
        assert posts[-1][2]["attachments"] == posts[2][2]["attachments"]
        assert "沿用原研究" in await continued_tool.execute(action="continue_research", question="再看", symbol="600000")

        state["attempt"]["status"] = "completed"
        next_tool = _session_tool(port, workspace, message_id="followup-3")
        await next_tool.execute(action="continue_research", question="只分析文字", attachments=[])
        assert "attachments" not in posts[-1][2]
        assert "同一主会话" in await _session_tool(port, workspace, chat_id="other").execute(action="read_research")


@pytest.mark.asyncio
async def test_unknown_creation_reconciles_without_send_or_duplicate_create(tmp_path, monkeypatch):
    async with _research_host(tmp_path, monkeypatch, unknown_create=True) as (port, state):
        tool = _session_tool(port, tmp_path)
        first = json.loads(await tool.execute(action="start_research", question="比较银行行业"))
        repeated = json.loads(await _session_tool(port, tmp_path).execute(action="start_research", question="比较银行行业"))
        assert first["result"]["status"] == "unknown"
        assert repeated["result"]["request_id"] == first["result"]["request_id"]
        assert [row[0] for row in state["posts"]] == ["/sessions"]


@pytest.mark.asyncio
async def test_unknown_send_is_not_replayed_when_tool_is_recreated(tmp_path, monkeypatch):
    async with _research_host(tmp_path, monkeypatch, unknown_send=True) as (port, state):
        first = json.loads(await _session_tool(port, tmp_path).execute(action="start_research", question="研究行业变化"))
        assert first["result"]["status"] == "unknown"
        assert first["result"]["session_id"] == "session_1"
        second = json.loads(await _session_tool(port, tmp_path).execute(action="start_research", question="研究行业变化"))
        assert second["result"]["request_id"] == first["result"]["request_id"]
        assert [row[0] for row in state["posts"]] == ["/sessions", "/sessions/session_1/messages"]


@pytest.mark.asyncio
async def test_multicompany_research_does_not_create_fake_single_stock_context(tmp_path, monkeypatch):
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        result = json.loads(await _session_tool(port, tmp_path).execute(action="start_research", question="比较两家公司的现金流"))
        assert result["session_id"] == "session_1"
        assert "config" not in state["posts"][0][2]
        assert "research" not in state["posts"][-1][2]


@pytest.mark.asyncio
async def test_new_research_id_uses_full_question_and_attachment_intent(tmp_path, monkeypatch):
    attachment = tmp_path / "资料.txt"
    attachment.write_text("第一版现金流", encoding="utf-8")
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        tool = _session_tool(port, tmp_path)
        prefix = "研究背景" * 20
        for question, paths in ((prefix + "分析盈利", None), (prefix + "分析现金流", None),
                                (prefix + "分析现金流", [str(attachment)])):
            await tool.execute(action="start_research", question=question, attachments=paths)
        created = [row for row in state["posts"] if row[0] == "/sessions"]
        assert len(created) == 3 and len({row[1] for row in created}) == 3
        assert len({row[2]["title"] for row in created}) == 1
        # An identical intent still reconciles the same create and send receipts.
        before = len(state["posts"])
        await tool.execute(action="start_research", question=prefix + "分析现金流", attachments=[str(attachment)])
        assert len(state["posts"]) == before


@pytest.mark.asyncio
async def test_attachment_paths_require_scope_or_trusted_user_attachment(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "private.txt"
    outside.write_text("用户选择的资料", encoding="utf-8")
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        tool = _session_tool(port, workspace)
        for path in (str(outside), "https://example.com/report.txt", "../private.txt"):
            assert "尚未提交研究" in await tool.execute(action="start_research", question="分析资料", attachments=[path])
        assert "资料不存在" in await tool.execute(action="start_research", question="分析资料", attachments=["missing.txt"])
        assert state["posts"] == []
        tool.set_context(RequestContext(channel="websocket", chat_id="room", message_id="trusted-file",
                                        metadata={"_attachment_paths": [str(outside)]}))
        # The original user-selected file is allowed without widening the workspace.
        uploads = tool._attachment_payloads([str(outside)])
        assert uploads[0]["filename"] == "private.txt"


@pytest.mark.asyncio
async def test_continuation_plan_freezes_target_context_and_local_file_digest(tmp_path, monkeypatch):
    attachment = tmp_path / "资料.txt"
    attachment.write_text("原始现金流", encoding="utf-8")
    async with _research_host(tmp_path, monkeypatch, unknown_send=True) as (port, state):
        await _session_tool(port, tmp_path).execute(action="start_research", question="分析财报", symbol="002460",
                                                   mode="medium", attachments=[str(attachment)])
        state["attempt"]["status"] = "completed"
        original = _session_tool(port, tmp_path, message_id="followup-stable")
        first = json.loads(await original.execute(action="continue_research", question="核对现金流"))
        assert first["result"]["status"] == "unknown"
        before = len(state["posts"])
        original._bind_session("session_other")
        state["messages"][-1]["metadata"] = {"research": {"symbol": "600000.SH", "mode": "ultrashort"},
                                                "attachments": [{"file_path": "uploads/" + "e" * 32 + ".txt", "filename": "新资料.txt"}]}
        restored = _session_tool(port, tmp_path, message_id="followup-stable")
        repeated = json.loads(await restored.execute(action="continue_research", question="核对现金流"))
        assert repeated["result"]["request_id"] == first["result"]["request_id"]
        assert repeated["result"]["session_id"] == "session_1"
        assert len(state["posts"]) == before
        assert not any("/sessions/session_other" in path for path in state["reads"])

        state["attempt"]["status"] = "completed"
        local_tool = _session_tool(port, tmp_path, message_id="followup-file")
        submitted = json.loads(await local_tool.execute(action="continue_research", session_id="session_1",
                                                         question="读取新版资料", attachments=[str(attachment)]))
        assert submitted["result"]["status"] == "unknown"
        before = len(state["posts"])
        attachment.write_text("内容已修改", encoding="utf-8")
        response = await _session_tool(port, tmp_path, message_id="followup-file").execute(
            action="continue_research", session_id="session_1", question="读取新版资料", attachments=[str(attachment)])
        assert "资料已发生变化" in response and len(state["posts"]) == before
        plan_text = "".join(path.read_text(encoding="utf-8") for path in local_tool._binding_path().parent.glob("plan-*.json"))
        assert "核对现金流" not in plan_text and "读取新版资料" not in plan_text


@pytest.mark.asyncio
async def test_untrusted_media_from_another_chat_is_not_an_allowed_attachment(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    media = tmp_path / "shared-media"
    media.mkdir()
    other_chat_file = media / "another-chat.txt"
    other_chat_file.write_text("其他会话的资料", encoding="utf-8")
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda: media)
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        result = await _session_tool(port, workspace).execute(action="start_research", question="读取资料",
                                                             attachments=[str(other_chat_file)])
        assert "本次尚未提交研究" in result and state["posts"] == []


@pytest.mark.asyncio
async def test_list_research_uses_real_host_recent_list_and_bounded_title_filter(tmp_path, monkeypatch):
    async with _research_host(tmp_path, monkeypatch) as (port, state):
        state["recent"] = [{"session_id": "old_general", "title": "银行行业比较", "status": "idle",
                             "created_at": "2026-10-18", "updated_at": "2026-10-19", "last_attempt_id": "old_attempt"},
                            {"session_id": "old_other", "title": "消费行业", "status": "idle"}]
        result = json.loads(await _session_tool(port, tmp_path).execute(action="list_research", query="银行", limit=100))
        assert result["loaded"] == 2 and result["limit"] == 100
        assert [item["session_id"] for item in result["sessions"]] == ["old_general"]
        assert result["sessions"][0]["last_attempt_id"] == "old_attempt"
        assert "不代表全部历史" in result["scope"]
        assert state["reads"] == ["http://native/sessions?limit=100"] and state["posts"] == []
