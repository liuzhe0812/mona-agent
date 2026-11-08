"""Hosted tool results remain readable after checkpoints and isolation restarts."""
import asyncio
import base64
import hashlib
import json
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.filesystem import HostedReadFileTool
from mona.hosted_work.history_media_rollback import restore_for_legacy
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles
from mona.hosted_work.tool_results import HostedResultRegistry, HostedToolResults
from mona.hosted_work.tools import HostedTools
from mona.hosted_work.turn import run_turn
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest

OWNER, OTHER = owner_key("21"), owner_key("22")
SID, RID = "a" * 32, "b" * 32
_REF = re.compile(r"mona-tool-result://sha256/[a-f0-9]{64}\.(?:txt|json|png|jpg|webp|gif)")


@pytest.fixture
def state(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path), max_history_bytes=65536,
                              history_media_storage_bytes=1024 * 1024)
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="fixture", text="question"))
    yield store
    store.close()


def storage(state, owner=OWNER, sid=SID, rid=RID):
    return HostedToolResults(state.config, owner, sid, rid)


class LargeTool(Tool):
    name = "get_large_result"
    description = "Return a large result."
    parameters = {"type": "object", "properties": {}, "required": []}

    async def execute(self):
        return "中" * 3000 + "end"


class ToolModel(LLMProvider):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def get_default_model(self):
        return "fixture"

    async def chat(self, messages, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(content="", tool_calls=[ToolCallRequest(id="call", name="get_large_result", arguments={})],
                               finish_reason="tool_calls")
        assert _REF.search(messages[-1]["content"])
        return LLMResponse(content="done")


@pytest.mark.asyncio
async def test_runner_commits_full_result_before_checkpoint_and_reads_it_after_restart(state):
    result_store = storage(state)
    registry = HostedResultRegistry(result_store)
    registry.register(LargeTool())
    observed = []

    async def checkpoint(value):
        if value.get("phase") == "tools_partial":
            result = value["completed_tool_results"][0]["content"]
            reference = _REF.search(result).group()
            # A separate connection must already see the committed bytes when
            # the checkpoint is emitted; this survives the child process exit.
            raw, _, _ = storage(state).read(reference)
            assert raw.decode() == "中" * 3000 + "end"
            state.save_checkpoint(OWNER, RID, value)
            observed.append(reference)

    model = ToolModel()
    result = await AgentRunner(model).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "go"}], tools=registry, model="fixture",
        max_iterations=3, max_tool_result_chars=1000, checkpoint_callback=checkpoint,
    ))
    assert result.stop_reason == "completed" and observed
    checkpoint_row = state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]
    assert observed[0] in checkpoint_row
    state.finish(OWNER, RID, "unknown", {"message": "待核对", "workspace_saved": False})
    state.resolve_unknown(OWNER, "run", RID, "execution stopped; preserve prior result")
    resumed_run = "c" * 32
    state.create_run(OWNER, SID, NewTurn(request_id=resumed_run, model_id="fixture", text="continue"))
    reader = HostedReadFileTool(AsyncMock(), max_file_bytes=state.config.max_file_bytes,
                                result_store=storage(state, OWNER, SID, resumed_run))
    window = await reader.execute(path=observed[0], char_offset=2998, char_limit=10)
    assert "中中end" in window


@pytest.mark.asyncio
async def test_hosted_tools_wire_result_references_without_enabling_desktop_ui(state, tmp_path):
    sandbox = DockerSandbox(state.config, OWNER, RID, tmp_path / "workspace.zip")
    tools = HostedTools(sandbox, AsyncMock(), result_session_id=SID)
    assert isinstance(tools.registry, HostedResultRegistry)
    assert not tools.registry.has("show_widget")
    spec = AgentRunSpec(initial_messages=[], tools=tools.registry, model="fixture", max_iterations=1,
                        max_tool_result_chars=1000)
    original = "z" * 3000
    response = AgentRunner(ToolModel())._normalize_tool_result(spec, "one", "fixture", original)
    reference = _REF.search(response).group()
    reader = tools.registry.get("read_file")
    window = await reader.execute(path=reference, char_offset=2990, char_limit=10)
    assert window.endswith("z" * 10)


@pytest.mark.asyncio
@pytest.mark.parametrize("desktop_ui", [False, True])
async def test_work_entry_passes_result_session_to_both_api_and_desktop_ui(state, tmp_path, monkeypatch, desktop_ui):
    config = state.config.model_copy(deep=True)
    config.models = {"fixture": HostedWorkModel(label="Mona", model="fixture")}
    config.public_origin = "https://mona-ai.cn"
    config.bind_host = "127.0.0.1"
    sandbox = DockerSandbox(config, OWNER, RID, tmp_path / "workspace.zip")
    monkeypatch.setattr("mona.hosted_work.context._scope", lambda *_args: None)
    monkeypatch.setattr("mona.hosted_work.owner_memory.build_memory_tools", lambda *_args: ())
    monkeypatch.setattr("mona.hosted_work.remote_inputs.RemoteInputs.poll", AsyncMock(return_value=[]))
    monkeypatch.setattr("mona.hosted_work.titles.update_title", AsyncMock())
    original_init = HostedTools.__init__

    class OversizedTool(LargeTool):
        async def execute(self):
            return "z" * 110000

    def register_test_tool(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.registry.register(OversizedTool())
        self.skills.allowed_names.add("get_large_result")
        self.skills.initial_names.add("get_large_result")
        allowed = self.registry.get_allowed_tool_names()
        if allowed is not None:
            self.registry.set_allowed_tool_names(allowed | {"get_large_result"})

    monkeypatch.setattr(HostedTools, "__init__", register_test_tool)
    checkpoints = []

    async def emit(kind, data):
        if kind == "checkpoint" and data.get("phase") == "tools_partial":
            result_text = data["completed_tool_results"][0]["content"]
            match = _REF.search(result_text)
            assert match, result_text[:500]
            reference = match.group()
            assert storage(state).read(reference)[0] == b"z" * 110000
            checkpoints.append(reference)

    result = await run_turn(config, {"owner": OWNER, "session_id": SID, "run_id": RID,
        "model_id": "fixture", "desktop_ui": desktop_ui, "account_token": "fixture-token",
        "history": [{"role": "user", "content": "create a long result"}], "attachments": []},
        sandbox, ToolModel(), emit)
    assert result["status"] == "completed" and checkpoints


@pytest.mark.asyncio
async def test_images_are_owned_per_session_and_older_context_can_be_read(state):
    raw = b"\x89PNG\r\n\x1a\n" + b"first image"
    url = "data:image/png;base64," + base64.b64encode(raw).decode()
    block = {"type": "image_url", "image_url": {"url": url}, "_meta": {"path": "/workspace/temporary.png"}}
    registry = HostedResultRegistry(storage(state))
    first = registry._mona_normalize_tool_result("one", [block], 1000)
    ref = first[0]["_meta"]["path"]
    assert ref.startswith("mona-tool-result:")
    assert first[0]["image_url"]["url"] == url
    messages = [{"role": "tool", "tool_call_id": "one", "content": first},
                {"role": "tool", "tool_call_id": "two", "content": [block]}]
    projected = registry._mona_offload_tool_images(messages)
    assert list(projected) == [0] and ref in projected[0][0]["text"]
    assert messages[0]["content"][0]["image_url"]["url"] == url
    reader = HostedReadFileTool(AsyncMock(), max_file_bytes=state.config.max_file_bytes,
                                result_store=storage(state))
    reread = await reader.execute(path=ref)
    assert reread[0]["image_url"]["url"] == url

    state.create_session(OTHER, NewSession(request_id="c" * 32))
    state.create_run(OTHER, "c" * 32, NewTurn(request_id="d" * 32, model_id="fixture", text="other"))
    with pytest.raises(WorkError):
        storage(state, OTHER, "c" * 32, "d" * 32).read(ref)
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    state.create_session(OWNER, NewSession(request_id="e" * 32))
    state.create_run(OWNER, "e" * 32, NewTurn(request_id="f" * 32, model_id="fixture", text="next"))
    with pytest.raises(WorkError):
        storage(state, OWNER, "e" * 32, "f" * 32).read(ref)


def test_quota_is_shared_with_images_and_concurrent_writes_are_atomic(state):
    data = b"a" * 600000
    result_store = storage(state)

    def save(index):
        try:
            return result_store.save(data + bytes([index]), "txt")
        except WorkError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, (1, 2)))
    assert sum(value is not None for value in results) == 1
    assert state.db.execute("SELECT sum(length(data)) FROM hosted_tool_results WHERE owner=?", (OWNER,)).fetchone()[0] == 600001
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64," +
             base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"b" * 350000).decode()}}
    with pytest.raises(WorkError) as error:
        state.save_history(OWNER, RID, [{"role": "tool", "content": [image]}])
    assert error.value.code == "history_media_limit"


