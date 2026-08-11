"""AgentJob model, state machine and file storage.

Multi-agent phase 2 (docs/design/multi-agent-development-guide.md sections
5.6 and 7.4). One JSON file per job under ``<workspace>/agent-jobs/``:

- ``AgentJob``: validated job model (``schema_version`` on write, unknown
  fields ignored on read for forward compatibility).
- Compare-and-set transitions: only an allowed predecessor state may enter a
  new state, so a cancelled/failed job never accepts a late success result.
- Atomic persistence: write temp file -> flush -> ``os.replace``.
- Per-room job queries.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from loguru import logger
from pydantic import Field, field_validator

from mona.agent.partners import normalize_agent_id
from mona.config.schema import Base

JOB_SCHEMA_VERSION = 1

JOB_STATUS_QUEUED = "queued"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_SUCCEEDED = "succeeded"
JOB_STATUS_FAILED = "failed"
JOB_STATUS_CANCELLED = "cancelled"

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]

TERMINAL_JOB_STATUSES = frozenset({
    JOB_STATUS_SUCCEEDED,
    JOB_STATUS_FAILED,
    JOB_STATUS_CANCELLED,
})

# Allowed predecessor states for each target state (compare-and-set semantics,
# guide 5.6). Terminal states have no outgoing transitions.
_ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    JOB_STATUS_RUNNING: frozenset({JOB_STATUS_QUEUED}),
    JOB_STATUS_SUCCEEDED: frozenset({JOB_STATUS_RUNNING}),
    JOB_STATUS_FAILED: frozenset({JOB_STATUS_QUEUED, JOB_STATUS_RUNNING}),
    JOB_STATUS_CANCELLED: frozenset({JOB_STATUS_QUEUED, JOB_STATUS_RUNNING}),
}

_JOB_ID_RE_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")


class JobTransitionError(ValueError):
    """Raised when a compare-and-set state transition is not allowed."""


class JobNotFoundError(KeyError):
    """Raised when a job file does not exist."""


class JobStorageError(RuntimeError):
    """Raised when a job file cannot be parsed (original file kept intact)."""


def can_transition(current: str, target: str) -> bool:
    """Return True when *current* may enter *target* under CAS semantics."""
    return target in _ALLOWED_TRANSITIONS and current in _ALLOWED_TRANSITIONS[target]


class AgentJob(Base):
    """One delegated task executed by a named agent inside a room (guide 5.6)."""

    schema_version: int = JOB_SCHEMA_VERSION
    id: str = Field(min_length=1)
    room_id: str = Field(min_length=1)
    requested_by: str = Field(min_length=1)
    assigned_to: str = Field(min_length=1)
    task: str = Field(min_length=1)
    success_criteria: str = ""
    status: JobStatus = JOB_STATUS_QUEUED
    workflow_run_id: str | None = None
    workflow_step_id: str | None = None
    parent_job_id: str | None = None
    attempt: int = 1
    result: str | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=datetime.now)
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != JOB_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported job schema_version {value}, expected {JOB_SCHEMA_VERSION}"
            )
        return value

    @field_validator("requested_by", "assigned_to")
    @classmethod
    def _check_agent_id(cls, value: str) -> str:
        return normalize_agent_id(value)

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate or any(ch not in _JOB_ID_RE_CHARS for ch in candidate):
            raise ValueError(f"Invalid job id {value!r}")
        return candidate


class AgentJobStore:
    """File-backed AgentJob storage; one JSON file per job, per-job locks.

    A single process owns the files; each job gets its own lock so one room
    never blocks unrelated rooms (guide 6.2). Corrupt files are never
    overwritten by reads — :meth:`load` raises and keeps the original bytes.
    """

    def __init__(self, jobs_dir: Path):
        self.jobs_dir = Path(jobs_dir)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    @staticmethod
    def default_dir(workspace: Path) -> Path:
        """Default jobs directory for a workspace (guide 6.1)."""
        return Path(workspace) / "agent-jobs"

    # ------------------------------------------------------------------
    # Paths and locks
    # ------------------------------------------------------------------

    def _path(self, job_id: str) -> Path:
        # Job IDs are validated on model load; validate raw caller input too
        # so a hostile ID can never escape the jobs directory.
        if not job_id or any(ch not in _JOB_ID_RE_CHARS for ch in job_id):
            raise ValueError(f"Invalid job id {job_id!r}")
        return self.jobs_dir / f"{job_id}.json"

    def _lock_for(self, job_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(job_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[job_id] = lock
            return lock

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def create(
        self,
        *,
        room_id: str,
        requested_by: str,
        assigned_to: str,
        task: str,
        success_criteria: str = "",
        workflow_run_id: str | None = None,
        workflow_step_id: str | None = None,
        parent_job_id: str | None = None,
    ) -> AgentJob:
        """Build and persist a new ``queued`` job."""
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        while self._path(job_id).exists():
            job_id = f"job_{uuid.uuid4().hex[:12]}"
        job = AgentJob(
            id=job_id,
            room_id=room_id,
            requested_by=requested_by,
            assigned_to=assigned_to,
            task=task,
            success_criteria=success_criteria,
            workflow_run_id=workflow_run_id,
            workflow_step_id=workflow_step_id,
            parent_job_id=parent_job_id,
        )
        self._save(job)
        return job

    def load(self, job_id: str) -> AgentJob:
        """Load a job by ID; corrupt files raise and are left untouched."""
        path = self._path(job_id)
        if not path.is_file():
            raise JobNotFoundError(job_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise JobStorageError(f"{path}: cannot read job file: {exc}") from exc
        if not isinstance(raw, dict):
            raise JobStorageError(f"{path}: job payload is not an object")
        from pydantic import ValidationError

        try:
            return AgentJob.model_validate(raw)
        except ValidationError as exc:
            raise JobStorageError(f"{path}: invalid job payload: {exc}") from exc

    def save(self, job: AgentJob) -> None:
        """Persist a job atomically under its own lock."""
        with self._lock_for(job.id):
            self._save(job)

    def _save(self, job: AgentJob) -> None:
        path = self._path(job.id)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(".json.tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(
                    job.model_dump(by_alias=True, mode="json"),
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
                f.flush()
            os.replace(tmp_path, path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    def list_for_room(self, room_id: str) -> list[AgentJob]:
        """List all jobs for a room, oldest first; corrupt files are skipped."""
        if not self.jobs_dir.is_dir():
            return []
        jobs: list[AgentJob] = []
        for path in sorted(self.jobs_dir.glob("job_*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise JobStorageError(f"{path}: job payload is not an object")
                job = AgentJob.model_validate(raw)
            except Exception as exc:
                logger.error("Skipping unreadable job file {}: {}", path, exc)
                continue
            if job.room_id == room_id:
                jobs.append(job)
        jobs.sort(key=lambda job: (job.created_at, job.id))
        return jobs

    # ------------------------------------------------------------------
    # Compare-and-set transitions
    # ------------------------------------------------------------------

    def transition(
        self,
        job_id: str,
        target: JobStatus,
        *,
        result: str | None = None,
        error: str | None = None,
    ) -> AgentJob:
        """Move a job to *target* when the current state allows it (CAS).

        Raises :class:`JobTransitionError` when the transition is illegal —
        e.g. a late success result arriving after cancellation.
        """
        with self._lock_for(job_id):
            job = self.load(job_id)
            if not can_transition(job.status, target):
                raise JobTransitionError(
                    f"job {job_id} cannot transition from {job.status!r} to {target!r}"
                )
            job.status = target
            now = datetime.now()
            if target == JOB_STATUS_RUNNING:
                job.started_at = now
            if target in TERMINAL_JOB_STATUSES:
                job.finished_at = now
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error
            self._save(job)
            return job

    def mark_running(self, job_id: str) -> AgentJob:
        return self.transition(job_id, JOB_STATUS_RUNNING)

    def mark_succeeded(self, job_id: str, *, result: str) -> AgentJob:
        return self.transition(job_id, JOB_STATUS_SUCCEEDED, result=result)

    def mark_failed(self, job_id: str, *, error: str) -> AgentJob:
        return self.transition(job_id, JOB_STATUS_FAILED, error=error)

    def mark_cancelled(self, job_id: str, *, error: str | None = None) -> AgentJob:
        return self.transition(job_id, JOB_STATUS_CANCELLED, error=error)


def serialize_job(job: AgentJob) -> dict[str, Any]:
    """Serialize a job for wire payloads (camelCase keys, JSON-safe)."""
    return job.model_dump(by_alias=True, mode="json")
