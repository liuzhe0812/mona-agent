import asyncio
import copy
import secrets
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId, InputState, RunStatus
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.session.manager import SessionManager


class Model(LLMProvider):
    def __init__(self, replies=None, gate=None):
        super().__init__()
        self.replies = list(replies or [])
        self.gate = gate
        self.entered = asyncio.Event()
        self.requests = []

    async def chat(self, messages, tools=None, **kwargs):
        self.requests.append(copy.deepcopy({"messages": messages, "tools": tools}))
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        return self.replies.pop(0) if self.replies else LLMResponse("完成当前请求。")

    def get_default_model(self):
        return "test-coding"


class ThinkingModel(Model):
    async def chat_stream(self, messages, tools=None, **kwargs):
        on_thinking_delta = kwargs.get("on_thinking_delta")
        if on_thinking_delta:
            await on_thinking_delta("检查实际文件")
        return await super().chat_stream(messages, tools=tools, **kwargs)


def make_runtime(tmp_path, monkeypatch, model):
    _resolve_tool_config_refs()
    config = Config()
    config.development.coding.max_tool_iterations = 8
    # Isolated models must not read the real desktop catalogue or its IPC credentials.
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", lambda *args, **kwargs:
        SimpleNamespace(provider=model, model="test-coding", context_window_tokens=65536))
    store = DevelopmentStore(tmp_path / "state.sqlite3")
    runtime = DevelopmentRuntime(store, SessionManager(tmp_path / "transcripts"), lambda: config)
    root = tmp_path / "代码 项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("PROJECT_RULE_SENTINEL: preserve manual work", encoding="utf-8")
    project = store.open_project(root)
    session = store.create_session(project.id)
    return runtime, project, session, root


async def wait_done(runtime, session_id):
    async def wait():
        while True:
            runs = runtime.store.list_runs(session_id)
            if runs and not any(r.status in {RunStatus.QUEUED, RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.INTERRUPTING} for r in runs) and not runtime.tasks:
                return runs
            await asyncio.sleep(0.02)
    return await asyncio.wait_for(wait(), 15)


