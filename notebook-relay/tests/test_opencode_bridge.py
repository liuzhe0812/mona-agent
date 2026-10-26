import asyncio
import json
import secrets
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from notebook_relay import opencode_bridge
from notebook_relay.config import Settings
from notebook_relay.opencode_bridge import (
    END,
    Job,
    NativeError,
    OpenCodeBridge,
    install_native_routes,
)
from notebook_relay.opencode_codec import FREE_MODEL, prepare_request


@pytest.mark.parametrize("existing", ["absent", "empty", "populated", "file"])
async def test_native_ignores_project_config_and_refuses_existing_machine_config(tmp_path, monkeypatch, existing):
    machine = tmp_path / "machine"
    executable = tmp_path / "opencode"
    executable.touch()
    if existing == "file":
        machine.write_text("leave intact", encoding="utf-8")
    elif existing != "absent":
        machine.mkdir()
        if existing == "populated":
            (machine / "opencode.json").write_text("leave intact", encoding="utf-8")
    monkeypatch.setattr(opencode_bridge, "SYSTEM_CONFIG_DIRECTORY", machine)
    spawned = []

    async def spawn(*args, **kwargs):
        spawned.append(kwargs["env"])
        raise RuntimeError("controlled process boundary")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    bridge = OpenCodeBridge(Settings(
        api_key=secrets.token_urlsafe(32), upstream_provider="opencode_native",
        opencode_executable=str(executable),
    ))
    try:
        with pytest.raises(RuntimeError, match="机器级 OpenCode 配置|controlled process boundary"):
            await bridge.start()
        if existing in {"absent", "empty"}:
            assert len(spawned) == 1
            assert spawned[0]["OPENCODE_CONFIG_PROJECT_DISABLE"] == "1"
        else:
            assert spawned == []
            original = machine / "opencode.json" if existing == "populated" else machine
            assert original.read_text(encoding="utf-8") == "leave intact"
    finally:
        await bridge.stop()


def context(text="synthetic request"):
    return prepare_request({"model": FREE_MODEL, "messages": [{"role": "user", "content": text}]})


def frame(delta=None, finish=None):
    return ("data: " + json.dumps({"id": "controlled-completion", "choices": [{
        "index": 0, "delta": delta or {}, "finish_reason": finish,
    }]}, ensure_ascii=False) + "\n\n").encode()


def stream(marker="完成", usage=None, done=True):
    data = frame({"role": "assistant", "content": marker}) + frame(finish="stop")
    if usage is not None:
        data += ("data: " + json.dumps({"choices": [], "usage": usage}) + "\n\n").encode()
    return data + (b"data: [DONE]\n\n" if done else b"")


async def chunks(data):
    for offset in range(0, len(data), 13):
        yield data[offset:offset + 13]
        await asyncio.sleep(0)


async def collect_events(bridge, job):
    return [event async for event in bridge.events(job)]


async def post_response(harness, job, data, split=False, status=200, retry_after=None):
    headers = {"X-Upstream-Status": str(status), "X-Upstream-Content-Type": "text/event-stream; charset=utf-8"}
    if retry_after is not None:
        headers["X-Upstream-Retry-After"] = retry_after
    return await harness.client.post(
        f"/internal/opencode/contexts/{job.id}/response",
        content=chunks(data) if split else data,
        headers=headers,
    )


@pytest.fixture
async def harness(tmp_path):
    bridge = OpenCodeBridge(Settings(
        api_key=SecretStr(secrets.token_urlsafe(32)), upstream_provider="opencode_native",
    ))
    bridge.root = tmp_path.resolve()
    (bridge.root / "work").mkdir()
    bridge.process = SimpleNamespace(returncode=None)
    state = SimpleNamespace(
        bridge=bridge, requests=[], plugin_requests=asyncio.Queue(), prompt_requests=asyncio.Queue(),
        interrupt_entered=asyncio.Queue(), release=asyncio.Event(), block_cleanup=False,
    )

    async def control(request):
        state.requests.append(request)
        if request.method == "POST" and request.url.path == "/api/session":
            return httpx.Response(200, json={"data": {"id": "session_" + secrets.token_hex(6)}})
        if request.url.path == "/api/plugin":
            state.plugin_requests.put_nowait(request)
        if request.url.path.endswith("/prompt"):
            state.prompt_requests.put_nowait(request)
        if request.url.path.endswith("/interrupt") and state.block_cleanup:
            state.interrupt_entered.put_nowait(request)
            await state.release.wait()
        return httpx.Response(204) if request.method == "DELETE" else httpx.Response(200, json={})

    bridge.client = httpx.AsyncClient(transport=httpx.MockTransport(control), base_url="http://127.0.0.1:9900")
    app = FastAPI()
    install_native_routes(app, bridge)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay",
        headers={"X-Relay-Plugin-Key": bridge.plugin_key},
    ) as client:
        state.client = client
        try:
            yield state
        finally:
            state.release.set()
            await asyncio.gather(*(bridge.close_job(job) for job in list(bridge.jobs.values())))
            if bridge.cleanup_tasks:
                await asyncio.gather(*list(bridge.cleanup_tasks))
            await bridge.client.aclose()


