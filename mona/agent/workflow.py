"""WorkflowDefinition/WorkflowRun models, validation, storage and runner.

Multi-agent phase 3 (docs/design/multi-agent-development-guide.md sections
5.4, 5.5, 7.6). One file per room under ``<workspace>/workflows/`` holds the
draft, the immutable revision list and the active pointer; one file per run
under ``<workspace>/workflow-runs/`` holds the full workflow snapshot plus
per-step state.

- Validation: unique step IDs, at least one agent step, existing deps,
  cycle detection via :class:`graphlib.TopologicalSorter` (never hand-rolled
  graph algorithms), room membership and enabled-agent checks, cron trigger
  validation on save.
- Runs hold a complete workflow snapshot, so editing a new revision never
  disturbs a run in flight and history stays interpretable.
- ``WorkflowRunner`` schedules ready steps with bounded ``asyncio.gather``,
  stops scheduling at approval steps, fails the run on any step failure and
  honours a per-run cancel event. One active run per room.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import uuid
from datetime import datetime, timedelta
from graphlib import TopologicalSorter
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from loguru import logger
from pydantic import Field, field_validator, model_validator

from mona.agent import run_artifacts
from mona.agent.partners import (
    AgentRegistry,
    ConversationMetadata,
    normalize_agent_id,
)
from mona.config.schema import Base

WORKFLOW_SCHEMA_VERSION = 1
RUN_SCHEMA_VERSION = 1

STEP_TYPE_AGENT = "agent"
STEP_TYPE_APPROVAL = "approval"

TRIGGER_MANUAL = "manual"
TRIGGER_CRON = "cron"

WORKFLOW_STATUS_DRAFT = "draft"
WORKFLOW_STATUS_ACTIVE = "active"
WORKFLOW_STATUS_ARCHIVED = "archived"

RUN_STATUS_QUEUED = "queued"
RUN_STATUS_RUNNING = "running"
RUN_STATUS_WAITING_APPROVAL = "waiting_approval"
RUN_STATUS_SUCCEEDED = "succeeded"
RUN_STATUS_FAILED = "failed"
RUN_STATUS_CANCELLED = "cancelled"

RunStatus = Literal[
    "queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"
]

TERMINAL_RUN_STATUSES = frozenset({
    RUN_STATUS_SUCCEEDED,
    RUN_STATUS_FAILED,
    RUN_STATUS_CANCELLED,
})

# Allowed predecessor states for each run status (compare-and-set semantics,
# same discipline as AgentJob; guide 5.6). Terminal states have no outgoing
# transitions, so a cancelled run never accepts a late completion.
_ALLOWED_RUN_TRANSITIONS: dict[str, frozenset[str]] = {
    RUN_STATUS_RUNNING: frozenset({RUN_STATUS_QUEUED, RUN_STATUS_WAITING_APPROVAL}),
    RUN_STATUS_WAITING_APPROVAL: frozenset({RUN_STATUS_RUNNING}),
    RUN_STATUS_SUCCEEDED: frozenset({RUN_STATUS_RUNNING}),
    RUN_STATUS_FAILED: frozenset({
        RUN_STATUS_QUEUED,
        RUN_STATUS_RUNNING,
        RUN_STATUS_WAITING_APPROVAL,
    }),
    RUN_STATUS_CANCELLED: frozenset({
        RUN_STATUS_QUEUED,
        RUN_STATUS_RUNNING,
        RUN_STATUS_WAITING_APPROVAL,
    }),
}

STEP_STATUS_QUEUED = "queued"
STEP_STATUS_RUNNING = "running"
STEP_STATUS_WAITING_APPROVAL = "waiting_approval"
STEP_STATUS_SUCCEEDED = "succeeded"
STEP_STATUS_FAILED = "failed"
STEP_STATUS_CANCELLED = "cancelled"
STEP_STATUS_SKIPPED = "skipped"

StepStatus = Literal[
    "queued", "running", "waiting_approval", "succeeded", "failed",
    "cancelled", "skipped",
]

TERMINAL_STEP_STATUSES = frozenset({
    STEP_STATUS_SUCCEEDED,
    STEP_STATUS_FAILED,
    STEP_STATUS_CANCELLED,
    STEP_STATUS_SKIPPED,
})

_STEP_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")
_WORKFLOW_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")

# Cap on the upstream digest injected into a downstream step's task (guide
# 7.6: structured summaries only, never full tool traces).
MAX_UPSTREAM_DIGEST_CHARS = 4000
# Debate and referee stock agents must read the upstream artifacts themselves.
# Key this by agent identity rather than generic step IDs so another workflow
# can still use a step named ``bull``/``bear``/``referee`` normally.
_ARTIFACT_ONLY_DOWNSTREAM_AGENT_IDS = frozenset(
    {
        "com.mona.stock-bull-researcher",
        "com.mona.stock-bear-researcher",
        "com.mona.stock-referee",
    }
)


class WorkflowValidationError(ValueError):
    """Raised when a workflow definition fails structural validation."""


class WorkflowNotFoundError(KeyError):
    """Raised when a workflow/run file does not exist."""


class WorkflowStorageError(RuntimeError):
    """Raised when a workflow/run file cannot be parsed (original kept)."""


class WorkflowTransitionError(ValueError):
    """Raised when a compare-and-set run transition is not allowed."""


class WorkflowRetryError(WorkflowTransitionError):
    """Raised when a failed workflow step cannot be retried."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


class RunConflictError(RuntimeError):
    """Raised when a room already has an active workflow run."""


class StepExecutionError(RuntimeError):
    """Raised by step executors when an agent step finishes unsuccessful."""


