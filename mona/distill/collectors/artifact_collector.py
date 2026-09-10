"""Collect explicitly delivered artifacts from visible WebUI transcripts.

This collector intentionally has a narrow input boundary.  Callers provide the
session keys that are already known to be visible; the collector only reads
``deliver_files`` transcript events and only accepts structured ``ArtifactRef``
payloads.  It never scans workspaces, session bodies, tool traces, or hidden
artifact stores.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from loguru import logger

from mona.agent.artifacts import ArtifactRef
from mona.webui import transcript

_MAX_TRANSCRIPT_FILE_BYTES = 8 * 1024 * 1024
_ARTIFACT_REF_FIELDS = (
    "id",
    "owner_kind",
    "owner_id",
    "relative_path",
    "created_by_agent_id",
    "created_at",
    "product",
    "session_id",
    "room_id",
    "job_id",
    "workflow_run_id",
    "workflow_step_id",
    "size",
    "modified_at",
    "mime",
)


@dataclass
class ArtifactRecord:
    """One deduplicated, explicitly delivered artifact projection."""

    id: str
    title: str
    mime: str | None
    first_recorded_at: str | None
    session_key: str
    room_id: str | None
    created_by_agent_id: str
    artifact_ref: dict[str, Any]
    source_ref: str
    missing: bool = False
    artifact_ref_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "mime": self.mime,
            "first_recorded_at": self.first_recorded_at,
            "session_key": self.session_key,
            "room_id": self.room_id,
            "created_by_agent_id": self.created_by_agent_id,
            "artifact_ref": self.artifact_ref,
            "source_ref": self.source_ref,
            "missing": self.missing,
            "artifact_ref_ids": list(self.artifact_ref_ids),
        }


@dataclass
class ArtifactStats:
    """Artifacts and source coverage collected from visible sessions."""

    artifacts: list[ArtifactRecord] = field(default_factory=list)
    scanned_sessions: int = 0
    unknown_time_count: int = 0
    truncated_count: int = 0
    partial: bool = False
    partial_reasons: list[str] = field(default_factory=list)
    recent: bool = False

    @property
    def total_artifacts(self) -> int:
        return len(self.artifacts)

    @property
    def earliest(self) -> str | None:
        dates = [
            (_parse_timestamp(item.first_recorded_at), item.first_recorded_at)
            for item in self.artifacts
            if item.first_recorded_at
        ]
        dates = [item for item in dates if item[0] is not None]
        return min(dates, key=lambda item: item[0])[1] if dates else None

    @property
    def latest(self) -> str | None:
        dates = [
            (_parse_timestamp(item.first_recorded_at), item.first_recorded_at)
            for item in self.artifacts
            if item.first_recorded_at
        ]
        dates = [item for item in dates if item[0] is not None]
        return max(dates, key=lambda item: item[0])[1] if dates else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_artifacts": self.total_artifacts,
            "artifacts": [item.to_dict() for item in self.artifacts],
            "earliest": self.earliest,
            "latest": self.latest,
            "coverage": {
                "source": "artifacts",
                "status": "partial" if self.partial else "available",
                "scanned_count": self.scanned_sessions,
                "selected_count": self.total_artifacts,
                "unknown_time_count": self.unknown_time_count,
                "truncated_count": self.truncated_count,
                "earliest": self.earliest,
                "latest": self.latest,
                "reason_code": ";".join(self.partial_reasons) if self.partial_reasons else None,
            },
        }


@dataclass
class _ArtifactAccumulator:
    key: tuple[str, str, str, str, str]
    record: ArtifactRecord
    known_dates: list[tuple[datetime, str]] = field(default_factory=list)


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalise_relative_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = value.replace("\\", "/")
    normalised = posixpath.normpath(path)
    if not normalised or normalised in {".", ".."}:
        return None
    if normalised.startswith("/") or normalised.startswith("../"):
        return None
    if "\x00" in normalised:
        return None
    return normalised


def _stable_id(key: tuple[str, str, str, str, str]) -> str:
    digest = hashlib.sha256("\0".join(key).encode("utf-8")).hexdigest()
    return f"artifact_{digest[:32]}"


def _validated_ref(raw: Any) -> tuple[ArtifactRef | None, dict[str, Any] | None, bool]:
    """Validate a raw ref without letting Pydantic invent ``created_at``."""
    if not isinstance(raw, dict):
        return None, None, False
    raw_created_at = raw.get("created_at")
    missing_time = _parse_timestamp(raw_created_at) is None
    candidate = dict(raw)
    if missing_time:
        # ``ArtifactRef`` has a default timestamp.  Use a non-current sentinel
        # solely for field validation, then remove it from the serialized ref.
        candidate["created_at"] = "1970-01-01T00:00:00+00:00"
    try:
        ref = ArtifactRef.model_validate(candidate)
    except Exception:
        return None, None, missing_time
    payload = {name: value for name, value in ref.model_dump(mode="json").items() if name in _ARTIFACT_REF_FIELDS}
    if missing_time:
        payload.pop("created_at", None)
    elif isinstance(raw_created_at, str):
        # Keep the persisted representation for the first-recorded timestamp;
        # normalization is only used for comparisons and window filtering.
        payload["created_at"] = raw_created_at.strip()
    return ref, payload, missing_time


def _transcript_state(session_key: str) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Read one transcript and report oversize/corrupt coverage separately."""
    path = transcript.webui_transcript_path(session_key)
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return [], False, None
    except OSError:
        return [], True, "transcript_unreadable"

    if size > _MAX_TRANSCRIPT_FILE_BYTES:
        # The shared reader deliberately skips oversize files.  Preserve that
        # behavior and expose the loss as partial coverage for this collector.
        transcript.read_transcript_lines(session_key)
        return [], True, "transcript_too_large"

    corrupt = False
    try:
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    try:
                        if not isinstance(json.loads(line), dict):
                            corrupt = True
                    except json.JSONDecodeError:
                        corrupt = True
    except (OSError, UnicodeError):
        return [], True, "transcript_unreadable"

    try:
        records = transcript.read_transcript_lines(session_key)
    except Exception:
        logger.exception("artifact transcript read failed for {}", session_key)
        return [], True, "transcript_unreadable"
    return records, corrupt, "transcript_corrupt" if corrupt else None


