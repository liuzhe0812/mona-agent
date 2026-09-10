"""Dependency-ordered, cross-process-safe user-profile pipeline."""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from filelock import FileLock
from filelock import Timeout as FileLockTimeout
from loguru import logger

from mona.distill.base import DistillContext, DistillResult
from mona.distill.tasks.advice import AdviceTask
from mona.distill.tasks.profile import ProfileTask
from mona.distill.tasks.work_pattern import WorkPatternTask

JOB_WORK_PATTERN = "distill-work-pattern"
JOB_PROFILE = "distill-profile"
_CRON_EXPR = "0 3 * * 0"
_DISTILL_LOCK = asyncio.Lock()


class ProfileBusyError(RuntimeError):
    """Another process is already updating the user profile."""


def _get_memory_dir() -> Path:
    from mona.distill.store import ensure_user_profile_store

    return ensure_user_profile_store()


def _get_workspace() -> Path:
    from mona.config.paths import get_workspace_path

    return get_workspace_path()


def _get_provider_and_model() -> tuple[Any, str]:
    try:
        from mona.providers.factory import load_provider_snapshot

        snapshot = load_provider_snapshot()
        return snapshot.provider, snapshot.model or ""
    except Exception as exc:
        logger.debug(f"[distill] could not build provider: {exc}")
        return None, ""


def _profile_config() -> Any:
    from mona.config.loader import load_config

    return load_config().profile


def _new_context(provider: Any, model_name: str) -> DistillContext:
    config = _profile_config()
    as_of = datetime.now(timezone.utc)
    return DistillContext(
        workspace=_get_workspace(),
        memory_dir=_get_memory_dir(),
        provider=provider,
        model_name=model_name,
        since=as_of - timedelta(days=config.window_days),
        until=as_of,
        as_of=as_of,
        profile_config=config,
    )


def build_context(since: datetime | None = None) -> DistillContext:
    provider, model_name = _get_provider_and_model()
    context = _new_context(provider, model_name)
    if since is not None:
        context.since = since
    return context


def build_context_from_loop(agent_loop: Any) -> DistillContext:
    return _new_context(
        getattr(agent_loop, "provider", None),
        getattr(agent_loop, "model", "") or "",
    )


@asynccontextmanager
async def _pipeline_lock(memory_dir: Path) -> AsyncIterator[None]:
    if _DISTILL_LOCK.locked():
        raise ProfileBusyError("profile update already running")
    await _DISTILL_LOCK.acquire()
    lock = FileLock(str((memory_dir / ".distill.lock").resolve()))
    try:
        try:
            lock.acquire(timeout=0)
        except FileLockTimeout as exc:
            raise ProfileBusyError("profile update already running") from exc
        yield
    finally:
        if lock.is_locked:
            lock.release()
        _DISTILL_LOCK.release()


def _get_notes_vault() -> Path | None:
    try:
        from mona.agent.tools.notes import _get_vault_path

        return _get_vault_path()
    except Exception:
        return None


def _artifact_evidence(item: dict[str, Any], source_scope_id: str) -> dict[str, Any]:
    title = str(item.get("title") or "")
    raw = f"{item.get('id')}\0{title}\0{item.get('first_recorded_at')}"
    return {
        "ref": item["source_ref"],
        "kind": "artifact",
        "source_scope_id": source_scope_id,
        "title": title,
        "occurred_at": item.get("first_recorded_at"),
        "excerpt": title[:600],
        "truncated": len(title) > 600,
        "session_key": item.get("session_key"),
        "artifact_id": item.get("id"),
        "content_hash": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    }


def _session_evidence(item: dict[str, Any], source_scope_id: str) -> dict[str, Any]:
    content = str(item.get("content") or "")
    return {
        "ref": item["ref"],
        "kind": "user_message",
        "source_scope_id": source_scope_id,
        "title": str(item.get("title") or ""),
        "occurred_at": item.get("occurred_at"),
        "excerpt": content[:600],
        "truncated": bool(item.get("truncated")) or len(content) > 600,
        "session_key": item.get("session_key"),
        "message_id": item.get("message_id"),
        "message_index": item.get("message_index"),
        "content_hash": item.get("content_hash") or hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }


