"""Stock pack bootstrap (stock-module design §5.1 / §11, dev plan T6).

Enabling the A-share pack performs a one-time idempotent bootstrap:

1. Create the deterministic hidden rooms ``stock_research`` and
   ``stock_ai_diagnosis`` — system-level execution containers for the six-agent
   deep-research workflow and the one-agent standard diagnosis workflow.
2. Install the packaged deep-research template as the room's active workflow
   revision (the only revision chain entry; the daily-review template never
   enters the chain — it stays a read-only package resource).
3. Register the daily-review cron under its own job id
   (``wf_stock_review_<room_id>``) with a ``template_ref`` payload, so
   ``SubagentManager.sync_workflow_cron`` (which manages ``wf_<room_id>``)
   never touches it.

The function holds no state of its own; everything goes through the existing
session/workflow/cron store APIs, and repeating it never duplicates a room,
a revision, or a cron job.
"""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from mona.agent.pack_templates import load_pack_template
from mona.agent.partners import (
    CONVERSATION_METADATA_KEY,
    AgentRegistry,
    ConversationMetadata,
)
from mona.agent.workflow import WorkflowStore
from mona.config.schema import StockConfig
from mona.cron.types import CronJob, CronPayload, CronSchedule

STOCK_PACK_ID = "com.mona.a-share-team"
STOCK_ROOM_ID = "stock_research"
STOCK_ROOM_TITLE = "股票研究室"
STOCK_DIAGNOSIS_ROOM_ID = "stock_ai_diagnosis"
STOCK_DIAGNOSIS_ROOM_TITLE = "AI诊股"

STOCK_INTERNAL_AGENT_IDS = [
    "com.mona.stock-tech-analyst",
    "com.mona.stock-fundamental-analyst",
    "com.mona.stock-news-analyst",
    "com.mona.stock-bull-researcher",
    "com.mona.stock-bear-researcher",
    "com.mona.stock-referee",
    "com.mona.stock-selection-analyst",
]
STOCK_ROOM_AGENT_IDS = list(STOCK_INTERNAL_AGENT_IDS)
STOCK_DIAGNOSIS_AGENT_ID = "com.mona.stock-diagnosis-semantic-researcher"
STOCK_DIAGNOSIS_ROOM_AGENT_IDS = [STOCK_DIAGNOSIS_AGENT_ID]

DEEP_RESEARCH_TEMPLATE_REF = (
    f"package://{STOCK_PACK_ID}/workflows/deep-research.json"
)
DAILY_REVIEW_TEMPLATE_REF = (
    f"package://{STOCK_PACK_ID}/workflows/daily-review.json"
)
STOCK_SELECTION_TEMPLATE_REF = (
    f"package://{STOCK_PACK_ID}/workflows/stock-selection.json"
)
DIAGNOSIS_TEMPLATE_REF = (
    f"package://{STOCK_PACK_ID}/workflows/ai-diagnosis.json"
)

REVIEW_CRON_TZ = "Asia/Shanghai"
SELECTION_CRON_TZ = REVIEW_CRON_TZ


def _review_cron_expr(review_time: str) -> str:
    """Translate ``HH:MM`` into a weekday cron expression (``分 时 * * 1-5``).

    The trading-day check itself happens at execution time (design §11); the
    schedule only pins weekdays so weekends never fire.
    """
    parts = review_time.strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"review_time must be HH:MM, got {review_time!r}")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError(f"review_time must be HH:MM, got {review_time!r}") from None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"review_time must be HH:MM, got {review_time!r}")
    return f"{minute} {hour} * * 1-5"


