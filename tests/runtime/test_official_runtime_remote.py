from __future__ import annotations

from types import SimpleNamespace

import httpx

from mona.runtime import official


def _response(status: int, payload: dict) -> httpx.Response:
    return httpx.Response(
        status,
        json=payload,
        request=httpx.Request("GET", "http://127.0.0.1"),
    )


async def test_services_uses_gateway_owned_runtime_job(monkeypatch) -> None:
    running = {
        "jobId": "job-1",
        "component": "ffmpeg",
        "packRef": "ffmpeg@6.1.1",
        "state": "running",
        "downloadedBytes": 10,
        "totalBytes": 100,
        "createdAt": 1,
        "updatedAt": 1,
    }
    completed = {**running, "state": "completed", "downloadedBytes": 100}
    requests: list[str] = []

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, **_kwargs):
            requests.append(url)
            if url.endswith("/webui/bootstrap"):
                return _response(200, {"token": "api-token"})
            if url.endswith("/api/runtimes/install/required"):
                return _response(202, {"ok": True, "job": running})
            return _response(200, {"job": completed})

    monkeypatch.setenv("MONA_PROCESS_ROLE", "services")
    monkeypatch.setattr(official.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    monkeypatch.setattr(official.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(
        "mona.config.loader.load_config",
        lambda: SimpleNamespace(
            channels=SimpleNamespace(
                websocket={"port": 8765, "tokenIssueSecret": "secret"}
            )
        ),
    )
    progress: list[tuple[int, int]] = []

    job = await official.ensure_official_runtime_resource(
        "ffmpeg", lambda _ref, current, total: progress.append((current, total))
    )

    assert job.state == "completed"
    assert progress == [(10, 100), (100, 100)]
    assert requests == [
        "http://127.0.0.1:8765/webui/bootstrap",
        "http://127.0.0.1:8765/api/runtimes/install/required",
        "http://127.0.0.1:8765/api/runtimes/install/status",
    ]


async def _no_sleep(_seconds: float) -> None:
    return None
