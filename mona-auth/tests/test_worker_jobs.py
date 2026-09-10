from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import settings
from app.models import WorkerJob


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_worker_job_lifecycle_keeps_attachments_private(
    client: TestClient, db, monkeypatch, register_and_get_token, tmp_path
):
    monkeypatch.setattr(settings, "worker_shared_key", "worker-test-secret-at-least-32-characters")
    monkeypatch.setattr(settings, "worker_attachment_dir", str(tmp_path / "attachments"))
    token = register_and_get_token()

    upload = client.post(
        "/worker/attachments",
        headers=_headers(token),
        files={"file": ("scan.pdf", b"source document", "application/pdf")},
    )
    assert upload.status_code == 201, upload.text
    attachment = upload.json()
    assert attachment["filename"] == "scan.pdf"

    job_body = {
        "job_id": "worker-job-0001",
        "kind": "ocr",
        "attachment_ids": [attachment["id"]],
        "options": {"language": "en"},
    }
    created = client.post("/worker/jobs", headers=_headers(token), json=job_body)
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "queued"
    assert "lease_token" not in created.json()

    repeated = client.post("/worker/jobs", headers=_headers(token), json=job_body)
    assert repeated.status_code == 200, repeated.text
    assert db.query(WorkerJob).count() == 1

    bad_payload = client.post(
        "/worker/jobs",
        headers=_headers(token),
        json={"kind": "ocr", "options": {"file_path": "/tmp/document.pdf"}},
    )
    assert bad_payload.status_code == 422
    assert bad_payload.json()["error"] == "local_path_not_allowed"

    claim = client.post(
        "/internal/worker/jobs/claim?worker_id=notebook-1",
        headers={"X-Worker-Key": settings.worker_shared_key},
    )
    assert claim.status_code == 200, claim.text
    claimed = claim.json()["job"]
    assert claimed["id"] == job_body["job_id"]
    assert claimed["lease_token"]

    missing_worker_auth = client.get(
        f"/internal/worker/attachments/{attachment['id']}",
        params={"job_id": claimed["id"]},
        headers={"X-Worker-Lease-Token": claimed["lease_token"]},
    )
    assert missing_worker_auth.status_code == 401

    invalid_lease = client.get(
        f"/internal/worker/attachments/{attachment['id']}",
        params={"job_id": claimed["id"]},
        headers={
            "X-Worker-Key": settings.worker_shared_key,
            "X-Worker-Lease-Token": "x" * 32,
        },
    )
    assert invalid_lease.status_code == 409

    attachment_response = client.get(
        f"/internal/worker/attachments/{attachment['id']}",
        params={"job_id": claimed["id"]},
        headers={
            "X-Worker-Key": settings.worker_shared_key,
            "X-Worker-Lease-Token": claimed["lease_token"],
        },
    )
    assert attachment_response.status_code == 200, attachment_response.text
    assert attachment_response.content == b"source document"

    heartbeat = client.post(
        "/internal/worker/jobs/heartbeat",
        headers={"X-Worker-Key": settings.worker_shared_key},
        json={"job_id": claimed["id"], "lease_token": claimed["lease_token"], "progress": 50},
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["status"] == "running"

    complete_body = {
        "job_id": claimed["id"],
        "lease_token": claimed["lease_token"],
        "result": {"text": "recognized"},
    }
    completed = client.post(
        "/internal/worker/jobs/complete",
        headers={"X-Worker-Key": settings.worker_shared_key},
        json=complete_body,
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    assert completed.json()["result"] == {"text": "recognized"}

    repeated_complete = client.post(
        "/internal/worker/jobs/complete",
        headers={"X-Worker-Key": settings.worker_shared_key},
        json=complete_body,
    )
    assert repeated_complete.status_code == 200, repeated_complete.text

    visible_to_user = client.get(f"/worker/jobs/{claimed['id']}", headers=_headers(token))
    assert visible_to_user.status_code == 200, visible_to_user.text
    assert "lease_token" not in visible_to_user.json()
    assert "worker_id" not in visible_to_user.json()


def test_worker_cancellation_invalidates_lease(client, monkeypatch, register_and_get_token):
    monkeypatch.setattr(settings, "worker_shared_key", "worker-test-secret-at-least-32-characters")
    token = register_and_get_token()
    job = client.post(
        "/worker/jobs",
        headers=_headers(token),
        json={"job_id": "worker-job-0002", "kind": "asr"},
    )
    assert job.status_code == 200, job.text
    claim = client.post(
        "/internal/worker/jobs/claim?worker_id=notebook-1",
        headers={"X-Worker-Key": settings.worker_shared_key},
    )
    assert claim.status_code == 200, claim.text
    claimed = claim.json()["job"]
    assert claimed["id"] == "worker-job-0002"

    cancelled = client.post("/worker/jobs/worker-job-0002/cancel", headers=_headers(token))
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"

    heartbeat = client.post(
        "/internal/worker/jobs/heartbeat",
        headers={"X-Worker-Key": settings.worker_shared_key},
        json={"job_id": claimed["id"], "lease_token": claimed["lease_token"], "progress": 1},
    )
    assert heartbeat.status_code == 409
    assert heartbeat.json()["error"] == "job_not_active"


