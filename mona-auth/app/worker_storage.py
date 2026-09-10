from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.config import settings
from app.models import WorkerAttachment, WorkerAttachmentStatus

CHUNK_SIZE = 1024 * 1024


def _root() -> Path:
    root = Path(settings.worker_attachment_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_attachment_path(storage_path: str) -> Path:
    root = _root()
    path = (root / storage_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise RuntimeError("Attachment storage path escaped its root") from exc
    return path


def _safe_filename(filename: str | None) -> str:
    name = (filename or "attachment").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(char if char >= " " and char != "\x7f" else "_" for char in name)
    return name[:255] or "attachment"


async def save_attachment(
    db: Session,
    *,
    user_id: int,
    upload: UploadFile,
) -> WorkerAttachment:
    attachment_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    relative = Path(f"{now:%Y}") / f"{now:%m}" / f"{attachment_id}.blob"
    target = resolve_attachment_path(relative.as_posix())
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{attachment_id}.upload")
    digest = hashlib.sha256()
    size = 0

    try:
        with temporary.open("xb") as output:
            while chunk := await upload.read(CHUNK_SIZE):
                size += len(chunk)
                if size > settings.worker_attachment_max_bytes:
                    raise HTTPException(status_code=413, detail="attachment_too_large")
                digest.update(chunk)
                output.write(chunk)
        os.replace(temporary, target)
        attachment = WorkerAttachment(
            id=attachment_id,
            user_id=user_id,
            original_name=_safe_filename(upload.filename),
            content_type=upload.content_type or "application/octet-stream",
            size=size,
            sha256=digest.hexdigest(),
            status=WorkerAttachmentStatus.READY,
            storage_path=relative.as_posix(),
        )
        db.add(attachment)
        db.flush()
        return attachment
    except Exception:
        db.rollback()
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise
