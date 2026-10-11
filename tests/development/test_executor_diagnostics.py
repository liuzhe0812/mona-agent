"""Native diagnostics exercise production workers/pipes, not vendor acceptance."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from mona.development.contracts import ExecutorId
from mona.development.executors import sdk_policy
from mona.development.executors.diagnostics import failed_probe, native_version
from mona.development.executors.rpc import JsonRpcProcess, RpcError
from mona.development.executors.sdk import _worker_error


@pytest.mark.parametrize("executor,models", [(ExecutorId.CLAUDE, ["peer-model"]), (ExecutorId.CODEBUDDY, [])])
@pytest.mark.asyncio
async def test_sdk_probe_uses_real_worker_connects_and_closes_without_query(tmp_path, monkeypatch, executor, models):
    from test_sdk_workbench import setup, trace
    runtime, project, root, host = await setup(tmp_path, monkeypatch, executor)
    if executor == ExecutorId.CODEBUDDY:
        from mona.development.executors.base import ExecutorProbe
        async def unavailable_catalog(profile):
            return ExecutorProbe(executor=executor, state="detected", stage="authentication",
                executable=str(profile.executable), protocol_verified=True, model_catalog_state="unavailable")
        monkeypatch.setattr("mona.development.executors.sdk.inspect_codebuddy_catalog", unavailable_catalog)
    try:
        probe = await host.probe()
        assert probe.protocol_verified and not probe.isolation_verified
        assert probe.authentication != "ready" and probe.state == "detected"
        assert probe.sdk_version == "test-peer" and probe.version == "0.0.0-test-peer"
        assert probe.stage == "authentication"
        assert not host._sessions and runtime.store.list_sessions(project.id) == []
        calls = trace(root)
        assert [c["method"] for c in calls] == ["version", "connect", "disconnect"]
        assert calls[-1]["sameOwner"]
        # CodeBuddy's public initialization has no catalog accessor; never
        # borrow the Claude test peer's get_server_info() to invent models.
        assert await host.list_models() == models
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_probe_http_reports_missing_program_not_project_access_error(tmp_path, monkeypatch):
    from test_workbench_api import AUTH, setup_client

    from mona.development.executors.base import ExecutorProbe
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _config: [
        ExecutorProbe(executor=ExecutorId.CODEX, state="not_detected", error_code="executable_not_found",
                      reason="missing", next_action="select program")])
    try:
        response = await client.post(f"/api/development/projects/{project.id}/executors/codex/probe", headers=AUTH)
        data = await response.json()
        assert response.status == 200 and data["stage"] == "discovery"
        assert data["errorCode"] == "executable_not_found"
        assert runtime.store.list_sessions(project.id) == [] and not runtime.tasks and not runtime.native.hosts
        denied = await client.post(f"/api/development/projects/{project.id}/executors/codex/probe")
        assert denied.status == 401
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_probe_http_returns_dependency_problem_without_starting_agent(tmp_path, monkeypatch):
    from test_workbench_api import AUTH, setup_client

    from mona.development.executors.base import ExecutorProbe
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _config: [
        ExecutorProbe(executor=ExecutorId.CLAUDE, state="detected", executable=sys.executable, source="configured")])
    def missing(_executor):
        raise RpcError("sdk_not_installed", "private diagnostic not for display")
    monkeypatch.setattr("mona.development.native_manager.sdk_version", missing)
    try:
        response = await client.post(f"/api/development/projects/{project.id}/executors/claude/probe", headers=AUTH)
        data = await response.json()
        assert response.status == 200 and data["errorCode"] == "sdk_not_installed"
        assert data["stage"] == "dependency" and data["executable"] == sys.executable
        assert data["source"] == "configured" and "private diagnostic" not in str(data)
        assert not runtime.native.hosts and not runtime.tasks
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_os_launch_denial_is_normalized_before_any_request(tmp_path, monkeypatch):
    async def denied(*_args, **_kwargs):
        raise PermissionError(13, "SYNTHETIC_PRIVATE_PATH")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", denied)
    with pytest.raises(RpcError) as raised:
        await JsonRpcProcess.spawn((sys.executable,), cwd=tmp_path, env={},
            notification=lambda *_: None, server_request=None, disconnected=lambda _: None)
    assert raised.value.code == "executable_access_denied" and not raised.value.outcome_unknown
    probe = failed_probe(ExecutorId.CODEX, raised.value)
    assert probe.stage == "launch" and probe.next_action
    assert "SYNTHETIC_PRIVATE_PATH" not in str(raised.value) + probe.model_dump_json()


@pytest.mark.asyncio
async def test_version_probe_rejects_a_different_real_executable(tmp_path):
    with pytest.raises(RpcError) as raised:
        await native_version(Path(sys.executable), ExecutorId.CODEX, cwd=tmp_path, env=os.environ)
    assert raised.value.code == "native_version_incompatible"


@pytest.mark.asyncio
async def test_version_timeout_reaps_its_real_child_without_task_replay(tmp_path, monkeypatch):
    original = asyncio.create_subprocess_exec
    children = []
    async def slow(*_args, **kwargs):
        child = await original(sys.executable, "-c", "import time; time.sleep(20)", **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(asyncio, "create_subprocess_exec", slow)
    with pytest.raises(RpcError) as raised:
        await native_version(Path(sys.executable), ExecutorId.CODEX, cwd=tmp_path, env=os.environ, timeout=.1)
    assert raised.value.code == "native_version_timeout"
    assert len(children) == 1 and children[0].returncode is not None


@pytest.mark.parametrize("executor,version,allowed", [
    (ExecutorId.CLAUDE, "0.2.134", True), (ExecutorId.CLAUDE, "0.2.133", False),
    (ExecutorId.CLAUDE, "0.3.0", False), (ExecutorId.CLAUDE, "0.2.134rc1", False),
    (ExecutorId.CODEBUDDY, "0.3.264", True), (ExecutorId.CODEBUDDY, "0.4.0", False),
])
def test_sdk_support_range_matches_both_lower_and_upper_limits(monkeypatch, executor, version, allowed):
    monkeypatch.setattr(sdk_policy.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(sdk_policy.importlib.metadata, "version", lambda _: version)
    if allowed:
        assert sdk_policy.sdk_version(executor) == version
    else:
        with pytest.raises(RpcError, match="版本"):
            sdk_policy.sdk_version(executor)


def test_worker_error_projection_accepts_only_host_codes():
    error = {"code": -32000, "message": "PRIVATE_TOKEN", "data": {"monaCode": "sdk_contract_incompatible"}}
    converted = _worker_error(error)
    assert converted.code == "sdk_contract_incompatible" and "PRIVATE_TOKEN" not in str(converted)
    assert _worker_error({**error, "data": {"monaCode": "PRIVATE_TOKEN"}}) is None
    assert _worker_error({**error, "code": -32603}) is None
