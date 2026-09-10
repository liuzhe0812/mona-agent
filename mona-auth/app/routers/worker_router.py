from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_worker_key
from app.errors import AuthError
from app.models import User, WorkerAttachment, WorkerJob
from app.schemas import (
    WorkerAttachmentInfo,
    WorkerClaimResponse,
    WorkerJobCompleteRequest,
    WorkerJobCreateRequest,
    WorkerJobFailRequest,
    WorkerJobHeartbeatRequest,
    WorkerJobInfo,
)
from app.worker_jobs import (
    _require_lease,
    build_job_payload,
    cancel_job,
    claim_job,
    complete_job,
    create_job,
    fail_job,
    heartbeat_job,
    serialize_job,
    utcnow,
    validate_job_id,
    validate_lease_token,
)
from app.worker_storage import resolve_attachment_path, save_attachment

router = APIRouter(tags=["worker-jobs"])


def _attachment_info(attachment: WorkerAttachment) -> WorkerAttachmentInfo:
    return WorkerAttachmentInfo(
        id=attachment.id,
        filename=attachment.original_name,
        content_type=attachment.content_type,
        size=attachment.size,
        sha256=attachment.sha256,
        status=attachment.status.value,
        created_at=attachment.created_at,
    )


def _get_user_job(db: Session, *, job_id: str, user_id: int) -> WorkerJob:
    validate_job_id(job_id)
    job = db.get(WorkerJob, job_id)
    if job is None or job.user_id != user_id:
        raise AuthError("job_not_found", "Job not found", status_code=404)
    return job


@router.post("/worker/attachments", response_model=WorkerAttachmentInfo, status_code=201)
async def upload_worker_attachment(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    attachment = await save_attachment(db, user_id=user.id, upload=file)
    db.commit()
    db.refresh(attachment)
    return _attachment_info(attachment)


@router.post("/worker/jobs", response_model=WorkerJobInfo)
def create_worker_job(
    body: WorkerJobCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job_id = body.job_id or uuid.uuid4().hex
    payload = build_job_payload(attachment_ids=body.attachment_ids, options=body.options)
    job = create_job(
        db,
        user_id=user.id,
        job_id=job_id,
        kind=body.kind,
        priority=body.priority,
        payload=payload,
    )
    db.commit()
    db.refresh(job)
    return serialize_job(job)


@router.get("/worker/jobs/{job_id}", response_model=WorkerJobInfo)
def get_worker_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return serialize_job(_get_user_job(db, job_id=job_id, user_id=user.id))


@router.post("/worker/jobs/{job_id}/cancel", response_model=WorkerJobInfo)
def cancel_worker_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = cancel_job(db, job_id=validate_job_id(job_id), user_id=user.id)
    db.commit()
    db.refresh(job)
    return serialize_job(job)


@router.post("/internal/worker/jobs/claim", response_model=WorkerClaimResponse)
def claim_worker_job(
    worker_id: str = Query(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"),
    _: None = Depends(require_worker_key),
    db: Session = Depends(get_db),
):
    job = claim_job(db, worker_id=worker_id)
    db.commit()
    if job is None:
        return {"job": None}
    db.refresh(job)
    return {"job": serialize_job(job, include_lease=True)}


@router.post("/internal/worker/jobs/heartbeat", response_model=WorkerJobInfo)
def heartbeat_worker_job(
    body: WorkerJobHeartbeatRequest,
    _: None = Depends(require_worker_key),
    db: Session = Depends(get_db),
):
    job = heartbeat_job(
        db,
        job_id=validate_job_id(body.job_id),
        lease_token=validate_lease_token(body.lease_token),
        progress=body.progress,
    )
    db.commit()
    db.refresh(job)
    return serialize_job(job, include_lease=True)


@router.post("/internal/worker/jobs/complete", response_model=WorkerJobInfo)
def complete_worker_job(
    body: WorkerJobCompleteRequest,
    _: None = Depends(require_worker_key),
    db: Session = Depends(get_db),
):
    job = complete_job(
        db,
        job_id=validate_job_id(body.job_id),
        lease_token=validate_lease_token(body.lease_token),
        result=body.result,
    )
    db.commit()
    db.refresh(job)
    return serialize_job(job, include_lease=True)


@router.post("/internal/worker/jobs/fail", response_model=WorkerJobInfo)
def fail_worker_job(
    body: WorkerJobFailRequest,
    _: None = Depends(require_worker_key),
    db: Session = Depends(get_db),
):
    job = fail_job(
        db,
        job_id=validate_job_id(body.job_id),
        lease_token=validate_lease_token(body.lease_token),
        error_code=body.error_code,
    )
    db.commit()
    db.refresh(job)
    return serialize_job(job, include_lease=True)


@router.get("/internal/worker/attachments/{attachment_id}")
def download_worker_attachment(
    attachment_id: str,
    job_id: str = Query(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    lease_token: str = Header(
        alias="X-Worker-Lease-Token", min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$"
    ),
    _: None = Depends(require_worker_key),
    db: Session = Depends(get_db),
):
    job = db.get(WorkerJob, validate_job_id(job_id))
    if job is None:
        raise AuthError("job_not_found", "Job not found", status_code=404)
    _require_lease(job, validate_lease_token(lease_token), utcnow())
    attachment_ids = job.payload_json.get("attachment_ids", [])
    if attachment_id not in attachment_ids:
        raise AuthError("attachment_not_found", "Attachment is unavailable", status_code=404)
    attachment = (
        db.query(WorkerAttachment)
        .filter(WorkerAttachment.id == attachment_id, WorkerAttachment.user_id == job.user_id)
        .one_or_none()
    )
    if attachment is None:
        raise AuthError("attachment_not_found", "Attachment is unavailable", status_code=404)
    path = resolve_attachment_path(attachment.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment is unavailable")
    return FileResponse(
        Path(path), media_type=attachment.content_type, filename=attachment.original_name
    )