async def test_internal_context_and_registration_require_the_distinct_plugin_key(harness):
    bridge, client = harness.bridge, harness.client
    job = bridge.create_job(context())
    path = f"/internal/opencode/contexts/{job.id}"
    assert bridge.plugin_key != bridge.settings.api_key.get_secret_value()
    for supplied in ("", bridge.settings.api_key.get_secret_value(), secrets.token_urlsafe(32)):
        headers = {"X-Relay-Plugin-Key": supplied, "Authorization": "Bearer " + bridge.settings.api_key.get_secret_value()}
        assert (await client.get(path, headers=headers)).status_code == 404
        assert (await client.post(path + "/registered", headers=headers)).status_code == 404
    assert (await client.get("/internal/opencode/contexts/unknown-job")).status_code == 404
    assert (await client.get(path)).json() == job.context
    assert not job.registered.is_set()
    assert (await client.post(path + "/registered")).status_code == 204
    await asyncio.wait_for(job.registered.wait(), 1)
    await bridge.close_job(job)
    assert (await client.get(path)).status_code == 404


@pytest.mark.parametrize("status", [200, 429])
async def test_open_waits_for_registration_and_preserves_rate_limits_without_retry(harness, status):
    bridge = harness.bridge
    opening = asyncio.create_task(bridge.open({
        "model": FREE_MODEL, "messages": [{"role": "user", "content": "synthetic request"}],
    }))
    try:
        plugin_request = await asyncio.wait_for(harness.plugin_requests.get(), 1)
        directory = Path(plugin_request.url.params["location[directory]"])
        job = bridge.jobs[directory.name]
        assert harness.prompt_requests.empty()
        assert not opening.done()
        registered = await harness.client.post(f"/internal/opencode/contexts/{job.id}/registered")
        assert registered.status_code == 204
        prompt = await asyncio.wait_for(harness.prompt_requests.get(), 1)
        assert prompt.url.path == f"/api/session/{job.session_id}/prompt"
        response = await post_response(harness, job, stream(), status=status, retry_after="37")
        if status == 200:
            assert response.status_code == 204
            assert await asyncio.wait_for(opening, 1) is job
            assert (await bridge.completion(job))["choices"][0]["message"]["content"] == "完成"
        else:
            assert response.status_code in {204, 409}
            with pytest.raises(NativeError) as failure:
                await asyncio.wait_for(opening, 1)
            assert failure.value.status == 429
            assert failure.value.code == "native_rate_limited"
            assert failure.value.headers == {"Retry-After": "37"}
            assert bridge.jobs == {}
            assert not job.directory.exists()
            assert len([request for request in harness.requests
                        if request.method == "POST" and request.url.path == "/api/session"]) == 1
            assert harness.prompt_requests.empty()
    finally:
        if not opening.done():
            opening.cancel()
        await asyncio.gather(opening, return_exceptions=True)


async def test_response_headers_stream_end_and_actual_usage_are_preserved(harness):
    bridge = harness.bridge
    usage = {"prompt_tokens": 17, "completion_tokens": 9, "total_tokens": 26,
             "completion_tokens_details": {"reasoning_tokens": 4}, "vendor_detail": {"cache": 6}}
    for mode, supplied_usage in (("completion", usage), ("completion", None), ("events", usage)):
        job = bridge.create_job(context())
        consuming = asyncio.create_task(bridge.completion(job) if mode == "completion" else collect_events(bridge, job))
        try:
            response = await post_response(harness, job, stream(usage=supplied_usage), split=True)
            assert response.status_code == 204
            assert job.ready.is_set()
            assert job.status == 200
            assert job.content_type == "text/event-stream; charset=utf-8"
            result = await asyncio.wait_for(consuming, 1)
            if mode == "completion":
                assert result["choices"][0]["message"]["content"] == "完成"
                if supplied_usage is None:
                    assert "usage" not in result
                else:
                    assert result["usage"] == usage
            else:
                assert result[-1] == "[DONE]"
                decoded = [json.loads(event) for event in result[:-1]]
                assert [event["usage"] for event in decoded if "usage" in event] == [usage]
            duplicate = await post_response(harness, job, stream())
            assert duplicate.status_code == 409
        finally:
            consuming.cancel()
            await asyncio.gather(consuming, return_exceptions=True)
            await bridge.close_job(job)


