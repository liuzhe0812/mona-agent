from __future__ import annotations

import ipaddress
import re
import socket
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Query

from app.config import settings
from app.errors import AuthError
from app.model_billing import IMAGE_RATE_KEYS, VIDEO_RATE_KEYS
from app.models import User
from app.routers.admin_router import require_admin
from app.schemas import AdminGatewayChannelRequest, AdminGatewayModelDiscoveryRequest

router = APIRouter(prefix="/admin/gateway", tags=["admin-gateway"])
ALLOWED_CHANNEL_TYPES = {8, 17, 36, 44}
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._:/-]+$")
DEFAULT_MODEL_BASE_URLS = {
    17: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    36: "https://api.deepseek.com",
    44: "https://api.siliconflow.cn/v1",
}
MODEL_HOST_SUFFIXES = {
    8: ("api.openai.com",),
    17: ("dashscope.aliyuncs.com", "maas.aliyuncs.com"),
    36: ("deepseek.com",),
    44: ("siliconflow.cn",),
}


def _one_api_request(
    method: str,
    path: str,
    *,
    params: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not settings.one_api_admin_token:
        raise AuthError("gateway_admin_unavailable", "One API admin access is not configured", 503)
    try:
        response = httpx.request(
            method,
            f"{settings.one_api_base_url.rstrip('/')}{path}",
            params=params,
            json=payload,
            headers={"Authorization": settings.one_api_admin_token},
            timeout=10,
        )
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise AuthError("gateway_unavailable", "One API is unavailable", 503) from exc
    if not isinstance(body, dict) or body.get("success") is not True:
        detail = ""
        if isinstance(body, dict):
            for key in ("message", "detail", "error"):
                value = body.get(key)
                if isinstance(value, dict):
                    value = value.get("message") or value.get("detail")
                if isinstance(value, str) and value.strip():
                    detail = " ".join(value.strip().split())[:500]
                    break
        raise AuthError(
            "gateway_rejected",
            f"One API：{detail}" if detail else "One API rejected the operation",
            502,
        )
    return body


def _normalize_models(raw: str) -> str:
    models = list(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    if not models or any(MODEL_PATTERN.fullmatch(model) is None for model in models):
        raise AuthError("invalid_models", "Model list is invalid", 422)
    return ",".join(models)


def _is_bailian_compatible_base(base_url: str) -> bool:
    parsed = urlparse(base_url.strip())
    hostname = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")
    return bool(
        hostname
        and (
            hostname == "coding.dashscope.aliyuncs.com"
            or hostname.endswith(".maas.aliyuncs.com")
        )
        and (
            not path
            or path.endswith("/compatible-mode")
            or path.endswith("/compatible-mode/v1")
            or path.endswith("/v1")
        )
    )


def _one_api_channel_type(channel_type: int, base_url: str) -> int:
    if channel_type == 17 and _is_bailian_compatible_base(base_url):
        return 8
    return channel_type


def _one_api_base_url(channel_type: int, base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if channel_type == 17 and normalized.endswith("/compatible-mode/v1"):
        return normalized[: -len("/v1")]
    return normalized


def _public_base_url(item: dict[str, Any]) -> str:
    base_url = str(item.get("base_url") or "").rstrip("/")
    if (
        int(item.get("type", 0)) == 8
        and _is_bailian_compatible_base(base_url)
        and base_url.endswith("/compatible-mode")
    ):
        return f"{base_url}/v1"
    return base_url


def _public_channel_type(item: dict[str, Any]) -> int:
    stored_type = int(item.get("type", 0))
    if stored_type == 8 and _is_bailian_compatible_base(str(item.get("base_url") or "")):
        return 17
    return stored_type


def _is_public_host(hostname: str) -> bool:
    try:
        addresses = {ipaddress.ip_address(hostname)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
            }
        except (OSError, ValueError):
            return False
    return bool(addresses) and all(address.is_global for address in addresses)


def _model_catalog_url(channel_type: int, base_url: str) -> str:
    base = base_url.strip() or DEFAULT_MODEL_BASE_URLS.get(channel_type, "")
    parsed = urlparse(base)
    hostname = (parsed.hostname or "").lower()
    allowed_suffixes = MODEL_HOST_SUFFIXES.get(channel_type, ())
    known_provider_host = any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffixes in MODEL_HOST_SUFFIXES.values()
        for suffix in suffixes
    )
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username
        or parsed.password
        or (
            not known_provider_host
            and not (
                channel_type == 8
                and _is_public_host(hostname)
            )
        )
        or (
            channel_type != 8
            and not any(
                hostname == suffix or hostname.endswith(f".{suffix}")
                for suffix in allowed_suffixes
            )
        )
    ):
        raise AuthError(
            "model_discovery_not_supported",
            "当前 API Base 不支持自动获取模型，请手动添加模型 ID",
            422,
        )
    base = base.rstrip("/")
    if base.endswith("/models"):
        return base
    if "/compatible-mode" in parsed.path:
        return f"{base}/models"
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return f"{base}/v1/models"


def _model_ids(payload: Any) -> list[str]:
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list) and isinstance(payload, dict):
        rows = payload.get("models")
    if not isinstance(rows, list):
        return []
    models: list[str] = []
    for row in rows:
        model = row.get("id") if isinstance(row, dict) else row
        if isinstance(model, str) and MODEL_PATTERN.fullmatch(model) and model not in models:
            models.append(model)
    return models


