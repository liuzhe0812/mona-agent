from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.credits import (
    display_amount,
    mark_request_running,
    mark_request_uncertain,
    release_request,
    reserve_request,
    settle_request,
)
from app.database import SessionLocal
from app.errors import AuthError
from app.model_billing import (
    active_price,
    image_actual_units,
    image_reserve_units,
    video_actual_units,
    video_reserve_units,
)
from app.models import ModelPrice, ModelRequest, ModelRequestStatus
from app.schemas import MediaGenerationRequest

MEDIA_TYPES = {"image", "video"}
TERMINAL_STATUSES = {
    ModelRequestStatus.SETTLED,
    ModelRequestStatus.RELEASED,
    ModelRequestStatus.UNCERTAIN,
}


@dataclass(frozen=True)
class BailianChannel:
    channel_id: int
    base_url: str
    api_key: str


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _public_https_url(value: str) -> str:
    if len(value) > 2048:
        raise AuthError("invalid_media_url", "Media URL is too long", 422)
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise AuthError("invalid_media_url", "Media URL must use HTTPS", 422)
    return value


def _channel_database() -> sqlite3.Connection:
    path = Path(settings.one_api_database_path)
    if not path.is_absolute() or not path.is_file():
        raise AuthError("media_channel_unavailable", "Media channel is unavailable", 503)
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=3)
        connection.row_factory = sqlite3.Row
        return connection
    except sqlite3.Error as exc:
        raise AuthError("media_channel_unavailable", "Media channel is unavailable", 503) from exc


def _bailian_channel(model: str, channel_id: int | None = None) -> BailianChannel:
    connection = _channel_database()
    try:
        if channel_id is None:
            rows = connection.execute(
                "SELECT id, base_url, key, models FROM channels "
                "WHERE status = 1 ORDER BY priority DESC, id ASC"
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT id, base_url, key, models FROM channels WHERE id = ?",
                (channel_id,),
            ).fetchall()
    finally:
        connection.close()
    for row in rows:
        models = {item.strip() for item in str(row["models"] or "").split(",") if item.strip()}
        parsed = urlparse(str(row["base_url"] or ""))
        hostname = (parsed.hostname or "").lower()
        api_key = next(
            (item.strip() for item in str(row["key"] or "").splitlines() if item.strip()),
            "",
        )
        if (
            model in models
            and hostname.endswith(".maas.aliyuncs.com")
            and parsed.scheme == "https"
            and api_key
        ):
            return BailianChannel(
                channel_id=int(row["id"]),
                base_url=f"https://{hostname}",
                api_key=api_key,
            )
    raise AuthError("media_channel_unavailable", "No enabled Bailian media channel", 503)


