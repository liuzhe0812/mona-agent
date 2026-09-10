from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AuthError
from app.models import (
    WorkerAttachment,
    WorkerAttachmentStatus,
    WorkerJob,
    WorkerJobStatus,
)

JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
LEASE_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
FORBIDDEN_PAYLOAD_KEYS = {
    "path",
    "file_path",
    "local_path",
    "storage_path",
    "absolute_path",
}
_WINDOWS_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def validate_job_id(value: str, *, field: str = "job_id") -> str:
    if not JOB_ID_PATTERN.fullmatch(value):
        raise AuthError("invalid_job_id", f"{field} is invalid", status_code=422)
    return value


def validate_lease_token(value: str) -> str:
    if not LEASE_TOKEN_PATTERN.fullmatch(value):
        raise AuthError("invalid_lease_token", "Lease token is invalid", status_code=422)
    return value


def _validate_json_value(value: Any, *, key: str | None = None) -> None:
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            if not isinstance(child_key, str):
                raise AuthError("invalid_job_payload", "Payload keys must be strings", 422)
            normalized = child_key.strip().lower()
            if normalized in FORBIDDEN_PAYLOAD_KEYS or normalized.endswith("_path"):
                raise AuthError(
                    "local_path_not_allowed",
                    "Worker payloads may reference attachments by ID only",
                    422,
                )
            _validate_json_value(child_value, key=child_key)
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_value(item, key=key)
        return
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, str) and (
            value.startswith(("/", "\\")) or _WINDOWS_PATH_PATTERN.match(value)
        ):
            raise AuthError(
                "local_path_not_allowed",
                "Worker payloads may reference attachments by ID only",
                422,
            )
        return
    raise AuthError("invalid_job_payload", "Payload must be JSON serializable", 422)


def validate_json_payload(payload: dict[str, Any], *, limit: int, error: str) -> dict[str, Any]:
    _validate_json_value(payload)
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise AuthError("invalid_job_payload", "Payload must be JSON serializable", 422) from exc
    if len(encoded) > limit:
        raise AuthError(error, "Payload is too large", 413)
    return payload


def build_job_payload(
    *, attachment_ids: list[str], options: dict[str, Any]
) -> dict[str, Any]:
    normalized_ids = list(dict.fromkeys(validate_job_id(item, field="attachment_id") for item in attachment_ids))
    payload = {"attachment_ids": normalized_ids, "options": options}
    return validate_json_payload(
        payload,
        limit=settings.worker_job_max_payload_bytes,
        error="job_payload_too_large",
    )


def _job_matches_payload(job: WorkerJob, *, kind: str, priority: int, payload: dict[str, Any]) -> bool:
    return (
        job.kind == kind
        and job.priority == priority
        and job.payload_json == payload
    )


def create_job(
    db: Session,
    *,
    user_id: int,
    job_id: str,
    kind: str,
    priority: int,
    payload: dict[str, Any],
) -> WorkerJob:
    existing = db.get(WorkerJob, job_id)
    if existing is not None:
        if existing.user_id != user_id or not _job_matches_payload(
            existing, kind=kind, priority=priority, payload=payload
        ):
            raise AuthError("job_conflict", "Job ID is already in use", status_code=409)
        return existing

    attachment_ids = payload.get("attachment_ids", [])
    attachments = (
        db.query(WorkerAttachment)
        .filter(
            WorkerAttachment.user_id == user_id,
            WorkerAttachment.id.in_(attachment_ids),
            WorkerAttachment.status == WorkerAttachmentStatus.READY,
        )
        .all()
        if attachment_ids
        else []
    )
    if len(attachments) != len(set(attachment_ids)):
        raise AuthError("attachment_not_found", "Attachment is unavailable", status_code=404)

    job = WorkerJob(
        id=job_id,
        user_id=user_id,
        kind=kind,
        status=WorkerJobStatus.QUEUED,
        priority=priority,
        payload_json=payload,
        progress=0,
    )
    db.add(job)
    db.flush()
    return job


def _active_job(db: Session, job_id: str) -> WorkerJob:
    job = db.query(WorkerJob).filter(WorkerJob.id == job_id).with_for_update().one_or_none()
    if job is None:
        raise AuthError("job_not_found", "Job not found", status_code=404)
    return job


