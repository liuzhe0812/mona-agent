"""Background video-runtime downloads expose progress without blocking the UI."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.api import video_runtime_jobs as jobs


@pytest.fixture(autouse=True)
def _clear_jobs(monkeypatch, tmp_path) -> None:
    jobs._jobs.clear()
    jobs._tasks.clear()
    jobs._loaded = False
    jobs._last_persisted_at = 0
    monkeypatch.setattr(jobs, "_jobs_file", lambda: tmp_path / "downloads.json")


async def test_background_job_reports_byte_progress(monkeypatch) -> None:
    async def ensure(_self, component, progress):
        progress(25, 100)
        progress(100, 100)
        return {"ok": True, "path": f"/{component}"}

    monkeypatch.setattr(jobs.VideoRuntime, "ensure_runtime", ensure)
    started = jobs.start_runtime_download(["ffmpeg"])
    await jobs._tasks[started["jobId"]]

    finished = jobs.get_runtime_download_jobs()[0]
    assert finished["state"] == "completed"
    assert finished["progress"] == 100
    assert finished["components"]["ffmpeg"]["receivedBytes"] == 100
    assert finished["components"]["ffmpeg"]["progress"] == 100


async def test_failed_component_is_visible(monkeypatch) -> None:
    async def ensure(_self, component, progress):
        assert component == "ffmpeg"
        progress(40, 100)
        return {"ok": False, "error": "network failed"}

    monkeypatch.setattr(jobs.VideoRuntime, "ensure_runtime", ensure)
    started = jobs.start_runtime_download(["ffmpeg"])
    await jobs._tasks[started["jobId"]]

    finished = jobs.get_runtime_download_jobs()[0]
    assert finished["state"] == "failed"
    assert finished["components"]["ffmpeg"]["error"] == "network failed"


async def test_rendering_browser_can_be_prepared_and_node_is_rejected(monkeypatch) -> None:
    async def ensure(_self, component, progress):
        assert component == "chrome"
        return {"ok": True, "path": "/managed/browser"}

    monkeypatch.setattr(jobs.VideoRuntime, "ensure_runtime", ensure)
    started = jobs.start_runtime_download(["chrome"])
    await jobs._tasks[started["jobId"]]
    assert jobs.get_runtime_download_jobs()[0]["state"] == "completed"
    with pytest.raises(ValueError, match="must contain ffmpeg"):
        jobs.start_runtime_download(["node"])


async def test_start_and_status_handlers_return_immediately(monkeypatch) -> None:
    gate = asyncio.Event()

    async def ensure(_self, _component, progress):
        progress(10, 100)
        await gate.wait()
        progress(100, 100)
        return {"ok": True, "path": "/ffmpeg"}

    monkeypatch.setattr(jobs.VideoRuntime, "ensure_runtime", ensure)
    request = MagicMock()
    request.json = AsyncMock(return_value={"components": ["ffmpeg"]})
    response = await jobs.handle_video_runtime_download_start(request)
    assert response.status == 202
    job_id = json.loads(response.body)["job"]["jobId"]

    status_request = MagicMock()
    status_request.query = {"jobId": job_id}
    status = await jobs.handle_video_runtime_download_status(status_request)
    assert json.loads(status.body)["job"]["state"] == "running"

    gate.set()
    await jobs._tasks[job_id]
    assert jobs._jobs[job_id]["state"] == "completed"


async def test_running_download_can_be_cancelled_and_resumed_later(monkeypatch) -> None:
    gate = asyncio.Event()

    async def ensure(_self, _component, progress):
        progress(40, 100)
        await gate.wait()
        return {"ok": True, "path": "/ffmpeg"}

    monkeypatch.setattr(jobs.VideoRuntime, "ensure_runtime", ensure)
    started = jobs.start_runtime_download(["ffmpeg"])
    await asyncio.sleep(0)
    request = MagicMock()
    request.json = AsyncMock(return_value={"jobId": started["jobId"]})

    response = await jobs.handle_video_runtime_download_cancel(request)

    assert response.status == 200
    cancelled = json.loads(response.body)["job"]
    assert cancelled["state"] == "cancelled"
    assert cancelled["components"]["ffmpeg"]["state"] == "cancelled"
    assert "断点续传" in cancelled["components"]["ffmpeg"]["error"]
    persisted = json.loads(jobs._jobs_file().read_text(encoding="utf-8"))
    assert persisted["jobs"][0]["state"] == "cancelled"


def test_interrupted_download_is_marked_recoverable_after_restart() -> None:
    jobs._jobs_file().write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobs": [
                    {
                        "jobId": "interrupted",
                        "state": "running",
                        "progress": 35,
                        "currentComponent": "ffmpeg",
                        "createdAt": 1,
                        "updatedAt": 2,
                        "components": {
                            "ffmpeg": {
                                "component": "ffmpeg",
                                "state": "downloading",
                                "progress": 35,
                                "receivedBytes": 35,
                                "totalBytes": 100,
                            }
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    recovered = jobs.get_runtime_download_jobs()[0]

    assert recovered["state"] == "failed"
    assert recovered["recoveredAfterRestart"] is True
    assert "断点续传" in recovered["components"]["ffmpeg"]["error"]
