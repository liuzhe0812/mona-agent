"""Read a provider's model catalog through the existing pinned HTTPS boundary."""
from __future__ import annotations

import asyncio
import hashlib
import json
import posixpath
import re
from urllib.parse import urlsplit

import httpx
from aiohttp import web
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_access import model_endpoint, model_secret
from mona.hosted_work.model_transport import HostedModelTransport, Resolver, validate_model_endpoint

MAX_BODY = 8192
MAX_RESPONSE = 2 * 1024 * 1024
MAX_MODELS = 2048
MODEL_ID = re.compile(r"[A-Za-z0-9@][A-Za-z0-9._:/@+\-]{0,199}\Z", re.ASCII)


class DiscoveryError(WorkError):
    def __init__(self, code: str, message: str, status: int, *, field: str | None = None):
        super().__init__(code, message, status)
        self.field = field


class DiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    api_base: str = Field(min_length=1, max_length=4096)
    api_key_env: str = Field(max_length=128, pattern=r"^MONA_WORK_MODEL_[A-Z0-9_]+$")


def _loopback_origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
                or parsed.username is not None or parsed.password is not None):
            return None
        return parsed.scheme, parsed.hostname, parsed.port or 80
    except ValueError:
        return None


def _existing_loopback(config: HostedWorkConfig, api_base: str, api_key_env: str) -> bool:
    origin = _loopback_origin(api_base)
    return bool(origin and any(model.source == "mona" and model.api_key_env == api_key_env
                               and _loopback_origin(model.api_base) == origin for model in config.models.values()))


def _account_gateway(config: HostedWorkConfig, endpoint: str) -> bool:
    """Match canonical origins, including explicit :443 and encoded paths."""
    try:
        target, auth = httpx.URL(endpoint), httpx.URL(config.auth_origin)
        same = (target.scheme, target.host.rstrip("."), target.port or 443) == (auth.scheme, auth.host.rstrip("."), auth.port or 443)
        path = posixpath.normpath("/" + target.path.lstrip("/"))
        if "\\" in path:
            return True
        return bool(same and any(path == prefix or path.startswith(prefix + "/")
                                 for prefix in ("/v1", "/auth", "/model-access", "/internal")))
    except (ValueError, httpx.InvalidURL):
        return False


def _invalid_endpoint() -> DiscoveryError:
    return DiscoveryError("invalid_model_endpoint", "模型接口地址无效或不允许访问。", 400, field="api_base")


def _unavailable(message: str = "暂时无法获取供应商的模型列表，请稍后重试。") -> DiscoveryError:
    return DiscoveryError("model_catalog_unavailable", message, 503)


def _parse_models(raw: bytes, *, endpoint: str, api_key_env: str, secret: str) -> dict:
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise _unavailable("供应商返回的模型列表格式不受支持。") from None
    entries = value.get("data") if isinstance(value, dict) else None
    if not isinstance(entries, list) or len(entries) > MAX_MODELS:
        raise _unavailable("供应商返回的模型列表格式不受支持或数量过多。")
    more = value.get("has_more")
    links = value.get("links")
    if ((more is not None and type(more) is not bool) or more
            or any(value.get(key) not in (None, "") for key in ("next", "next_page", "next_cursor", "next_page_token"))
            or isinstance(links, dict) and links.get("next") not in (None, "")):
        raise _unavailable("供应商返回了分页模型列表，暂时无法读取完整列表。")
    identifiers: set[str] = set()
    for entry in entries:
        identifier = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(identifier, str) or not MODEL_ID.fullmatch(identifier) or secret in identifier:
            raise _unavailable("供应商返回的模型列表包含无效标识。")
        identifiers.add(identifier)
    models = []
    for identifier in sorted(identifiers, key=lambda item: (item.casefold(), item)):
        digest = hashlib.sha256((endpoint + "\0" + api_key_env + "\0" + identifier).encode()).hexdigest()[:24]
        label = identifier if len(identifier) <= 80 else identifier[:77] + "..."
        models.append({"id": identifier, "label": label, "suggested_id": "api-" + digest})
    return {"models": models}


