"""Administrator configuration for free, platform-owned API models."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal
from urllib.parse import urlsplit

from aiohttp import web
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.admin import CodexAdmin
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_access import model_endpoint, model_secret

_FIELDS = frozenset({"label", "source", "api_base", "api_key_env", "model",
                     "context_window_tokens", "max_output_tokens", "reasoning_effort"})
EndpointValidator = Callable[..., Awaitable[str]]


class ModelAdminError(WorkError):
    def __init__(self, code: str, message: str, status: int, *, field: str | None = None):
        super().__init__(code, message, status)
        self.field = field


class FreeModelConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str = Field(min_length=1, max_length=80)
    source: Literal["mona"] = "mona"
    api_base: str = Field(min_length=1, max_length=4096)
    api_key_env: str = Field(pattern=r"^MONA_WORK_MODEL_[A-Z0-9_]+$")
    model: str = Field(min_length=1, max_length=200)
    context_window_tokens: int | None = Field(default=None, ge=4096, le=2_000_000)
    max_output_tokens: int = Field(default=4096, ge=256, le=32768)
    reasoning_effort: str | None = Field(default=None, max_length=64)

    @field_validator("label", "api_base", "model", "reasoning_effort")
    @classmethod
    def _plain(cls, value: str | None) -> str | None:
        if value is not None and (value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value)):
            raise ValueError("invalid field")
        return value


class SaveModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    model_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    configuration: FreeModelConfiguration


def _ready(model: HostedWorkModel) -> bool:
    try:
        model_secret(model)
    except WorkError:
        return False
    return True


def _origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        return parsed.scheme, parsed.hostname, parsed.port or 80
    except ValueError:
        return None


def _existing_loopback(model: HostedWorkModel | None, value: str) -> bool:
    if model is None or model.source != "mona":
        return False
    origin = _origin(model.api_base)
    return origin is not None and origin == _origin(value)


class ModelAdmin:
    """Share the Codex editor's revision and locks; publish only free models."""

    def __init__(self, admin: CodexAdmin, service, *, endpoint_validator: EndpointValidator | None = None):
        self.admin, self.service, self.endpoint_validator = admin, service, endpoint_validator

    def _read(self):
        data, key, revision, _ = self.admin._read()
        return data, key, revision, HostedWorkConfig.model_validate(data[key])

    def snapshot(self) -> dict:
        _, _, revision, saved = self._read()
        models = [{"id": identifier, "configuration": model.model_dump(include=_FIELDS),
                   "credentials": {"configured": _ready(model)}}
                  for identifier, model in self.service.config.models.items() if model.source == "mona"]
        return {"revision": revision, "models": models,
                "synchronized": saved.models == self.service.config.models,
                "billing": {"mode": "shared_wallet", "ready": False,
                            "prices_endpoint": "/admin/credits/model-prices", "admin_url": "/admin"}}

    def _idle(self) -> None:
        service = self.service
        if (service.store.config is not service.config
                or getattr(service.executor, "config", service.config) is not service.config):
            raise WorkError("invalid_state", "工作台配置状态无法确认，请稍后重试。", 503)
        processes = getattr(service.executor, "processes", {})
        if (service.active_users or service.active_engines or processes
                or any(not task.done() for task in service.tasks.values())
                or service.store.db.execute(
                    "SELECT 1 FROM runs WHERE status IN ('running','cancelling','unknown') LIMIT 1").fetchone()
                or service.store.db.execute(
                    "SELECT 1 FROM workspace_operations WHERE status IN ('running','unknown') LIMIT 1").fetchone()):
            raise WorkError("work_busy", "工作台仍有任务或待核对操作，请处理后再保存。", 409)

    async def _validate_endpoint(self, value: str, *, allow_loopback: bool) -> str:
        validator = self.endpoint_validator
        if validator is None:
            from mona.hosted_work.model_transport import validate_model_endpoint
            validator = validate_model_endpoint
        try:
            normalized = await validator(value, allow_loopback=allow_loopback)
        except WorkError as exc:
            if exc.status == 400:
                raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base") from None
            raise ModelAdminError("model_endpoint_unavailable", "模型地址暂时无法核验，请稍后重试。", 503,
                                  field="api_base") from None
        except (OSError, TimeoutError):
            raise ModelAdminError("model_endpoint_unavailable", "模型地址暂时无法核验，请稍后重试。", 503,
                                  field="api_base") from None
        if not isinstance(normalized, str) or not normalized:
            raise ModelAdminError("model_endpoint_unavailable", "模型地址暂时无法核验，请稍后重试。", 503,
                                  field="api_base")
        return normalized

    async def save(self, request: SaveModel) -> dict:
        _, _, revision, saved = self._read()
        if revision != request.expected_revision or saved.models != self.service.config.models:
            raise WorkError("configuration_changed", "配置已变化，请重新加载后检查。", 409)
        old = self.service.config.models.get(request.model_id)
        if old is not None and old.source != "mona":
            raise WorkError("model_source_conflict", "此模型标识已用于其他来源，不能覆盖。", 409)
        allow_loopback = _existing_loopback(old, request.configuration.api_base)
        endpoint = await self._validate_endpoint(request.configuration.api_base, allow_loopback=allow_loopback)
        async with self.admin.lock:
            try:
                with FileLock(str(self.admin._scoped(self.admin.path.name + ".admin.lock")), timeout=0):
                    data, key, revision, saved = self._read()
                    if revision != request.expected_revision or saved.models != self.service.config.models:
                        raise WorkError("configuration_changed", "配置已变化，请重新加载后检查。", 409)
                    old = self.service.config.models.get(request.model_id)
                    if old is not None and old.source != "mona":
                        raise WorkError("model_source_conflict", "此模型标识已用于其他来源，不能覆盖。", 409)
                    if _origin(endpoint) is not None and not allow_loopback:
                        raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base")
                    if allow_loopback and not _existing_loopback(old, endpoint):
                        raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base")
                    self._idle()
                    values = old.model_dump() if old is not None else {}
                    values.update(request.configuration.model_dump())
                    values["api_base"] = endpoint
                    model = HostedWorkModel.model_validate(values)
                    try:
                        model_endpoint(self.service.config, model)
                    except WorkError:
                        raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base") from None
                    if not _ready(model):
                        raise ModelAdminError("credential_not_ready", "模型凭据尚未载入服务，请先完成服务器配置。", 422,
                                              field="api_key_env")
                    data[key].setdefault("models", {})[request.model_id] = model.model_dump()
                    candidate = HostedWorkConfig.model_validate(data[key])
                    self.admin._write_locked(data, key, revision, backup_kind="models")
                    # The service, store and executor share this config object.
                    # No await occurs between the idle check and this swap.
                    self.service.config.models = candidate.models
                    self.admin.checked = None
            except Timeout as exc:
                raise WorkError("configuration_busy", "配置正在保存，请稍后重试。", 409) from exc
        return self.snapshot()

    def register(self, app: web.Application) -> None:
        async def handle(request):
            if request.method == "GET":
                return web.json_response(self.snapshot())
            if request.content_length is not None and request.content_length > 8192:
                raise WorkError("invalid_request", "配置内容过大。", 413)
            raw = bytearray()
            async for chunk in request.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise WorkError("invalid_request", "配置内容过大。", 413)
            try:
                model = SaveModel.model_validate_json(raw)
            except ValidationError as exc:
                location = exc.errors(include_input=False)[0].get("loc", ())
                field = location[-1] if location and location[-1] in _FIELDS | {"model_id"} else None
                raise ModelAdminError("invalid_model", "模型配置无效，请检查填写内容。", 400, field=field) from None
            return web.json_response(await self.save(model))

        app.router.add_get("/api/work/admin/models", handle)
        app.router.add_put("/api/work/admin/models", handle)