class WorkflowApprovalError(RuntimeError):
    """Approval resolution failed; ``code`` is a wire-safe error code."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _validate_cron_expr(expr: str) -> str:
    """Validate a cron expression with the existing croniter integration."""
    candidate = expr.strip()
    if not candidate:
        raise WorkflowValidationError("cron trigger requires a non-empty expression")
    try:
        from croniter import croniter

        if not croniter.is_valid(candidate):
            raise ValueError("invalid expression")
    except (ValueError, ImportError) as exc:
        raise WorkflowValidationError(
            f"invalid cron expression {expr!r}: {exc}"
        ) from exc
    return candidate


class WorkflowTrigger(Base):
    """When the workflow runs: manual only, or a cron schedule (guide 5.4)."""

    type: Literal["manual", "cron"] = TRIGGER_MANUAL
    expr: str | None = None  # cron expression when type == "cron"
    tz: str | None = None  # IANA timezone; None = server local

    @model_validator(mode="after")
    def _check_trigger(self) -> WorkflowTrigger:
        if self.type == TRIGGER_CRON:
            if self.expr is None:
                raise WorkflowValidationError("cron trigger requires expr")
            self.expr = _validate_cron_expr(self.expr)
        elif self.expr is not None:
            raise WorkflowValidationError("manual trigger must not set expr")
        return self


class WorkflowStep(Base):
    """One workflow step: an agent task or a human approval gate."""

    id: str = Field(min_length=1)
    type: Literal["agent", "approval"] = STEP_TYPE_AGENT
    agent_id: str | None = None
    task: str = ""
    expected_output: str = ""
    message: str = ""  # approval prompt shown to the user
    depends_on: list[str] = Field(default_factory=list)
    # Canvas node coordinates ({"x": .., "y": ..}); None = auto-layout.
    position: dict[str, float] | None = None

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate or any(ch not in _STEP_ID_CHARS for ch in candidate):
            raise ValueError(f"Invalid step id {value!r}")
        return candidate

    @field_validator("agent_id")
    @classmethod
    def _check_agent_id(cls, value: str | None) -> str | None:
        return normalize_agent_id(value) if value is not None else None

    @field_validator("depends_on")
    @classmethod
    def _check_depends_on(cls, value: list[str]) -> list[str]:
        deduped: list[str] = []
        for entry in value:
            candidate = entry.strip()
            if not candidate:
                raise ValueError("depends_on entries must be non-empty")
            if candidate not in deduped:
                deduped.append(candidate)
        return deduped

    @model_validator(mode="after")
    def _check_shape(self) -> WorkflowStep:
        if self.type == STEP_TYPE_AGENT:
            if self.agent_id is None:
                raise ValueError("agent steps must set agent_id")
            if not self.task.strip():
                raise ValueError("agent steps must set a non-empty task")
        else:
            if self.agent_id is not None:
                raise ValueError("approval steps must not set agent_id")
            if not self.message.strip():
                raise ValueError("approval steps must set a non-empty message")
        return self


class WorkflowDefinition(Base):
    """Immutable workflow revision (guide 5.4). Drafts use ``status=draft``."""

    schema_version: int = WORKFLOW_SCHEMA_VERSION
    id: str = Field(min_length=1)
    room_id: str = Field(min_length=1)
    revision: int = Field(ge=1)
    status: Literal["draft", "active", "archived"] = WORKFLOW_STATUS_DRAFT
    goal: str = ""
    trigger: WorkflowTrigger = Field(default_factory=WorkflowTrigger)
    steps: list[WorkflowStep] = Field(min_length=1)
    created_at: datetime = Field(default_factory=datetime.now)
    created_by: str = "user"

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != WORKFLOW_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported workflow schema_version {value}, "
                f"expected {WORKFLOW_SCHEMA_VERSION}"
            )
        return value

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate or any(ch not in _WORKFLOW_ID_CHARS for ch in candidate):
            raise ValueError(f"Invalid workflow id {value!r}")
        return candidate

    @field_validator("steps")
    @classmethod
    def _check_steps(cls, value: list[WorkflowStep]) -> list[WorkflowStep]:
        seen: set[str] = set()
        for step in value:
            if step.id in seen:
                raise WorkflowValidationError(f"duplicate step id {step.id!r}")
            seen.add(step.id)
        return value

    def step_map(self) -> dict[str, WorkflowStep]:
        return {step.id: step for step in self.steps}


class StepRun(Base):
    """Per-step state inside a WorkflowRun (guide 5.5)."""

    status: StepStatus = STEP_STATUS_QUEUED
    # Number of durable execution attempts for this step.  Missing values in
    # older run files load as the initial attempt.
    attempt: int = Field(default=1, ge=1)
    job_id: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    output: dict[str, Any] | None = None  # {"summary": ..., "artifacts": [...]}
    error: str | None = None
    # Approval gate state (phase 4). The random token binds resolution to
    # this run/step; the decision fields make replays idempotent and keep an
    # audit trail (guide 10.3). All ``None`` on agent steps and on approval
    # steps that have never waited.
    approval_token: str | None = None
    approval_expires_at: datetime | None = None
    approval_decision: str | None = None  # "approved" | "rejected"
    approval_resolved_at: datetime | None = None
    approval_resolved_by: str | None = None


class WorkflowRun(Base):
    """One workflow execution with a full definition snapshot (guide 5.5)."""

    schema_version: int = RUN_SCHEMA_VERSION
    id: str = Field(min_length=1)
    room_id: str = Field(min_length=1)
    workflow_id: str = Field(min_length=1)
    workflow_revision: int = Field(ge=1)
    workflow: WorkflowDefinition  # full snapshot, not a revision pointer
    status: RunStatus = RUN_STATUS_QUEUED
    trigger_type: Literal["manual", "cron"] = TRIGGER_MANUAL
    started_by: str = "user"
    started_at: datetime = Field(default_factory=datetime.now)
    finished_at: datetime | None = None
    steps: dict[str, StepRun] = Field(default_factory=dict)
    # Run-input snapshot (stock-module design 4.2). Written once at create
    # time and never mutated afterwards; legacy run files without the field
    # load as empty inputs without a schema_version bump.
    inputs: dict[str, Any] = Field(default_factory=dict)

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != RUN_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported run schema_version {value}, expected {RUN_SCHEMA_VERSION}"
            )
        return value


# ----------------------------------------------------------------------
# Structural validation
# ----------------------------------------------------------------------


def execution_layers(definition: WorkflowDefinition) -> list[list[str]]:
    """Topologically order steps into parallel-ready layers.

    Uses :class:`graphlib.TopologicalSorter` — never hand-rolled graph
    algorithms (guide 5.4). Raises :class:`WorkflowValidationError` on
    missing dependencies or cycles.
    """
    steps = definition.step_map()
    predecessors: dict[str, set[str]] = {}
    for step in definition.steps:
        for dep in step.depends_on:
            if dep == step.id:
                raise WorkflowValidationError(
                    f"step {step.id!r} must not depend on itself"
                )
            if dep not in steps:
                raise WorkflowValidationError(
                    f"step {step.id!r} depends on unknown step {dep!r}"
                )
        predecessors[step.id] = set(step.depends_on)
    sorter = TopologicalSorter(predecessors)
    try:
        ordered = list(sorter.static_order())
    except Exception as exc:
        raise WorkflowValidationError(
            f"workflow contains a dependency cycle: {exc}"
        ) from exc
    # Group into layers: a step joins the earliest layer after its deps.
    layer_of: dict[str, int] = {}
    for step_id in ordered:
        deps = predecessors[step_id]
        layer_of[step_id] = max((layer_of[d] for d in deps), default=-1) + 1
    layers: list[list[str]] = []
    for step_id in ordered:
        index = layer_of[step_id]
        while len(layers) <= index:
            layers.append([])
        layers[index].append(step_id)
    return layers


def validate_workflow(
    definition: WorkflowDefinition,
    conversation: ConversationMetadata,
    registry: AgentRegistry | None = None,
) -> None:
    """Validate a definition against room membership and agent availability.

    Guide 5.4: at least one agent step; every agent step targets a room
    member that is installed and enabled; dependencies exist; no cycles.
    """
    if conversation.type != "room":
        raise WorkflowValidationError("workflows require a collaboration room")
    agent_steps = [s for s in definition.steps if s.type == STEP_TYPE_AGENT]
    if not agent_steps:
        raise WorkflowValidationError("workflow needs at least one agent step")
    for step in agent_steps:
        assert step.agent_id is not None  # enforced by the model
        if step.agent_id not in conversation.agent_ids:
            raise WorkflowValidationError(
                f"step {step.id!r}: agent {step.agent_id!r} is not a room member"
            )
        if registry is not None and registry.get(step.agent_id) is None:
            raise WorkflowValidationError(
                f"step {step.id!r}: agent {step.agent_id!r} is not installed "
                f"or is disabled"
            )
    execution_layers(definition)  # raises on missing deps / cycles


# ----------------------------------------------------------------------
# Storage
# ----------------------------------------------------------------------


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _room_id_path_fragment(room_id: str) -> str:
    candidate = room_id.strip()
    if not candidate or any(
        ch not in _WORKFLOW_ID_CHARS for ch in candidate
    ):
        raise ValueError(f"Invalid room id {room_id!r}")
    return candidate


class RoomWorkflowFile(Base):
    """On-disk per-room workflow file: draft + immutable revisions + pointer."""

    schema_version: int = WORKFLOW_SCHEMA_VERSION
    room_id: str = Field(min_length=1)
    draft: WorkflowDefinition | None = None
    versions: list[WorkflowDefinition] = Field(default_factory=list)
    active_revision: int | None = None

    def active(self) -> WorkflowDefinition | None:
        if self.active_revision is None:
            return None
        for version in self.versions:
            if version.revision == self.active_revision:
                return version
        return None


class WorkflowStore:
    """Per-room workflow storage; one JSON file per room, per-room locks."""

    def __init__(self, workflows_dir: Path):
        self.workflows_dir = Path(workflows_dir)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    @staticmethod
    def default_dir(workspace: Path) -> Path:
        """Default workflow-definition directory in Mona runtime state."""
        from mona.config.paths import get_workflows_dir

        return get_workflows_dir()

    def _path(self, room_id: str) -> Path:
        return self.workflows_dir / f"{_room_id_path_fragment(room_id)}.json"

    def _lock_for(self, room_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(room_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[room_id] = lock
            return lock

    def load(self, room_id: str) -> RoomWorkflowFile:
        """Load the room workflow file; a missing file means an empty state."""
        path = self._path(room_id)
        if not path.is_file():
            return RoomWorkflowFile(room_id=room_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkflowStorageError(
                f"{path}: cannot read workflow file: {exc}"
            ) from exc
        if not isinstance(raw, dict):
            raise WorkflowStorageError(f"{path}: workflow payload is not an object")
        from pydantic import ValidationError

        try:
            return RoomWorkflowFile.model_validate(raw)
        except ValidationError as exc:
            raise WorkflowStorageError(f"{path}: invalid workflow payload: {exc}") from exc

    def _save(self, state: RoomWorkflowFile) -> None:
        _atomic_write_json(
            self._path(state.room_id),
            state.model_dump(by_alias=True, mode="json"),
        )

    def save_draft(
        self,
        room_id: str,
        *,
        goal: str,
        trigger: WorkflowTrigger | None,
        steps: list[WorkflowStep],
        created_by: str = "user",
        conversation: ConversationMetadata | None = None,
        registry: AgentRegistry | None = None,
    ) -> WorkflowDefinition:
        """Replace the room draft; validates before writing when given a room.

        The draft keeps the room's workflow id and takes the next revision
        number, so activating it never collides with an archived revision.
        """
        with self._lock_for(room_id):
            state = self.load(room_id)
            workflow_id = (
                state.draft.id if state.draft is not None else f"wf_{uuid.uuid4().hex[:12]}"
            )
            next_revision = max(
                (v.revision for v in state.versions),
                default=0,
            ) + 1
            if state.draft is not None and state.draft.revision >= next_revision:
                next_revision = state.draft.revision + 1
            draft = WorkflowDefinition(
                id=workflow_id,
                room_id=room_id,
                revision=next_revision,
                status=WORKFLOW_STATUS_DRAFT,
                goal=goal,
                trigger=trigger or WorkflowTrigger(),
                steps=steps,
                created_by=created_by,
            )
            if conversation is not None:
                validate_workflow(draft, conversation, registry)
            state.draft = draft
            self._save(state)
            return draft

    def discard_draft(self, room_id: str) -> None:
        with self._lock_for(room_id):
            state = self.load(room_id)
            if state.draft is not None:
                state.draft = None
                self._save(state)

    def activate(self, room_id: str) -> WorkflowDefinition:
        """Promote the draft to an immutable active revision (guide 5.4).

        Only one active revision per room; the previous active revision is
        archived. Runs already in flight keep their own snapshot, so the
        swap never disturbs them.
        """
        with self._lock_for(room_id):
            state = self.load(room_id)
            if state.draft is None:
                raise WorkflowNotFoundError(f"room {room_id!r} has no workflow draft")
            promoted = state.draft.model_copy(update={"status": WORKFLOW_STATUS_ACTIVE})
            versions = [
                v.model_copy(update={"status": WORKFLOW_STATUS_ARCHIVED})
                if v.revision == state.active_revision
                else v
                for v in state.versions
            ]
            versions.append(promoted)
            state.versions = versions
            state.active_revision = promoted.revision
            state.draft = None
            self._save(state)
            return promoted

    def get_active(self, room_id: str) -> WorkflowDefinition | None:
        return self.load(room_id).active()

    def get_revision(self, room_id: str, revision: int) -> WorkflowDefinition:
        for version in self.load(room_id).versions:
            if version.revision == revision:
                return version
        raise WorkflowNotFoundError(
            f"room {room_id!r} has no workflow revision {revision}"
        )


class WorkflowRunStore:
    """File-backed WorkflowRun storage; one JSON per run, per-run CAS locks."""

    def __init__(self, runs_dir: Path):
        self.runs_dir = Path(runs_dir)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    @staticmethod
    def default_dir(workspace: Path) -> Path:
        """Default workflow-run directory in Mona runtime state."""
        from mona.config.paths import get_workflow_runs_dir

        return get_workflow_runs_dir()

    def _path(self, run_id: str) -> Path:
        if not run_id or any(ch not in _WORKFLOW_ID_CHARS for ch in run_id):
            raise ValueError(f"Invalid run id {run_id!r}")
        return self.runs_dir / f"{run_id}.json"

    def _lock_for(self, run_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(run_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[run_id] = lock
            return lock

    def create(
        self,
        *,
        room_id: str,
        workflow: WorkflowDefinition,
        trigger_type: str = TRIGGER_MANUAL,
        started_by: str = "user",
        inputs: dict[str, Any] | None = None,
    ) -> WorkflowRun:
        """Persist a new ``queued`` run with the full workflow snapshot."""
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        while self._path(run_id).exists():
            run_id = f"run_{uuid.uuid4().hex[:12]}"
        run = WorkflowRun(
            id=run_id,
            room_id=room_id,
            workflow_id=workflow.id,
            workflow_revision=workflow.revision,
            workflow=workflow,
            trigger_type=trigger_type,  # type: ignore[arg-type]
            started_by=started_by,
            steps={step.id: StepRun() for step in workflow.steps},
            inputs=inputs or {},
        )
        self._save(run)
        return run

    def load(self, run_id: str) -> WorkflowRun:
        path = self._path(run_id)
        if not path.is_file():
            raise WorkflowNotFoundError(run_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkflowStorageError(f"{path}: cannot read run file: {exc}") from exc
        if not isinstance(raw, dict):
            raise WorkflowStorageError(f"{path}: run payload is not an object")
        from pydantic import ValidationError

        try:
            return WorkflowRun.model_validate(raw)
        except ValidationError as exc:
            raise WorkflowStorageError(f"{path}: invalid run payload: {exc}") from exc

    def save(self, run: WorkflowRun) -> None:
        with self._lock_for(run.id):
            self._save(run)

    def _save(self, run: WorkflowRun) -> None:
        _atomic_write_json(self._path(run.id), run.model_dump(by_alias=True, mode="json"))

    def _scan(self) -> list[WorkflowRun]:
        if not self.runs_dir.is_dir():
            return []
        runs: list[WorkflowRun] = []
        for path in sorted(self.runs_dir.glob("run_*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise WorkflowStorageError(f"{path}: run payload is not an object")
                runs.append(WorkflowRun.model_validate(raw))
            except Exception as exc:
                logger.error("Skipping unreadable run file {}: {}", path, exc)
        runs.sort(key=lambda run: (run.started_at, run.id))
        return runs

    def list_for_room(self, room_id: str, *, limit: int | None = None) -> list[WorkflowRun]:
        """Runs for a room, newest first."""
        runs = [r for r in self._scan() if r.room_id == room_id]
        runs.reverse()
        return runs[:limit] if limit else runs

    def latest_by_room(self) -> dict[str, WorkflowRun]:
        """Latest run per room id from one directory scan (IM sessions list).

        ``_scan`` orders ascending by ``(started_at, id)`` so the last write
        per room wins; callers get the persisted current state without one
        directory rescan per room.
        """
        latest: dict[str, WorkflowRun] = {}
        for run in self._scan():
            latest[run.room_id] = run
        return latest

    def list_non_terminal(self) -> list[WorkflowRun]:
        """Runs not in a terminal state, for restart recovery (guide 7.6)."""
        return [r for r in self._scan() if r.status not in TERMINAL_RUN_STATUSES]

    # ------------------------------------------------------------------
    # Compare-and-set transitions
    # ------------------------------------------------------------------

    def transition(self, run_id: str, target: RunStatus) -> WorkflowRun:
        """Move a run to *target* when the current state allows it (CAS)."""
        with self._lock_for(run_id):
            run = self.load(run_id)
            allowed = _ALLOWED_RUN_TRANSITIONS.get(target, frozenset())
            if run.status not in allowed:
                raise WorkflowTransitionError(
                    f"run {run_id} cannot transition from {run.status!r} to {target!r}"
                )
            run.status = target
            if target in TERMINAL_RUN_STATUSES:
                run.finished_at = datetime.now()
            self._save(run)
            return run

    def transition_step(
        self,
        run_id: str,
        step_id: str,
        target: StepStatus,
        *,
        job_id: str | None = None,
        output: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> WorkflowRun:
        """Update one step under the run lock; terminal step states stick.

        A step already in a terminal state rejects late updates, mirroring
        the job CAS discipline (a cancelled step never accepts a late
        success).
        """
        with self._lock_for(run_id):
            run = self.load(run_id)
            step = run.steps.get(step_id)
            if step is None:
                raise WorkflowNotFoundError(f"run {run_id} has no step {step_id!r}")
            if step.status in TERMINAL_STEP_STATUSES:
                raise WorkflowTransitionError(
                    f"step {step_id!r} of run {run_id} is already {step.status!r}"
                )
            step.status = target
            now = datetime.now()
            if target == STEP_STATUS_RUNNING:
                step.started_at = now
            if target in TERMINAL_STEP_STATUSES:
                step.finished_at = now
            if job_id is not None:
                step.job_id = job_id
            if output is not None:
                step.output = output
            if error is not None:
                step.error = error
            self._save(run)
            return run

    def retry_step(self, run_id: str, step_id: str) -> WorkflowRun:
        """Queue one failed agent step for a new attempt.

        Only a terminal ``failed`` run and its failed agent step are eligible.
        Successful steps and unrelated failed branches are left untouched;
        every queued/skipped branch is made runnable again so the normal
        dependency scheduler can decide what is safe to execute.
        """
        with self._lock_for(run_id):
            run = self.load(run_id)
            if run.status != RUN_STATUS_FAILED:
                code = "retry_in_progress" if run.status in {
                    RUN_STATUS_QUEUED,
                    RUN_STATUS_RUNNING,
                    RUN_STATUS_WAITING_APPROVAL,
                } else "run_not_retryable"
                raise WorkflowRetryError(
                    code,
                    f"run {run_id} is {run.status!r}; only failed runs can retry",
                )
            step = run.steps.get(step_id)
            if step is None:
                raise WorkflowNotFoundError(f"run {run_id} has no step {step_id!r}")
            definition = run.workflow.step_map().get(step_id)
            if definition is None:
                raise WorkflowNotFoundError(f"run {run_id} has no step {step_id!r}")
            if definition.type != STEP_TYPE_AGENT:
                raise WorkflowRetryError(
                    "step_not_retryable",
                    f"step {step_id!r} is not an agent step",
                )
            if step.status != STEP_STATUS_FAILED:
                raise WorkflowRetryError(
                    "step_not_retryable",
                    f"step {step_id!r} is {step.status!r}; only failed steps can retry",
                )

            reset_ids = {
                candidate.id
                for candidate in run.workflow.steps
                if run.steps[candidate.id].status
                in {STEP_STATUS_QUEUED, STEP_STATUS_SKIPPED}
            }
            reset_ids.add(step_id)

            for candidate_id in reset_ids:
                candidate = run.steps[candidate_id]
                candidate.status = STEP_STATUS_QUEUED
                candidate.job_id = None
                candidate.started_at = None
                candidate.finished_at = None
                candidate.error = None
                candidate.output = None
                candidate.approval_token = None
                candidate.approval_expires_at = None
                candidate.approval_decision = None
                candidate.approval_resolved_at = None
                candidate.approval_resolved_by = None
            step.attempt += 1
            run.status = RUN_STATUS_QUEUED
            run.finished_at = None
            self._save(run)
            return run

    def begin_approval(
        self,
        run_id: str,
        step_id: str,
        *,
        token: str,
        expires_at: datetime | None,
    ) -> WorkflowRun:
        """Move a queued step into ``waiting_approval`` with a fresh token.

        The token comes from ``secrets.token_urlsafe`` at the runner and is
        persisted so any resolution must present it (guide 10.3).
        """
        with self._lock_for(run_id):
            run = self.load(run_id)
            step = run.steps.get(step_id)
            if step is None:
                raise WorkflowNotFoundError(f"run {run_id} has no step {step_id!r}")
            if step.status != STEP_STATUS_QUEUED:
                raise WorkflowTransitionError(
                    f"step {step_id!r} of run {run_id} is {step.status!r}, "
                    "cannot wait for approval"
                )
            step.status = STEP_STATUS_WAITING_APPROVAL
            step.approval_token = token
            step.approval_expires_at = expires_at
            step.started_at = datetime.now()
            self._save(run)
            return run

    def resolve_approval_step(
        self,
        run_id: str,
        step_id: str,
        *,
        token: str,
        approve: bool,
        decided_by: str,
    ) -> WorkflowRun:
        """Compare-and-set an approval decision on a waiting step.

        Idempotent: replaying the same decision with the same token returns
        the current run without side effects (guide 9.6). Mismatched tokens,
        conflicting decisions, expired approvals and non-waiting steps raise
        :class:`WorkflowApprovalError` with a wire-safe ``code``.
        """
        with self._lock_for(run_id):
            run = self.load(run_id)
            step = run.steps.get(step_id)
            if step is None:
                raise WorkflowNotFoundError(f"run {run_id} has no step {step_id!r}")
            decision = "approved" if approve else "rejected"
            if step.approval_decision is not None:
                if step.approval_decision == decision and step.approval_token == token:
                    return run
                raise WorkflowApprovalError(
                    "conflict",
                    f"approval for step {step_id!r} was already resolved",
                )
            if step.status != STEP_STATUS_WAITING_APPROVAL:
                raise WorkflowApprovalError(
                    "not_waiting",
                    f"step {step_id!r} is {step.status!r}, not waiting for approval",
                )
            if not token or not secrets.compare_digest(token, step.approval_token or ""):
                raise WorkflowApprovalError(
                    "invalid_token", "approval token does not match"
                )
            now = datetime.now()
            if step.approval_expires_at is not None and step.approval_expires_at <= now:
                step.status = STEP_STATUS_FAILED
                step.error = "Approval expired."
                step.finished_at = now
                self._save(run)
                raise WorkflowApprovalError(
                    "approval_expired", f"approval for step {step_id!r} has expired"
                )
            step.status = STEP_STATUS_SUCCEEDED if approve else STEP_STATUS_FAILED
            step.error = None if approve else f"Rejected by {decided_by}."
            step.finished_at = now
            step.approval_decision = decision
            step.approval_resolved_at = now
            step.approval_resolved_by = decided_by
            self._save(run)
            return run

    def reconcile_interrupted(self, run_id: str, *, reason: str) -> WorkflowRun:
        """Fail a run whose driver died with the process (restart recovery).

        ``running`` steps cannot be proven free of external side effects, so
        they are failed rather than blindly replayed (guide 7.6); steps that
        never started are skipped. Terminal and ``waiting_approval`` runs are
        returned untouched — approvals survive restarts by design.
        """
        with self._lock_for(run_id):
            run = self.load(run_id)
            if run.status in TERMINAL_RUN_STATUSES:
                return run
            if run.status == RUN_STATUS_WAITING_APPROVAL:
                return run
            now = datetime.now()
            for step in run.steps.values():
                if step.status == STEP_STATUS_RUNNING:
                    step.status = STEP_STATUS_FAILED
                    step.error = reason
                    step.finished_at = now
                elif step.status in (STEP_STATUS_QUEUED, STEP_STATUS_WAITING_APPROVAL):
                    step.status = STEP_STATUS_SKIPPED
                    step.error = reason
                    step.finished_at = now
            run.status = RUN_STATUS_FAILED
            run.finished_at = now
            self._save(run)
            return run


# ----------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------

# Executes one agent step to completion; returns the result summary. Must
# raise :class:`StepExecutionError` (or ``asyncio.CancelledError``) on
# failure. ``upstream`` maps dependency step IDs to their output dicts.
StepExecutor = Callable[
    [WorkflowRun, WorkflowStep, dict[str, dict[str, Any] | None]],
    Awaitable[str],
]

# Called after every persisted run change (UI projection / events).
RunObserver = Callable[[WorkflowRun], None]

# Optional per-run bootstrap hook (stock-module T21): invoked once right
# after the run snapshot is created and before the first step executes —
# e.g. building the evidence bundle for ``run.inputs["symbols"]``. Raising
# fails the run (queued -> failed) and propagates to the caller, so a
# missing prerequisite never silently produces an evidence-free run.
RunInitializer = Callable[[WorkflowRun], Awaitable[None]]


def compose_step_task(
    step: WorkflowStep,
    upstream: dict[str, dict[str, Any] | None],
    *,
    max_chars: int = MAX_UPSTREAM_DIGEST_CHARS,
    inputs: dict[str, Any] | None = None,
) -> str:
    """Build the downstream task text with a capped upstream digest.

    Only structured summaries and artifact references flow downstream —
    never full tool traces (guide 7.6). Run inputs (stock-module design
    4.2) ride along as a read-only ``[Run inputs]`` section; the model
    receives them as context and can never modify the stored snapshot.
    """
    task = step.task
    sections: list[str] = []
    if upstream:
        lines: list[str] = []
        for step_id, output in upstream.items():
            summary = ""
            artifacts: list[str] = []
            if output:
                raw_summary = output.get("summary")
                summary = raw_summary if isinstance(raw_summary, str) else ""
                raw_artifacts = output.get("artifacts")
                if isinstance(raw_artifacts, list):
                    from mona.agent.artifacts import coerce_artifact_ref

                    for raw in raw_artifacts:
                        ref = coerce_artifact_ref(raw)
                        artifacts.append(ref.uri if ref is not None else str(raw))
            entry = (
                f"### {step_id}"
                if step.agent_id in _ARTIFACT_ONLY_DOWNSTREAM_AGENT_IDS
                else f"### {step_id}\n{summary}"
            ).rstrip()
            if artifacts:
                entry += "\nArtifacts: " + ", ".join(artifacts)
            lines.append(entry)
        sections.append("[Upstream results]\n" + "\n\n".join(lines))
    if inputs:
        sections.append("[Run inputs]\n" + json.dumps(inputs, ensure_ascii=False))
    if not sections:
        return task
    digest = "\n\n".join(sections)
    if len(digest) > max_chars:
        digest = digest[: max_chars - 1] + "…"
    return f"{task}\n\n{digest}"


MAX_RUN_INPUTS_CHARS = 16_384


def validate_run_inputs(raw: Any) -> dict[str, Any]:
    """Validate caller-supplied run inputs: a JSON object within a size cap.

    Returns ``{}`` for ``None`` so existing call sites stay unchanged.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("workflow inputs must be a JSON object")
    if len(json.dumps(raw, ensure_ascii=False)) > MAX_RUN_INPUTS_CHARS:
        raise ValueError("workflow inputs exceed the 16 KiB limit")
    return raw


