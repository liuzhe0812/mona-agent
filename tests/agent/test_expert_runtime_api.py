"""Authenticated gateway HTTP contracts for expert and runtime installation."""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock

from mona.agent.expert_jobs import ExpertInstallJob
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.runtime.jobs import RuntimeInstallJob


def _request(path: str, *, token: str | None = "tok") -> MagicMock:
    request = MagicMock()
    request.path = path
    request.headers = {"Authorization": f"Bearer {token}"} if token else {}
    return request


def _channel() -> WebSocketChannel:
    channel = WebSocketChannel({}, MessageBus())
    channel._api_tokens["tok"] = time.monotonic() + 60
    return channel


def _expert_job() -> ExpertInstallJob:
    return ExpertInstallJob(
        jobId="expert-job",
        expertId="com.mona.researcher",
        version="1.0.0",
        state="running",
        createdAt=1,
        updatedAt=1,
    )


def _runtime_job() -> RuntimeInstallJob:
    return RuntimeInstallJob(
        jobId="runtime-job",
        component="python",
        packRef="python-base@3.12",
        state="running",
        createdAt=1,
        updatedAt=1,
    )


class FakeExpertManager:
    async def catalog_payload(self):
        return {"schemaVersion": 1, "experts": [], "installEnabled": True}

    def start(self, expert_id: str, version: str | None):
        assert (expert_id, version) == ("com.mona.researcher", "1.0.0")
        return _expert_job()

    def get(self, job_id: str):
        assert job_id == "expert-job"
        return _expert_job()

    def list(self):
        return [_expert_job()]

    async def cancel(self, job_id: str):
        assert job_id == "expert-job"
        return _expert_job().model_copy(update={"state": "cancelled"})


class FakeRuntimeManager:
    async def status_payload(self):
        return {"schemaVersion": 1, "components": [], "installEnabled": True}

    async def start(self, component: str, *, repair: bool = False):
        assert component == "python"
        assert repair is False
        return _runtime_job()

    async def start_required(self, component: str):
        assert component == "python"
        return _runtime_job()

    def get(self, job_id: str):
        assert job_id == "runtime-job"
        return _runtime_job()

    def list(self):
        return [_runtime_job()]

    async def cancel(self, job_id: str):
        assert job_id == "runtime-job"
        return _runtime_job().model_copy(update={"state": "cancelled"})

    def cleanup(self):
        return {"removedDownloads": 2, "removedVersions": 1, "freedBytes": 7}


class UnavailableExpertManager:
    async def catalog_payload(self):
        raise RuntimeError("catalog returned 404")


async def test_expert_catalog_and_install_routes_are_authenticated() -> None:
    channel = _channel()
    channel._expert_jobs = FakeExpertManager()

    unauthorized = await channel._handle_expert_catalog(
        _request("/api/experts/catalog", token=None)
    )
    catalog = await channel._handle_expert_catalog(_request("/api/experts/catalog"))
    started = channel._handle_expert_install_start(
        _request(
            "/api/experts/install/start?expert_id=com.mona.researcher&version=1.0.0"
        )
    )
    status = channel._handle_expert_install_status(
        _request("/api/experts/install/status?job_id=expert-job")
    )
    cancelled = await channel._handle_expert_install_cancel(
        _request("/api/experts/install/cancel?job_id=expert-job")
    )

    assert unauthorized.status_code == 401
    assert json.loads(catalog.body)["experts"] == []
    assert started.status_code == 202
    assert json.loads(started.body)["job"]["jobId"] == "expert-job"
    assert json.loads(status.body)["job"]["expertId"] == "com.mona.researcher"
    assert json.loads(cancelled.body)["job"]["state"] == "cancelled"


async def test_unpublished_expert_catalog_is_a_normal_empty_state() -> None:
    channel = _channel()
    channel._expert_jobs = UnavailableExpertManager()

    response = await channel._handle_expert_catalog(_request("/api/experts/catalog"))
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["source"] == "unavailable"
    assert payload["installEnabled"] is False
    assert payload["experts"] == []


async def test_runtime_status_start_status_and_cancel_routes() -> None:
    channel = _channel()
    channel._runtime_jobs = FakeRuntimeManager()

    status_payload = await channel._handle_runtime_status(
        _request("/api/runtimes/status")
    )
    started = await channel._handle_runtime_install_start(
        _request("/api/runtimes/install/start?component=python")
    )
    required = await channel._handle_runtime_install_required(
        _request("/api/runtimes/install/required?component=python")
    )
    status = channel._handle_runtime_install_status(
        _request("/api/runtimes/install/status?job_id=runtime-job")
    )
    cancelled = await channel._handle_runtime_install_cancel(
        _request("/api/runtimes/install/cancel?job_id=runtime-job")
    )

    assert json.loads(status_payload.body)["components"] == []
    assert started.status_code == 202
    assert required.status_code == 202
    assert json.loads(started.body)["job"]["packRef"] == "python-base@3.12"
    assert json.loads(status.body)["job"]["component"] == "python"
    assert json.loads(cancelled.body)["job"]["state"] == "cancelled"


def test_runtime_settings_and_cleanup_routes(monkeypatch) -> None:
    channel = _channel()
    channel._runtime_jobs = FakeRuntimeManager()
    monkeypatch.setattr(
        "mona.channels.websocket.update_agent_settings",
        lambda query: {
            "runtime": {"auto_download": query["auto_download"][0] == "true"}
        },
    )

    updated = channel._handle_runtime_settings_update(
        _request("/api/runtimes/settings/update?auto_download=false")
    )
    cleaned = channel._handle_runtime_cleanup(_request("/api/runtimes/cleanup"))

    assert json.loads(updated.body) == {"ok": True, "autoDownload": False}
    assert json.loads(cleaned.body) == {
        "ok": True,
        "removedDownloads": 2,
        "removedVersions": 1,
        "freedBytes": 7,
    }