@pytest.mark.asyncio
async def test_queued_input_guided_during_tool_execution_reaches_same_run_once(tmp_path, monkeypatch):
    model_gate, tool_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    model = Model([
        LLMResponse("", tool_calls=[ToolCallRequest("read-once", "read_file", {"path": "AGENTS.md"})]),
        LLMResponse("Guidance handled."),
    ], model_gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        first = await runtime.submit(session.id, "request_original", "ORIGINAL_REQUEST")
        await asyncio.wait_for(model.entered.wait(), 3)
        reader = runtime.tools[session.id].registry.get("read_file")
        execute = reader.execute

        async def gated_execute(**params):
            tool_entered.set()
            await release.wait()
            return await execute(**params)

        monkeypatch.setattr(reader, "execute", gated_execute)
        model_gate.set()
        await asyncio.wait_for(tool_entered.wait(), 3)
        await runtime.submit(session.id, "request_queued", "GUIDE_DURING_TOOL")
        submitted = await runtime.guide_input(session.id, "request_queued", 0, first["run"]["id"])
        repeated = await runtime.guide_input(session.id, "request_queued", 0, first["run"]["id"])
        assert submitted["input"]["id"] == repeated["input"]["id"] == "request_queued"
        assert repeated["reused"]
        assert submitted["input"]["state"] == "pending"
        assert len(model.requests) == 1
        assert runtime.snapshot(session.id)["pendingInputs"][0]["intent"] == "steering"
        assert next(m for m in runtime.snapshot(session.id)["messages"] if m["content"] == "GUIDE_DURING_TOOL")["queued"]

        release.set()
        runs = await wait_done(runtime, session.id)
        assert len(runs) == 1 and runs[0].id == first["run"]["id"]
        assert runs[0].status == RunStatus.SUCCEEDED
        assert len(model.requests) == 2
        assert sum(m.get("role") == "user" and m.get("content") == "GUIDE_DURING_TOOL"
                   for m in model.requests[1]["messages"]) == 1
        assert runtime.store.get_input("request_queued").state == InputState.CONSUMED
        final = runtime.snapshot(session.id)
        assert not final["pendingInputs"]
        assert sum(m["content"] == "GUIDE_DURING_TOOL" for m in final["messages"]) == 1
        assert sum(m["role"] == "tool" for m in final["messages"]) == 1
        retry = await runtime.submit(session.id, "request_queued", "GUIDE_DURING_TOOL")
        assert retry["reused"] and len(model.requests) == 2
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_stop_before_guidance_dispatch_keeps_the_same_input_in_a_paused_queue(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model(gate=gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        first = await runtime.submit(session.id, "request_one", "1")
        await asyncio.wait_for(model.entered.wait(), 3)
        await runtime.submit(session.id, "request_two", "2")
        await runtime.guide_input(session.id, "request_two", 0, first["run"]["id"])
        before_stop = runtime.snapshot(session.id)
        second = next(m for m in before_stop["messages"] if m["content"] == "2")
        assert second["queued"]
        assert before_stop["pendingInputs"][0]["intent"] == "steering"

        await runtime.interrupt(session.id, first["run"]["id"])
        pending = runtime.store.get_input("request_two")
        assert pending.state == InputState.PENDING and pending.intent == "follow_up"
        stopped = runtime.snapshot(session.id)
        assert [i["id"] for i in stopped["pendingInputs"]] == ["request_two"]
        assert [m["content"] for m in stopped["messages"] if m["role"] == "user" and not m["queued"]] == ["1"]
        retry = await runtime.submit(session.id, "request_two", "2")
        assert retry["reused"] and retry["input"]["state"] == "pending"
        assert len(model.requests) == 1
        assert len(runtime.store.list_runs(session.id)) == 1
    finally:
        gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_paused_guide_can_be_delivered_to_a_new_active_run(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model(gate=gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        first = await runtime.submit(session.id, "request_one", "1")
        await asyncio.wait_for(model.entered.wait(), 3)
        await runtime.submit(session.id, "request_two", "2")
        await runtime.guide_input(session.id, "request_two", 0, first["run"]["id"])
        await runtime.interrupt(session.id, first["run"]["id"])
        paused = runtime.store.get_input("request_two")
        model.entered.clear()
        current = await runtime.submit(session.id, "request_three", "3")
        await asyncio.wait_for(model.entered.wait(), 3)
        guided = await runtime.guide_input(session.id, paused.id, paused.revision, current["run"]["id"])
        assert guided["input"]["id"] == paused.id
        assert [item.id for item in runtime.store.list_inputs(current["run"]["id"])] == [paused.id]
        assert not runtime.store.list_inputs(first["run"]["id"])

        gate.set()
        await wait_done(runtime, session.id)
        assert runtime.store.get_input(paused.id).state == InputState.CONSUMED
        assert len(model.requests) == 3
        assert sum(m.get("content") == "2" for m in model.requests[-1]["messages"]) == 1
        assert not runtime.snapshot(session.id)["pendingInputs"]
    finally:
        gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_guide_api_preserves_queue_identity_and_reuses_the_receipt(tmp_path, monkeypatch):
    token = secrets.token_hex(32)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    gate = asyncio.Event()
    model = Model(gate=gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    async with TestClient(TestServer(app)) as client:
        first = await runtime.submit(session.id, "request_one", "1")
        await asyncio.wait_for(model.entered.wait(), 3)
        queued = await runtime.submit(session.id, "request_two", "2")
        path = f"/api/development/sessions/{session.id}/inputs/request_two/guide"
        body = {"revision": 0, "targetRunId": first["run"]["id"]}
        headers = {"X-Mona-Token": token}
        async with client.post(path, json=body, headers=headers) as response:
            assert response.status == 200
            guided = await response.json()
        assert guided["input"]["id"] == queued["input"]["id"]
        assert guided["input"]["messageId"] == queued["input"]["messageId"]
        assert guided["input"]["intent"] == "steering"
        async with client.post(path, json=body, headers=headers) as response:
            assert response.status == 200
            assert (await response.json())["reused"]
        assert len(runtime.store.list_inputs(first["run"]["id"])) == 1
        gate.set()
        await wait_done(runtime, session.id)
        assert sum(m.get("content") == "2" for m in model.requests[-1]["messages"]) == 1


@pytest.mark.asyncio
async def test_interrupted_dispatched_guidance_does_not_return_as_a_pending_input(tmp_path, monkeypatch):
    gate, guide_dispatched = asyncio.Event(), asyncio.Event()
    model = Model(gate=gate)
    chat = model.chat

    async def paused_chat(*args, **kwargs):
        response = await chat(*args, **kwargs)
        if len(model.requests) == 2:
            guide_dispatched.set()
            await asyncio.Event().wait()
        return response

    monkeypatch.setattr(model, "chat", paused_chat)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        first = await runtime.submit(session.id, "request_original", "ORIGINAL_REQUEST")
        await asyncio.wait_for(model.entered.wait(), 3)
        await runtime.submit(session.id, "request_queued", "GUIDANCE_BEFORE_STOP")
        await runtime.guide_input(session.id, "request_queued", 0, first["run"]["id"])
        gate.set()
        await asyncio.wait_for(guide_dispatched.wait(), 3)
        await runtime.interrupt(session.id, first["run"]["id"])

        assert runtime.store.get_input("request_queued").state == InputState.UNKNOWN
        snapshot = runtime.snapshot(session.id)
        assert snapshot["pendingInputs"] == []
        guided = [m for m in snapshot["messages"] if m["content"] == "GUIDANCE_BEFORE_STOP"]
        assert len(guided) == 1 and not guided[0]["queued"] and guided[0]["sourceKind"] == "steering"
        assert len(model.requests) == 2
        assert len(runtime.store.list_runs(session.id)) == 1
    finally:
        gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_guide_keeps_the_original_queue_item_and_input_source(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model(gate=gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        first = await runtime.submit(session.id, "request_one", "1")
        await asyncio.wait_for(model.entered.wait(), 3)
        queued = await runtime.submit(session.id, "request_two", "2")
        with pytest.raises(ConflictError):
            await runtime.guide_input(session.id, "request_two", 99, first["run"]["id"])
        preserved = runtime.store.get_input("request_two")
        assert preserved.state == InputState.PENDING and preserved.intent == "follow_up"
        assert preserved.message_id == queued["input"]["messageId"]
        assert runtime.snapshot(session.id)["pendingInputs"][0]["source"]["content"] == "2"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_guided_attachment_keeps_display_text_and_model_content_separate(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model(gate=gate)
    runtime, _, session, root = make_runtime(tmp_path, monkeypatch, model)
    runtime.attachment_root = root
    (root / "requirements.txt").write_text("ATTACHMENT_BODY_SENTINEL", encoding="utf-8")
    try:
        first = await runtime.submit(session.id, "request_one", "1")
        await asyncio.wait_for(model.entered.wait(), 3)
        await runtime.submit(session.id, "request_attachment", "检查要求",
                             doc_paths=["requirements.txt"], document_names=["需求.txt"])
        queued_display = next(m["content"] for m in runtime.snapshot(session.id)["messages"] if m["queued"])
        await runtime.guide_input(session.id, "request_attachment", 0, first["run"]["id"])
        gate.set()
        await wait_done(runtime, session.id)
        guided = next(m for m in runtime.snapshot(session.id)["messages"] if m["sourceKind"] == "steering")
        assert guided["content"] == queued_display
        assert "需求.txt" in guided["content"] and "ATTACHMENT_BODY_SENTINEL" not in guided["content"]
        assert "ATTACHMENT_BODY_SENTINEL" in str(model.requests[1]["messages"])
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_usage_reports_last_request_and_survives_snapshot_reload(tmp_path, monkeypatch):
    model = Model([
        LLMResponse("", tool_calls=[ToolCallRequest("c1", "read_file", {"path": "AGENTS.md"})],
                    usage={"prompt_tokens": 40000, "completion_tokens": 100}),
        LLMResponse("已读取", usage={"prompt_tokens": 42000, "completion_tokens": 200}),
    ])
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        await runtime.submit(session.id, "request_usage", "检查项目")
        await wait_done(runtime, session.id)
        events = [e["payload"] for e in runtime.snapshot(session.id)["events"] if e["type"] == "usage.updated"]
        assert events[-1]["usage"]["prompt_tokens"] == 82000
        assert events[-1]["contextTokens"] == 42200
        assert events[-1]["contextWindow"] == 65536
        assert events[-1]["selectedModel"] == session.model
        assert any(e.get("contextTokens") == 40100 for e in events)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_real_tools_checkpoint_idempotence_and_manual_edit(tmp_path, monkeypatch):
    model = Model([
        LLMResponse("", tool_calls=[ToolCallRequest("c1", "write_file", {"path": "result.py", "content": "answer = 42\n"})]),
        LLMResponse("文件已写入。"),
        LLMResponse("", tool_calls=[ToolCallRequest("c2", "read_file", {"path": "result.py"})]),
        LLMResponse("人工修改已保留。"),
    ])
    runtime, project, session, root = make_runtime(tmp_path, monkeypatch, model)
    try:
        response = await runtime.submit(session.id, "request_first", "创建代码")
        await wait_done(runtime, session.id)
        again = await runtime.submit(session.id, "request_first", "创建代码")
        assert again["reused"] and again["run"]["id"] == response["run"]["id"]
        assert (root / "result.py").read_text() == "answer = 42\n"
        (root / "result.py").write_text("answer = 42\n# manual note\n", encoding="utf-8")
        await runtime.submit(session.id, "request_second", "读取并保留人工修改")
        runs = await wait_done(runtime, session.id)
        assert all(r.status == RunStatus.SUCCEEDED for r in runs)
        assert len(runs) == 2
        snapshot = runtime.snapshot(session.id)
        assert len({m["id"] for m in snapshot["messages"]}) == len(snapshot["messages"])
        assert len([m for m in snapshot["messages"] if m["role"] == "user"]) == 2
        tool_results = [m for m in snapshot["messages"] if m["role"] == "tool"]
        assert {m["toolCallId"] for m in tool_results} == {"c1", "c2"}
        calls = {(m["runId"], call["id"]) for m in snapshot["messages"] for call in m["toolCalls"]}
        assert all((m["runId"], m["toolCallId"]) in calls for m in tool_results)
        assert snapshot["live"] is None
        assert "manual note" in (root / "result.py").read_text()
        assert all("PROJECT_RULE_SENTINEL" in str(r) for r in model.requests)
        assert not any(t["function"]["name"] in {"office", "memory", "my"} for r in model.requests for t in r["tools"])
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_streamed_assistant_is_persisted_once_and_live_is_cleared_before_tools(tmp_path, monkeypatch):
    tool_entered, release = asyncio.Event(), asyncio.Event()
    gate = asyncio.Event()
    model = ThinkingModel([
        LLMResponse("The project instructions are loaded.", tool_calls=[
            ToolCallRequest("inspect", "read_file", {"path": "AGENTS.md"}),
        ]),
        LLMResponse("Done."),
    ], gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        await runtime.submit(session.id, "request_stream_once", "Inspect the project.")
        await asyncio.wait_for(model.entered.wait(), 3)
        reader = runtime.tools[session.id].registry.get("read_file")
        execute = reader.execute

        async def gated_execute(**params):
            tool_entered.set()
            await release.wait()
            return await execute(**params)

        monkeypatch.setattr(reader, "execute", gated_execute)
        gate.set()
        await asyncio.wait_for(tool_entered.wait(), 3)

        during_tool = runtime.snapshot(session.id)
        body = "The project instructions are loaded."
        assert during_tool["live"] is None
        body_message = next(m for m in during_tool["messages"] if m["role"] == "assistant" and m["content"] == body)
        assert sum(m["role"] == "assistant" and m["content"] == body for m in during_tool["messages"]) == 1
        assert any(e["type"] == "agent.message.completed" and e["payload"].get("messageId") == body_message["id"]
                   for e in during_tool["events"])

        release.set()
        await wait_done(runtime, session.id)
        final = runtime.snapshot(session.id)
        assert final["live"] is None
        assert sum(m["role"] == "assistant" and m["content"] == body for m in final["messages"]) == 1
        completed_messages = {e["payload"]["messageId"] for e in final["events"]
                              if e["type"] == "agent.message.completed"}
        assert all(m["id"] in completed_messages for m in final["messages"] if m["role"] == "assistant")
        reasoning = [e for e in final["events"] if e["type"].startswith("reasoning.")]
        starts = {e["payload"]["itemId"] for e in reasoning if e["type"] == "reasoning.started"}
        completions = {e["payload"]["itemId"]: e for e in reasoning if e["type"] == "reasoning.completed"}
        assert len(starts) == 2 and starts == set(completions)
        assert all("durationMs" in completions[item_id]["payload"] for item_id in starts)
        assert "检查实际文件" in str(reasoning)
        assert all("检查实际文件" not in m["content"] for m in final["messages"])
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_snapshot_reasoning_has_no_fabricated_duration(tmp_path, monkeypatch):
    model = Model([LLMResponse("Answer.", reasoning_content="检查已有配置")])
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        await runtime.submit(session.id, "request_snapshot_reasoning", "Answer this.")
        await wait_done(runtime, session.id)
        events = runtime.snapshot(session.id)["events"]
        reasoning = [e for e in events if e["type"].startswith("reasoning.")]

        assert len(reasoning) == 1
        assert reasoning[0]["type"] == "reasoning.completed"
        assert set(reasoning[0]["payload"]) == {"itemId", "text"}
        assert reasoning[0]["payload"]["text"] == "检查已有配置"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_queued_inputs_survive_tool_checkpoints_and_run_once(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model([LLMResponse("first"), LLMResponse("second"), LLMResponse("third")], gate)
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        await runtime.submit(session.id, "request_one", "first")
        await model.entered.wait()
        queued = await runtime.submit(session.id, "request_two", "second")
        repeated = await runtime.submit(session.id, "request_two", "second")
        await runtime.submit(session.id, "request_three", "third")
        assert queued["queued"] and repeated["input"]["id"] == queued["input"]["id"]
        gate.set()
        runs = await wait_done(runtime, session.id)
        assert len(runs) == 3
        assert all(r.status == RunStatus.SUCCEEDED for r in runs)
        user = [m for m in runtime.sessions.get_or_create(session.transcript_key).messages if m["role"] == "user" and not m.get("_input_delivered")]
        assert [m["content"] for m in user] == ["first", "second", "third"]
        assert not any(m.get("_ui_only") for m in user)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_same_project_concurrent_sessions_and_interrupt_scope(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, project, first, _ = make_runtime(tmp_path, monkeypatch, model)
    second = runtime.store.create_session(project.id)
    try:
        a = await runtime.submit(first.id, "request_a", "a")
        b = await runtime.submit(second.id, "request_b", "b")
        await asyncio.sleep(0.1)
        assert len(runtime.tasks) == 2
        with pytest.raises(ConflictError):
            await runtime.interrupt(first.id, b["run"]["id"])
        await runtime.interrupt(first.id, a["run"]["id"])
        assert runtime.store.get_run(a["run"]["id"]).status == RunStatus.INTERRUPTED
        assert runtime.store.get_run(b["run"]["id"]).status == RunStatus.RUNNING
        model.gate.set()
        await wait_done(runtime, second.id)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_readonly_context_and_external_executor_no_model_fallback(tmp_path, monkeypatch):
    from test_workbench_api import use_missing_programs
    use_missing_programs(tmp_path, monkeypatch)
    model = Model()
    runtime, project, session, _ = make_runtime(tmp_path, monkeypatch, model)
    runtime.config_loader().development.enabled_engines = ["codex"]
    child = runtime.store.create_session(project.id, readonly=True, parent_session_id=session.id)
    external = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        with pytest.raises(DevelopmentError) as failure:
            await runtime.submit(external.id, "request_cli", "never via model")
        assert failure.value.code == "invalid_executable"
        assert not model.requests and not runtime.store.list_runs(external.id)
        await runtime.submit(child.id, "request_read", "只读解释项目")
        await wait_done(runtime, child.id)
        assert {t["function"]["name"] for t in model.requests[0]["tools"]} == {"read_file", "list_dir", "grep", "find_files"}
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_after_restart_is_not_replayed(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    reply = await runtime.submit(session.id, "request_run", "stay busy")
    await model.entered.wait()
    await runtime.close()
    assert runtime.store.get_run(reply["run"]["id"]).status == RunStatus.UNKNOWN
    recovered = DevelopmentRuntime(runtime.store, SessionManager(tmp_path / "transcripts"), runtime.config_loader)
    try:
        repeat = await recovered.submit(session.id, "request_run", "stay busy")
        assert repeat["reused"] and not recovered.tasks
        with pytest.raises(ConflictError):
            await recovered.submit(session.id, "request_new", "continue without reconciliation")
    finally:
        await recovered.close()
