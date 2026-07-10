"""Video generation tool."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.schema import Base
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

if TYPE_CHECKING:
    from mona.config.schema import ProviderConfig


class VideoGenerationToolConfig(Base):
    """Video generation tool configuration."""

    enabled: bool = False
    provider: str = "agnes"
    model: str = "agnes-video-v2.0"
    default_aspect_ratio: str = "16:9"
    default_duration: int = Field(default=5, ge=1, le=18)
    save_dir: str = "generated"
    poll_interval: float = Field(default=5.0, ge=1.0, le=60.0)
    poll_timeout: float = Field(default=600.0, ge=30.0, le=1800.0)


@tool_parameters(
    tool_parameters_schema(
        prompt=StringSchema(
            "Detailed video generation prompt. Describe the scene, motion, camera, lighting, and style.",
            min_length=1,
        ),
        reference_images=ArraySchema(
            StringSchema("Image URL for image-to-video generation. Only HTTP(S) URLs are supported."),
            description="Optional image URLs to drive image-to-video generation.",
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

    @property
    def name(self) -> str:
        return "generate_video"

    @property
    def description(self) -> str:
        return (
            "Generate a video from a text prompt (or an image URL for image-to-video) "
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
        return cls(
            api_key=provider.api_key if provider else None,
            api_base=api_base,
            extra_headers=provider.extra_headers if provider else None,
            extra_body=provider.extra_body if provider else None,
            poll_interval=self.config.poll_interval,
            poll_timeout=self.config.poll_timeout,
        )

    async def execute(
        self,
        prompt: str,
        reference_images: list[str] | None = None,
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
            response = await client.generate(
                prompt=prompt,
                model=model,
                reference_images=reference_images,
                aspect_ratio=aspect_ratio or self.config.default_aspect_ratio,
                duration=duration or self.config.default_duration,
            )
            raw = await download_video_bytes(response.video_url)
            artifact = store_generated_video_artifact(
                raw,
                prompt=prompt,
                model=model,
                provider=self.config.provider,
                video_url=response.video_url,
                source_images=reference_images,
                save_dir=self.config.save_dir,
                duration=response.seconds,
                size=response.size,
            )
            return generated_video_tool_result([artifact])
        except (ArtifactError, VideoGenerationError, OSError) as exc:
            return f"Error: {exc}"
