"""Video generation tool."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.paths import get_media_dir
from mona.config.schema import Base, ModelGenerationParameters
from mona.providers.video_generation import (
    VideoGenerationError,
    VideoGenerationProvider,
    download_video_bytes,
    get_video_gen_provider,
)
from mona.utils.artifacts import (
    ArtifactError,
    generated_video_tool_result,
    store_generated_video_artifact,
)
from mona.utils.helpers import detect_image_mime
from mona.utils.image_upload import ImageUploadError, upload_image_to_mona

if TYPE_CHECKING:
    from mona.config.schema import ProviderConfig


class VideoGenerationToolConfig(Base):
    """Video generation tool configuration."""

    enabled: bool = False
    provider: str = "agnes"
    model: str = "agnes-video-v2.0"
    default_aspect_ratio: str = "16:9"
    default_duration: int = Field(default=5, ge=1, le=18)
    model_parameters: dict[str, ModelGenerationParameters] = Field(default_factory=dict)
    save_dir: str = "generated"
    poll_interval: float = Field(default=5.0, ge=1.0, le=60.0)


@tool_parameters(
    tool_parameters_schema(
        prompt=StringSchema(
            "Detailed video generation prompt. Describe the scene, motion, camera, lighting, and style.",
            min_length=1,
        ),
        reference_images=ArraySchema(
            StringSchema(
                "General reference image for style, subject, or composition. May be an "
                "HTTP(S) URL, a local image path, or a data: URL.",
            ),
            description="Optional general references. Do not use this list to imply first/last frame order.",
        ),
        first_frame=StringSchema(
            "Optional explicit first frame image as an HTTP(S) URL, local image path, or data: URL.",
        ),
        last_frame=StringSchema(
            "Optional explicit last frame image as an HTTP(S) URL, local image path, or data: URL.",
        ),
        aspect_ratio=StringSchema(
            "Optional output aspect ratio, e.g. 16:9, 9:16, 1:1, 4:3, 3:4.",
        ),
        duration=IntegerSchema(
            description="Optional target video duration in seconds (3, 5, 10, or 18).",
            minimum=1,
            maximum=18,
        ),
        required=["prompt"],
    )
)
class VideoGenerationTool(Tool):
    """Generate persistent video artifacts through the configured video provider."""

    _scopes = {"core", "subagent"}
    config_key = "video_generation"

    @classmethod
    def config_cls(cls):
        return VideoGenerationToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.video_generation.enabled

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.video_generation,
            provider_configs=ctx.video_generation_provider_configs,
        )

    def __init__(
        self,
        *,
        workspace: str | Path,
        config: VideoGenerationToolConfig,
        provider_configs: dict[str, ProviderConfig] | None = None,
    ) -> None:
        self.workspace = Path(workspace).expanduser()
        self.config = config
        self.provider_configs = dict(provider_configs or {})

    def _active_workspace(self) -> Path:
        """Return the active session workspace (contextvar) or configured fallback."""
        ws = get_current_workspace(self.workspace)
        return ws if ws is not None else self.workspace

    @property
    def name(self) -> str:
        return "generate_video"

    @property
    def description(self) -> str:
        return (
            "Generate a video from a text prompt with optional general references and explicit first/last frames, "
            "and store it as a persistent artifact. Returns the artifact id and local path. "
            "Video generation is asynchronous and may take tens of seconds to a few minutes."
        )

    def _provider_config(self) -> ProviderConfig | None:
        return self.provider_configs.get(self.config.provider)

    def _provider_client(self) -> VideoGenerationProvider | None:
        cls = get_video_gen_provider(self.config.provider)
        if cls is None:
            return None
        provider = self._provider_config()
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
            allowed = {"seed", "steps", "cfg", "negative_prompt", "fps"}
            extra_body.update(
                {
                    name: parameters.values[name]
                    for name in parameters.enabled
                    if name in allowed and name in parameters.values
                }
            )
        return cls(
            api_key=provider.api_key if provider else None,
            api_base=api_base,
            extra_headers=provider.extra_headers if provider else None,
            extra_body=extra_body,
            poll_interval=self.config.poll_interval,
        )

    async def execute(
        self,
        prompt: str,
        reference_images: list[str] | None = None,
        first_frame: str | None = None,
        last_frame: str | None = None,
        aspect_ratio: str | None = None,
        duration: int | None = None,
        **kwargs: Any,
    ) -> str:
        client = self._provider_client()
        if client is None:
            return f"Error: unsupported video generation provider '{self.config.provider}'"

        try:
            model = self.config.model
            if not model:
                return "Error: no video model configured. Set the video model in Video settings."
            requires_public_urls = getattr(client, "provider_name", "") != "openai_compat"
            normalized_refs = await self._normalize_reference_images(
                reference_images,
                requires_public_urls=requires_public_urls,
            )
            normalized_first_frame = await self._normalize_reference_image(
                first_frame,
                requires_public_url=requires_public_urls,
            )
            normalized_last_frame = await self._normalize_reference_image(
                last_frame,
                requires_public_url=requires_public_urls,
            )
            response = await client.generate(
                prompt=prompt,
                model=model,
                reference_images=normalized_refs,
                first_frame=normalized_first_frame,
                last_frame=normalized_last_frame,
                aspect_ratio=aspect_ratio or self.config.default_aspect_ratio,
                duration=duration or self.config.default_duration,
            )
            embedded = response.raw.get("_video_bytes") if isinstance(response.raw, dict) else None
            download_kwargs: dict[str, Any] = {}
            api_base = getattr(client, "api_base", None)
            if api_base:
                download_kwargs["api_base"] = api_base
            raw = (
                embedded
                if isinstance(embedded, bytes)
                else await download_video_bytes(response.video_url, **download_kwargs)
            )
            # Store generated videos under the active session workspace so they
            # appear in the active Agent output panel for normal sessions.
            artifact_root = self._active_workspace()
            artifact = store_generated_video_artifact(
                raw,
                prompt=prompt,
                model=model,
                provider=self.config.provider,
                video_url=response.video_url,
                source_images=[
                    value
                    for value in [*(reference_images or []), first_frame, last_frame]
                    if value
                ],
                save_dir=self.config.save_dir,
                duration=response.seconds,
                size=response.size,
                artifact_root=artifact_root,
            )
            return generated_video_tool_result([artifact])
        except VideoGenerationError as exc:
            message = str(exc)
            result_url = getattr(exc, "result_url", None)
            if result_url:
                return json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "VIDEO_RESULT_UNAVAILABLE",
                            "message": message,
                            "result_url": result_url,
                            "retryable": False,
                            "next_step": (
                                "Retry downloading result_url without resubmitting "
                                "the generation request."
                            ),
                        },
                    },
                    ensure_ascii=False,
                )
            if "超时" in message or "timed out" in message.lower():
                return json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "VIDEO_GENERATION_TIMEOUT",
                            "message": (
                                "对端视频服务已终止超时任务。本回合不会自动重试，"
                                "以免重复创建耗时任务。"
                            ),
                            "detail": message,
                            "retryable": False,
                        },
                    },
                    ensure_ascii=False,
                )
            return f"Error: {exc}"
        except (ArtifactError, ImageUploadError, OSError) as exc:
            return f"Error: {exc}"

    async def _normalize_reference_images(
        self,
        refs: list[str] | None,
        *,
        requires_public_urls: bool,
    ) -> list[str] | None:
        if not refs:
            return refs
        normalized: list[str] = []
        for ref in refs:
            if not isinstance(ref, str) or not ref.strip():
                continue
            value = await self._normalize_reference_image(
                ref.strip(),
                requires_public_url=requires_public_urls,
            )
            if value:
                normalized.append(value)
        return normalized or None

    async def _normalize_reference_image(
        self,
        value: str | None,
        *,
        requires_public_url: bool,
    ) -> str | None:
        if not value:
            return None
        normalized = self._resolve_reference_image(value)
        if requires_public_url:
            return await upload_image_to_mona(normalized)
        return normalized

    def _resolve_reference_image(self, value: str) -> str:
        if value.startswith(("http://", "https://", "data:")):
            return value
        active_ws = self._active_workspace()
        raw_path = Path(value).expanduser()
        path = raw_path if raw_path.is_absolute() else active_ws / raw_path
        try:
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise VideoGenerationError(f"reference image not found: {value}") from exc
        allowed_roots = [active_ws.resolve(), get_media_dir().resolve()]
        if not any(_is_relative_to(resolved, root) for root in allowed_roots):
            raise VideoGenerationError(
                "video reference images must be inside the workspace or mona media directory"
            )
        raw = resolved.read_bytes()
        mime = detect_image_mime(raw)
        if mime is None:
            raise VideoGenerationError(f"unsupported reference image: {value}")
        encoded = base64.b64encode(raw).decode("ascii")
        return f"data:{mime};base64,{encoded}"


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