def _require_lease(job: WorkerJob, lease_token: str, now: datetime) -> None:
    if job.status not in {WorkerJobStatus.LEASED, WorkerJobStatus.RUNNING}:
        raise AuthError("job_not_active", "Job is no longer active", status_code=409)
    if job.lease_token != lease_token:
        raise AuthError("lease_conflict", "Job lease is no longer valid", status_code=409)
    expires_at = _aware(job.lease_expires_at)
    if expires_at is None or expires_at <= now:
        raise AuthError("lease_expired", "Job lease has expired", status_code=409)


def claim_job(db: Session, *, worker_id: str) -> WorkerJob | None:
    now = utcnow()
    job = (
        db.query(WorkerJob)
        .filter(
            or_(
                WorkerJob.status == WorkerJobStatus.QUEUED,
                and_(
                    WorkerJob.status.in_([WorkerJobStatus.LEASED, WorkerJobStatus.RUNNING]),
                    WorkerJob.lease_expires_at.is_not(None),
                    WorkerJob.lease_expires_at <= now,
                ),
            )
        )
        .order_by(WorkerJob.priority.desc(), WorkerJob.created_at.asc())
        .with_for_update()
        .first()
    )
    if job is None:
        return None

    job.status = WorkerJobStatus.LEASED
    job.worker_id = worker_id
    job.lease_token = secrets.token_urlsafe(32)
    job.lease_expires_at = now + timedelta(seconds=settings.worker_job_lease_seconds)
    job.heartbeat_at = now
    job.started_at = job.started_at or now
    db.flush()
    return job


def heartbeat_job(
    db: Session,
    *,
    job_id: str,
    lease_token: str,
    progress: int,
) -> WorkerJob:
    now = utcnow()
    job = _active_job(db, job_id)
    _require_lease(job, lease_token, now)
    job.status = WorkerJobStatus.RUNNING
    job.progress = min(max(progress, 0), 99)
    job.heartbeat_at = now
    job.lease_expires_at = now + timedelta(seconds=settings.worker_job_lease_seconds)
    db.flush()
    return job


def complete_job(
    db: Session,
    *,
    job_id: str,
    lease_token: str,
    result: dict[str, Any],
) -> WorkerJob:
    result = validate_json_payload(
        result,
        limit=settings.worker_job_max_result_bytes,
        error="job_result_too_large",
    )
    now = utcnow()
    job = _active_job(db, job_id)
    if job.status == WorkerJobStatus.COMPLETED:
        if job.result_json != result:
            raise AuthError("job_conflict", "Completed result cannot be changed", status_code=409)
        return job
    _require_lease(job, lease_token, now)
    job.status = WorkerJobStatus.COMPLETED
    job.progress = 100
    job.result_json = result
    job.completed_at = now
    job.lease_token = None
    job.lease_expires_at = None
    job.heartbeat_at = now
    db.flush()
    return job


def fail_job(
    db: Session,
    *,
    job_id: str,
    lease_token: str,
    error_code: str,
) -> WorkerJob:
    now = utcnow()
    job = _active_job(db, job_id)
    if job.status == WorkerJobStatus.FAILED:
        if job.error_code != error_code:
            raise AuthError("job_conflict", "Failed result cannot be changed", status_code=409)
        return job
    _require_lease(job, lease_token, now)
    job.status = WorkerJobStatus.FAILED
    job.error_code = error_code
    job.completed_at = now
    job.lease_token = None
    job.lease_expires_at = None
    job.heartbeat_at = now
    db.flush()
    return job


def cancel_job(db: Session, *, job_id: str, user_id: int) -> WorkerJob:
    job = _active_job(db, job_id)
    if job.user_id != user_id:
        raise AuthError("job_not_found", "Job not found", status_code=404)
    if job.status == WorkerJobStatus.CANCELLED:
        return job
    if job.status in {WorkerJobStatus.COMPLETED, WorkerJobStatus.FAILED}:
        raise AuthError("job_not_cancellable", "Job is already finished", status_code=409)
    job.status = WorkerJobStatus.CANCELLED
    job.completed_at = utcnow()
    job.lease_token = None
    job.lease_expires_at = None
    db.flush()
    return job


def serialize_job(job: WorkerJob, *, include_lease: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": job.id,
        "kind": job.kind,
        "status": job.status.value,
        "priority": job.priority,
        "progress": job.progress,
        "payload": job.payload_json,
        "result": job.result_json,
        "error_code": job.error_code,
        "worker_id": job.worker_id if include_lease else None,
        "lease_expires_at": job.lease_expires_at if include_lease else None,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
    }
    if include_lease:
        payload["lease_token"] = job.lease_token
    else:
        payload.pop("worker_id")
        payload.pop("lease_expires_at")
    return payload