def _media_model_hint(model: str) -> bool:
    normalized = model.lower()
    return "image" in normalized or bool(
        re.search(r"(^|[-_/])(t2v|i2v|video)([-_/]|$)", normalized)
    )


def _stored_channel_key(channel_id: int) -> str:
    database_path = Path(settings.one_api_database_path)
    if not database_path.is_absolute() or not database_path.is_file():
        raise AuthError(
            "gateway_key_unavailable",
            "无法复用已保存的 API Key，请重新输入",
            503,
        )
    try:
        connection = sqlite3.connect(
            f"file:{database_path.as_posix()}?mode=ro",
            uri=True,
            timeout=3,
        )
        try:
            row = connection.execute(
                "SELECT key FROM channels WHERE id = ?",
                (channel_id,),
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise AuthError(
            "gateway_key_unavailable",
            "无法复用已保存的 API Key，请重新输入",
            503,
        ) from exc
    if not row:
        raise AuthError("channel_not_found", "Channel not found", 404)
    api_key = next(
        (item.strip() for item in str(row[0] or "").splitlines() if item.strip()),
        "",
    )
    if not api_key:
        raise AuthError("api_key_required", "请重新输入 API Key", 422)
    return api_key


def _bailian_catalog_url(base_url: str) -> str:
    parsed = urlparse(base_url.strip())
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not hostname or parsed.username or parsed.password:
        raise AuthError("official_price_unavailable", "该渠道无法查询官方价格", 422)
    if hostname == "coding.dashscope.aliyuncs.com":
        raise AuthError(
            "coding_plan_pricing_unavailable",
            "Coding Plan 按调用次数结算，不提供 Token 官方价格",
            422,
        )
    allowed = (
        hostname.endswith(".maas.aliyuncs.com")
        or hostname == "dashscope-intl.aliyuncs.com"
        or hostname == "cn-hongkong.dashscope.aliyuncs.com"
    )
    if not allowed:
        raise AuthError(
            "official_price_unavailable",
            "请使用包含 Workspace ID 的百炼通用 API Base",
            422,
        )
    return f"https://{hostname}/api/v1/models"


def _price_kind(item: dict[str, Any]) -> str | None:
    price_type = str(item.get("type") or "").strip().lower()
    price_name = str(item.get("price_name") or "").strip().lower()
    marker = f"{price_type} {price_name}"
    if price_type in {"cache_input_token", "input_token_cache"} or (
        ("缓存命中" in price_name and "显式" not in price_name)
        or ("cache" in price_name and "hit" in price_name and "explicit" not in price_name)
    ):
        return "cached_input"
    if "cache" in marker or "缓存" in marker:
        return None
    if "input" in marker or "输入" in marker:
        return "input"
    if "output" in marker or "输出" in marker:
        return "output"
    return None


def _price_amount(item: dict[str, Any]) -> Decimal | None:
    try:
        value = Decimal(str(item.get("price")))
    except (InvalidOperation, TypeError):
        return None
    return value if value >= 0 else None


def _billing_type_for_unit(unit: str) -> str | None:
    normalized = unit.lower()
    if "百万" in normalized or "million" in normalized:
        return "token"
    if "张" in normalized or "image" in normalized:
        return "image"
    if "秒" in normalized or "second" in normalized:
        return "video"
    return None


def _official_price_payload(model_item: dict[str, Any]) -> dict[str, Any]:
    raw_entries: list[tuple[str, dict[str, Any], str]] = []
    for raw_tier in model_item.get("prices") or []:
        if not isinstance(raw_tier, dict):
            continue
        range_name = str(raw_tier.get("range_name") or "Default")
        for raw_price in raw_tier.get("prices") or []:
            if not isinstance(raw_price, dict):
                continue
            billing_type = _billing_type_for_unit(str(raw_price.get("price_unit") or ""))
            if billing_type and _price_amount(raw_price) is not None:
                raw_entries.append((range_name, raw_price, billing_type))
    billing_types = {entry[2] for entry in raw_entries}
    if not billing_types:
        raise AuthError("official_price_missing", "官方目录未返回可识别的模型价格", 502)
    if "token" in billing_types:
        billing_type = "token"
    elif len(billing_types) == 1:
        billing_type = next(iter(billing_types))
    else:
        raise AuthError("official_price_missing", "官方目录返回了混合计费单位", 502)

    if billing_type in {"image", "video"}:
        allowed_keys = IMAGE_RATE_KEYS if billing_type == "image" else VIDEO_RATE_KEYS
        price_items: list[dict[str, str]] = []
        for range_name, raw_price, entry_type in raw_entries:
            rate_key = str(raw_price.get("type") or "")
            amount = _price_amount(raw_price)
            if entry_type != billing_type or rate_key not in allowed_keys or amount is None:
                continue
            price_items.append(
                {
                    "key": rate_key,
                    "label": str(raw_price.get("price_name") or rate_key),
                    "amount": str(amount),
                    "unit": str(raw_price.get("price_unit") or ""),
                    "range_name": range_name,
                }
            )
        if not price_items:
            raise AuthError("official_price_missing", "官方目录未返回支持的媒体价格", 502)
        return {
            "model": str(model_item.get("model") or ""),
            "billing_type": billing_type,
            "price_items": price_items,
            "tiers": [],
            "safe_cost": {},
            "context_window": None,
        }

    tiers: list[dict[str, Any]] = []
    safe_cost: dict[str, Decimal] = {}
    for raw_tier in model_item.get("prices") or []:
        if not isinstance(raw_tier, dict):
            continue
        amounts: dict[str, Decimal] = {}
        for raw_price in raw_tier.get("prices") or []:
            if not isinstance(raw_price, dict):
                continue
            kind = _price_kind(raw_price)
            amount = _price_amount(raw_price)
            if kind and amount is not None:
                amounts[kind] = max(amounts.get(kind, Decimal("0")), amount)
                safe_cost[kind] = max(safe_cost.get(kind, Decimal("0")), amount)
        if amounts:
            tiers.append(
                {
                    "range_name": str(raw_tier.get("range_name") or "Default"),
                    **{f"{kind}_amount": str(value) for kind, value in amounts.items()},
                }
            )
    if "input" not in safe_cost or "output" not in safe_cost:
        raise AuthError("official_price_missing", "官方目录未返回文本模型价格", 502)
    if "cached_input" not in safe_cost:
        safe_cost["cached_input"] = safe_cost["input"]
    model_info = model_item.get("model_info")
    return {
        "model": str(model_item.get("model") or ""),
        "billing_type": "token",
        "price_items": [],
        "tiers": tiers,
        "safe_cost": {
            "input_amount_per_million": str(safe_cost["input"]),
            "cached_input_amount_per_million": str(safe_cost["cached_input"]),
            "output_amount_per_million": str(safe_cost["output"]),
        },
        "context_window": model_info.get("context_window")
        if isinstance(model_info, dict)
        else None,
    }


def _channel_payload(body: AdminGatewayChannelRequest, *, channel_id: int | None = None) -> dict:
    if body.channel_type not in ALLOWED_CHANNEL_TYPES:
        raise AuthError("invalid_channel_type", "Channel type is not supported", 422)
    base_url = body.base_url.strip()
    if base_url:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise AuthError("invalid_base_url", "Channel base URL must be HTTPS", 422)
    elif body.channel_type == 8:
        raise AuthError("invalid_base_url", "Custom channels require an HTTPS base URL", 422)
    payload = {
        "type": _one_api_channel_type(body.channel_type, base_url),
        "key": body.api_key or "",
        "status": 1 if body.enabled else 2,
        "name": body.name.strip(),
        "base_url": _one_api_base_url(body.channel_type, base_url),
        "models": _normalize_models(body.models),
        "group": body.group,
        "priority": body.priority,
    }
    if channel_id is not None:
        payload["id"] = channel_id
    return payload


def _public_channel(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(item.get("id", 0)),
        "name": str(item.get("name") or ""),
        "channel_type": _public_channel_type(item),
        "enabled": item.get("status") == 1,
        "status": int(item.get("status", 0)),
        "base_url": _public_base_url(item),
        "models": str(item.get("models") or ""),
        "group": str(item.get("group") or "default"),
        "priority": int(item.get("priority") or 0),
        "response_time": int(item.get("response_time") or 0),
        "test_time": int(item.get("test_time") or 0),
        "key_configured": True,
    }


@router.get("/channels")
def list_channels(_admin: User = Depends(require_admin)):
    data = _one_api_request(
        "GET",
        "/api/channel/search",
        params={"keyword": ""},
    ).get("data")
    channels = data if isinstance(data, list) else []
    return {"channels": [_public_channel(item) for item in channels if isinstance(item, dict)]}


@router.post("/channels/models")
def discover_channel_models(
    body: AdminGatewayModelDiscoveryRequest,
    _admin: User = Depends(require_admin),
):
    channel_type = body.channel_type
    base_url = body.base_url
    api_key = body.api_key
    if body.channel_id is not None and not api_key:
        channel = _one_api_request("GET", f"/api/channel/{body.channel_id}").get("data")
        if not isinstance(channel, dict):
            raise AuthError("channel_not_found", "Channel not found", 404)
        stored_raw_type = int(channel.get("type") or channel_type)
        stored_type = _public_channel_type(channel)
        stored_base_url = _public_base_url(channel)
        requested_base_url = base_url.strip() or stored_base_url
        if (
            channel_type not in {stored_type, stored_raw_type}
            or requested_base_url.rstrip("/") != stored_base_url.rstrip("/")
        ):
            raise AuthError(
                "api_key_required",
                "更换供应商或 API Base 后，请输入新的 API Key",
                422,
            )
        channel_type = stored_type
        base_url = stored_base_url
        api_key = _stored_channel_key(body.channel_id)
    if not api_key:
        raise AuthError("api_key_required", "请先填写 API Key", 422)

    try:
        response = httpx.get(
            _model_catalog_url(channel_type, base_url),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=12,
            follow_redirects=False,
        )
        response.raise_for_status()
        models = _model_ids(response.json())
    except (httpx.HTTPError, ValueError) as exc:
        raise AuthError("model_discovery_failed", "模型列表获取失败，请检查 API Key 和 API Base", 502) from exc
    if not models:
        raise AuthError("model_discovery_empty", "供应商没有返回可选择的模型", 502)
    return {"models": models}


@router.get("/channels/{channel_id}/official-price")
def get_channel_official_price(
    channel_id: int,
    model: str = Query(min_length=1, max_length=128),
    _admin: User = Depends(require_admin),
):
    if channel_id <= 0 or MODEL_PATTERN.fullmatch(model) is None:
        raise AuthError("invalid_model", "模型 ID 不合法", 422)
    channel = _one_api_request("GET", f"/api/channel/{channel_id}").get("data")
    if not isinstance(channel, dict):
        raise AuthError("channel_not_found", "Channel not found", 404)
    api_key = _stored_channel_key(channel_id)
    try:
        response = httpx.get(
            _bailian_catalog_url(str(channel.get("base_url") or "")),
            params={"model": model, "language": "zh-CN", "page_no": 1, "page_size": 20},
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=12,
            follow_redirects=False,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise AuthError(
            "official_price_fetch_failed",
            "官方价格获取失败，请检查百炼通用 API 渠道",
            502,
        ) from exc
    models = (payload.get("output") or {}).get("models") if isinstance(payload, dict) else None
    model_item = next(
        (
            item
            for item in models or []
            if isinstance(item, dict) and item.get("model") == model
        ),
        None,
    )
    if model_item is None:
        raise AuthError("official_price_missing", "官方目录中没有该模型价格", 404)
    result = _official_price_payload(model_item)
    return {
        **result,
        "channel_id": channel_id,
        "channel_name": str(channel.get("name") or ""),
        "source": "阿里云百炼官方模型目录",
        "synced_at": datetime.now(timezone.utc),
    }


@router.post("/channels")
def create_channel(
    body: AdminGatewayChannelRequest,
    _admin: User = Depends(require_admin),
):
    if not body.api_key:
        raise AuthError("api_key_required", "API key is required for a new channel", 422)
    _one_api_request("POST", "/api/channel/", payload=_channel_payload(body))
    return {"created": True}


@router.put("/channels/{channel_id}")
def update_channel(
    channel_id: int,
    body: AdminGatewayChannelRequest,
    _admin: User = Depends(require_admin),
):
    if channel_id <= 0:
        raise AuthError("channel_not_found", "Channel not found", 404)
    _one_api_request(
        "PUT",
        "/api/channel/",
        payload=_channel_payload(body, channel_id=channel_id),
    )
    return {"channel_id": channel_id, "updated": True}


@router.post("/channels/{channel_id}/test")
def test_channel(
    channel_id: int,
    model: str | None = Query(default=None, min_length=1, max_length=128),
    _admin: User = Depends(require_admin),
):
    if channel_id <= 0:
        raise AuthError("channel_not_found", "Channel not found", 404)
    channel = _one_api_request("GET", f"/api/channel/{channel_id}").get("data")
    if not isinstance(channel, dict):
        raise AuthError("channel_not_found", "Channel not found", 404)
    selected_model = (model or "").strip()
    if selected_model and MODEL_PATTERN.fullmatch(selected_model) is None:
        raise AuthError("invalid_model", "Model ID is invalid", 422)
    if not selected_model:
        models = str(channel.get("models") or "")
        selected_model = next((item.strip() for item in models.split(",") if item.strip()), "")
    if selected_model and _media_model_hint(selected_model):
        api_key = _stored_channel_key(channel_id)
        try:
            response = httpx.get(
                _model_catalog_url(_public_channel_type(channel), _public_base_url(channel)),
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=12,
                follow_redirects=False,
            )
            response.raise_for_status()
            if selected_model not in _model_ids(response.json()):
                raise AuthError("gateway_rejected", "百炼目录中没有该媒体模型", 502)
        except AuthError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise AuthError("gateway_rejected", "百炼媒体模型目录检查失败", 502) from exc
        return {"channel_id": channel_id, "healthy": True, "test_mode": "catalog"}
    params = {"model": selected_model} if selected_model else None
    _one_api_request("GET", f"/api/channel/test/{channel_id}", params=params)
    return {"channel_id": channel_id, "healthy": True}


@router.delete("/channels/{channel_id}")
def delete_channel(channel_id: int, _admin: User = Depends(require_admin)):
    if channel_id <= 0:
        raise AuthError("channel_not_found", "Channel not found", 404)
    _one_api_request("DELETE", f"/api/channel/{channel_id}")
    return {"channel_id": channel_id, "deleted": True}