def _request_hash(body: MediaGenerationRequest) -> str:
    encoded = json.dumps(
        body.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _image_payload(body: MediaGenerationRequest) -> tuple[dict, int]:
    size = body.size or "1024*1024"
    content = [{"image": _public_https_url(url)} for url in body.input_image_urls]
    content.append({"text": body.prompt})
    parameters: dict = {
        "size": size,
        "n": body.n,
        "watermark": body.watermark,
        "prompt_extend": True,
    }
    if body.negative_prompt:
        parameters["negative_prompt"] = body.negative_prompt
    return (
        {
            "model": body.model,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": parameters,
        },
        len(body.input_image_urls),
    )


def _video_payload(body: MediaGenerationRequest) -> dict:
    if len(body.input_image_urls) > 1:
        raise AuthError("invalid_media_input", "Video generation accepts one input image", 422)
    input_data: dict = {"prompt": body.prompt}
    if body.input_image_urls:
        input_data["img_url"] = _public_https_url(body.input_image_urls[0])
    resolution = body.resolution or "720P"
    aspect_ratio = body.aspect_ratio or "16:9"
    parameters: dict = {
        "duration": body.duration,
        "watermark": body.watermark,
        "prompt_extend": True,
    }
    if not body.input_image_urls and "-t2v" in body.model.lower():
        size_map = {
            "480P": {"16:9": "854*480", "9:16": "480*854", "1:1": "480*480"},
            "720P": {"16:9": "1280*720", "9:16": "720*1280", "1:1": "720*720"},
            "1080P": {"16:9": "1920*1080", "9:16": "1080*1920", "1:1": "1080*1080"},
        }
        parameters["size"] = size_map[resolution].get(aspect_ratio, size_map[resolution]["16:9"])
    else:
        parameters["resolution"] = resolution
        if body.model.lower().startswith("wan3"):
            parameters["ratio"] = aspect_ratio
    if body.negative_prompt:
        input_data["negative_prompt"] = body.negative_prompt
    return {"model": body.model, "input": input_data, "parameters": parameters}


def _reservation(price: ModelPrice, body: MediaGenerationRequest) -> tuple[int, dict, str]:
    if price.billing_type == "image":
        upstream, input_count = _image_payload(body)
        size = body.size or "1024*1024"
        units = image_reserve_units(
            price,
            input_count=input_count,
            output_count=body.n,
            size=size,
        )
        return units, upstream, "/api/v1/services/aigc/image-generation/generation"
    if price.billing_type == "video":
        upstream = _video_payload(body)
        units = video_reserve_units(
            price,
            resolution=body.resolution or "720P",
            duration=body.duration,
        )
        return units, upstream, "/api/v1/services/aigc/video-generation/video-synthesis"
    raise AuthError("model_not_available", "Managed media model is not available", 404)


def _request_error_code(payload: dict, fallback: str) -> str:
    output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    value = payload.get("code") or output.get("code") or fallback
    return str(value).strip()[:64] or fallback


def create_media_request(
    db: Session,
    *,
    request_id: str,
    user_id: int,
    body: MediaGenerationRequest,
) -> ModelRequest:
    digest = _request_hash(body)
    existing = db.get(ModelRequest, request_id)
    if existing is not None:
        if existing.user_id != user_id or existing.request_hash != digest:
            raise AuthError("request_conflict", "Request ID payload changed", 409)
        return existing

    price = active_price(db, body.model)
    if price.billing_type not in MEDIA_TYPES:
        raise AuthError("model_not_available", "Managed media model is not available", 404)
    channel = _bailian_channel(body.model)
    reserved_units, upstream, endpoint = _reservation(price, body)
    request = reserve_request(
        db,
        request_id=request_id,
        user_id=user_id,
        model=body.model,
        reserved_units=reserved_units,
        price_version=price.version,
        billing_type=price.billing_type,
        request_hash=digest,
        allow_existing=False,
    )
    db.commit()

    try:
        response = httpx.post(
            f"{channel.base_url}{endpoint}",
            headers={
                "Authorization": f"Bearer {channel.api_key}",
                "Content-Type": "application/json",
                "X-DashScope-Async": "enable",
            },
            json=upstream,
            timeout=20,
        )
    except httpx.RequestError as exc:
        mark_request_uncertain(db, request_id=request_id, error_code="upstream_delivery_uncertain")
        db.commit()
        raise AuthError("upstream_unavailable", "Media request delivery is uncertain", 502) from exc

    try:
        payload = response.json()
    except ValueError:
        payload = {}
    output = payload.get("output") if isinstance(payload, dict) else None
    task_id = output.get("task_id") if isinstance(output, dict) else None
    if response.status_code >= 400 or not isinstance(task_id, str) or not task_id:
        release_request(
            db,
            request_id=request_id,
            error_code=_request_error_code(payload, f"upstream_{response.status_code}"),
        )
        db.commit()
        raise AuthError("upstream_rejected", "Media generation request was rejected", 502)

    request = mark_request_running(
        db,
        request_id=request_id,
        upstream_request_id=task_id,
        upstream_channel_id=channel.channel_id,
    )
    request.last_polled_at = _utcnow()
    db.commit()
    db.refresh(request)
    return request


def _image_result(payload: dict) -> dict:
    output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    urls: list[str] = []
    for choice in output.get("choices") or []:
        message = choice.get("message") if isinstance(choice, dict) else None
        for item in (message or {}).get("content") or []:
            url = item.get("image") if isinstance(item, dict) else None
            if isinstance(url, str) and url:
                urls.append(url)
    if not urls:
        raise ValueError("image result is missing")
    return {"images": urls, "expires_at": (_utcnow() + timedelta(hours=24)).isoformat()}


def _video_result(payload: dict) -> dict:
    output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    url = output.get("video_url")
    if not isinstance(url, str) or not url:
        raise ValueError("video result is missing")
    return {"video_url": url, "expires_at": (_utcnow() + timedelta(hours=24)).isoformat()}


def poll_media_request(
    db: Session,
    *,
    request_id: str,
    user_id: int | None = None,
) -> ModelRequest:
    request = db.get(ModelRequest, request_id)
    if request is None or request.billing_type not in MEDIA_TYPES:
        raise AuthError("media_request_not_found", "Media request not found", 404)
    if user_id is not None and request.user_id != user_id:
        raise AuthError("media_request_not_found", "Media request not found", 404)
    if request.status in TERMINAL_STATUSES:
        return request
    if not request.upstream_request_id or request.upstream_channel_id is None:
        return request
    now = _utcnow()
    last_polled = request.last_polled_at
    if last_polled is not None and last_polled.tzinfo is None:
        last_polled = last_polled.replace(tzinfo=timezone.utc)
    if last_polled is not None and (now - last_polled).total_seconds() < 3:
        return request

    channel = _bailian_channel(request.model, request.upstream_channel_id)
    try:
        response = httpx.get(
            f"{channel.base_url}/api/v1/tasks/{request.upstream_request_id}",
            headers={"Authorization": f"Bearer {channel.api_key}"},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        request.last_polled_at = now
        db.commit()
        return request

    request.last_polled_at = now
    output = payload.get("output") if isinstance(payload, dict) else None
    task_status = str((output or {}).get("task_status") or "").upper()
    if task_status in {"PENDING", "RUNNING"}:
        db.commit()
        return request
    if task_status in {"FAILED", "CANCELED"}:
        request = release_request(
            db,
            request_id=request_id,
            error_code=_request_error_code(payload, f"upstream_{task_status.lower()}"),
        )
        db.commit()
        return request
    if task_status != "SUCCEEDED":
        request = mark_request_uncertain(
            db,
            request_id=request_id,
            error_code="upstream_task_unknown",
        )
        db.commit()
        return request

    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
    if usage is None:
        request = mark_request_uncertain(db, request_id=request_id, error_code="missing_usage")
        db.commit()
        return request
    price = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == request.model, ModelPrice.version == request.price_version)
        .one()
    )
    try:
        if request.billing_type == "image":
            actual_units = image_actual_units(price, usage)
            result = _image_result(payload)
            if int(usage.get("output_image_count") or 0) != len(result["images"]):
                raise ValueError("image usage does not match result count")
        else:
            actual_units = video_actual_units(price, usage)
            result = _video_result(payload)
    except (AuthError, TypeError, ValueError):
        request = mark_request_uncertain(
            db,
            request_id=request_id,
            error_code="invalid_media_usage",
        )
        db.commit()
        return request
    request = settle_request(
        db,
        request_id=request_id,
        actual_units=actual_units,
        prompt_tokens=0,
        completion_tokens=0,
        cached_tokens=0,
        usage_metadata=usage,
        result_json=result,
    )
    db.commit()
    return request