def ensure_stock_pack(
    session_manager,
    workflow_store: WorkflowStore,
    cron_service,
    registry: AgentRegistry,
    *,
    review_time: str = "15:30",
    enabled: bool = True,
    auto_review_enabled: bool = False,
    builtin_dir: Path | None = None,
    installed_dir: Path | None = None,
) -> str:
    """Idempotently bootstrap the stock pack; returns the room id.

    With ``enabled=False`` nothing is created (design §13: disabling the
    module never deletes the installed pack or historical reports either —
    it simply skips creation here).
    """
    if not enabled:
        return STOCK_ROOM_ID

    # 1. Hidden execution container.
    session = session_manager.get_or_create(f"websocket:{STOCK_ROOM_ID}")
    conversation = session.conversation_metadata
    desired = ConversationMetadata.room(
        STOCK_ROOM_AGENT_IDS, title=STOCK_ROOM_TITLE, hidden=True
    )
    if (
        conversation.type != "room"
        or not conversation.hidden
        or conversation.agent_ids != desired.agent_ids
    ):
        session.metadata[CONVERSATION_METADATA_KEY] = desired.to_session_metadata()
        session_manager.save(session)
        logger.info("Stock pack: created hidden room {}", STOCK_ROOM_ID)
    conversation = session.conversation_metadata

    # 2. Deep-research template as the room's single active revision.
    template = load_pack_template(
        DEEP_RESEARCH_TEMPLATE_REF,
        builtin_dir=builtin_dir,
        installed_dir=installed_dir,
    )
    active = workflow_store.get_active(STOCK_ROOM_ID)
    if (
        active is None
        or active.goal != template.goal
        or active.steps != template.steps
    ):
        workflow_store.save_draft(
            STOCK_ROOM_ID,
            goal=template.goal,
            trigger=template.trigger,
            steps=template.steps,
            created_by=f"pack:{STOCK_PACK_ID}",
            conversation=conversation,
            registry=registry,
        )
        workflow_store.activate(STOCK_ROOM_ID)
        logger.info("Stock pack: installed deep-research template as active")

    # 2b. Standard AI-diagnosis gets its own hidden room and workflow chain.
    # It deliberately does not add the semantic Agent to the six-agent room.
    ensure_stock_diagnosis_room(
        session_manager,
        workflow_store,
        registry,
        builtin_dir=builtin_dir,
        installed_dir=installed_dir,
    )

    # 3. Independent daily-review cron (register_system_job replaces by id,
    # so re-registration never duplicates).
    if cron_service is not None:
        sync_stock_review_cron(
            cron_service,
            StockConfig(
                enabled=True,
                auto_review_enabled=auto_review_enabled,
                review_time=review_time,
            ),
        )
        sync_all_stock_selection_crons(cron_service)
    return STOCK_ROOM_ID


def ensure_stock_diagnosis_room(
    session_manager,
    workflow_store: WorkflowStore,
    registry: AgentRegistry,
    *,
    builtin_dir: Path | None = None,
    installed_dir: Path | None = None,
) -> str:
    """Idempotently create the hidden room for standard AI diagnosis."""
    session = session_manager.get_or_create(f"websocket:{STOCK_DIAGNOSIS_ROOM_ID}")
    conversation = session.conversation_metadata
    desired = ConversationMetadata.room(
        STOCK_DIAGNOSIS_ROOM_AGENT_IDS,
        title=STOCK_DIAGNOSIS_ROOM_TITLE,
        hidden=True,
    )
    if (
        conversation.type != "room"
        or not conversation.hidden
        or conversation.agent_ids != desired.agent_ids
    ):
        session.metadata[CONVERSATION_METADATA_KEY] = desired.to_session_metadata()
        session_manager.save(session)
        logger.info("Stock pack: created hidden room {}", STOCK_DIAGNOSIS_ROOM_ID)
    conversation = session.conversation_metadata

    template = load_pack_template(
        DIAGNOSIS_TEMPLATE_REF,
        builtin_dir=builtin_dir,
        installed_dir=installed_dir,
    )
    active = workflow_store.get_active(STOCK_DIAGNOSIS_ROOM_ID)
    if (
        active is None
        or active.goal != template.goal
        or active.steps != template.steps
    ):
        workflow_store.save_draft(
            STOCK_DIAGNOSIS_ROOM_ID,
            goal=template.goal,
            trigger=template.trigger,
            steps=template.steps,
            created_by=f"pack:{STOCK_PACK_ID}",
            conversation=conversation,
            registry=registry,
        )
        workflow_store.activate(STOCK_DIAGNOSIS_ROOM_ID)
        logger.info("Stock pack: installed standard AI-diagnosis template as active")
    return STOCK_DIAGNOSIS_ROOM_ID


def stock_review_cron_job(stock: StockConfig) -> CronJob:
    """The daily-review cron job definition for the current config."""
    return CronJob(
        id=f"wf_stock_review_{STOCK_ROOM_ID}",
        name=f"workflow:stock-review:{STOCK_ROOM_ID}",
        enabled=True,
        schedule=CronSchedule(
            kind="cron",
            expr=_review_cron_expr(stock.review_time),
            tz=REVIEW_CRON_TZ,
        ),
        payload=CronPayload(
            kind="workflow_run",
            room_id=STOCK_ROOM_ID,
            template_ref=DAILY_REVIEW_TEMPLATE_REF,
        ),
    )


def sync_stock_review_cron(cron_service, stock: StockConfig) -> None:
    """Sync the daily-review cron job to the current :class:`StockConfig`.

    Single integration point shared by the pack bootstrap above and the
    settings page (dev plan T17): the job is registered only when both the
    stock module and automatic review are enabled. ``register_system_job``
    replaces by id, so a time change never duplicates; either gate being off
    removes the job. The room, templates and historical reports are never
    touched here (design §13).
    """
    if cron_service is None:
        return
    job_id = f"wf_stock_review_{STOCK_ROOM_ID}"
    if not (stock.enabled and stock.auto_review_enabled):
        cron_service.remove_job(job_id)
        return
    cron_service.register_system_job(stock_review_cron_job(stock))