class WorkflowRunner:
    """Executes a WorkflowRun: serial/parallel scheduling, failure, cancel.

    Guide 7.6 algorithm: one active run per room; snapshot saved up front;
    ready steps run with bounded gather; approval steps pause the run;
    any step failure fails the run and skips downstream; cancellation
    cancels queued steps and lets running jobs finish through the job
    cancel path.
    """

    def __init__(
        self,
        *,
        run_store: WorkflowRunStore,
        step_executor: StepExecutor,
        observer: RunObserver | None = None,
        run_initializer: RunInitializer | None = None,
        max_parallel: int = 2,
        approval_ttl_seconds: float = 72 * 3600,
    ):
        self._runs = run_store
        self._execute = step_executor
        self._observer = observer
        self._run_initializer = run_initializer
        self._max_parallel = max(1, max_parallel)
        # Approvals outlive this TTL are failed on resolution or at startup
        # recovery, so a forgotten gate cannot pause a run forever.
        self._approval_ttl_seconds = approval_ttl_seconds
        self._room_locks: dict[str, asyncio.Lock] = {}
        self._room_locks_guard = threading.Lock()
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active: dict[str, str] = {}  # room_id -> run_id (in-process)

    def _room_lock(self, room_id: str) -> asyncio.Lock:
        with self._room_locks_guard:
            lock = self._room_locks.get(room_id)
            if lock is None:
                lock = asyncio.Lock()
                self._room_locks[room_id] = lock
            return lock

    def active_run_for_room(self, room_id: str) -> str | None:
        return self._active.get(room_id)

    def cancel_run(self, run_id: str) -> None:
        """Signal a run to cancel; the runner loop observes it between steps."""
        event = self._cancel_events.get(run_id)
        if event is not None:
            event.set()

    async def resume(self, run_id: str) -> WorkflowRun:
        """Re-drive a paused or never-started run from persisted state.

        Used after an approval resolves and by restart recovery. Unlike
        :meth:`run`, this waits for the room lock: a second approval landing
        while a sibling resume is mid-flight continues right after it
        instead of erroring out. Runs that reached a terminal state in the
        meantime are returned untouched.
        """
        run = self._runs.load(run_id)
        if run.status not in (RUN_STATUS_QUEUED, RUN_STATUS_WAITING_APPROVAL):
            raise WorkflowTransitionError(
                f"run {run_id} is {run.status!r}; only queued or "
                "waiting_approval runs can resume"
            )
        lock = self._room_lock(run.room_id)
        async with lock:
            run = self._runs.load(run_id)
            if run.status not in (RUN_STATUS_QUEUED, RUN_STATUS_WAITING_APPROVAL):
                return run
            cancel_event = asyncio.Event()
            self._cancel_events[run_id] = cancel_event
            self._active[run.room_id] = run_id
            try:
                return await self._drive(run, cancel_event)
            finally:
                self._cancel_events.pop(run_id, None)
                self._active.pop(run.room_id, None)

    def resolve_approval(
        self,
        *,
        run_id: str,
        step_id: str,
        token: str,
        approve: bool,
        decided_by: str = "user",
    ) -> WorkflowRun:
        """Resolve a waiting approval step (guide 7.6 step 8).

        Approval marks the step succeeded — the caller then resumes the run
        via :meth:`resume`. Rejection fails the step and cancels every
        remaining step. An expired approval fails the run. All state changes
        are compare-and-set, so duplicate clicks stay idempotent.
        """
        try:
            self._runs.resolve_approval_step(
                run_id, step_id, token=token, approve=approve, decided_by=decided_by,
            )
        except WorkflowApprovalError as exc:
            if exc.code == "approval_expired":
                self.fail_run(run_id, failed_step=step_id, reason="Approval expired.")
            raise
        if approve:
            run = self._runs.load(run_id)
            self._notify(run)
            return run
        run = self._cancel_remaining(
            run_id, f"Approval {step_id!r} rejected by {decided_by}."
        )
        self._notify(run)
        return run

    def fail_run(self, run_id: str, *, failed_step: str, reason: str) -> WorkflowRun:
        """Fail a paused run because *failed_step* can no longer proceed.

        Used for expired approvals (both at resolution time and during
        startup recovery); mirrors the in-loop failure path: step failed,
        run failed, transitive downstream skipped.
        """
        try:
            self._runs.transition_step(run_id, failed_step, STEP_STATUS_FAILED, error=reason)
        except WorkflowTransitionError:
            pass
        try:
            self._runs.transition(run_id, RUN_STATUS_FAILED)
        except WorkflowTransitionError:
            pass
        self._skip_downstream(run_id, failed_step=failed_step)
        run = self._runs.load(run_id)
        self._notify(run)
        return run

    def _notify(self, run: WorkflowRun) -> None:
        if self._observer is not None:
            try:
                self._observer(run)
            except Exception:
                logger.exception("Workflow run observer failed for {}", run.id)

    async def run(
        self,
        *,
        room_id: str,
        workflow: WorkflowDefinition,
        trigger_type: str = TRIGGER_MANUAL,
        started_by: str = "user",
        conversation: ConversationMetadata | None = None,
        registry: AgentRegistry | None = None,
        inputs: dict[str, Any] | None = None,
    ) -> WorkflowRun:
        """Run a workflow to a terminal state (or waiting_approval pause).

        Raises :class:`RunConflictError` when the room already has an active
        run — never queue a second one (guide 7.6).
        """
        lock = self._room_lock(room_id)
        if lock.locked():
            raise RunConflictError(f"room {room_id!r} already has an active run")
        async with lock:
            if conversation is not None:
                validate_workflow(workflow, conversation, registry)
            run = self._runs.create(
                room_id=room_id,
                workflow=workflow,
                trigger_type=trigger_type,
                started_by=started_by,
                inputs=inputs,
            )
            self._notify(run)
            if self._run_initializer is not None:
                try:
                    await self._run_initializer(run)
                except Exception:
                    logger.exception(
                        "Workflow run initializer failed for run {}", run.id
                    )
                    failed = self._runs.transition(run.id, RUN_STATUS_FAILED)
                    self._notify(failed)
                    raise
            cancel_event = asyncio.Event()
            self._cancel_events[run.id] = cancel_event
            self._active[room_id] = run.id
            try:
                return await self._drive(run, cancel_event)
            except asyncio.CancelledError:
                raise
            except Exception:
                # A crashing drive loop must not strand the persisted run in
                # a non-terminal state — the room UI keys off the stored
                # status and would show the workflow as "running" forever.
                logger.exception("Workflow run {} crashed", run.id)
                try:
                    crashed = self._runs.transition(run.id, RUN_STATUS_FAILED)
                    self._notify(crashed)
                except Exception:
                    logger.exception(
                        "Failed to mark workflow run {} failed", run.id
                    )
                raise
            finally:
                self._cancel_events.pop(run.id, None)
                self._active.pop(room_id, None)

    async def _drive(self, run: WorkflowRun, cancel_event: asyncio.Event) -> WorkflowRun:
        runs = self._runs
        runs.transition(run.id, RUN_STATUS_RUNNING)
        run = runs.load(run.id)
        self._notify(run)

        layers = execution_layers(run.workflow)
        step_map = run.workflow.step_map()

        def current() -> WorkflowRun:
            return runs.load(run.id)

        def outputs_of(step_ids: list[str]) -> dict[str, dict[str, Any] | None]:
            state = current()
            return {sid: state.steps[sid].output for sid in step_ids}

        for layer in layers:
            if cancel_event.is_set():
                run = self._cancel_remaining(run.id, "Cancelled by user.")
                return current()
            state = current()
            ready: list[str] = []
            blocked: list[tuple[str, list[str]]] = []
            for sid in layer:
                if state.steps[sid].status != STEP_STATUS_QUEUED:
                    continue
                dependencies = step_map[sid].depends_on
                dependency_states = {
                    dep: state.steps[dep].status for dep in dependencies
                }
                failed_dependencies = [
                    dep
                    for dep, status in dependency_states.items()
                    if status
                    in {
                        STEP_STATUS_FAILED,
                        STEP_STATUS_SKIPPED,
                        STEP_STATUS_CANCELLED,
                    }
                ]
                if failed_dependencies:
                    blocked.append((sid, failed_dependencies))
                elif all(
                    status == STEP_STATUS_SUCCEEDED
                    for status in dependency_states.values()
                ):
                    ready.append(sid)
            for sid, dependencies in blocked:
                try:
                    runs.transition_step(
                        run.id,
                        sid,
                        STEP_STATUS_SKIPPED,
                        error=(
                            "upstream step(s) cannot proceed: "
                            + ", ".join(dependencies)
                        ),
                    )
                except WorkflowTransitionError:
                    pass
            if not ready:
                # A resumed run can re-encounter a sibling approval that is
                # still waiting: pause again instead of walking past it.
                if any(current().steps[sid].status == STEP_STATUS_WAITING_APPROVAL
                       for sid in layer):
                    runs.transition(run.id, RUN_STATUS_WAITING_APPROVAL)
                    self._notify(current())
                    return current()
                continue

            # Approval steps pause the run; they never share a layer with
            # executable work in practice, but pause only after siblings
            # finish so parallel branches are not silently dropped.
            approvals = [sid for sid in ready
                         if step_map[sid].type == STEP_TYPE_APPROVAL]
            agents = [sid for sid in ready
                      if step_map[sid].type == STEP_TYPE_AGENT]

            failure = await self._run_agent_steps(run, agents, outputs_of, cancel_event)
            if failure is not None:
                runs.transition(run.id, RUN_STATUS_FAILED)
                self._skip_downstream(run.id, failed_step=failure)
                self._notify(current())
                return current()
            if cancel_event.is_set():
                self._cancel_remaining(run.id, "Cancelled by user.")
                return current()

            if approvals:
                for sid in approvals:
                    expires_at = (
                        datetime.now() + timedelta(seconds=self._approval_ttl_seconds)
                        if self._approval_ttl_seconds
                        else None
                    )
                    runs.begin_approval(
                        run.id,
                        sid,
                        token=secrets.token_urlsafe(16),
                        expires_at=expires_at,
                    )
                runs.transition(run.id, RUN_STATUS_WAITING_APPROVAL)
                self._notify(current())
                # Approval resolution resumes the run via resume(); the run
                # pauses here with every downstream step still queued.
                return current()

        state = current()
        if state.status == RUN_STATUS_RUNNING:
            if any(step.status == STEP_STATUS_FAILED for step in state.steps.values()):
                runs.transition(run.id, RUN_STATUS_FAILED)
            elif any(
                step.status
                in {
                    STEP_STATUS_QUEUED,
                    STEP_STATUS_RUNNING,
                    STEP_STATUS_WAITING_APPROVAL,
                }
                for step in state.steps.values()
            ):
                runs.transition(run.id, RUN_STATUS_FAILED)
            else:
                runs.transition(run.id, RUN_STATUS_SUCCEEDED)
        self._notify(current())
        return current()

    async def _run_agent_steps(
        self,
        run: WorkflowRun,
        step_ids: list[str],
        outputs_of: Callable[[list[str]], dict[str, dict[str, Any] | None]],
        cancel_event: asyncio.Event,
    ) -> str | None:
        """Run agent steps with bounded parallelism; returns failed step id."""
        if not step_ids:
            return None
        semaphore = asyncio.Semaphore(self._max_parallel)
        failed: dict[str, str] = {}

        async def _one(step_id: str) -> None:
            step = run.workflow.step_map()[step_id]
            async with semaphore:
                if cancel_event.is_set():
                    return
                runs = self._runs
                runs.transition_step(run.id, step_id, STEP_STATUS_RUNNING)
                self._notify(self._runs.load(run.id))
                upstream = outputs_of(step.depends_on)
                run_artifacts.begin(run.id, step_id)
                try:
                    summary = await self._execute(run, step, upstream)
                except asyncio.CancelledError:
                    run_artifacts.discard(run.id, step_id)
                    raise
                except StepExecutionError as exc:
                    run_artifacts.discard(run.id, step_id)
                    failed[step_id] = str(exc)
                    try:
                        runs.transition_step(
                            run.id, step_id, STEP_STATUS_FAILED, error=str(exc)
                        )
                    except WorkflowTransitionError:
                        pass
                    self._notify(self._runs.load(run.id))
                    return
                except Exception as exc:  # executor bugs fail the step, not the run loop
                    run_artifacts.discard(run.id, step_id)
                    logger.exception("Workflow step {} of run {} crashed", step_id, run.id)
                    failed[step_id] = str(exc)
                    try:
                        runs.transition_step(
                            run.id, step_id, STEP_STATUS_FAILED, error=str(exc)
                        )
                    except WorkflowTransitionError:
                        pass
                    self._notify(self._runs.load(run.id))
                    return
                try:
                    runs.transition_step(
                        run.id,
                        step_id,
                        STEP_STATUS_SUCCEEDED,
                        output={
                            "summary": summary,
                            "artifacts": run_artifacts.collect(run.id, step_id),
                        },
                    )
                except WorkflowTransitionError:
                    pass
                self._notify(self._runs.load(run.id))

        async with asyncio.TaskGroup() as group:
            for sid in step_ids:
                group.create_task(_one(sid))
        if failed:
            # Deterministic: report the earliest step in declaration order.
            return next(sid for sid in step_ids if sid in failed)
        return None

    def _cancel_remaining(self, run_id: str, reason: str) -> WorkflowRun:
        """Cancel every non-terminal step, then the run itself."""
        run = self._runs.load(run_id)
        for step_id, step in run.steps.items():
            if step.status in TERMINAL_STEP_STATUSES:
                continue
            try:
                self._runs.transition_step(
                    run_id, step_id, STEP_STATUS_CANCELLED, error=reason
                )
            except WorkflowTransitionError:
                pass
        return self._runs.transition(run_id, RUN_STATUS_CANCELLED)

    def _skip_downstream(self, run_id: str, *, failed_step: str) -> None:
        """Mark steps that transitively depend on *failed_step* as skipped."""
        run = self._runs.load(run_id)
        doomed: set[str] = {failed_step}
        changed = True
        while changed:
            changed = False
            for step in run.workflow.steps:
                if step.id in doomed:
                    continue
                if any(dep in doomed for dep in step.depends_on):
                    doomed.add(step.id)
                    changed = True
        for step_id in doomed:
            if step_id == failed_step:
                continue
            step = run.steps.get(step_id)
            if step is None or step.status in TERMINAL_STEP_STATUSES:
                continue
            try:
                self._runs.transition_step(
                    run_id, step_id, STEP_STATUS_SKIPPED,
                    error=f"upstream step {failed_step!r} failed",
                )
            except WorkflowTransitionError:
                pass


def serialize_run(run: WorkflowRun) -> dict[str, Any]:
    """Serialize a run for wire payloads (camelCase keys, JSON-safe)."""
    return run.model_dump(by_alias=True, mode="json")


def serialize_workflow(definition: WorkflowDefinition) -> dict[str, Any]:
    """Serialize a workflow definition for wire payloads."""
    return definition.model_dump(by_alias=True, mode="json")