def media_request_payload(request: ModelRequest) -> dict:
    job_status = {
        ModelRequestStatus.RESERVED: "pending",
        ModelRequestStatus.RUNNING: "running",
        ModelRequestStatus.SETTLED: "succeeded",
        ModelRequestStatus.RELEASED: "failed",
        ModelRequestStatus.UNCERTAIN: "uncertain",
    }[request.status]
    return {
        "request_id": request.request_id,
        "model": request.model,
        "modality": request.billing_type,
        "status": job_status,
        "reserved_amount": display_amount(request.reserved_units),
        "spent_amount": display_amount(request.actual_units)
        if request.actual_units is not None
        else None,
        "usage": request.usage_json,
        "result": public_media_result(request),
        "error_code": request.error_code,
        "created_at": request.created_at,
        "completed_at": request.settled_at,
    }


def public_media_result(request: ModelRequest) -> dict | None:
    result = request.result_json if isinstance(request.result_json, dict) else None
    if result is None:
        return None
    expires_at = result.get("expires_at")
    if request.billing_type == "image":
        images = result.get("images") if isinstance(result.get("images"), list) else []
        return {
            "assets": [
                {
                    "index": index,
                    "url": f"/v1/media/generations/{request.request_id}/assets/{index}",
                }
                for index in range(len(images))
            ],
            "expires_at": expires_at,
        }
    if request.billing_type == "video" and isinstance(result.get("video_url"), str):
        return {
            "asset": {
                "index": 0,
                "url": f"/v1/media/generations/{request.request_id}/assets/0",
            },
            "expires_at": expires_at,
        }
    return None


def media_asset_source(
    db: Session,
    *,
    request_id: str,
    user_id: int,
    asset_index: int,
) -> tuple[str, str]:
    request = db.get(ModelRequest, request_id)
    if (
        request is None
        or request.user_id != user_id
        or request.status != ModelRequestStatus.SETTLED
        or request.billing_type not in MEDIA_TYPES
        or not isinstance(request.result_json, dict)
    ):
        raise AuthError("media_asset_not_found", "Media asset not found", 404)
    if request.billing_type == "image":
        urls = request.result_json.get("images")
        extension = "png"
    else:
        urls = [request.result_json.get("video_url")]
        extension = "mp4"
    if not isinstance(urls, list) or asset_index < 0 or asset_index >= len(urls):
        raise AuthError("media_asset_not_found", "Media asset not found", 404)
    url = urls[asset_index]
    parsed = urlparse(str(url or ""))
    if parsed.scheme != "https" or not parsed.hostname:
        raise AuthError("media_asset_not_found", "Media asset not found", 404)
    return str(url), f"{request.model}-{request.request_id[:12]}-{asset_index}.{extension}"


def poll_pending_media_requests(limit: int = 20) -> int:
    with SessionLocal() as db:
        request_ids = [
            item.request_id
            for item in db.query(ModelRequest)
            .filter(
                ModelRequest.billing_type.in_(MEDIA_TYPES),
                ModelRequest.status == ModelRequestStatus.RUNNING,
            )
            .order_by(ModelRequest.created_at)
            .limit(limit)
            .all()
        ]
    completed = 0
    for request_id in request_ids:
        with SessionLocal() as db:
            before = db.get(ModelRequest, request_id)
            if before is None or before.status in TERMINAL_STATUSES:
                continue
            after = poll_media_request(db, request_id=request_id)
            if after.status in TERMINAL_STATUSES:
                completed += 1
    return completed


def ensure_active_media_channels(db: Session) -> None:
    models = [
        item.model
        for item in db.query(ModelPrice)
        .filter(
            ModelPrice.enabled.is_(True),
            ModelPrice.billing_type.in_(MEDIA_TYPES),
        )
        .all()
    ]
    for model in models:
        _bailian_channel(model)
