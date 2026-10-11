import asyncio
import copy
from types import SimpleNamespace

import pytest

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId, RunStatus
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
