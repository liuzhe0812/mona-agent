from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.auth import create_model_access_token
from app.config import settings
from app.credits import (
    display_amount,
    mark_request_running,
    mark_request_uncertain,
    release_request,
    reserve_request,
    settle_request,
)
from app.database import SessionLocal, get_db
from app.deps import get_current_user, get_model_access_user
from app.errors import AuthError
from app.feature_flags import managed_model_enabled
from app.media_generation import (
    create_media_request,
    media_asset_source,
    media_request_payload,
    poll_media_request,
)
from app.middleware import limiter
from app.model_billing import active_price, actual_units, effective_rate, reserve_units
from app.model_promotions import (
    active_model_promotion,
    active_model_promotions,
    aware_utc,
    discount_percent,
    promotion_label,
)
from app.models import ModelPrice, ModelPromotion, ModelRequest, ModelRequestStatus, User
from app.schemas import MediaGenerationRequest, ModelAccessTokenResponse

token_router = APIRouter(prefix="/model-access", tags=["model-access"])
proxy_router = APIRouter(prefix="/v1", tags=["model-proxy"])
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _catalog_price(
    price: ModelPrice,
    promotion: ModelPromotion | None = None,
) -> dict:
    multiplier = promotion.price_multiplier_bps if promotion else 10_000
    payload = {
        "billing_type": price.billing_type,
        "rates": {
            key: display_amount(value)
            for key, value in (price.rates_json or {}).items()
            if isinstance(value, int)
        },
    }
    if price.billing_type == "token":
        payload.update(
            {
                "input_amount_per_million": display_amount(
                    effective_rate(price.input_rate, multiplier)
                ),
                "cached_input_amount_per_million": display_amount(
                    effective_rate(price.cached_input_rate, multiplier)
                ),
                "output_amount_per_million": display_amount(
                    effective_rate(price.output_rate, multiplier)
                ),
            }
        )
        if promotion:
            payload.update(
                {
                    "original_input_amount_per_million": display_amount(price.input_rate),
                    "original_cached_input_amount_per_million": display_amount(
                        price.cached_input_rate
                    ),
                    "original_output_amount_per_million": display_amount(price.output_rate),
                    "promotion_label": promotion_label(promotion),
                    "promotion_name": "限时折扣",
                    "discount_percent": discount_percent(promotion),
                    "promotion_start_at": aware_utc(promotion.start_at),
                    "promotion_end_at": aware_utc(promotion.end_at),
                }
            )
    return payload