async def test_full_job_queue_stops_waiting_when_the_job_is_cancelled(tmp_path):
    job = Job("bounded-job", tmp_path, {}, chunks=asyncio.Queue(maxsize=1))
    assert await job.put(b"already queued")
    blocked = asyncio.create_task(job.put(END))
    await asyncio.sleep(0)
    assert not blocked.done()
    job.cancelled.set()
    assert await asyncio.wait_for(blocked, 1) is False
    assert job.chunks.get_nowait() == b"already queued"
    assert job.chunks.empty()


async def test_cancelled_close_callers_leave_shielded_cleanup_running_to_completion(harness):
    bridge = harness.bridge
    harness.block_cleanup = True
    jobs = [bridge.create_job(context(f"request {index}")) for index in range(2)]
    for index, job in enumerate(jobs):
        job.session_id = f"controlled-session-{index}"
    closers = [asyncio.create_task(bridge.close_job(job)) for job in jobs]
    try:
        for _ in jobs:
            await asyncio.wait_for(harness.interrupt_entered.get(), 1)
        for closer in closers:
            closer.cancel()
        cancelled = await asyncio.gather(*closers, return_exceptions=True)
        assert all(isinstance(result, asyncio.CancelledError) for result in cancelled)
        pending_cleanup = list(bridge.cleanup_tasks)
        assert pending_cleanup
        harness.release.set()
        await asyncio.wait_for(asyncio.gather(*pending_cleanup), 1)
        assert bridge.jobs == {}
        assert bridge.cleanup_tasks == set()
        for job in jobs:
            location = [request for request in harness.requests
                        if request.url.params.get("location[directory]") == str(job.directory)]
            session = [request for request in harness.requests if job.session_id in request.url.path]
            assert [(request.method, request.url.path) for request in session] == [
                ("POST", f"/api/session/{job.session_id}/interrupt"),
                ("DELETE", f"/api/session/{job.session_id}"),
            ]
            assert [(request.method, request.url.path) for request in location] == [("DELETE", "/api/debug/location")]
            assert harness.requests.index(session[-1]) < harness.requests.index(location[0])
            assert not job.directory.exists()
        before = len(harness.requests)
        await asyncio.gather(*(bridge.close_job(job) for job in jobs))
        assert len(harness.requests) == before
    finally:
        harness.release.set()
        for closer in closers:
            closer.cancel()
        await asyncio.gather(*closers, return_exceptions=True)


async def test_events_and_completion_reject_incomplete_or_unsafe_native_responses(harness):
    invalid = [
        stream(done=False),
        frame({"content": "partial"}, finish="unknown-finish") + b"data: [DONE]\n\n",
        frame({"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {
            "name": "bash", "arguments": "{}",
        }}]}, finish="tool_calls") + b"data: [DONE]\n\n",
    ]
    for body in invalid:
        for consume in (harness.bridge.completion, lambda job: collect_events(harness.bridge, job)):
            job = harness.bridge.create_job(context())
            try:
                assert (await post_response(harness, job, body)).status_code == 204
                with pytest.raises(NativeError) as failure:
                    await consume(job)
                assert failure.value.status == 502
                assert failure.value.code in {"native_protocol_error", "native_incomplete_response"}
            finally:
                await harness.bridge.close_job(job)


async def test_fifteen_concurrent_native_jobs_keep_responses_separate_and_all_close(harness):
    bridge = harness.bridge
    jobs = [bridge.create_job(context(f"request-{index}")) for index in range(15)]
    markers = [f"独立结果-{index}" for index in range(15)]
    consumers = [asyncio.create_task(bridge.completion(job)) for job in jobs]
    try:
        responses = await asyncio.wait_for(asyncio.gather(*(
            post_response(harness, job, stream(marker), split=True) for job, marker in zip(jobs, markers, strict=True)
        )), 3)
        assert all(response.status_code == 204 for response in responses)
        results = await asyncio.wait_for(asyncio.gather(*consumers), 3)
        assert [result["choices"][0]["message"]["content"] for result in results] == markers
        assert len({job.id for job in jobs}) == 15
        assert len({job.directory for job in jobs}) == 15
    finally:
        for consumer in consumers:
            consumer.cancel()
        await asyncio.gather(*consumers, return_exceptions=True)
        await asyncio.gather(*(bridge.close_job(job) for job in jobs))
    assert bridge.jobs == {}
    assert all(not job.directory.exists() for job in jobs)
    disposed = [request.url.params["location[directory]"] for request in harness.requests
                if request.method == "DELETE" and request.url.path == "/api/debug/location"]
    assert sorted(disposed) == sorted(str(job.directory) for job in jobs)
