"""Background download jobs for Mona's video runtime dependencies."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.api.video_runtime import VideoRuntime
from mona.config.paths import get_workspace_path

RUNTIME_COMPONENTS = ("node", "ffmpeg")
_jobs: dict[str, dict[str, Any]] = {}
_tasks: dict[str, asyncio.Task] = {}
_loaded = False
_last_persisted_at = 0.0


def _now_ms() -> int:
    return int(time.time() * 1000)


def _snapshot(job: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(job)


def _jobs_file() -> Path:
    return get_workspace_path() / "video_runtime_downloads.json"


def _persist_jobs(*, force: bool = False) -> None:
    global _last_persisted_at

    now = time.monotonic()
    if not force and now - _last_persisted_at < 0.5:
        return
    path = _jobs_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(
                {"schemaVersion": 1, "jobs": list(_jobs.values())},
                stream,
                ensure_ascii=False,
                indent=2,
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _last_persisted_at = now
    finally:
        temporary.unlink(missing_ok=True)


def _ensure_loaded() -> None:
    global _loaded

    if _loaded:
        return
    _loaded = True
    path = _jobs_file()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, list):
        return
    recovered = False
    for item in jobs[-20:]:
        if not isinstance(item, dict) or not item.get("jobId"):
            continue
        job = copy.deepcopy(item)
        if job.get("state") == "running":
            recovered = True
            job["state"] = "failed"
            job["currentComponent"] = None
            job["updatedAt"] = _now_ms()
            job["finishedAt"] = job["updatedAt"]
            job["recoveredAfterRestart"] = True
            for component in (job.get("components") or {}).values():
                if component.get("state") in {"pending", "downloading"}:
                    component["state"] = "failed"
                    component["error"] = "下载在应用退出时中断，可重新开始并断点续传"
        _jobs[str(job["jobId"])] = job
    if recovered:
        _persist_jobs(force=True)


def _overall_progress(job: dict[str, Any]) -> int:
    values: list[int] = []
    for component in job["components"].values():
        if component["state"] == "completed":
            values.append(100)
        elif component["state"] == "pending":
            values.append(0)
        elif component.get("totalBytes", 0) > 0:
            values.append(
                min(
                    99,
                    round(
                        component.get("receivedBytes", 0)
                        / component["totalBytes"]
                        * 100
                    ),
                )
            )
        else:
            values.append(0)
    return round(sum(values) / len(values)) if values else 0


async def _run_job(job_id: str) -> None:
    job = _jobs[job_id]
    runtime = VideoRuntime()
    failed = False
    try:
        for component_name, component in job["components"].items():
            component["state"] = "downloading"
            component["startedAt"] = _now_ms()
            job["currentComponent"] = component_name
            job["updatedAt"] = _now_ms()
            _persist_jobs(force=True)

            def progress(downloaded: int, total: int) -> None:
                component["receivedBytes"] = max(0, int(downloaded))
                component["totalBytes"] = max(0, int(total))
                component["progress"] = (
                    min(99, round(downloaded / total * 100)) if total > 0 else None
                )
                job["progress"] = _overall_progress(job)
                job["updatedAt"] = _now_ms()
                _persist_jobs()

            try:
                result = await runtime.ensure_runtime(component_name, progress)
            except Exception as exc:
                logger.exception("video runtime background download failed")
                result = {"ok": False, "error": str(exc)}
            if result.get("ok"):
                component.update(
                    {
                        "state": "completed",
                        "progress": 100,
                        "path": result.get("path"),
                        "finishedAt": _now_ms(),
                    }
                )
            else:
                failed = True
                component.update(
                    {
                        "state": "failed",
                        "error": str(result.get("error") or "安装失败"),
                        "finishedAt": _now_ms(),
                    }
                )
            job["progress"] = _overall_progress(job)
            job["updatedAt"] = _now_ms()
            _persist_jobs(force=True)
        job["state"] = "failed" if failed else "completed"
        job["currentComponent"] = None
        job["progress"] = 100 if not failed else _overall_progress(job)
        job["finishedAt"] = _now_ms()
        job["updatedAt"] = job["finishedAt"]
        _persist_jobs(force=True)
    except asyncio.CancelledError:
        job["state"] = "cancelled"
        job["currentComponent"] = None
        job["updatedAt"] = _now_ms()
        job["finishedAt"] = job["updatedAt"]
        for component in job["components"].values():
            if component["state"] in {"pending", "downloading"}:
                component["state"] = "cancelled"
                component["error"] = "已停止，可重新开始并断点续传"
        _persist_jobs(force=True)


def start_runtime_download(components: list[str]) -> dict[str, Any]:
    _ensure_loaded()
    normalized = list(dict.fromkeys(components))
    if not normalized or any(item not in RUNTIME_COMPONENTS for item in normalized):
        raise ValueError("components must contain node or ffmpeg")
    for job_id, task in _tasks.items():
        if not task.done() and set(normalized).issubset(_jobs[job_id]["components"]):
            return _snapshot(_jobs[job_id])

    now = _now_ms()
    job_id = uuid.uuid4().hex
    job = {
        "jobId": job_id,
        "state": "running",
        "progress": 0,
        "currentComponent": None,
        "createdAt": now,
        "updatedAt": now,
        "components": {
            component: {
                "component": component,
                "state": "pending",
                "progress": 0,
                "receivedBytes": 0,
                "totalBytes": 0,
            }
            for component in normalized
        },
    }
    _jobs[job_id] = job
    _tasks[job_id] = asyncio.create_task(_run_job(job_id))
    _persist_jobs(force=True)
    completed = sorted(
        (
            value
            for value in _jobs.values()
            if value["state"] in {"completed", "failed", "cancelled"}
        ),
        key=lambda value: value["updatedAt"],
        reverse=True,
    )
    for stale in completed[20:]:
        _jobs.pop(stale["jobId"], None)
        _tasks.pop(stale["jobId"], None)
    _persist_jobs(force=True)
    return _snapshot(job)


def get_runtime_download_jobs() -> list[dict[str, Any]]:
    _ensure_loaded()
    return [
        _snapshot(job)
        for job in sorted(_jobs.values(), key=lambda value: value["createdAt"], reverse=True)
    ]


async def cancel_runtime_download(job_id: str) -> dict[str, Any]:
    _ensure_loaded()
    job = _jobs.get(job_id)
    if job is None:
        raise KeyError("download job not found")
    task = _tasks.get(job_id)
    if task is None or task.done() or job.get("state") != "running":
        raise ValueError("download job is not running")
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return _snapshot(job)


async def handle_video_runtime_download_start(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    raw = body.get("components") if isinstance(body, dict) else None
    if raw is None and isinstance(body, dict):
        raw = [body.get("component")]
    if not isinstance(raw, list):
        return web.json_response({"error": "components must be a list"}, status=400)
    try:
        job = start_runtime_download([str(item or "").strip() for item in raw])
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True, "job": job}, status=202)


async def handle_video_runtime_download_status(request: web.Request) -> web.Response:
    _ensure_loaded()
    job_id = str(request.query.get("jobId") or "").strip()
    if job_id:
        job = _jobs.get(job_id)
        if job is None:
            return web.json_response({"error": "download job not found"}, status=404)
        return web.json_response({"job": _snapshot(job)})
    return web.json_response({"jobs": get_runtime_download_jobs()})


async def handle_video_runtime_download_cancel(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    job_id = str(body.get("jobId") or "").strip() if isinstance(body, dict) else ""
    if not job_id:
        return web.json_response({"error": "jobId is required"}, status=400)
    try:
        job = await cancel_runtime_download(job_id)
    except KeyError:
        return web.json_response({"error": "download job not found"}, status=404)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    return web.json_response({"ok": True, "job": job})
