"""Distillation service — orchestrates distill tasks and cron registration.

Tasks run on a weekly schedule (Sunday 03:00 local time).
Each task is independent and idempotent.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from mona.distill.base import DistillContext, DistillResult
from mona.distill.tasks.work_pattern import WorkPatternTask
from mona.distill.tasks.profile import ProfileTask
from mona.distill.store import read_rich_profile


# Distill job IDs (must be stable across runs for idempotent registration)
JOB_WORK_PATTERN = "distill-work-pattern"
JOB_PROFILE = "distill-profile"

# Weekly schedule: Sunday 03:00
_CRON_EXPR = "0 3 * * 0"


def _get_memory_dir() -> Path:
    from mona.config.paths import get_memory_dir
    return get_memory_dir()


def _get_workspace() -> Path:
    from mona.config.paths import get_workspace_path
    return get_workspace_path()


def _get_provider_and_model() -> tuple[Any, str]:
    """Get LLM provider and model for distillation.

    Returns (provider, model_name). Provider may be None if not configured.
    """
    try:
        from mona.providers.factory import load_provider_snapshot

        snapshot = load_provider_snapshot()
        return snapshot.provider, snapshot.model or ""
    except Exception as e:
        logger.debug(f"[distill] could not build provider: {e}")
        return None, ""


def build_context(since: datetime | None = None) -> DistillContext:
    """Build distill context from current config."""
    provider, model_name = _get_provider_and_model()
    return DistillContext(
        workspace=_get_workspace(),
        memory_dir=_get_memory_dir(),
        provider=provider,
        model_name=model_name,
        since=since,
        until=datetime.now(),
    )


def build_context_from_loop(agent_loop: Any) -> DistillContext:
    """Build distill context from an existing AgentLoop instance.

    Reuses the provider and model already initialized in the gateway process
    instead of rebuilding them from config (which may fail due to partial
    Config definitions).
    """
    provider = getattr(agent_loop, "provider", None)
    model = getattr(agent_loop, "model", "") or ""
    return DistillContext(
        workspace=_get_workspace(),
        memory_dir=_get_memory_dir(),
        provider=provider,
        model_name=model,
        until=datetime.now(),
    )


async def run_work_pattern_distill(agent_loop: Any = None) -> DistillResult:
    """Run work pattern distillation task."""
    ctx = build_context_from_loop(agent_loop) if agent_loop else build_context()
    task = WorkPatternTask()
    logger.info("[distill] starting work pattern distillation")
    result = await task.run(ctx)
    if result.success:
        logger.info(f"[distill] work pattern done (confidence={result.confidence:.2f})")
    else:
        logger.warning(f"[distill] work pattern failed: {result.error}")
    return result


async def run_profile_distill(agent_loop: Any = None) -> DistillResult:
    """Run profile distillation task."""
    ctx = build_context_from_loop(agent_loop) if agent_loop else build_context()
    task = ProfileTask()
    logger.info("[distill] starting profile distillation")
    result = await task.run(ctx)
    if result.success:
        logger.info(f"[distill] profile done (confidence={result.confidence:.2f})")
    else:
        logger.warning(f"[distill] profile failed: {result.error}")
    return result


async def run_all_distill(agent_loop: Any = None) -> list[DistillResult]:
    """Run all distillation tasks sequentially."""
    results = []
    results.append(await run_work_pattern_distill(agent_loop))
    results.append(await run_profile_distill(agent_loop))
    return results


class DistillService:
    """Service wrapper for distillation tasks.

    Registered as a system handler — when cron fires a `system_event`
    with `distill` payload, this service executes the distillation pipeline.
    """

    async def handle_system_event(self, event: str) -> None:
        if event == "distill-work-pattern":
            await run_work_pattern_distill()
        elif event == "distill-profile":
            await run_profile_distill()
        elif event == "distill-all":
            await run_all_distill()
        else:
            logger.debug(f"[distill] unknown event: {event}")


def register_distill_jobs(cron_service: Any, timezone: str = "Asia/Shanghai") -> None:
    """Register distillation cron jobs (idempotent).

    Call this at startup, after CronService is initialized.
    """
    from mona.cron.types import CronJob, CronPayload, CronSchedule

    jobs = [
        CronJob(
            id=JOB_WORK_PATTERN,
            name="distill-work-pattern",
            schedule=CronSchedule(kind="cron", expr=_CRON_EXPR, tz=timezone),
            payload=CronPayload(kind="system_event", message="distill-work-pattern"),
        ),
        CronJob(
            id=JOB_PROFILE,
            name="distill-profile",
            schedule=CronSchedule(kind="cron", expr=_CRON_EXPR, tz=timezone),
            payload=CronPayload(kind="system_event", message="distill-profile"),
        ),
    ]

    for job in jobs:
        try:
            cron_service.register_system_job(job)
            logger.info(f"[distill] registered cron job: {job.id}")
        except Exception as e:
            logger.warning(f"[distill] failed to register job {job.id}: {e}")


def run_distill_sync(task_name: str = "all") -> None:
    """Synchronous entry point for CLI: `mona distill run <task>`."""
    if task_name == "work-pattern":
        asyncio.run(run_work_pattern_distill())
    elif task_name == "profile":
        asyncio.run(run_profile_distill())
    else:
        asyncio.run(run_all_distill())
