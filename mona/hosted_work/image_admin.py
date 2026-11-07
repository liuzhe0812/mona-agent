"""Administrator-only settings for Codex image generation."""
from __future__ import annotations

from decimal import Decimal

from aiohttp import web
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.image_policy import image_ready, resolve_image_model
from mona.hosted_work.model_admin import ModelAdminError


class ImageConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    price: HostedWorkImagePrice | None


class SaveImage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    configuration: ImageConfiguration


class ImageAdmin:
    def __init__(self, models):
        self.models = models
        self.admin, self.service = models.admin, models.service

    def snapshot(self) -> dict:
        _, _, revision, saved = self.models._read()
        image = saved.image_generation
        runtime = self.service.config.image_generation
        synchronized = image == runtime
        model = resolve_image_model(self.service.config, runtime)
        ready = bool(model) and image_ready(self.service.config)
        if not synchronized:
            message = "配置尚未同步，请稍后重试。"
            ready = False
        elif not model:
            message = "请先开放一个 Codex 模型，生图暂不可用。"
        elif not runtime.enabled:
            message = "尚未启用生图。"
        elif ready:
            message = "配置已就绪，实际调用以上游结果为准。"
        else:
            message = "生图暂未就绪，请检查 Codex 连接和计费配置。"
        return {"revision": revision, "configuration": {"enabled": image.enabled,
                "price": image.price.model_dump() if image.price else None},
                "synchronized": synchronized, "availability": {"ready": ready, "message": message}}

    async def save(self, request: SaveImage) -> dict:
        _, _, revision, saved = self.models._read()
        if revision != request.expected_revision or saved.image_generation != self.service.config.image_generation:
            raise WorkError("configuration_changed", "配置已变化，请重新加载后检查。", 409)
        config = request.configuration
        if config.enabled and config.price is None:
            raise ModelAdminError("invalid_image", "请填写每张图片价格。", 400, field="price")
        mode = "free" if config.price is not None and Decimal(config.price.amount_per_image) == 0 else "wallet"
        image = HostedWorkImageSettings(enabled=config.enabled, provider="codex", model="", billing_mode=mode, price=config.price)
        async with self.admin.lock:
            try:
                with FileLock(str(self.admin._scoped(self.admin.path.name + ".admin.lock")), timeout=0):
                    data, key, revision, saved = self.models._read()
                    if revision != request.expected_revision or saved.image_generation != self.service.config.image_generation:
                        raise WorkError("configuration_changed", "配置已变化，请重新加载后检查。", 409)
                    self.models._idle()
                    section = data[key]
                    image_key = "imageGeneration" if "imageGeneration" in section else "image_generation"
                    section[image_key] = image.model_dump()
                    HostedWorkConfig.model_validate(section)
                    checked = self.admin.checked
                    self.admin._write_locked(data, key, revision, backup_kind="image")
                    self.service.config.image_generation = image
                    if checked and checked[0] == revision:
                        _, _, new_revision, codex = self.admin._read()
                        self.admin.checked = (new_revision, checked[1]) if codex == saved.codex else None
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
                model = SaveImage.model_validate_json(raw)
            except ValidationError as exc:
                location = exc.errors(include_input=False)[0].get("loc", ())
                field = "price" if "price" in location else "enabled" if "enabled" in location else None
                raise ModelAdminError("invalid_image", "生图配置无效，请检查填写内容。", 400, field=field) from None
            return web.json_response(await self.save(model))

        app.router.add_get("/api/work/admin/image", handle)
        app.router.add_put("/api/work/admin/image", handle)