@token_router.post("/token", response_model=ModelAccessTokenResponse)
@limiter.limit("30/minute")
def issue_model_access_token(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del request
    if not managed_model_enabled(db) or not settings.one_api_token:
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    token, expires_in = create_model_access_token(user.id)
    return ModelAccessTokenResponse(access_token=token, expires_in=expires_in)


@token_router.get("/prices")
def list_managed_model_prices(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del user
    if not managed_model_enabled(db) or not settings.one_api_token:
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    rows = (
        db.query(ModelPrice)
        .filter(ModelPrice.enabled.is_(True))
        .order_by(ModelPrice.model, ModelPrice.version.desc())
        .all()
    )
    latest: dict[str, ModelPrice] = {}
    for price in rows:
        latest.setdefault(price.model, price)
    promotions = active_model_promotions(
        db,
        set(latest),
        now=datetime.now(timezone.utc),
    )
    return {
        "prices": [
            {"model": model, **_catalog_price(price, promotions.get(model))}
            for model, price in sorted(latest.items())
        ]
    }


@token_router.get("/catalog")
def get_managed_model_catalog(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del user
    available = managed_model_enabled(db) and bool(settings.one_api_token)
    if not available:
        return {"available": False, "models": []}
    rows = (
        db.query(ModelPrice)
        .filter(ModelPrice.enabled.is_(True))
        .order_by(ModelPrice.model, ModelPrice.version.desc())
        .all()
    )
    latest: dict[str, ModelPrice] = {}
    for price in rows:
        latest.setdefault(price.model, price)
    promotions = active_model_promotions(
        db,
        set(latest),
        now=datetime.now(timezone.utc),
    )
    return {
        "available": bool(latest),
        "models": [
            {
                "id": model,
                "name": model,
                **_catalog_price(price, promotions.get(model)),
            }
            for model, price in sorted(latest.items())
        ],
    }


@proxy_router.get("/models")
def list_managed_models(
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del user
    if not managed_model_enabled(db) or not settings.one_api_token:
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    prices = (
        db.query(ModelPrice)
        .filter(ModelPrice.enabled.is_(True))
        .order_by(ModelPrice.model, ModelPrice.version.desc())
        .all()
    )
    latest: dict[str, ModelPrice] = {}
    for price in prices:
        latest.setdefault(price.model, price)
    return {
        "object": "list",
        "data": [
            {
                "id": model,
                "object": "model",
                "owned_by": "mona",
                "billing_type": latest[model].billing_type,
            }
            for model in sorted(latest)
        ],
    }


@proxy_router.post("/media/generations", status_code=202)
@limiter.limit("30/minute")
def create_media_generation(
    request: Request,
    body: MediaGenerationRequest,
    x_request_id: str = Header(alias="X-Request-ID"),
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del request
    if not managed_model_enabled(db):
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    if not REQUEST_ID_PATTERN.fullmatch(x_request_id):
        raise AuthError("invalid_request_id", "X-Request-ID is invalid", 422)
    model_request = create_media_request(
        db,
        request_id=x_request_id,
        user_id=user.id,
        body=body,
    )
    return media_request_payload(model_request)


@proxy_router.get("/media/generations/{request_id}")
@limiter.limit("120/minute")
def get_media_generation(
    request: Request,
    request_id: str,
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del request
    if not REQUEST_ID_PATTERN.fullmatch(request_id):
        raise AuthError("media_request_not_found", "Media request not found", 404)
    model_request = poll_media_request(db, request_id=request_id, user_id=user.id)
    return media_request_payload(model_request)


async def _media_asset_stream(
    client: httpx.AsyncClient,
    response: httpx.Response,
) -> AsyncIterator[bytes]:
    try:
        async for chunk in response.aiter_bytes():
            yield chunk
    finally:
        await response.aclose()
        await client.aclose()


@proxy_router.get("/media/generations/{request_id}/assets/{asset_index}")
@limiter.limit("60/minute")
async def download_media_generation_asset(
    request: Request,
    request_id: str,
    asset_index: int,
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del request
    source_url, filename = media_asset_source(
        db,
        request_id=request_id,
        user_id=user.id,
        asset_index=asset_index,
    )
    client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15), follow_redirects=True)
    try:
        response = await client.send(client.build_request("GET", source_url), stream=True)
    except httpx.RequestError as exc:
        await client.aclose()
        raise AuthError("media_asset_unavailable", "Media asset is unavailable", 502) from exc
    if response.status_code >= 400:
        await response.aclose()
        await client.aclose()
        raise AuthError("media_asset_unavailable", "Media asset is unavailable", 502)
    media_type = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
    if not (
        media_type.startswith("image/")
        or media_type.startswith("video/")
        or media_type == "application/octet-stream"
    ):
        await response.aclose()
        await client.aclose()
        raise AuthError("media_asset_unavailable", "Media asset type is invalid", 502)
    return StreamingResponse(
        _media_asset_stream(client, response),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@proxy_router.get("/media/generations")
@limiter.limit("60/minute")
def list_media_generations(
    request: Request,
    limit: int = 20,
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del request
    safe_limit = min(max(limit, 1), 50)
    rows = (
        db.query(ModelRequest)
        .filter(
            ModelRequest.user_id == user.id,
            ModelRequest.billing_type.in_({"image", "video"}),
        )
        .order_by(ModelRequest.created_at.desc())
        .limit(safe_limit)
        .all()
    )
    return {"generations": [media_request_payload(item) for item in rows]}


def _usage(payload: dict) -> tuple[int, int, int] | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    prompt = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
    completion = usage.get("completion_tokens") or usage.get("output_tokens") or 0
    details = usage.get("prompt_tokens_details")
    cached = (
        (details.get("cached_tokens") if isinstance(details, dict) else 0)
        or usage.get("cached_tokens")
        or usage.get("cache_read_input_tokens")
        or usage.get("prompt_cache_hit_tokens")
        or 0
    )
    values = (prompt, completion, cached)
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values):
        return None
    if cached > prompt:
        return None
    if prompt > settings.model_access_max_request_bytes:
        return None
    if completion > settings.model_access_max_output_tokens:
        return None
    return prompt, completion, cached


def _request_body(body: dict, *, user_id: int) -> tuple[dict, str, int, bool]:
    if not settings.one_api_token:
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise AuthError("invalid_model", "Model is required", 422)
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AuthError("invalid_messages", "Messages are required", 422)
    encoded_size = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
    if encoded_size > settings.model_access_max_request_bytes:
        raise AuthError("request_too_large", "Model request is too large", 413)
    requested_max = body.get("max_tokens", settings.model_access_max_output_tokens)
    if isinstance(requested_max, bool) or not isinstance(requested_max, int) or requested_max <= 0:
        raise AuthError("invalid_max_tokens", "max_tokens must be positive", 422)
    max_tokens = min(requested_max, settings.model_access_max_output_tokens)
    upstream = dict(body)
    upstream["model"] = model
    upstream["max_tokens"] = max_tokens
    for unsafe_field in (
        "api_key",
        "api_base",
        "provider",
        "user_id",
        "max_completion_tokens",
        "best_of",
        "candidate_count",
        "num_beams",
    ):
        upstream.pop(unsafe_field, None)
    upstream["n"] = 1
    upstream["user"] = f"mona-{user_id}"
    stream = upstream.get("stream") is True
    upstream["stream"] = stream
    if stream:
        upstream["stream_options"] = {"include_usage": True}
    else:
        upstream.pop("stream_options", None)
    return upstream, model, max_tokens, stream


def _reserve(
    db: Session,
    *,
    request_id: str,
    user_id: int,
    body: dict,
    model: str,
    max_tokens: int,
) -> tuple[int, int]:
    existing = db.get(ModelRequest, request_id)
    if existing is not None:
        if existing.user_id != user_id:
            raise AuthError(
                "request_conflict",
                "Request ID is already in use",
                status_code=409,
            )
        raise AuthError(
            "request_already_exists",
            f"Request is already {existing.status.value}",
            status_code=409,
        )
    price = active_price(db, model)
    if price.billing_type != "token":
        raise AuthError("model_requires_media_api", "Use the managed media API", 422)
    promotion = active_model_promotion(db, model, now=datetime.now(timezone.utc))
    multiplier = promotion.price_multiplier_bps if promotion else 10_000
    units = reserve_units(
        body,
        price,
        max_output_tokens=max_tokens,
        price_multiplier_bps=multiplier,
    )
    reserve_request(
        db,
        request_id=request_id,
        user_id=user_id,
        model=model,
        reserved_units=units,
        price_version=price.version,
        promotion_id=promotion.id if promotion else None,
        price_multiplier_bps=multiplier,
        allow_existing=False,
    )
    db.commit()
    return price.version, units


def _release(request_id: str, error_code: str) -> None:
    with SessionLocal() as db:
        release_request(db, request_id=request_id, error_code=error_code)
        db.commit()


def _uncertain(request_id: str, error_code: str) -> None:
    with SessionLocal() as db:
        mark_request_uncertain(db, request_id=request_id, error_code=error_code)
        db.commit()


def _settle(request_id: str, usage: tuple[int, int, int]) -> ModelRequestStatus:
    prompt, completion, cached = usage
    with SessionLocal() as db:
        request = db.get(ModelRequest, request_id)
        price = (
            db.query(ModelPrice)
            .filter(
                ModelPrice.model == request.model,
                ModelPrice.version == request.price_version,
            )
            .one()
        )
        units = actual_units(
            price,
            prompt_tokens=prompt,
            completion_tokens=completion,
            cached_tokens=cached,
            price_multiplier_bps=request.price_multiplier_bps,
        )
        request = settle_request(
            db,
            request_id=request_id,
            actual_units=units,
            prompt_tokens=prompt,
            completion_tokens=completion,
            cached_tokens=cached,
        )
        db.commit()
        return request.status


def _upstream_headers(request_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.one_api_token}",
        "Content-Type": "application/json",
        "X-Request-ID": request_id,
    }


async def _stream_response(
    client: httpx.AsyncClient,
    response: httpx.Response,
    *,
    request_id: str,
) -> AsyncIterator[bytes]:
    usage: tuple[int, int, int] | None = None
    finalized = False
    try:
        async for line in response.aiter_lines():
            if line.startswith("data:"):
                data = line[5:].strip()
                if data and data != "[DONE]":
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        parsed = None
                    if isinstance(parsed, dict):
                        usage = _usage(parsed) or usage
            yield (line + "\n").encode()
        if usage is None:
            _uncertain(request_id, "missing_usage")
        else:
            _settle(request_id, usage)
        finalized = True
    except asyncio.CancelledError:
        _uncertain(request_id, "client_disconnected")
        finalized = True
        raise
    except Exception:
        _uncertain(request_id, "stream_failed")
        finalized = True
        raise
    finally:
        if not finalized:
            _uncertain(request_id, "stream_closed")
        await response.aclose()
        await client.aclose()


@proxy_router.post("/chat/completions")
@limiter.limit("120/minute")
async def chat_completions(
    request: Request,
    body: dict,
    x_request_id: str = Header(alias="X-Request-ID"),
    user: User = Depends(get_model_access_user),
    db: Session = Depends(get_db),
):
    del request
    if not managed_model_enabled(db) or not settings.one_api_token:
        raise AuthError("managed_model_unavailable", "Managed models are unavailable", 503)
    if not REQUEST_ID_PATTERN.fullmatch(x_request_id):
        raise AuthError("invalid_request_id", "X-Request-ID is invalid", 422)
    upstream, model, max_tokens, stream = _request_body(body, user_id=user.id)
    _reserve(
        db,
        request_id=x_request_id,
        user_id=user.id,
        body=upstream,
        model=model,
        max_tokens=max_tokens,
    )

    with SessionLocal() as request_db:
        mark_request_running(request_db, request_id=x_request_id)
        request_db.commit()

    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=15))
    try:
        request = client.build_request(
            "POST",
            f"{settings.one_api_base_url.rstrip('/')}/v1/chat/completions",
            headers=_upstream_headers(x_request_id),
            json=upstream,
        )
        response = await client.send(request, stream=stream)
    except asyncio.CancelledError:
        await client.aclose()
        _uncertain(x_request_id, "client_cancelled_before_response")
        raise
    except (httpx.ConnectError, httpx.ConnectTimeout):
        await client.aclose()
        _release(x_request_id, "upstream_unavailable")
        raise AuthError("upstream_unavailable", "Managed model is unavailable", 502)
    except Exception:
        await client.aclose()
        _uncertain(x_request_id, "upstream_delivery_uncertain")
        raise AuthError("upstream_unavailable", "Managed model request is uncertain", 502)

    if response.status_code >= 400:
        await response.aclose()
        await client.aclose()
        _release(x_request_id, f"upstream_{response.status_code}")
        return JSONResponse(
            status_code=response.status_code,
            content={"error": {"type": "upstream_error", "message": "Model request failed"}},
        )

    try:
        with SessionLocal() as request_db:
            mark_request_running(
                request_db,
                request_id=x_request_id,
                upstream_request_id=response.headers.get("x-request-id"),
            )
            request_db.commit()
    except Exception as exc:
        await response.aclose()
        await client.aclose()
        raise AuthError(
            "billing_unavailable",
            "Model billing state could not be updated",
            503,
        ) from exc

    if stream:
        return StreamingResponse(
            _stream_response(client, response, request_id=x_request_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    try:
        payload = response.json()
    except Exception:
        _uncertain(x_request_id, "invalid_upstream_response")
        raise AuthError("invalid_upstream_response", "Managed model returned invalid data", 502)
    finally:
        await response.aclose()
        await client.aclose()
    try:
        usage = _usage(payload) if isinstance(payload, dict) else None
    except (TypeError, ValueError):
        usage = None
    if usage is None:
        _uncertain(x_request_id, "missing_usage")
    else:
        _settle(x_request_id, usage)
    return JSONResponse(content=payload)
