import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse

from app.config import settings
from app.middleware import limiter

router = APIRouter(prefix="/upload", tags=["upload"])

ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB
EXT_BY_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


@router.post("/image")
@limiter.limit("20/hour")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
):
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_type", "detail": "Only PNG/JPEG/WebP/GIF are allowed"},
        )

    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        return JSONResponse(
            status_code=413,
            content={"error": "file_too_large", "detail": "Max image size is 8 MB"},
        )

    now = datetime.now(timezone.utc)
    ext = EXT_BY_TYPE.get(file.content_type, ".bin")
    filename = f"{uuid.uuid4().hex}{ext}"
    rel_dir = Path(f"{now:%Y}") / f"{now:%m}"
    abs_dir = Path(settings.upload_dir) / rel_dir
    abs_dir.mkdir(parents=True, exist_ok=True)
    (abs_dir / filename).write_bytes(data)

    url = f"{settings.upload_url_base.rstrip('/')}/{rel_dir.as_posix()}/{filename}"
    return {"url": url}