def test_unavailable_or_corrupted_storage_never_silently_shortens_result(state):
    store = storage(state)
    registry = HostedResultRegistry(store)
    model = ToolModel()
    spec = AgentRunSpec(initial_messages=[], tools=registry, model="fixture", max_iterations=1,
                        max_tool_result_chars=1000)
    text = "x" * (state.config.max_file_bytes + 1)
    assert AgentRunner(model)._normalize_tool_result(spec, "one", "fixture", text) == text
    reference = store.save(b"safe result", "txt")
    state.db.execute("UPDATE hosted_tool_results SET data=? WHERE owner=? AND session_id=?",
                     (b"changed", OWNER, SID))
    with pytest.raises(WorkError):
        store.read(reference)


@pytest.mark.asyncio
async def test_busy_result_database_does_not_block_event_loop_or_user_cancellation(state, monkeypatch):
    result_store = storage(state)
    registry = HostedResultRegistry(result_store)
    spec = AgentRunSpec(initial_messages=[], tools=registry, model="fixture", max_iterations=1,
                        max_tool_result_chars=1000)
    started, finished = threading.Event(), threading.Event()
    original = result_store.save

    def tracked_save(*args, **kwargs):
        started.set()
        try:
            return original(*args, **kwargs)
        finally:
            finished.set()

    monkeypatch.setattr(result_store, "save", tracked_save)
    blocker = sqlite3.connect(result_store._database(), isolation_level=None)
    blocker.execute("BEGIN IMMEDIATE")
    try:
        task = asyncio.create_task(AgentRunner(ToolModel())._normalize_tool_result_async(spec, "one", "fixture", "x" * 10000))
        assert await asyncio.to_thread(started.wait, 2)
        assert not task.done()
        before = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - before < 0.2
    finally:
        blocker.execute("ROLLBACK")
        blocker.close()
        assert await asyncio.to_thread(finished.wait, 2)


@pytest.mark.asyncio
async def test_failed_result_storage_preserves_started_checkpoint_without_retry(state, monkeypatch):
    result_store = storage(state)
    registry = HostedResultRegistry(result_store)
    calls = []

    class OversizedTool(LargeTool):
        async def execute(self):
            calls.append("executed")
            return "x" * (state.config.max_history_bytes + 1000)

    registry.register(OversizedTool())
    monkeypatch.setattr(result_store, "save", lambda *_args: (_ for _ in ()).throw(WorkError("fixture", "unavailable", 503)))
    model = ToolModel()

    async def checkpoint(value):
        state.save_checkpoint(OWNER, RID, value)

    with pytest.raises(WorkError):
        await AgentRunner(model).run(AgentRunSpec(
            initial_messages=[{"role": "user", "content": "go"}], tools=registry, model="fixture",
            max_iterations=3, max_tool_result_chars=1000, checkpoint_callback=checkpoint,
        ))
    saved = json.loads(state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0])
    assert saved["phase"] == "tools_started" and saved["started_tool_call_ids"] == ["call"]
    assert calls == ["executed"] and model.calls == 1
    state.finish(OWNER, RID, "unknown", {"message": "结果待核对", "workspace_saved": False})
    assert state.run(OWNER, RID)["status"] == "unknown"
    assert any("TOOL_OUTCOME_UNKNOWN" in str(message.get("content")) for message in state.history(OWNER, SID))