class ModelDiscovery:
    def __init__(self, config: HostedWorkConfig, *, resolver: Resolver | None = None,
                 inner_transport: httpx.AsyncBaseTransport | None = None):
        self.config, self.resolver, self.inner_transport = config, resolver, inner_transport

    async def discover(self, api_base: str, api_key_env: str) -> dict:
        try:
            request = DiscoveryRequest(api_base=api_base, api_key_env=api_key_env)
        except ValidationError:
            raise DiscoveryError("invalid_request", "请填写有效的模型接口地址和凭据变量名称。", 400) from None
        selected = HostedWorkModel(label="model discovery", model="discovery", api_base=request.api_base,
                                   api_key_env=request.api_key_env)
        try:
            endpoint = model_endpoint(self.config, selected)
        except WorkError:
            raise _invalid_endpoint() from None
        if _account_gateway(self.config, endpoint):
            raise _invalid_endpoint()
        allow_loopback = _existing_loopback(self.config, endpoint, request.api_key_env)
        try:
            secret = model_secret(selected)
        except WorkError:
            raise DiscoveryError("model_credentials_unavailable", "模型凭据尚未载入服务，请先完成服务器配置。",
                                 422, field="api_key_env") from None
        try:
            async with asyncio.timeout(20):
                endpoint = await validate_model_endpoint(endpoint, allow_loopback=allow_loopback, resolver=self.resolver)
                if _account_gateway(self.config, endpoint):
                    raise _invalid_endpoint()
                transport = HostedModelTransport(endpoint, allow_loopback=allow_loopback, resolver=self.resolver,
                                                 transport=self.inner_transport)
                async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                             timeout=10) as client:
                    headers = {"Authorization": "Bearer " + secret, "Accept": "application/json", "Accept-Encoding": "identity"}
                    async with client.stream("GET", endpoint + "/models", headers=headers) as response:
                        if response.status_code in {401, 403}:
                            raise DiscoveryError("model_credentials_unavailable", "供应商凭据无效或无权读取模型列表。",
                                                 422, field="api_key_env")
                        if response.status_code in {404, 405, 501}:
                            raise _unavailable("供应商未提供模型列表，请核对接口地址。")
                        if response.status_code != 200:
                            raise _unavailable()
                        if response.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
                            raise _unavailable("供应商返回的模型列表格式不受支持。")
                        length = response.headers.get("Content-Length")
                        if length and (not length.isascii() or not length.isdecimal() or int(length) > MAX_RESPONSE):
                            raise _unavailable("供应商返回的模型列表过大。")
                        content = bytearray()
                        async for chunk in response.aiter_raw():
                            if len(content) + len(chunk) > MAX_RESPONSE:
                                raise _unavailable("供应商返回的模型列表过大。")
                            content.extend(chunk)
                return _parse_models(bytes(content), endpoint=endpoint, api_key_env=request.api_key_env, secret=secret)
        except DiscoveryError:
            raise
        except WorkError as exc:
            if exc.status == 400:
                raise _invalid_endpoint() from None
            raise _unavailable() from None
        except (httpx.HTTPError, httpx.StreamError, OSError, TimeoutError, UnicodeError, ValueError):
            raise _unavailable() from None


def register_model_discovery(app: web.Application, config: HostedWorkConfig, *, resolver: Resolver | None = None,
                             inner_transport: httpx.AsyncBaseTransport | None = None) -> None:
    discovery = ModelDiscovery(config, resolver=resolver, inner_transport=inner_transport)

    async def handle(request: web.Request) -> web.Response:
        if request.content_length is not None and request.content_length > MAX_BODY:
            raise WorkError("invalid_request", "请求内容过大。", 413)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(MAX_BODY):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                raise WorkError("invalid_request", "请求内容过大。", 413)
        try:
            payload = DiscoveryRequest.model_validate_json(raw)
        except ValidationError:
            raise DiscoveryError("invalid_request", "请填写有效的模型接口地址和凭据变量名称。", 400) from None
        return web.json_response(await discovery.discover(payload.api_base, payload.api_key_env))

    app.router.add_post("/api/work/admin/models/discover", handle)
