"""Base interfaces for distillation tasks."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger


@dataclass
class DistillContext:
    """Runtime context passed to distill tasks."""

    workspace: Path
    memory_dir: Path
    # LLM provider for distillation prompts
    provider: Any = None
    model_name: str = ""
    # Time window (None = all history)
    since: datetime | None = None
    until: datetime | None = None


@dataclass
class DistillResult:
    """Output of a distill task."""

    task_name: str
    success: bool
    # Confidence score 0.0-1.0
    confidence: float = 0.0
    # Structured data for profile.rich.json
    data: dict[str, Any] = field(default_factory=dict)
    # Markdown content to write into USER.md section
    markdown: str = ""
    # Section heading in USER.md (e.g. "Work Patterns")
    user_section: str = ""
    error: str | None = None


class DistillTask(ABC):
    """Base class for distillation tasks. Subclasses implement collect + distill."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique task name."""
        ...

    @abstractmethod
    async def collect(self, ctx: DistillContext) -> dict[str, Any]:
        """Collect raw data from sources. Returns structured aggregates."""
        ...

    @abstractmethod
    async def distill(
        self, ctx: DistillContext, data: dict[str, Any]
    ) -> DistillResult:
        """Run LLM distillation on collected data and produce result."""
        ...

    async def run(self, ctx: DistillContext) -> DistillResult:
        """Execute full pipeline: collect → distill → write."""
        try:
            data = await self.collect(ctx)
            result = await self.distill(ctx, data)
            if result.success:
                await self.write(ctx, result)
            return result
        except Exception as e:
            logger.exception(f"[distill:{self.name}] failed")
            return DistillResult(
                task_name=self.name,
                success=False,
                error=str(e),
            )

    async def write(self, ctx: DistillContext, result: DistillResult) -> None:
        """Write result to USER.md and profile.rich.json."""
        from mona.distill.store import write_distill_result
        write_distill_result(ctx.memory_dir, result)
