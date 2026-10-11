from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from test_codebuddy_catalog import peer as codebuddy_catalog_peer
from test_codebuddy_catalog import profile as codebuddy_profile
from test_codex_executor import collect_until
from test_codex_executor import setup as setup_codex
from test_codex_executor import trace as codex_trace
from test_native_workbench import setup as setup_native
from test_sdk_workbench import setup as setup_sdk
from test_sdk_workbench import trace as sdk_trace

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe
from mona.development.executors.sdk import SDKExecutor
from mona.development.native_manager import NativeExecutorManager
from mona.development.store import DevelopmentError, DevelopmentStore
from mona.session.manager import SessionManager


@pytest.mark.asyncio
async def test_codex_probe_and_turn_preserve_native_reasoning_efforts(tmp_path):
    executor, start = setup_codex(tmp_path)
    try:
        probe = await executor.probe()
        model = next(item for item in probe.model_details if item.id == "example-model")
        assert model.reasoning_efforts == ["low", "high", "xhigh"]
        assert model.reasoning_effort == "high"

        start.session.model = "example-model"
        start.session.model_reasoning_effort = "xhigh"
        binding = await executor.create_session(start)
        receipt = await executor.send(binding, "request_xhigh", "instant")
        assert receipt.outcome == "accepted"
        await collect_until(executor, binding, "run.completed")
        request = next(row for row in codex_trace(executor)
                       if row.get("method") == "turn/start")
        assert request["params"]["effort"] == "xhigh"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_native_effort_selection_persists_refreshes_same_model_and_never_dispatches(tmp_path, monkeypatch):
    runtime, project, root, host = await setup_native(tmp_path)
    discovery = ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable=sys.executable)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _: [discovery])
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        probe = await runtime.native.probe(project.id, ExecutorId.CODEX)
        model = next(item for item in probe["modelDetails"] if item["id"] == "example-model")
        assert model["reasoningEfforts"] == ["low", "high", "xhigh"]
        assert model["reasoningEffort"] == "high"

        selected = await runtime.select_model_source(
            session.id, session.revision, ExecutorId.CODEX, "example-model", None, "high")
        binding = runtime.store.list_bindings(session.id)[0]
        assert selected.model == "example-model" and selected.model_reasoning_effort == "high"
        resumes_before = len([row for row in _codex_rows(root) if row.get("method") == "thread/resume"])

        selected = await runtime.select_model_source(
            session.id, selected.revision, ExecutorId.CODEX, "example-model", None, "xhigh")
        assert selected.model == "example-model" and selected.model_reasoning_effort == "xhigh"
        assert runtime.store.list_bindings(session.id)[0].id == binding.id
        assert host._starts[binding.id].session.model_reasoning_effort == "xhigh"
        assert len([row for row in _codex_rows(root) if row.get("method") == "thread/resume"]) == resumes_before + 1

        before = runtime.store.get_session(session.id)
        with pytest.raises(DevelopmentError, match="未声明支持"):
            await runtime.select_model_source(
                session.id, before.revision, ExecutorId.CODEX, "example-model", None, "max")
        after = runtime.store.get_session(session.id)
        assert (after.revision, after.model, after.model_reasoning_effort) == (
            before.revision, before.model, before.model_reasoning_effort)
        assert runtime.store.list_runs(session.id) == []
        assert not [row for row in _codex_rows(root) if row.get("method") == "turn/start"]
    finally:
        await runtime.close()


def _codex_rows(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "peer-trace.jsonl").read_text(encoding="utf8").splitlines()]


@pytest.mark.asyncio
async def test_claude_selection_forwards_effort_to_sdk_options_without_sending_a_task(tmp_path, monkeypatch):
    runtime, project, root, _host = await setup_sdk(tmp_path, monkeypatch, ExecutorId.CLAUDE)
    discovery = ExecutorProbe(executor=ExecutorId.CLAUDE, state="detected", executable=sys.executable)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _: [discovery])
    monkeypatch.setattr("mona.development.native_manager.sdk_version", lambda _: "test-peer")
    try:
        probe = await runtime.native.probe(project.id, ExecutorId.CLAUDE)
        model = next(item for item in probe["modelDetails"] if item["id"] == "peer-model")
        assert model["reasoningEfforts"] == ["low", "high"]
        assert model["reasoningEffort"] == "high"

        session = runtime.store.create_session(project.id)
        selected = await runtime.select_model_source(
            session.id, session.revision, ExecutorId.CLAUDE, "peer-model", None, "high")
        assert selected.model_reasoning_effort == "high"
        connection = [row for row in sdk_trace(root) if row["method"] == "connect"][-1]
        assert connection["model"] == "peer-model" and connection["effort"] == "high"
        assert runtime.store.list_runs(session.id) == []
        assert not [row for row in sdk_trace(root) if row["method"] == "query"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_codebuddy_catalog_has_no_invented_effort_and_rejects_effort_selection(tmp_path, monkeypatch):
    _resolve_tool_config_refs()
    catalog_trace, children = codebuddy_catalog_peer(tmp_path, monkeypatch)
    profile = codebuddy_profile(tmp_path)
    config = Config()
    store = DevelopmentStore(tmp_path / "state.sqlite3")
    project = store.open_project(profile.project_root)
    manager = NativeExecutorManager(store, SessionManager(tmp_path / "history"), lambda: config)
    discovery = ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="detected", executable=sys.executable)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _: [discovery])
    monkeypatch.setattr("mona.development.native_manager.sdk_version", lambda _: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.sdk_version", lambda _: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.worker_command",
                        lambda: (sys.executable, "-u", str(Path(__file__).with_name("sdk_peer.py"))))
    manager.hosts[("", ExecutorId.CODEBUDDY)] = SDKExecutor(profile)
    session = store.create_session(project.id)
    try:
        result = await manager.probe(None, ExecutorId.CODEBUDDY)
        model = next(item for item in result["modelDetails"] if item["id"] == "model-a")
        assert model.get("reasoningEfforts", []) == []
        assert model.get("reasoningEffort") is None

        with pytest.raises(DevelopmentError, match="未声明支持"):
            await manager.switch(session.id, session.revision, ExecutorId.CODEBUDDY, "model-a", "high")
        unchanged = store.get_session(session.id)
        assert (unchanged.revision, unchanged.executor, unchanged.model, unchanged.model_reasoning_effort) == (
            session.revision, session.executor, session.model, session.model_reasoning_effort)
        assert store.list_bindings(session.id) == []
        assert store.list_runs(session.id) == []
        assert "session/prompt" not in catalog_trace.read_text(encoding="utf8")
    finally:
        await manager.close()
    assert all(child.closed for child in children)