def test_session_deletion_reclaims_results_and_old_release_rollback_refuses_them(state):
    reference = storage(state).save(b"retained", "txt")
    assert hashlib.sha256(b"retained").hexdigest() in reference
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    with pytest.raises(WorkError) as error:
        restore_for_legacy(state)
    assert error.value.code == "legacy_tool_results"
    state.db.execute("DELETE FROM runs WHERE owner=? AND id=?", (OWNER, RID))
    state.db.execute("DELETE FROM sessions WHERE owner=? AND id=?", (OWNER, SID))
    assert state.db.execute("SELECT count(*) FROM hosted_tool_results").fetchone()[0] == 0


def test_shared_image_is_reused_and_reclaimed_after_last_session_even_without_checkpoint(state):
    raw = b"\x89PNG\r\n\x1a\n" + b"shared bytes"
    encoded = base64.b64encode(raw).decode()
    url = "data:image/png;base64," + encoded
    first = storage(state).images([url])[0]
    # Simulate a child crash before its checkpoint: only the mapping and blob
    # were committed, so neither occurs in the conversation history.
    state.finish(OWNER, RID, "unknown", {"message": "待核对", "workspace_saved": False})
    state.resolve_unknown(OWNER, "run", RID, "execution stopped before checkpoint")
    second_sid, second_run = "c" * 32, "d" * 32
    state.create_session(OWNER, NewSession(request_id=second_sid))
    state.create_run(OWNER, second_sid, NewTurn(request_id=second_run, model_id="fixture", text="next"))
    second = storage(state, OWNER, second_sid, second_run).images([url])[0]
    block = {"type": "image_url", "image_url": {"url": url}, "_meta": {"path": second}}
    state.save_checkpoint(OWNER, second_run, {"phase": "tools_completed", "assistant_message": {"role": "assistant", "content": ""},
        "completed_tool_results": [{"role": "tool", "tool_call_id": "img", "name": "fixture", "content": [block]}],
        "pending_tool_calls": []})
    assert first == second
    assert state.db.execute("SELECT count(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
    assert state.db.execute("SELECT count(*) FROM hosted_tool_results WHERE owner=?", (OWNER,)).fetchone()[0] == 2
    assert state.db.execute("SELECT COALESCE(sum(length(data)),0) FROM hosted_tool_results WHERE owner=?", (OWNER,)).fetchone()[0] == 0
    state.finish(OWNER, second_run, "completed", {"workspace_saved": True})

    service = SimpleNamespace(config=state.config, store=state, active_users=set(), tasks={})
    desktop = DesktopStore(service, TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.db.execute("SELECT count(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        next_run = "e" * 32
        state.create_run(OWNER, second_sid, NewTurn(request_id=next_run, model_id="fixture", text="again"))
        assert storage(state, OWNER, second_sid, next_run).read(second)[0] == raw
        state.finish(OWNER, next_run, "completed", {"workspace_saved": True})
        desktop.delete(OWNER, second_sid)
        assert state.db.execute("SELECT count(*) FROM hosted_tool_results WHERE owner=?", (OWNER,)).fetchone()[0] == 0
        assert state.db.execute("SELECT count(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 0
    finally:
        desktop.close()