def _select_holistic_events(
    events: list[dict[str, Any]],
    *,
    max_sessions: int,
    max_messages: int,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in events:
        session_key = item.get("session_key")
        if not isinstance(session_key, str) or not session_key or not item.get("ref"):
            continue
        grouped.setdefault(session_key, []).append(item)
    for items in grouped.values():
        items.sort(key=lambda value: str(value.get("occurred_at") or ""), reverse=True)
    session_keys = sorted(
        grouped,
        key=lambda key: str(grouped[key][0].get("occurred_at") or ""),
        reverse=True,
    )[:max_sessions]
    selected: list[dict[str, Any]] = []
    offset = 0
    while len(selected) < max_messages:
        added = False
        for key in session_keys:
            items = grouped[key]
            if offset < len(items):
                selected.append(items[offset])
                added = True
                if len(selected) >= max_messages:
                    break
        if not added:
            break
        offset += 1
    return selected


def _explicit_evidence(data: dict[str, Any], source_scope_id: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for field, item in data.get("facts", {}).get("explicit_context", {}).items():
        if not isinstance(item, dict) or item.get("mode") != "override":
            continue
        value = str(item.get("value") or "")
        output.append({
            "ref": f"explicit:{field}",
            "kind": "explicit_context",
            "source_scope_id": source_scope_id,
            "title": field,
            "occurred_at": item.get("updated_at"),
            "excerpt": value[:600],
            "truncated": len(value) > 600,
            "content_hash": hashlib.sha256(value.encode("utf-8")).hexdigest(),
        })
    return output


def _evidence_projection(item: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "ref",
        "kind",
        "source_scope_id",
        "title",
        "occurred_at",
        "excerpt",
        "truncated",
        "session_key",
        "message_id",
        "message_index",
        "note_relative_path",
        "artifact_id",
        "content_hash",
    }
    return {key: value for key, value in item.items() if key in allowed}


def _is_current_evidence(item: dict[str, Any], ctx: DistillContext) -> bool:
    if item.get("kind") == "explicit_context":
        return True
    raw = item.get("occurred_at")
    if not isinstance(raw, str) or not raw:
        return False
    try:
        occurred = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if occurred.tzinfo is None:
        occurred = occurred.replace(tzinfo=timezone.utc)
    occurred = occurred.astimezone(timezone.utc)
    start = ctx.since.astimezone(timezone.utc) if ctx.since else None
    end = ctx.until.astimezone(timezone.utc) if ctx.until else None
    return (start is None or occurred >= start) and (end is None or occurred < end)


def _prepare_dashboard(ctx: DistillContext) -> DistillResult:
    from mona.distill.collectors import collect_artifacts
    from mona.distill.dashboard import build_dashboard
    from mona.distill.profile_charts import build_profile_charts
    from mona.distill.store import commit_dashboard_bundle, read_rich_profile

    config = ctx.profile_config
    dashboard = build_dashboard(
        ctx.workspace,
        _get_notes_vault(),
        as_of=ctx.as_of,
        timezone_name=config.timezone,
        window_days=config.window_days,
        max_evidence_sessions=config.max_evidence_sessions,
        max_evidence_messages=config.max_evidence_messages,
        max_message_chars=config.max_message_chars,
        max_input_tokens=config.max_input_tokens,
    )
    source_scope_id = dashboard["source_scope_id"]
    for name, metric in dashboard.get("metrics", {}).items():
        if name == "generated_artifacts" or not isinstance(metric, dict):
            continue
        metric["comparison_available"] = bool(dashboard.get("comparison_available"))
        metric["comparison_reason"] = dashboard.get("comparison_reason")
    source_stats = dashboard.pop("source_stats", {})
    sessions = source_stats.get("sessions", {})
    visible_keys = set(source_stats.get("visible_session_keys", []))
    current = collect_artifacts(
        visible_keys,
        source_scope_id=source_scope_id,
        since=ctx.since,
        until=ctx.until,
    )
    previous_start = (ctx.since or ctx.as_of) - timedelta(days=config.window_days)
    previous = collect_artifacts(
        visible_keys,
        source_scope_id=source_scope_id,
        since=previous_start,
        until=ctx.since,
    )
    current_payload = current.to_dict()
    previous_payload = previous.to_dict()
    coverage = current_payload["coverage"]
    coverage.setdefault("assumed_timezone_count", 0)
    coverage["previous"] = previous_payload["coverage"]
    dashboard["coverage"] = [
        coverage if item.get("source") == "artifacts" else item
        for item in dashboard.get("coverage", [])
    ]
    dashboard["artifacts"] = current_payload["artifacts"][:50]
    current_notes = dict(source_stats.get("notes_current", {}))
    previous_notes = dict(source_stats.get("notes_previous", {}))
    current_notes["records"] = source_stats.get("notes_current_all_records", [])
    previous_notes["records"] = source_stats.get("notes_previous_all_records", [])
    dashboard["profile_charts"] = build_profile_charts(
        current_events=list(source_stats.get("current_events", [])),
        previous_events=list(source_stats.get("previous_events", [])),
        current_notes=current_notes,
        previous_notes=previous_notes,
        artifacts=current_payload["artifacts"],
        as_of=ctx.as_of or datetime.now(timezone.utc),
        timezone_name=config.timezone,
    )
    dashboard["topic_records"] = [
        {
            "topic": item["topic"],
            "count": item["current"],
            "previous_count": item["previous"],
            "delta": item["delta"],
            "source": "会话与笔记主题",
        }
        for item in dashboard["profile_charts"]["topic_comparison"][:15]
    ]
    artifact_available = coverage.get("status") != "unavailable"
    previous_available = (
        previous_payload["coverage"].get("status") == "available"
        and bool(dashboard.get("comparison_available"))
    )
    current_value = current.total_artifacts if artifact_available else None
    previous_value = previous.total_artifacts if previous_available else None
    dashboard["metrics"]["generated_artifacts"] = {
        "current": {
            "value": current_value,
            "availability": coverage.get("status", "unavailable"),
        },
        "previous": {
            "value": previous_value,
            "availability": "available" if previous_available else "unavailable",
        },
        "delta": (
            current_value - previous_value
            if current_value is not None and previous_value is not None
            else None
        ),
        "comparison_available": previous_available,
        "comparison_reason": None if previous_available else "no_previous_observation",
    }

    selected = [
        item
        for item in dashboard.pop("selected_evidence", [])
        if isinstance(item, dict) and _is_current_evidence(item, ctx)
    ]
    holistic_evidence = _select_holistic_events(
        list(source_stats.get("all_user_events", [])),
        max_sessions=config.max_evidence_sessions,
        max_messages=config.max_evidence_messages,
    )
    selected.extend(_session_evidence(item, source_scope_id) for item in holistic_evidence)
    for artifact in current_payload["artifacts"]:
        evidence = _artifact_evidence(artifact, source_scope_id)
        selected.append(evidence)
    selected.extend(_explicit_evidence(read_rich_profile(ctx.memory_dir), source_scope_id))
    evidence_index = {
        item["ref"]: _evidence_projection(item)
        for item in selected
        if isinstance(item.get("ref"), str)
    }
    ctx.shared_data.update({
        "dashboard": dashboard,
        "sessions": sessions,
        "notes": source_stats.get("notes_current", {}),
        "coverage": dashboard.get("coverage", []),
        "evidence_index": evidence_index,
        "holistic_evidence": holistic_evidence,
        "source_scope_id": source_scope_id,
    })
    commit_dashboard_bundle(ctx.memory_dir, dashboard, evidence_index)
    return DistillResult(
        task_name="dashboard",
        success=True,
        confidence=0.0,
        data=dashboard,
        status="success",
    )


def _finalise_status(result: DistillResult) -> DistillResult:
    if not result.success and result.status == "success":
        result.status = "failed"
    return result


async def _run_work_pattern(ctx: DistillContext) -> DistillResult:
    logger.info("[distill] starting work pattern distillation")
    return _finalise_status(await WorkPatternTask().run(ctx))


async def _run_profile(ctx: DistillContext) -> DistillResult:
    logger.info("[distill] starting profile understanding")
    return _finalise_status(await ProfileTask().run(ctx))


async def _run_advice(ctx: DistillContext) -> DistillResult:
    from mona.distill.store import record_advice_failure

    logger.info("[distill] starting profile advice")
    result = _finalise_status(await AdviceTask().run(ctx))
    if not result.success:
        record_advice_failure(
            ctx.memory_dir,
            code=result.code or "advice_failed",
            message=result.error or "建议生成失败",
        )
    return result


def _context(agent_loop: Any = None) -> DistillContext:
    return build_context_from_loop(agent_loop) if agent_loop else build_context()


async def run_work_pattern_distill(agent_loop: Any = None) -> DistillResult:
    ctx = _context(agent_loop)
    async with _pipeline_lock(ctx.memory_dir):
        return await _run_work_pattern(ctx)


async def run_profile_distill(agent_loop: Any = None) -> DistillResult:
    ctx = _context(agent_loop)
    async with _pipeline_lock(ctx.memory_dir):
        await asyncio.to_thread(_prepare_dashboard, ctx)
        return await _run_profile(ctx)


async def run_advice_distill(agent_loop: Any = None) -> DistillResult:
    ctx = _context(agent_loop)
    async with _pipeline_lock(ctx.memory_dir):
        await asyncio.to_thread(_prepare_dashboard, ctx)
        return await _run_advice(ctx)


async def run_all_distill(agent_loop: Any = None) -> list[DistillResult]:
    ctx = _context(agent_loop)
    async with _pipeline_lock(ctx.memory_dir):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + getattr(ctx.profile_config, "pipeline_timeout_seconds", 420)
        stages = [
            ("dashboard", lambda: asyncio.to_thread(_prepare_dashboard, ctx)),
            ("work-pattern", lambda: _run_work_pattern(ctx)),
            ("profile", lambda: _run_profile(ctx)),
            ("advice", lambda: _run_advice(ctx)),
        ]
        results: list[DistillResult] = []
        for index, (name, stage) in enumerate(stages):
            remaining = deadline - loop.time()
            if remaining <= 0:
                results.extend(
                    DistillResult(
                        task_name=skipped_name,
                        success=False,
                        status="skipped",
                        code="pipeline_timeout",
                        error="画像更新总时间已用完",
                    )
                    for skipped_name, _ in stages[index:]
                )
                break
            try:
                results.append(await asyncio.wait_for(stage(), timeout=remaining))
            except TimeoutError:
                results.append(
                    DistillResult(
                        task_name=name,
                        success=False,
                        status="failed",
                        code="timeout",
                        error="画像更新阶段超时",
                    )
                )
                results.extend(
                    DistillResult(
                        task_name=skipped_name,
                        success=False,
                        status="skipped",
                        code="pipeline_timeout",
                        error="前序阶段超时，本阶段未运行",
                    )
                    for skipped_name, _ in stages[index + 1 :]
                )
                break
        return results


class DistillService:
    async def handle_system_event(self, event: str) -> None:
        try:
            if event == "distill-work-pattern":
                await run_work_pattern_distill()
            elif event == "distill-profile":
                await run_profile_distill()
            elif event == "distill-all":
                await run_all_distill()
            else:
                logger.debug(f"[distill] unknown event: {event}")
        except ProfileBusyError:
            logger.info("[distill] profile update already running; scheduled run skipped")


def register_distill_jobs(cron_service: Any, timezone: str = "Asia/Shanghai") -> None:
    from mona.cron.types import CronJob, CronPayload, CronSchedule

    jobs = [
        CronJob(
            id=JOB_WORK_PATTERN,
            name="distill-work-pattern",
            enabled=False,
            schedule=CronSchedule(kind="cron", expr=_CRON_EXPR, tz=timezone),
            payload=CronPayload(kind="system_event", message="distill-work-pattern"),
        ),
        CronJob(
            id=JOB_PROFILE,
            name="distill-profile-pipeline",
            schedule=CronSchedule(kind="cron", expr=_CRON_EXPR, tz=timezone),
            payload=CronPayload(kind="system_event", message="distill-all"),
        ),
    ]
    for job in jobs:
        try:
            cron_service.register_system_job(job)
            logger.info(f"[distill] registered cron job: {job.id}")
        except Exception as exc:
            logger.warning(f"[distill] failed to register job {job.id}: {exc}")


def run_distill_sync(task_name: str = "all") -> None:
    if task_name == "work-pattern":
        asyncio.run(run_work_pattern_distill())
    elif task_name == "profile":
        asyncio.run(run_profile_distill())
    elif task_name == "advice":
        asyncio.run(run_advice_distill())
    else:
        asyncio.run(run_all_distill())


__all__ = [
    "DistillService",
    "JOB_PROFILE",
    "JOB_WORK_PATTERN",
    "ProfileBusyError",
    "build_context",
    "build_context_from_loop",
    "register_distill_jobs",
    "run_advice_distill",
    "run_all_distill",
    "run_distill_sync",
    "run_profile_distill",
    "run_work_pattern_distill",
]
