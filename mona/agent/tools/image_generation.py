"""Image generation tool."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from pydantic import Field

from mona.agent.tools.base import Tool
from mona.agent.tools.path_utils import get_current_workspace
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.paths import get_media_dir
from mona.config.schema import Base, ModelGenerationParameters
from mona.providers.image_generation import (
    ImageGenerationError,
    ImageGenerationProvider,
    get_image_gen_provider,
)
from mona.utils.artifacts import (
    ArtifactError,
    generated_image_tool_result,
    store_generated_image_artifact,
)
from mona.utils.helpers import detect_image_mime

if TYPE_CHECKING:
    from mona.config.schema import ProviderConfig


class ImageGenerationToolConfig(Base):
    """Image generation tool configuration."""
    enabled: bool = False
    provider: str = "openrouter"
    model: str = "openai/gpt-5.4-image-2"
    default_aspect_ratio: str = "1:1"
    default_image_size: str = "1K"
    max_images_per_turn: int = Field(default=4, ge=1, le=8)
    model_parameters: dict[str, ModelGenerationParameters] = Field(default_factory=dict)
    save_dir: str = "generated"

_IMAGE_PARAMETERS = tool_parameters_schema(
        prompt=StringSchema(
            "Follow the active image-generation Skill before calling this tool. For an incomplete new-image "
            "request, read its matching upstream template and example reference. Submit a complete image brief "
            "in the user's language. Make the subject and task, focal placement and "
            "scale, spatial relationships, medium/material, palette and light, exact text placement "
            "or no-added-text policy, output form and targeted exclusions concrete in this prompt. "
            "Generic praise such as professional layout or high quality cannot replace these decisions. "
            "For a narrow edit, state what changes and what stays unchanged; do not redesign the image.",
            min_length=1,
        ),
        reference_images=ArraySchema(
            StringSchema("Local path of an existing image artifact or user-provided image to use as an edit reference."),
            description="Optional local image paths. Use generated artifact paths for iterative edits.",
        ),
        aspect_ratio=StringSchema(
            "Optional output aspect ratio, e.g. 1:1, 16:9, 9:16, 4:3.",
        ),
        image_size=StringSchema(
            "Optional output size hint supported by the configured provider, e.g. 1K, 2K, 4K, or 1024x1024.",
        ),
        count=IntegerSchema(
            description="Number of images to generate in this turn.",
            minimum=1,
            maximum=8,
        ),
        required=["prompt"],
)


class ImageGenerationTool(Tool):
    """Generate persistent image artifacts through the configured image provider."""

    _scopes = {"core", "subagent"}
    config_key = "image_generation"

    @classmethod
    def config_cls(cls):
        return ImageGenerationToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.image_generation.enabled

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.image_generation,
            provider_configs=ctx.image_generation_provider_configs,
        )

    def __init__(
        self,
        *,
        workspace: str | Path,
        config: ImageGenerationToolConfig,
        provider_config: ProviderConfig | None = None,
        provider_configs: dict[str, ProviderConfig] | None = None,
    ) -> None:
        self.workspace = Path(workspace).expanduser()
        self.config = config
        self.provider_configs = dict(provider_configs or {})
        if provider_config is not None and "openrouter" not in self.provider_configs:
            self.provider_configs["openrouter"] = provider_config

    def _active_workspace(self) -> Path:
        """Return the active session workspace (contextvar) or configured fallback."""
        ws = get_current_workspace(self.workspace)
        return ws if ws is not None else self.workspace

    @property
    def name(self) -> str:
        return "generate_image"

    @property
    def description(self) -> str:
        return (
            "Generate or edit images and store them as persistent artifacts. "
            "Returns artifact ids and local paths. For edits, pass prior generated image paths "
            "or user image paths as reference_images. Optional image_size and aspect_ratio "
            "override the user's defaults for this call only. Common sizes are presets, "
            "not a guarantee of provider support. A successful returned image is ready to use: "
            "do not check its dimensions against the request or generate again to correct them. "
            "If retry_safe is false, do not resubmit an uncertain or failed generation. "
            f"Current defaults: image_size={self.config.default_image_size}, "
            f"aspect_ratio={self.config.default_aspect_ratio}."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        from copy import deepcopy

        schema = deepcopy(_IMAGE_PARAMETERS)
        props = schema["properties"]
        props["image_size"]["description"] = (
            "Optional per-call resolution override, e.g. 1K, 2K, 4K or WIDTHxHEIGHT. "
            f"Omit to use the user's default {self.config.default_image_size}. "
            "The provider decides which sizes it accepts; use returned alternatives on a size rejection."
        )
        props["aspect_ratio"]["description"] = (
            f"Optional per-call aspect ratio; default {self.config.default_aspect_ratio}. "
            "Explicit pixel dimensions already define their ratio."
        )
        props["count"]["maximum"] = self.config.max_images_per_turn
        return schema

    def _provider_config(self) -> ProviderConfig | None:
        return self.provider_configs.get(self.config.provider)

    def _provider_client(self) -> ImageGenerationProvider | None:
        provider = self._provider_config()
        cls = get_image_gen_provider(self.config.provider)
        if cls is None:
            return None
        # Resolve api_base: prefer the provider's explicit api_base, then
        # fall back to the ProviderSpec's default_api_base so gateways like
        # Agnes AI work even when the user didn't manually fill api_base.
        api_base = provider.api_base if provider else None
        if not api_base:
            from mona.providers.registry import find_by_name as _find_spec
            spec = _find_spec(self.config.provider)
            if spec and spec.default_api_base:
                api_base = spec.default_api_base
        extra_body = dict(provider.extra_body or {}) if provider else {}
        parameters = self.config.model_parameters.get(self.config.model)
        from mona.providers.registry import is_custom_provider_name

        if parameters and is_custom_provider_name(self.config.provider):
            allowed = {"seed", "steps", "cfg", "negative_prompt"}
            extra_body.update(
                {
                    name: parameters.values[name]
                    for name in parameters.enabled
                    if name in allowed and name in parameters.values
                }
            )
        kwargs = {
            "api_key": provider.api_key if provider else None,
            "api_base": api_base,
            "extra_headers": provider.extra_headers if provider else None,
            "extra_body": extra_body,
        }
        return cls(**kwargs)

    def _output_parameters(self, image_size: str | None, aspect_ratio: str | None) -> tuple[str | None, str | None]:
        size = (image_size or self.config.default_image_size).strip().replace("×", "x").replace("X", "x")
        ratio = (aspect_ratio or self.config.default_aspect_ratio).strip()
        if size and not re.fullmatch(r"(?:[1-9][0-9]{0,4}x[1-9][0-9]{0,4}|(?:0\.5|[1-9][0-9]?)[kK]|auto)", size):
            raise ImageGenerationError("分辨率格式无效，请使用 1K、2K、4K 或宽x高。", code="INVALID_IMAGE_SIZE", retry_safe=True)
        if ratio and not re.fullmatch(r"[1-9][0-9]?(?:\.[0-9]+)?:[1-9][0-9]?(?:\.[0-9]+)?", ratio):
            raise ImageGenerationError("画面比例格式无效，例如 16:9。", code="INVALID_IMAGE_SIZE", retry_safe=True)
        if "x" in size:
            width, height = (int(part) for part in size.split("x"))
            if width > 65536 or height > 65536:
                raise ImageGenerationError("图片宽高超出可接受范围。", code="INVALID_IMAGE_SIZE", retry_safe=True)
            if aspect_ratio:
                left, right = (float(part) for part in ratio.split(":"))
                if not math.isclose(width / height, left / right, rel_tol=0.001):
                    if image_size:
                        raise ImageGenerationError("本次指定的像素尺寸与画面比例冲突，请调整其中一项。", code="INVALID_IMAGE_SIZE", retry_safe=True)
                    # An explicitly requested aspect takes priority over a conflicting default canvas.
                    return None, ratio
            return size, None
        if size.lower().endswith("k"):
            size = size.upper()
        return size or None, ratio or None

    def _resolve_reference_image(self, value: str) -> str:
        active_ws = self._active_workspace()
        raw_path = Path(value).expanduser()
        path = raw_path if raw_path.is_absolute() else active_ws / raw_path
        try:
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise ImageGenerationError(f"reference image not found: {value}") from exc

        allowed_roots = [active_ws.resolve(), get_media_dir().resolve()]
        if not any(_is_relative_to(resolved, root) for root in allowed_roots):
            raise ImageGenerationError(
                "reference_images must be inside the workspace or mona media directory"
            )
        if not resolved.is_file():
            raise ImageGenerationError(f"reference image is not a file: {value}")
        raw = resolved.read_bytes()
        if detect_image_mime(raw) is None:
            raise ImageGenerationError(f"unsupported reference image: {value}")
        return str(resolved)

    def _resolve_reference_images(self, values: list[str] | None) -> list[str]:
        if not values:
            return []
        return [self._resolve_reference_image(value) for value in values if value]

    async def execute(
        self,
        prompt: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
        count: int | None = None,
        **kwargs: Any,
    ) -> str:
        requested = count or 1
        if count is not None and (isinstance(count, bool) or count < 1):
            return "Error: count must be a positive integer"
        if requested > self.config.max_images_per_turn:
            return (
                "Error: count exceeds tools.imageGeneration.maxImagesPerTurn "
                f"({self.config.max_images_per_turn})"
            )

        artifacts: list[dict[str, Any]] = []
        try:
            effective_size, effective_ratio = self._output_parameters(image_size, aspect_ratio)
            client = self._provider_client()
            if client is None:
                return f"Error: unsupported image generation provider '{self.config.provider}'"
            refs = self._resolve_reference_images(reference_images)
            # Use the image-specific model from image_generation config.
            # Do not fall back to the provider's chat model — image generation
            # needs a dedicated image model, and chat models cannot generate
            # images. The image model is selected in Image settings.
            model = self.config.model
            if not model:
                return "Error: no image model configured. Set the image model in Image settings."
            # Store generated images under the active session workspace so they
            # appear in the active Agent output panel for normal sessions.
            artifact_root = self._active_workspace()
            while len(artifacts) < requested:
                response = await client.generate(
                    prompt=prompt,
                    model=model,
                    reference_images=refs,
                    aspect_ratio=effective_ratio,
                    image_size=effective_size,
                )
                if not response.images:
                    raise ImageGenerationError("模型服务未返回图片")
                for image_data_url in response.images:
                    artifact = store_generated_image_artifact(
                        image_data_url,
                        prompt=prompt,
                        model=model,
                        source_images=refs,
                        save_dir=self.config.save_dir,
                        provider=self.config.provider,
                        artifact_root=artifact_root,
                        requested_size=effective_size,
                        requested_aspect_ratio=effective_ratio,
                    )
                    artifacts.append(artifact)
                    if len(artifacts) >= requested:
                        break
            return generated_image_tool_result(artifacts)
        except (ArtifactError, ImageGenerationError, OSError) as exc:
            code = getattr(exc, "code", None)
            supported_sizes = getattr(exc, "supported_sizes", [])
            if code or artifacts:
                return json.dumps({
                    "ok": False, "code": code or "IMAGE_GENERATION_FAILED", "message": str(exc),
                    "supported_sizes": supported_sizes,
                    "retry_safe": getattr(exc, "retry_safe", False), "artifacts": artifacts,
                    "next_step": "Keep completed artifacts. Do not automatically resubmit when retry_safe is false. Respect the user's exact size requirements.",
                }, ensure_ascii=False)
            return f"Error: {exc}"
        except (httpx.HTTPError, ValueError) as exc:
            return json.dumps({
                "ok": False, "code": "IMAGE_RESULT_UNAVAILABLE", "retry_safe": False,
                "message": "无法读取生成结果；任务可能已执行，请勿自动重新提交。",
                "artifacts": artifacts,
                "error_type": type(exc).__name__,
            }, ensure_ascii=False)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
