"""Versioned, validated records used by the academic research agent.

The records intentionally contain provenance rather than generated prose.  A
store can therefore reject an unsupported fact, a dangling map edge, or a
claimed successful experiment without needing to understand the research
content itself.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import AliasChoices, ConfigDict, Field, field_validator, model_validator

from mona.config.schema import Base

ACADEMIC_SCHEMA_VERSION = 1

_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_ABSOLUTE_WINDOWS_RE = re.compile(r"^[A-Za-z]:[\\/]")

ClaimType = Literal["fact", "inference", "hypothesis"]
ClaimSupport = Literal["support", "conflict", "context"]
ExperimentStatus = Literal[
    "planned", "running", "succeeded", "failed", "rejected", "accepted"
]
MetricDirection = Literal["maximize", "minimize"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str, field_name: str) -> str:
    candidate = value.strip()
    if not candidate or candidate != value or not _ID_RE.fullmatch(candidate):
        raise ValueError(
            f"{field_name} must contain only letters, numbers, '_' or '-' and must not be a path"
        )
    if ".." in candidate:
        raise ValueError(f"{field_name} must not contain '..'")
    return candidate


def _safe_relative_path(value: str, field_name: str = "path") -> str:
    candidate = value.strip()
    if not candidate:
        raise ValueError(f"{field_name} must be a non-empty relative path")
    if candidate.startswith(("/", "\\", "~")) or _ABSOLUTE_WINDOWS_RE.match(candidate):
        raise ValueError(f"{field_name} must be relative")
    parts = re.split(r"[/\\]", candidate)
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"{field_name} contains an unsafe path segment")
    return "/".join(parts)


def _safe_id_list(values: list[str], field_name: str) -> list[str]:
    return [_safe_id(value, field_name) for value in values]


class AcademicModel(Base):
    """Common Pydantic contract for all persisted academic records."""

    schema_version: int = ACADEMIC_SCHEMA_VERSION
    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != ACADEMIC_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported academic schema_version {value}; "
                f"expected {ACADEMIC_SCHEMA_VERSION}"
            )
        return value


class SourceRecord(AcademicModel):
    """A source and its unmodified, explicitly known academic metadata."""

    source_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("source_id", "id", "sourceId"),
        serialization_alias="source_id",
    )
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    published_at: str | None = None
    venue: str | None = None
    source_type: str = "paper"
    doi: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    arxiv_id: str | None = None
    nct_id: str | None = None
    url: str | None = None
    abstract: str | None = None
    retrieved_at: str = Field(default_factory=_now_iso)
    provider: str
    providers: list[str] = Field(default_factory=list)
    version: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("source_id")
    @classmethod
    def _check_source_id(cls, value: str) -> str:
        return _safe_id(value, "source_id")

    @field_validator("authors", "providers")
    @classmethod
    def _clean_lists(cls, value: list[str]) -> list[str]:
        return [entry.strip() for entry in value if entry.strip()]

    @field_validator("provider")
    @classmethod
    def _check_provider(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("provider must not be empty")
        return value.strip()

    @property
    def id(self) -> str:
        """Compatibility accessor for provider code that calls this field ``id``."""

        return self.source_id


class EvidenceLocator(AcademicModel):
    """A precise location within a source, including abstract-only evidence."""

    kind: str = Field(min_length=1)
    value: str | None = None
    context: str | None = None

    @model_validator(mode="after")
    def _check_value(self) -> EvidenceLocator:
        if self.kind != "abstract" and not self.value:
            raise ValueError("non-abstract locators require a value")
        return self


class EvidenceClaim(AcademicModel):
    """A fact, inference, or explicitly pending hypothesis."""

    claim_id: str = Field(min_length=1)
    claim_type: ClaimType
    claim_text: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    evidence_text: str | None = None
    locator: EvidenceLocator | None = None
    basis: str | None = None
    supports: ClaimSupport | None = None
    limitations: list[str] = Field(default_factory=list)
    missing_reason: str | None = None
    verified_at: str | None = None
    verification_status: Literal["pending", "verified", "rejected"] = Field(
        default="pending",
        validation_alias=AliasChoices(
            "verification_status", "status", "verificationStatus"
        ),
        serialization_alias="verification_status",
    )

    @field_validator("claim_id")
    @classmethod
    def _check_claim_id(cls, value: str) -> str:
        return _safe_id(value, "claim_id")

    @field_validator("source_ids")
    @classmethod
    def _check_source_ids(cls, value: list[str], info: Any) -> list[str]:
        return _safe_id_list(value, info.field_name.rstrip("s"))

    @model_validator(mode="after")
    def _check_evidence(self) -> EvidenceClaim:
        if self.claim_type == "fact":
            if not self.source_ids:
                raise ValueError("fact claims require source_ids")
            if self.locator is None:
                raise ValueError("fact claims require a locator")
        elif self.claim_type == "inference":
            if not self.source_ids:
                raise ValueError("inference claims require source_ids")
            if not (self.basis or self.evidence_text):
                raise ValueError("inference claims require basis or evidence_text")
        elif self.verification_status != "pending":
            # A hypothesis can be promoted only by a later recorded result;
            # the initial record must never silently look like an established fact.
            raise ValueError("hypothesis claims must be marked pending")
        return self


class KnowledgeNode(AcademicModel):
    """One node in a source-backed knowledge map."""

    node_id: str = Field(min_length=1)
    node_type: Literal["paper", "concept", "method", "dataset", "hypothesis"]
    label: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    claim_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("node_id")
    @classmethod
    def _check_node_id(cls, value: str) -> str:
        return _safe_id(value, "node_id")

    @field_validator("source_ids", "claim_ids")
    @classmethod
    def _check_source_ids(cls, value: list[str]) -> list[str]:
        return _safe_id_list(value, "source_id")


class KnowledgeEdge(AcademicModel):
    """A source-backed relation between two knowledge-map nodes."""

    edge_id: str = Field(min_length=1)
    source_node_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("source_node_id", "from_node_id", "sourceNodeId"),
        serialization_alias="source_node_id",
    )
    target_node_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("target_node_id", "to_node_id", "targetNodeId"),
        serialization_alias="target_node_id",
    )
    relation: Literal["supports", "conflicts", "uses", "extends", "gap"]
    source_ids: list[str] = Field(min_length=1)
    claim_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("edge_id", "source_node_id", "target_node_id")
    @classmethod
    def _check_edge_ids(cls, value: str, info: Any) -> str:
        return _safe_id(value, info.field_name)

    @field_validator("source_ids", "claim_ids")
    @classmethod
    def _check_source_ids(cls, value: list[str]) -> list[str]:
        return _safe_id_list(value, "source_id")


class KnowledgeMap(AcademicModel):
    """A complete map whose edges cannot dangle."""

    nodes: list[KnowledgeNode] = Field(default_factory=list)
    edges: list[KnowledgeEdge] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_graph(self) -> KnowledgeMap:
        node_ids = [node.node_id for node in self.nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("knowledge map contains duplicate node_id")
        node_set = set(node_ids)
        for edge in self.edges:
            if edge.source_node_id not in node_set or edge.target_node_id not in node_set:
                raise ValueError(
                    f"knowledge edge {edge.edge_id!r} references a missing node"
                )
        return self


class MetricSource(AcademicModel):
    """A deterministic metric source; never a model-supplied numeric value."""

    kind: Literal["json", "stdout_regex", "regex", "stdout"] = Field(
        validation_alias=AliasChoices("kind", "type"),
        serialization_alias="kind",
    )
    path: str = Field(min_length=1)
    key: str | None = None
    pattern: str | None = None
    group: int | str = 1

    @field_validator("path")
    @classmethod
    def _check_metric_path(cls, value: str) -> str:
        return _safe_relative_path(value, "metrics_source.path")

    @model_validator(mode="after")
    def _check_metric_source(self) -> MetricSource:
        if self.kind == "json" and not self.key:
            raise ValueError("JSON metric sources require key")
        if self.kind in {"stdout_regex", "regex", "stdout"} and not self.pattern:
            raise ValueError("stdout regex metric sources require pattern")
        if isinstance(self.group, str) and not self.group.strip():
            raise ValueError("regex metric source group must not be empty")
        if isinstance(self.group, int) and self.group < 0:
            raise ValueError("regex metric source group must be non-negative")
        return self


class ExperimentRun(AcademicModel):
    """One planned or actually executed experiment."""

    run_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("run_id", "id", "runId"),
        serialization_alias="run_id",
    )
    status: ExperimentStatus = "planned"
    command: str | None = None
    working_dir: str | None = None
    source_dir: str | None = None
    isolated_dir: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    metrics_source: MetricSource | str | None = None
    metrics: dict[str, float] = Field(default_factory=dict)
    input_hashes: dict[str, str] = Field(default_factory=dict)
    data_hash: str | None = None
    code_hash: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    random_seed: int | None = None
    input_file_count: int | None = Field(default=None, ge=0)
    input_total_bytes: int | None = Field(default=None, ge=0)
    stdout_path: str | None = None
    stderr_path: str | None = None
    artifact_paths: list[str] = Field(default_factory=list)
    decision_reason: str | None = None
    metric_name: str | None = None
    metric_unit: str | None = Field(
        default=None,
        validation_alias=AliasChoices("metric_unit", "unit", "metricUnit"),
        serialization_alias="metric_unit",
    )
    metric_direction: MetricDirection | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "metric_direction", "direction", "metricDirection"
        ),
        serialization_alias="metric_direction",
    )
    evaluation_command: str | None = None
    baseline_value: float | None = None
    candidate_value: float | None = None
    comparison: Literal["baseline", "accepted", "rejected"] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("run_id")
    @classmethod
    def _check_run_id(cls, value: str) -> str:
        return _safe_id(value, "run_id")

    @field_validator("artifact_paths")
    @classmethod
    def _check_artifact_paths(cls, value: list[str]) -> list[str]:
        return [_safe_relative_path(entry, "artifact_path") for entry in value]

    @field_validator("metrics")
    @classmethod
    def _check_finite_metrics(cls, value: dict[str, float]) -> dict[str, float]:
        for name, metric in value.items():
            if not math.isfinite(metric):
                raise ValueError(f"metric {name!r} must be finite")
        return value

    @field_validator("metric_name")
    @classmethod
    def _check_metric_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("metric_name must not be empty")
        return value

    @field_validator("baseline_value", "candidate_value")
    @classmethod
    def _check_finite_metric_value(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("metric comparison values must be finite")
        return value

    @model_validator(mode="after")
    def _check_result(self) -> ExperimentRun:
        if self.status in {"succeeded", "accepted", "rejected"}:
            missing: list[str] = []
            if not self.command:
                missing.append("command")
            if self.exit_code is None:
                missing.append("exit_code")
            if self.metrics_source is None:
                missing.append("metrics_source")
            if missing:
                raise ValueError(
                    "successful experiment records require " + ", ".join(missing)
                )
            if self.exit_code != 0:
                raise ValueError("successful experiment records require exit_code == 0")
        elif self.exit_code is not None and self.exit_code != 0 and self.status != "failed":
            raise ValueError("non-zero exit_code is only valid for failed experiments")
        return self


class DeliverableRecord(AcademicModel):
    """A user-facing output tied back to claims and/or experiment runs."""

    deliverable_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    path: str = Field(min_length=1)
    title: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    claim_ids: list[str] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    registered_at: str = Field(default_factory=_now_iso)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("deliverable_id")
    @classmethod
    def _check_deliverable_id(cls, value: str) -> str:
        return _safe_id(value, "deliverable_id")

    @field_validator("path")
    @classmethod
    def _check_path(cls, value: str) -> str:
        return _safe_relative_path(value)

    @field_validator("source_ids", "claim_ids", "run_ids")
    @classmethod
    def _check_references(cls, value: list[str]) -> list[str]:
        return _safe_id_list(value, "record_id")


class ResearchManifest(AcademicModel):
    """The task-level index for a research workspace."""

    task_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("task_id", "id", "taskId"),
        serialization_alias="task_id",
    )
    goal: str = ""
    status: Literal["active", "completed", "failed", "archived"] = "active"
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    artifacts: dict[str, str] = Field(default_factory=dict)
    source_ids: list[str] = Field(default_factory=list)
    claim_ids: list[str] = Field(default_factory=list)
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    deliverable_ids: list[str] = Field(default_factory=list)

    @field_validator("task_id")
    @classmethod
    def _check_task_id(cls, value: str) -> str:
        return _safe_id(value, "task_id")

    @field_validator("artifacts")
    @classmethod
    def _check_artifacts(cls, value: dict[str, str]) -> dict[str, str]:
        return {
            name: _safe_relative_path(path, f"artifacts[{name!r}]")
            for name, path in value.items()
        }

    @field_validator("source_ids", "claim_ids", "node_ids", "edge_ids", "run_ids", "deliverable_ids")
    @classmethod
    def _check_manifest_ids(cls, value: list[str]) -> list[str]:
        return _safe_id_list(value, "manifest reference")