def _selection_cron_expr(mode: str, time_text: str, weekday: int | None) -> str:
    """Translate a SelectionStrategy schedule into a weekday cron expression."""
    parts = str(time_text or "15:30").strip().split(":")
    if len(parts) != 2:
        raise ValueError("schedule.time must be HH:MM")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError("schedule.time must be HH:MM") from None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("schedule.time must be HH:MM")
    if mode == "daily_after_close":
        days = "1-5"
    elif mode == "weekly":
        # Python's weekday convention is used by SelectionStrategy: Monday=0.
        day = 4 if weekday is None else int(weekday)
        if not 0 <= day <= 6:
            raise ValueError("schedule.weekday must be between 0 and 6")
        days = str(day + 1)  # cron convention: Monday=1, Sunday=7
    else:
        raise ValueError(f"unsupported selection schedule mode {mode!r}")
    return f"{minute} {hour} * * {days}"


def stock_selection_cron_job(
    strategy_id: str,
    schedule: dict,
) -> CronJob:
    """Build the idempotent workflow cron payload for a saved strategy.

    ``channel_meta.strategy_id`` is intentionally explicit.  The cron
    dispatcher copies it into ``WorkflowRun.inputs`` before the packaged
    workflow starts; this keeps one hidden room and one WorkflowRun state.
    """
    mode = str(schedule.get("mode") or "manual")
    expr = _selection_cron_expr(mode, str(schedule.get("time") or "15:30"), schedule.get("weekday"))
    job_id = f"wf_stock_selection_{strategy_id}"
    return CronJob(
        id=job_id,
        name=f"workflow:stock-selection:{strategy_id}",
        enabled=True,
        schedule=CronSchedule(kind="cron", expr=expr, tz=SELECTION_CRON_TZ),
        payload=CronPayload(
            kind="workflow_run",
            room_id=STOCK_ROOM_ID,
            template_ref=STOCK_SELECTION_TEMPLATE_REF,
            channel_meta={"strategy_id": strategy_id},
        ),
    )


def sync_stock_selection_cron(
    cron_service,
    strategy_id: str,
    schedule: dict | None,
) -> dict[str, str | None]:
    """Synchronize a saved strategy's schedule without false success.

    The cron dispatcher propagates ``channel_meta.strategy_id`` into workflow
    inputs for the packaged selection template.  A malformed schedule or a
    missing service returns ``unavailable`` and never registers an unbound job.
    """
    raw = schedule if isinstance(schedule, dict) else {}
    mode = str(raw.get("mode") or "manual")
    enabled = bool(raw.get("enabled", False))
    job_id = f"wf_stock_selection_{strategy_id}"
    if cron_service is None:
        return {"status": "unavailable", "code": "cron_service_unavailable", "job_id": job_id}
    if mode == "manual" or not enabled:
        cron_service.remove_job(job_id)
        return {"status": "disabled", "code": None, "job_id": job_id}
    try:
        cron_service.register_system_job(stock_selection_cron_job(strategy_id, raw))
    except (TypeError, ValueError) as exc:
        return {"status": "unavailable", "code": str(exc), "job_id": job_id}
    return {"status": "registered", "code": None, "job_id": job_id}


def sync_all_stock_selection_crons(cron_service) -> list[dict[str, str | None]]:
    """Restore every persisted enabled strategy schedule after gateway restart."""
    if cron_service is None:
        return []
    try:
        from mona.services.stock.api import _provider
        from mona.services.stock.screening import default_screening_service

        service = default_screening_service(provider=_provider())
        strategies = service.strategies()
    except Exception as exc:
        logger.warning("Stock selection cron restore unavailable: {}", exc)
        return [{"status": "unavailable", "code": str(exc), "job_id": None}]
    results: list[dict[str, str | None]] = []
    known_ids: set[str] = set()
    for strategy in strategies:
        strategy_id = str(strategy.strategy_id)
        result = sync_stock_selection_cron(
            cron_service,
            strategy_id,
            strategy.schedule.model_dump(mode="json"),
        )
        results.append(result)
        if result.get("status") == "registered":
            known_ids.add(result.get("job_id") or "")
    for job in cron_service.list_jobs(include_disabled=True):
        if job.id.startswith("wf_stock_selection_") and job.id not in known_ids:
            cron_service.remove_job(job.id)
    return results
