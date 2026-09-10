from __future__ import annotations

import asyncio
import mimetypes
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI

VPS_WORKER_URL = os.getenv("VPS_WORKER_URL", "").rstrip("/")
VPS_WORKER_KEY = os.getenv("VPS_WORKER_KEY", "")
VPS_WORKER_CA_FILE = os.getenv("VPS_WORKER_CA_FILE", "")
WORKER_ID = os.getenv("WORKER_ID", "mona-notebook-01")
POLL_SECONDS = int(os.getenv("WORKER_POLL_SECONDS", "5"))
LEASE_SECONDS = int(os.getenv("WORKER_LEASE_SECONDS", "900"))
UPLOAD_ROOT = Path("/data/uploads")

SERVICE_BY_KIND = {
    "ocr": ("http://mona-ocr:8000/v1/ocr", {}),
    "structure_ocr": ("http://mona-structure-ocr:8000/v1/structure-ocr", {}),
}


class WorkerRuntime:
    def __init__(self) -> None:
        self.running_job_id: str | None = None
        self.last_error: str | None = None

    @property
    def configured(self) -> bool:
        return bool(VPS_WORKER_URL and VPS_WORKER_KEY and (not VPS_WORKER_CA_FILE or Path(VPS_WORKER_CA_FILE).is_file()))

    def request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        headers = dict(kwargs.pop("headers", {}))
        headers["X-Worker-Key"] = VPS_WORKER_KEY
        return requests.request(
            method,
            f"{VPS_WORKER_URL}{path}",
            headers=headers,
            timeout=(10, LEASE_SECONDS),
            verify=VPS_WORKER_CA_FILE or True,
            **kwargs,
        )

    def claim(self) -> dict[str, Any] | None:
        response = self.request(
            "POST",
            "/internal/worker/jobs/claim",
            params={"worker_id": WORKER_ID},
        )
        response.raise_for_status()
        return response.json().get("job")

    def heartbeat(self, job: dict[str, Any], progress: int) -> None:
        response = self.request(
            "POST",
            "/internal/worker/jobs/heartbeat",
            json={
                "job_id": job["id"],
                "lease_token": job["lease_token"],
                "progress": progress,
            },
        )
        response.raise_for_status()

    def download_attachment(self, job: dict[str, Any], attachment_id: str, destination: Path) -> str:
        response = self.request(
            "GET",
            f"/internal/worker/attachments/{attachment_id}",
            params={"job_id": job["id"]},
            headers={"X-Worker-Lease-Token": job["lease_token"]},
            stream=True,
        )
        response.raise_for_status()
        with destination.open("xb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)
        return response.headers.get("Content-Type", "application/octet-stream")

    def complete(self, job: dict[str, Any], result: dict[str, Any]) -> None:
        response = self.request(
            "POST",
            "/internal/worker/jobs/complete",
            json={"job_id": job["id"], "lease_token": job["lease_token"], "result": result},
        )
        response.raise_for_status()

    def fail(self, job: dict[str, Any], error_code: str) -> None:
        response = self.request(
            "POST",
            "/internal/worker/jobs/fail",
            json={
                "job_id": job["id"],
                "lease_token": job["lease_token"],
                "error_code": error_code,
            },
        )
        response.raise_for_status()

    def _service_for_job(self, job: dict[str, Any]) -> tuple[str, dict[str, str]]:
        if job["kind"] == "asr":
            mode = job["payload"].get("options", {}).get("mode", "quick_asr")
            if mode not in {"quick_asr", "meeting_diarize"}:
                raise ValueError("unsupported_asr_mode")
            language = job["payload"].get("options", {}).get("language", "auto")
            return "http://mona-asr:8000/v1/transcriptions", {"mode": mode, "language": language}
        return SERVICE_BY_KIND[job["kind"]]

    def execute(self, job: dict[str, Any]) -> None:
        attachment_ids = job["payload"].get("attachment_ids", [])
        if len(attachment_ids) != 1:
            raise ValueError("unsupported_attachment_count")
        attachment_id = attachment_ids[0]
        endpoint, form = self._service_for_job(job)
        job_root = UPLOAD_ROOT / job["id"]
        job_root.mkdir(parents=True, exist_ok=True)
        temporary = job_root / "input"
        content_type = self.download_attachment(job, attachment_id, temporary)
        suffix = mimetypes.guess_extension(content_type.split(";", 1)[0]) or ".bin"
        source = temporary.with_suffix(suffix)
        temporary.replace(source)
        with source.open("rb") as file:
            response = requests.post(
                endpoint,
                data=form,
                files={"file": (source.name, file, content_type)},
                timeout=LEASE_SECONDS,
            )
        response.raise_for_status()
        self.complete(job, response.json())

    def _heartbeat_loop(self, job: dict[str, Any], stop: threading.Event) -> None:
        while not stop.wait(min(30, max(1, LEASE_SECONDS // 3))):
            try:
                self.heartbeat(job, 1)
            except requests.RequestException:
                self.last_error = "worker_heartbeat_failed"

    def run_once(self) -> None:
        job = self.claim()
        if job is None:
            return
        self.running_job_id = job["id"]
        stop = threading.Event()
        heartbeat = threading.Thread(target=self._heartbeat_loop, args=(job, stop), daemon=True)
        heartbeat.start()
        try:
            self.heartbeat(job, 1)
            self.execute(job)
            self.last_error = None
        except (KeyError, ValueError) as exc:
            self.last_error = str(exc)
            try:
                self.fail(job, str(exc))
            except requests.RequestException:
                pass
        except requests.RequestException:
            self.last_error = "worker_execution_failed"
            try:
                self.fail(job, "worker_execution_failed")
            except requests.RequestException:
                pass
        except Exception:
            self.last_error = "worker_execution_failed"
            try:
                self.fail(job, "worker_execution_failed")
            except requests.RequestException:
                pass
        finally:
            stop.set()
            heartbeat.join(timeout=1)
            self.running_job_id = None


runtime = WorkerRuntime()


async def _poll() -> None:
    while True:
        if runtime.configured:
            try:
                await asyncio.to_thread(runtime.run_once)
            except requests.RequestException:
                runtime.last_error = "worker_claim_failed"
        await asyncio.sleep(POLL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    poll_task = asyncio.create_task(_poll())
    try:
        yield
    finally:
        poll_task.cancel()
        await asyncio.gather(poll_task, return_exceptions=True)


app = FastAPI(title="Mona Worker API", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
async def ready() -> dict[str, bool]:
    return {"ready": runtime.configured}


@app.get("/status")
async def status() -> dict[str, str | None | bool]:
    return {
        "configured": runtime.configured,
        "running_job_id": runtime.running_job_id,
        "last_error": runtime.last_error,
    }