def collect_artifacts(
    visible_session_keys: Iterable[str],
    *,
    source_scope_id: str = "default",
    since: datetime | None = None,
    until: datetime | None = None,
) -> ArtifactStats:
    """Collect explicit ``deliver_files`` ArtifactRefs from visible sessions.

    ``since``/``until`` use a half-open interval.  When a window is supplied,
    artifacts without an explicit raw ``created_at`` are retained in coverage
    counts but excluded from the returned recent list.
    """
    stats = ArtifactStats(recent=since is not None or until is not None)
    source_scope_id = str(source_scope_id or "default")
    accumulators: dict[tuple[str, str, str, str, str], _ArtifactAccumulator] = {}
    seen_sessions: set[str] = set()

    since_utc = _parse_timestamp(since.isoformat()) if since is not None else None
    until_utc = _parse_timestamp(until.isoformat()) if until is not None else None

    for raw_session_key in visible_session_keys:
        if not isinstance(raw_session_key, str) or not raw_session_key.strip():
            continue
        session_key = raw_session_key.strip()
        if session_key in seen_sessions:
            continue
        seen_sessions.add(session_key)
        stats.scanned_sessions += 1
        records, partial, reason = _transcript_state(session_key)
        if partial:
            stats.partial = True
            if reason == "transcript_too_large":
                stats.truncated_count += 1
            if reason and reason not in stats.partial_reasons:
                stats.partial_reasons.append(reason)

        for record in records:
            if record.get("event") != "deliver_files":
                continue
            files = record.get("files")
            if not isinstance(files, list):
                continue
            for file_row in files:
                if not isinstance(file_row, dict):
                    continue
                ref, ref_payload, missing_time = _validated_ref(file_row.get("artifact_ref"))
                if ref is None or ref_payload is None:
                    continue
                relative_path = _normalise_relative_path(ref.relative_path)
                if relative_path is None:
                    continue
                key = (
                    source_scope_id,
                    ref.owner_kind,
                    ref.product or "",
                    ref.owner_id,
                    relative_path,
                )
                stable_id = _stable_id(key)
                title = str(file_row.get("name") or Path(relative_path).name)
                mime = file_row.get("mime") or ref.mime
                raw_id = ref_payload.get("id")
                ref_ids = [raw_id] if isinstance(raw_id, str) and raw_id else []
                accumulator = accumulators.get(key)
                if accumulator is None:
                    accumulator = _ArtifactAccumulator(
                        key=key,
                        record=ArtifactRecord(
                            id=stable_id,
                            title=title,
                            mime=mime if isinstance(mime, str) else None,
                            first_recorded_at=None,
                            session_key=session_key,
                            room_id=ref.room_id,
                            created_by_agent_id=ref.created_by_agent_id,
                            artifact_ref=ref_payload,
                            source_ref=f"artifact:{stable_id}",
                            missing=file_row.get("missing") is True,
                            artifact_ref_ids=ref_ids,
                        ),
                    )
                    accumulators[key] = accumulator
                else:
                    for ref_id in ref_ids:
                        if ref_id not in accumulator.record.artifact_ref_ids:
                            accumulator.record.artifact_ref_ids.append(ref_id)
                    if file_row.get("missing") is True:
                        accumulator.record.missing = True

                if missing_time:
                    continue
                parsed = _parse_timestamp(ref_payload.get("created_at"))
                if parsed is not None:
                    accumulator.known_dates.append((parsed, str(ref_payload["created_at"])))

    output: list[ArtifactRecord] = []
    for accumulator in accumulators.values():
        record = accumulator.record
        if accumulator.known_dates:
            _first_date, first_raw = min(accumulator.known_dates, key=lambda item: item[0])
            record.first_recorded_at = first_raw
        else:
            stats.unknown_time_count += 1

        if stats.recent:
            parsed = _parse_timestamp(record.first_recorded_at)
            if parsed is None:
                continue
            if since_utc is not None and parsed < since_utc:
                continue
            if until_utc is not None and parsed >= until_utc:
                continue
        output.append(record)

    output.sort(
        key=lambda item: (
            item.first_recorded_at is not None,
            _parse_timestamp(item.first_recorded_at) or datetime.min.replace(tzinfo=timezone.utc),
            item.id,
        ),
        reverse=True,
    )
    stats.artifacts = output
    return stats


def collect_artifact_stats(
    visible_session_keys: Iterable[str],
    **kwargs: Any,
) -> ArtifactStats:
    """Compatibility alias matching the other distillation collector names."""
    return collect_artifacts(visible_session_keys, **kwargs)


__all__ = ["ArtifactRecord", "ArtifactStats", "collect_artifacts", "collect_artifact_stats"]
