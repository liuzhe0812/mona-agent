"""Run-level artifact collector (stock-module design 4.3, dev plan T3).

The ``WorkflowRunner`` owns one pending-reference collector per step, keyed
by ``(run_id, step_id)``. Submission tools only know their ``job_id`` from
the ToolContext, so the step executor binds each created job to its
collector; tools then call :func:`append` with that job id.

On step success the runner drains the collector into
``StepRun.output["artifacts"]``; on failure the pending references are
discarded. Collectors are process-local and in-memory only — the artifact
files themselves are already persisted by the submission tools, so a
restart simply starts with empty collectors.
"""

from __future__ import annotations

import threading
from typing import Any

from mona.agent.artifacts import ArtifactRef, coerce_artifact_ref

_lock = threading.Lock()
_collectors: dict[tuple[str, str], list[dict[str, Any]]] = {}
_job_index: dict[str, tuple[str, str]] = {}
_job_refs: dict[str, list[dict[str, Any]]] = {}


def begin(run_id: str, step_id: str) -> None:
    """Start a fresh collector for one step execution."""
    with _lock:
        _collectors[(run_id, step_id)] = []


def bind(job_id: str, run_id: str, step_id: str) -> None:
    """Map a created AgentJob to its step collector."""
    with _lock:
        _job_index[job_id] = (run_id, step_id)
        _job_refs.setdefault(job_id, [])


def append(job_id: str, ref: ArtifactRef | dict[str, Any] | str) -> None:
    """Record a structured reference submitted inside *job_id*.

    Unknown or already-drained jobs are ignored — a late submission after
    the step finished must not leak into a later collector.
    """
    with _lock:
        artifact = coerce_artifact_ref(ref)
        if artifact is None:
            # Legacy URI values remain readable by old transcripts but are
            # not persisted as new workflow output.
            return
        payload = artifact.model_dump(mode="json")
        job_refs = _job_refs.setdefault(job_id, [])
        if not any(item.get("id") == payload.get("id") for item in job_refs):
            job_refs.append(payload)
        key = _job_index.get(job_id)
        if key is None:
            return
        collector = _collectors.get(key)
        if collector is not None and not any(item.get("id") == payload.get("id") for item in collector):
            collector.append(payload)


def peek_job(job_id: str) -> list[dict[str, Any]]:
    """Return a copy of refs produced by a job without draining its step."""
    with _lock:
        return [dict(item) for item in _job_refs.get(job_id, [])]


def discard_job(job_id: str) -> None:
    """Drop the process-local job projection after terminal failure."""
    with _lock:
        _job_refs.pop(job_id, None)


def collect(run_id: str, step_id: str) -> list[dict[str, Any]]:
    """Drain the step collector (destructive) and drop its job bindings."""
    with _lock:
        refs = _collectors.pop((run_id, step_id), [])
        for job_id, key in list(_job_index.items()):
            if key == (run_id, step_id):
                _job_refs.pop(job_id, None)
        _drop_bindings(run_id, step_id)
        return refs


def discard(run_id: str, step_id: str) -> None:
    """Drop the step collector and its job bindings without reading."""
    with _lock:
        _collectors.pop((run_id, step_id), None)
        for job_id, key in list(_job_index.items()):
            if key == (run_id, step_id):
                _job_refs.pop(job_id, None)
        _drop_bindings(run_id, step_id)


def _drop_bindings(run_id: str, step_id: str) -> None:
    doomed = [
        job_id
        for job_id, key in _job_index.items()
        if key == (run_id, step_id)
    ]
    for job_id in doomed:
        _job_index.pop(job_id, None)
