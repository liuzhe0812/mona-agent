"""Administrator-owned custom API connections and billing choices."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal
from urllib.parse import urlsplit

from aiohttp import web
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator
from pydantic.alias_generators import to_camel

from mona.config.schema import HostedWorkConfig, HostedWorkModel, HostedWorkPrice
from mona.hosted_work.admin import CodexAdmin
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_access import model_endpoint, model_secret
from mona.hosted_work.model_policy import billing_ready, model_available

_FIELDS = frozenset({"label", "source", "api_base", "api_key_env", "model",
                     "context_window_tokens", "max_output_tokens", "reasoning_effort", "billing_mode", "billing_model", "price", "enabled"})
_PRICE_FIELDS = frozenset({"input_amount_per_million", "cached_input_amount_per_million", "output_amount_per_million"})
EndpointValidator = Callable[..., Awaitable[str]]


class ModelAdminError(WorkError):
    def __init__(self, code: str, message: str, status: int, *, field: str | None = None):
        super().__init__(code, message, status)
        self.field = field


class ModelConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str = Field(min_length=1, max_length=80)
    source: Literal["mona", "codex"] = "mona"
    api_base: str = Field(default="", max_length=4096, validate_default=True)
    api_key_env: str = Field(default="", pattern=r"^(?:MONA_WORK_MODEL_[A-Z0-9_]+)?$", validate_default=True)
    model: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    billing_mode: Literal["free", "wallet"]
    billing_model: str = Field(default="", max_length=200)
    price: HostedWorkPrice | None = None
    context_window_tokens: int | None = Field(default=None, ge=4096, le=2_000_000)
    max_output_tokens: int = Field(default=4096, ge=256, le=32768)
    reasoning_effort: str | None = Field(default=None, max_length=64)

    @field_validator("label", "api_base", "model", "reasoning_effort", "billing_model")
    @classmethod
    def _plain(cls, value: str | None) -> str | None:
        if value is not None and (value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value)):
            raise ValueError("invalid field")
        return value

    @field_validator("api_base", "api_key_env")
    @classmethod
    def _source_connection(cls, value: str, info: ValidationInfo) -> str:
        source = info.data.get("source")
        if (source == "mona" and not value) or (source == "codex" and value):
            raise ValueError("invalid provider connection")
        return value


class SaveModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    model_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    configuration: ModelConfiguration


def _ready(model: HostedWorkModel) -> bool:
    try:
        model_secret(model)
    except WorkError:
        return False
    return True


def _model_snapshot(identifier: str, model: HostedWorkModel, config: HostedWorkConfig) -> dict:
    configuration = model.model_dump(include=_FIELDS)
    configured = _ready(model) if model.source == "mona" else bool(config.operator_config_path and config.codex.cli_path)
    if model.source == "codex":
        # These legacy values are unrelated to the dedicated CLI connection.
        configuration.update(api_base="", api_key_env="")
    if not model.enabled:
        message = "此模型暂未开放。"
    elif model.source == "codex":
        message = ("当前模型已开放。" if model_available(model, config) and configured
                   else "模型连接或余额计费尚未就绪，暂不可调用。")
    elif model.billing_mode == "wallet":
        message = "共用余额计费尚未接通，暂不可调用。"
    else:
        message = "当前服务已加载凭据。" if configured else "当前服务尚未加载凭据。"
    return {"id": identifier, "configuration": configuration, "credentials": {"configured": configured},
            "availability": {"ready": model_available(model, config) and configured, "message": message}}


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
    """Share the Codex editor's revision and locks without choosing prices."""

    def __init__(self, admin: CodexAdmin, service, *, endpoint_validator: EndpointValidator | None = None):
        self.admin, self.service, self.endpoint_validator = admin, service, endpoint_validator

    def _read(self):
        data, key, revision, _ = self.admin._read()
        return data, key, revision, HostedWorkConfig.model_validate(data[key])

    def snapshot(self) -> dict:
        _, _, revision, saved = self._read()
        models = [_model_snapshot(identifier, model, self.service.config) for identifier, model in self.service.config.models.items()
                  if model.source in {"mona", "codex"}]
        return {"revision": revision, "models": models,
                "synchronized": saved.models == self.service.config.models,
                "billing": {"mode": "shared_wallet", "ready": billing_ready(self.service.config)}}

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
        if old is not None and old.source != request.configuration.source:
            raise WorkError("model_source_conflict", "此模型标识已用于其他来源，不能覆盖。", 409)
        allow_loopback = _existing_loopback(old, request.configuration.api_base)
        enabled = request.configuration.enabled if "enabled" in request.configuration.model_fields_set else old.enabled if old else False
        endpoint = None
        if request.configuration.source == "mona":
            # Closing an existing model must remain possible during an upstream
            # DNS outage. Any new or changed URL still passes the normal guard.
            if (old is not None and not enabled and old.api_base == request.configuration.api_base
                    and old.api_key_env == request.configuration.api_key_env):
                endpoint = old.api_base
            else:
                endpoint = await self._validate_endpoint(request.configuration.api_base, allow_loopback=allow_loopback)
        async with self.admin.lock:
            try:
                with FileLock(str(self.admin._scoped(self.admin.path.name + ".admin.lock")), timeout=0):
                    data, key, revision, saved = self._read()
                    if revision != request.expected_revision or saved.models != self.service.config.models:
                        raise WorkError("configuration_changed", "配置已变化，请重新加载后检查。", 409)
                    old = self.service.config.models.get(request.model_id)
                    if old is not None and old.source != request.configuration.source:
                        raise WorkError("model_source_conflict", "此模型标识已用于其他来源，不能覆盖。", 409)
                    if endpoint is not None:
                        if _origin(endpoint) is not None and not allow_loopback:
                            raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base")
                        if allow_loopback and not _existing_loopback(old, endpoint):
                            raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base")
                    self._idle()
                    values = old.model_dump() if old is not None else {"enabled": False}
                    changes = request.configuration.model_dump(exclude_unset=True)
                    if request.configuration.source == "codex":
                        # Preserve any legacy backend-only connection fields;
                        # a website request cannot set or clear them.
                        changes.pop("api_base", None)
                        changes.pop("api_key_env", None)
                    values.update(changes)
                    if endpoint is not None:
                        values["api_base"] = endpoint
                    model = HostedWorkModel.model_validate(values)
                    if model.enabled and not (old and old.enabled) and model.price is None:
                        raise ModelAdminError("price_required", "请先配置此模型的价格。", 400, field="price")
                    if model.source == "mona":
                        try:
                            model_endpoint(self.service.config, model)
                        except WorkError:
                            raise ModelAdminError("invalid_endpoint", "模型地址无效或不允许访问。", 400, field="api_base") from None
                        if not _ready(model) and (model.enabled or old is None or old.api_key_env != model.api_key_env):
                            raise ModelAdminError("credential_not_ready", "模型凭据尚未载入服务，请先完成服务器配置。", 422,
                                                  field="api_key_env")
                    data[key].setdefault("models", {})[request.model_id] = model.model_dump()
                    candidate = HostedWorkConfig.model_validate(data[key])
                    checked = self.admin.checked
                    self.admin._write_locked(data, key, revision, backup_kind="models")
                    # The service, store and executor share this config object.
                    # No await occurs between the idle check and this swap.
                    self.service.config.models = candidate.models
                    if checked and checked[0] == revision:
                        _, _, checked_revision, codex = self.admin._read()
                        self.admin.checked = (checked_revision, checked[1]) if codex == saved.codex else None
                    else:
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
                if "price" in location:
                    field = next((name for name in _PRICE_FIELDS if location[-1] in {name, to_camel(name)}), "price")
                else:
                    field = location[-1] if location and location[-1] in _FIELDS | {"model_id"} else None
                raise ModelAdminError("invalid_model", "模型配置无效，请检查填写内容。", 400, field=field) from None
            return web.json_response(await self.save(model))

        app.router.add_get("/api/work/admin/models", handle)
        app.router.add_put("/api/work/admin/models", handle)
        from mona.hosted_work.image_admin import ImageAdmin

        ImageAdmin(self).register(app)
