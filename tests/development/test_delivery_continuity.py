"""Regression tests for native continuation and exact collaboration attribution."""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from test_native_workbench import settle, setup, trace, wait_run
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.development.context import collaboration_context
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_policy import MIN_SDK, SDK_PACKAGES
from mona.providers.base import LLMResponse


@pytest.mark.asyncio
async def test_idle_native_connection_restores_same_thread_before_next_input(tmp_path):
    runtime, project, root, adapter = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "request_first", "instant")
        await settle(runtime)
        before = runtime.store.list_bindings(session.id)[0]
        await adapter._client.close()
        assert await adapter.get_status(before) == "not_loaded"
        await runtime.submit(session.id, "request_second", "instant")
        await settle(runtime)
        after = runtime.store.list_bindings(session.id)[0]
        assert after.id == before.id and after.native_session_id == before.native_session_id
        calls = trace(root)
        assert sum(r.get("method") == "thread/start" for r in calls) == 1
        assert sum(r.get("method") == "thread/resume" for r in calls) == 1
        assert sum(r.get("method") == "turn/start" for r in calls) == 2
        assert all(r.status == RunStatus.SUCCEEDED for r in runtime.store.list_runs(session.id))
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_delegated_source_reaches_native_worker_without_mona_model(tmp_path, monkeypatch):
    runtime, project, root, _ = await setup(tmp_path)
    parent = runtime.store.create_session(project.id)
    transcript = runtime.sessions.get_or_create(parent.transcript_key)
    transcript.add_message("user", "SOURCE_REQUIREMENT: keep parser API and manual comments")
    runtime.sessions.save(transcript)
    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", lambda *_a, **_k: pytest.fail("native work cannot call Mona model"))
    try:
        record = await runtime.collaboration.start(parent.id, "request_delegate", ExecutorId.CODEX, "Review parser", readonly=True)
        await wait_run(runtime, record["childSessionId"], RunStatus.RUNNING)
        calls = [r for r in trace(root) if r.get("method") == "turn/start"]
        assert len(calls) == 1
        assert "SOURCE_REQUIREMENT" in calls[0]["params"]["input"][0]["text"]
        child = runtime.store.get_session(record["childSessionId"])
        run = runtime.store.find_run_request(child.id, record["requestId"])
        await runtime.interrupt(child.id, run.id)
        await settle(runtime)
        await runtime.submit(child.id, "request_follow", "instant")
        await settle(runtime)
        calls = [r for r in trace(root) if r.get("method") == "turn/start"]
        assert "SOURCE_REQUIREMENT" not in calls[-1]["params"]["input"][0]["text"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_collaboration_result_stays_on_dispatched_run_after_child_followup(tmp_path, monkeypatch):
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, Model([
        LLMResponse("ORIGINAL_REVIEW"), LLMResponse("LATER_UNRELATED_ANSWER")]))
    # Defer automatic delivery, representing a host restart before reconciliation.
    monkeypatch.setattr(runtime.collaboration, "_monitor", lambda _: None)
    try:
        record = await runtime.collaboration.start(parent.id, "request_review", ExecutorId.MONA, "Review", readonly=True)
        await wait_done(runtime, record["childSessionId"])
        original = runtime.store.find_run_request(record["childSessionId"], record["requestId"])
        await runtime.submit(record["childSessionId"], "request_later", "Different question")
        await wait_done(runtime, record["childSessionId"])
        rows = await runtime.collaboration.observe(parent.id)
        assert rows[0]["latestRun"]["id"] == original.id
        result = await runtime.collaboration.wait(parent.id, record["id"], 1)
        assert result["result"] == "ORIGINAL_REVIEW"
        messages = runtime.sessions.get_or_create(parent.transcript_key).messages
        returned = [m for m in messages if m.get("source_kind") == "collaboration"]
        assert len(returned) == 1
        assert "ORIGINAL_REVIEW" in returned[0]["content"]
        assert "LATER_UNRELATED_ANSWER" not in returned[0]["content"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_long_parent_excerpt_keeps_provenance_and_valid_json(tmp_path, monkeypatch):
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    source = runtime.sessions.get_or_create(parent.transcript_key)
    source.add_message("user", "x" * 30000)
    source.add_message("user", "RECENT_REQUIREMENT")
    runtime.sessions.save(source)
    try:
        record = await runtime.collaboration.start(parent.id, "request_excerpt", ExecutorId.MONA, "Read", readonly=True)
        child = runtime.store.get_session(record["childSessionId"])
        transcript = runtime.sessions.get_or_create(child.transcript_key)
        body = next(m["content"] for m in transcript.messages if m.get("_collaboration_context"))
        assert body.startswith("以下是相关会话摘录") and len(body) < 20000
        data = json.loads(body.split("\n", 1)[1])
        assert data["omittedMessages"] == 1
        assert data["messages"][0]["content"] == "RECENT_REQUIREMENT"
        assert collaboration_context(transcript) == ""
        assert "RECENT_REQUIREMENT" in collaboration_context(transcript, include_source=True)
        await wait_done(runtime, child.id)
    finally:
        await runtime.close()


@pytest.mark.parametrize("subtype,error,expected", [
    ("success", False, "run.completed"), ("new_result_type", False, "run.unknown"),
    ("success", None, "run.unknown"), ("error_max_turns", True, "run.failed"),
    ("interrupted", False, "run.interrupted"),
])
def test_sdk_unknown_result_is_not_completion(subtype, error, expected):
    projector = SDKEventProjector("native-session")
    projector.begin("sdk:request")
    events = projector.consume({"type": "result", "session_id": "native-session", "subtype": subtype, "is_error": error})
    assert events[-1].type == expected


def test_installable_sdk_dependencies_cover_runtime_minimums():
    root = Path(__file__).resolve().parents[2]
    config = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf8"))
    requirements = {r.name: r for r in map(Requirement, config["project"]["optional-dependencies"]["development"])}
    for executor, minimum in MIN_SDK.items():
        assert ".".join(map(str, minimum)) in requirements[SDK_PACKAGES[executor]].specifier
