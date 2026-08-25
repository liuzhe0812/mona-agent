"""Workspace-scoped JSON/JSONL storage for academic research records."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mona.agent.tools.path_utils import resolve_workspace_path

from .models import (
    DeliverableRecord,
    EvidenceClaim,
    ExperimentRun,
    KnowledgeMap,
    MetricSource,
    ResearchManifest,
    SourceRecord,
    _safe_id,
    _safe_relative_path,
)


class ResearchStoreError(RuntimeError):
    """Base error for a corrupt or otherwise unusable research ledger."""


class ResearchStoreConflictError(ValueError):
    """Raised when a caller would silently overwrite an existing record."""


class ResearchStoreNotFoundError(FileNotFoundError):
    """Raised when a requested research task or artifact does not exist."""


MAX_EXPERIMENT_FILES = 10_000
MAX_EXPERIMENT_BYTES = 512 * 1024 * 1024
IGNORED_SOURCE_DIRS = frozenset({".git", ".venv", "node_modules", "__pycache__"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_model(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return dict(value)
    raise TypeError("record must be a Pydantic model or JSON object")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write one JSON document without exposing a partial replacement."""

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            tmp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        tmp_name = None
    finally:
        if tmp_name:
            try:
                Path(tmp_name).unlink()
            except FileNotFoundError:
                pass


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as exc:
        raise ResearchStoreNotFoundError(f"missing {label}: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ResearchStoreError(f"corrupt {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ResearchStoreError(f"corrupt {label}: expected a JSON object: {path}")
    return value


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ResearchStoreError(
                        f"corrupt {label} at line {line_no}: {path}: {exc}"
                    ) from exc
                if not isinstance(record, dict):
                    raise ResearchStoreError(
                        f"corrupt {label} at line {line_no}: expected a JSON object"
                    )
                records.append(record)
    except OSError as exc:
        raise ResearchStoreError(f"cannot read {label}: {path}: {exc}") from exc
    return records


def _append_jsonl(path: Path, payload: dict[str, Any], label: str) -> None:
    # Parse the existing file before append. A broken ledger must remain
    # visible and actionable; never replace it with an empty file.
    _read_jsonl(path, label)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise ResearchStoreError(f"cannot append {label}: {path}: {exc}") from exc


def _atomic_write_jsonl(path: Path, rows: list[dict[str, Any]], label: str) -> None:
    """Rewrite a JSONL ledger atomically after an upsert merge."""

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            tmp_name = handle.name
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        tmp_name = None
    except OSError as exc:
        raise ResearchStoreError(f"cannot rewrite {label}: {path}: {exc}") from exc
    finally:
        if tmp_name:
            try:
                Path(tmp_name).unlink()
            except FileNotFoundError:
                pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_files(source_dir: Path) -> tuple[list[tuple[str, Path, int]], int]:
    """List regular source files while rejecting every symlink in the tree."""

    files: list[tuple[str, Path, int]] = []

    def visit(directory: Path, relative: Path) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda entry: entry.name.casefold())
        except OSError as exc:
            raise ValueError(f"cannot inspect source directory: {directory}: {exc}") from exc
        for entry in entries:
            if entry.is_symlink():
                raise ValueError(f"symlink is not allowed in source directory: {entry}")
            entry_relative = relative / entry.name
            if entry.is_dir():
                if entry.name in IGNORED_SOURCE_DIRS:
                    continue
                visit(entry, entry_relative)
                continue
            if not entry.is_file():
                raise ValueError(f"unsupported non-file source entry: {entry}")
            try:
                size = entry.stat().st_size
            except OSError as exc:
                raise ValueError(f"cannot stat source file: {entry}: {exc}") from exc
            files.append((entry_relative.as_posix(), entry, size))

    visit(source_dir, Path())
    return files, sum(size for _, _, size in files)


def _mermaid_text(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _render_knowledge_map_markdown(knowledge_map: KnowledgeMap) -> str:
    """Render the persisted graph as deterministic, previewable Mermaid."""

    max_nodes_per_block = 60
    chunks = [
        knowledge_map.nodes[index:index + max_nodes_per_block]
        for index in range(0, len(knowledge_map.nodes), max_nodes_per_block)
    ] or [[]]
    lines = ["# Knowledge map", ""]
    for chunk in chunks:
        chunk_ids = {node.node_id for node in chunk}
        lines.extend(["```mermaid", "graph LR"])
        for node in chunk:
            label = f"{node.node_type}: {node.label}"
            lines.append(f'  {node.node_id}["{_mermaid_text(label)}"]')
        for edge in knowledge_map.edges:
            # Assign a cross-block edge to the block containing its source.
            if edge.source_node_id not in chunk_ids:
                continue
            provenance = ", ".join(edge.source_ids)
            if edge.claim_ids:
                provenance += f"; claims: {', '.join(edge.claim_ids)}"
            label = _mermaid_text(f"{edge.relation}; {provenance}")
            lines.append(
                f"  {edge.source_node_id} -->|{label}| {edge.target_node_id}"
            )
        lines.extend(["```", ""])
    lines.extend(["## Provenance", ""])
    for node in knowledge_map.nodes:
        lines.append(
            f"- `{node.node_id}` sources: {', '.join(node.source_ids) or 'none'}; "
            f"claims: {', '.join(node.claim_ids) or 'none'}"
        )
    for edge in knowledge_map.edges:
        lines.append(
            f"- `{edge.edge_id}` sources: {', '.join(edge.source_ids)}; "
            f"claims: {', '.join(edge.claim_ids) or 'none'}"
        )
    return "\n".join(lines) + "\n"


class ResearchRecordStore:
    """Store one research task beneath ``<workspace>/research/<task_id>``."""

    def __init__(self, workspace: str | Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.research_root = resolve_workspace_path("research", self.workspace, self.workspace)
        self.research_root.mkdir(parents=True, exist_ok=True)

    def __enter__(self) -> ResearchRecordStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the store; file handles are intentionally short-lived."""

    @staticmethod
    def validate_task_id(task_id: str) -> str:
        return _safe_id(task_id, "task id")

    def task_dir(self, task_id: str, *, create: bool = False) -> Path:
        safe_id = self.validate_task_id(task_id)
        task_dir = resolve_workspace_path(
            f"research/{safe_id}", self.workspace, self.workspace
        )
        if create:
            task_dir.mkdir(parents=True, exist_ok=True)
        return task_dir

    def _manifest_path(self, task_id: str) -> Path:
        return self._artifact_path(task_id, "manifest.json", create_parent=False)

    def _artifact_path(
        self, task_id: str, relative_path: str, *, create_parent: bool = True
    ) -> Path:
        task_dir = self.task_dir(task_id, create=create_parent)
        safe_path = _safe_relative_path(relative_path)
        resolved = resolve_workspace_path(safe_path, task_dir, task_dir)
        if create_parent:
            resolved.parent.mkdir(parents=True, exist_ok=True)
        return resolved

    def read_artifact(self, task_id: str, relative_path: str) -> Path:
        path = self._artifact_path(task_id, relative_path)
        if not path.is_file():
            raise ResearchStoreNotFoundError(f"artifact not found: {relative_path}")
        return path

    def init(self, task_id: str, goal: str = "") -> ResearchManifest:
        """Create a task manifest, or return it unchanged when already present."""

        safe_id = self.validate_task_id(task_id)
        task_dir = self.task_dir(safe_id, create=True)
        manifest_path = task_dir / "manifest.json"
        if manifest_path.exists():
            existing = ResearchManifest.model_validate(_read_json(manifest_path, "manifest"))
            if goal and existing.goal and goal != existing.goal:
                raise ResearchStoreConflictError(
                    f"research task {safe_id!r} already exists with a different goal"
                )
            return existing
        manifest = ResearchManifest(task_id=safe_id, goal=goal)
        _atomic_write_json(manifest_path, manifest.model_dump(mode="json"))
        return manifest

    initialize = init

    def _load_manifest(self, task_id: str) -> ResearchManifest:
        path = self._manifest_path(task_id)
        return ResearchManifest.model_validate(_read_json(path, "manifest"))

    def status(self, task_id: str) -> ResearchManifest:
        return self._load_manifest(task_id)

    def _save_manifest(self, manifest: ResearchManifest) -> ResearchManifest:
        updated = manifest.model_copy(update={"updated_at": _now_iso()})
        _atomic_write_json(
            self._manifest_path(updated.task_id), updated.model_dump(mode="json")
        )
        return updated

    def _register_artifact(self, task_id: str, name: str, relative_path: str) -> None:
        manifest = self._load_manifest(task_id)
        artifacts = dict(manifest.artifacts)
        artifacts[name] = _safe_relative_path(relative_path)
        self._save_manifest(manifest.model_copy(update={"artifacts": artifacts}))

    def _update_refs(self, task_id: str) -> None:
        manifest = self._load_manifest(task_id)
        source_records = self.read_sources(task_id)
        claim_records = self.read_claims(task_id)
        map_record = self.read_map(task_id)
        runs = self.read_experiments(task_id)
        deliverables = self.read_deliverables(task_id)
        updates = {
            "source_ids": [record.source_id for record in source_records],
            "claim_ids": [record.claim_id for record in claim_records],
            "node_ids": [node.node_id for node in map_record.nodes] if map_record else [],
            "edge_ids": [edge.edge_id for edge in map_record.edges] if map_record else [],
            "run_ids": [run.run_id for run in runs],
            "deliverable_ids": [record.deliverable_id for record in deliverables],
        }
        self._save_manifest(manifest.model_copy(update=updates))

    def read_sources(self, task_id: str) -> list[SourceRecord]:
        path = self._artifact_path(task_id, "sources.jsonl", create_parent=False)
        return [SourceRecord.model_validate(row) for row in _read_jsonl(path, "sources.jsonl")]

    def source_upsert(
        self, task_id: str, source: SourceRecord | dict[str, Any]
    ) -> SourceRecord:
        record = source if isinstance(source, SourceRecord) else SourceRecord.model_validate(source)
        self._load_manifest(task_id)
        path = self._artifact_path(task_id, "sources.jsonl")
        rows = _read_jsonl(path, "sources.jsonl")
        core_fields = (
            "title", "authors", "published_at", "venue", "source_type", "doi",
            "pmid", "pmcid", "arxiv_id", "nct_id", "url", "abstract", "version",
        )
        replacement = record
        for index, row in enumerate(rows):
            existing = SourceRecord.model_validate(row)
            if existing.source_id != record.source_id:
                continue
            current = existing.model_dump(mode="json")
            incoming = record.model_dump(mode="json")
            for field_name in core_fields:
                old_value = current.get(field_name)
                new_value = incoming.get(field_name)
                if old_value not in (None, "", []) and new_value not in (None, "", []) and old_value != new_value:
                    raise ResearchStoreConflictError(
                        f"source {record.source_id!r} conflicts on {field_name}"
                    )
                if old_value in (None, "", []) and new_value not in (None, "", []):
                    current[field_name] = new_value
            current["retrieved_at"] = incoming["retrieved_at"]
            current["providers"] = list(dict.fromkeys(
                [*(current.get("providers") or []), current.get("provider"),
                 *(incoming.get("providers") or []), incoming.get("provider")]
            ))
            current["metadata"] = {**(current.get("metadata") or {}), **(incoming.get("metadata") or {})}
            replacement = SourceRecord.model_validate(current)
            rows[index] = replacement.model_dump(mode="json")
            _atomic_write_jsonl(path, rows, "sources.jsonl")
            self._register_artifact(task_id, "sources", "sources.jsonl")
            self._update_refs(task_id)
            return replacement
        rows.append(record.model_dump(mode="json"))
        _atomic_write_jsonl(path, rows, "sources.jsonl")
        self._register_artifact(task_id, "sources", "sources.jsonl")
        self._update_refs(task_id)
        return replacement

    def read_claims(self, task_id: str) -> list[EvidenceClaim]:
        path = self._artifact_path(task_id, "claims.jsonl", create_parent=False)
        return [EvidenceClaim.model_validate(row) for row in _read_jsonl(path, "claims.jsonl")]

    def claim_append(
        self, task_id: str, claim: EvidenceClaim | dict[str, Any]
    ) -> EvidenceClaim:
        record = claim if isinstance(claim, EvidenceClaim) else EvidenceClaim.model_validate(claim)
        self._load_manifest(task_id)
        path = self._artifact_path(task_id, "claims.jsonl")
        known_source_ids = {source.source_id for source in self.read_sources(task_id)}
        missing_sources = set(record.source_ids) - known_source_ids
        if missing_sources:
            raise ValueError(
                f"claim {record.claim_id!r} references missing sources: {sorted(missing_sources)}"
            )
        for row in _read_jsonl(path, "claims.jsonl"):
            existing = EvidenceClaim.model_validate(row)
            if existing.claim_id == record.claim_id:
                raise ResearchStoreConflictError(
                    f"claim {record.claim_id!r} already exists"
                )
        _append_jsonl(path, record.model_dump(mode="json"), "claims.jsonl")
        self._register_artifact(task_id, "claims", "claims.jsonl")
        self._update_refs(task_id)
        return record

    def _resolve_run_file(self, task_id: str, run_id: str, path: str) -> Path:
        safe_path = _safe_relative_path(path, "metrics_source.path")
        run_dir = self._run_path(task_id, run_id).parent
        run_candidate = (run_dir / safe_path).resolve()
        if run_candidate.is_relative_to(run_dir.resolve()) and run_candidate.is_file():
            return run_candidate
        raise ResearchStoreNotFoundError(
            f"metric source file not found in run workspace: {safe_path}"
        )

    @staticmethod
    def _finite_metric(value: Any, *, context: str) -> float:
        if isinstance(value, bool):
            raise ValueError(f"{context} must be a finite number")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{context} must be a finite number") from exc
        if not math.isfinite(number):
            raise ValueError(f"{context} must be finite")
        return number

    def read_metric(
        self,
        task_id: str,
        run_id: str,
        metrics_source: MetricSource | dict[str, Any] | str,
    ) -> float:
        """Read one finite metric from a saved JSON or stdout artifact."""

        if isinstance(metrics_source, str):
            raise ValueError(
                "metrics_source must declare JSON key or stdout regex; direct values are not accepted"
            )
        source = (
            metrics_source
            if isinstance(metrics_source, MetricSource)
            else MetricSource.model_validate(metrics_source)
        )
        path = self._resolve_run_file(task_id, run_id, source.path)
        if source.kind == "json":
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError(f"cannot read JSON metric source: {path}: {exc}") from exc
            assert source.key is not None
            value: Any = payload
            if isinstance(payload, dict) and source.key in payload:
                value = payload[source.key]
            else:
                for key in source.key.split("."):
                    if not isinstance(value, dict) or key not in value:
                        raise ValueError(f"metric key is missing: {source.key}")
                    value = value[key]
            return self._finite_metric(value, context=f"metric {source.key}")

        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ValueError(f"cannot read stdout metric source: {path}: {exc}") from exc
        try:
            matches = list(re.finditer(source.pattern or "", text))
        except re.error as exc:
            raise ValueError(f"invalid metric regex: {exc}") from exc
        if not matches:
            raise ValueError("regex metric capture is missing")
        if len(matches) != 1:
            raise ValueError("regex metric capture is ambiguous: multiple matches")
        match = matches[0]
        try:
            captured = match.group(source.group)
        except (IndexError, KeyError) as exc:
            raise ValueError("regex metric capture group is missing") from exc
        if captured is None or captured == "":
            raise ValueError("regex metric capture is missing")
        return self._finite_metric(captured, context="regex metric capture")

    read_metric_value = read_metric

    def read_map(self, task_id: str) -> KnowledgeMap | None:
        path = self._artifact_path(task_id, "knowledge_map.json", create_parent=False)
        if not path.exists():
            return None
        return KnowledgeMap.model_validate(_read_json(path, "knowledge_map.json"))

    def map_write(self, task_id: str, knowledge_map: KnowledgeMap | dict[str, Any]) -> KnowledgeMap:
        record = (
            knowledge_map
            if isinstance(knowledge_map, KnowledgeMap)
            else KnowledgeMap.model_validate(knowledge_map)
        )
        manifest = self._load_manifest(task_id)
        source_ids = set(manifest.source_ids)
        claim_ids = set(manifest.claim_ids)
        for node in record.nodes:
            missing = set(node.source_ids) - source_ids
            if missing:
                raise ValueError(f"knowledge node references missing source ids: {sorted(missing)}")
            missing = set(node.claim_ids) - claim_ids
            if missing:
                raise ValueError(f"knowledge node references missing claim ids: {sorted(missing)}")
        for edge in record.edges:
            missing = set(edge.source_ids) - source_ids
            if missing:
                raise ValueError(f"knowledge edge references missing source ids: {sorted(missing)}")
            missing = set(edge.claim_ids) - claim_ids
            if missing:
                raise ValueError(f"knowledge edge references missing claim ids: {sorted(missing)}")
        path = self._artifact_path(task_id, "knowledge_map.json")
        _atomic_write_json(path, record.model_dump(mode="json"))
        self._register_artifact(task_id, "knowledge_map", "knowledge_map.json")
        markdown_path = self._artifact_path(task_id, "knowledge_map.md")
        markdown_path.write_text(_render_knowledge_map_markdown(record), encoding="utf-8")
        self._register_artifact(task_id, "knowledge_map_md", "knowledge_map.md")
        self._update_refs(task_id)
        return record

    def read_experiments(self, task_id: str) -> list[ExperimentRun]:
        experiments_dir = self._artifact_path(
            task_id, "experiments", create_parent=False
        )
        if not experiments_dir.exists():
            return []
        runs: list[ExperimentRun] = []
        for run_dir in sorted(experiments_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            run_path = run_dir / "run.json"
            if run_path.exists():
                runs.append(ExperimentRun.model_validate(_read_json(run_path, "experiment run")))
        return runs

    def _run_path(self, task_id: str, run_id: str) -> Path:
        safe_run_id = _safe_id(run_id, "run id")
        return self._artifact_path(task_id, f"experiments/{safe_run_id}/run.json")

    def _snapshot_source(
        self,
        task_id: str,
        run_id: str,
        source_dir: str | Path,
        *,
        max_files: int | None = None,
        max_bytes: int | None = None,
    ) -> dict[str, Any]:
        raw_source = os.fspath(source_dir)
        if any(part == ".." for part in re.split(r"[/\\]", raw_source)):
            raise ValueError("source_dir path traversal is not allowed")
        try:
            source = resolve_workspace_path(raw_source, self.workspace, self.workspace)
        except (OSError, PermissionError, ValueError) as exc:
            raise ValueError(f"source_dir is outside workspace: {source_dir}") from exc
        if not source.is_dir():
            raise ValueError(f"source_dir is not a directory: {source_dir}")
        if source.is_symlink():
            raise ValueError("source_dir symlink is not allowed")

        run_path = self._run_path(task_id, run_id)
        destination = run_path.parent / "workspace"
        source_resolved = source.resolve()
        destination_resolved = destination.resolve()
        if destination.exists():
            raise ResearchStoreConflictError(
                f"experiment isolation directory already exists: {destination}"
            )
        if (
            destination_resolved == source_resolved
            or destination_resolved.is_relative_to(source_resolved)
            or source_resolved.is_relative_to(destination_resolved)
        ):
            raise ValueError("source_dir and isolated experiment workspace overlap")

        files, total_bytes = _source_files(source)
        file_limit = MAX_EXPERIMENT_FILES if max_files is None else max_files
        byte_limit = MAX_EXPERIMENT_BYTES if max_bytes is None else max_bytes
        if file_limit <= 0 or len(files) > file_limit:
            raise ValueError(
                f"source directory exceeds file limit: {len(files)} > {file_limit}"
            )
        if byte_limit <= 0 or total_bytes > byte_limit:
            raise ValueError(
                f"source directory exceeds byte limit: {total_bytes} > {byte_limit}"
            )

        input_hashes = {
            relative: f"sha256:{_sha256_file(path)}"
            for relative, path, _ in files
        }
        try:
            shutil.copytree(
                source,
                destination,
                ignore=shutil.ignore_patterns(*IGNORED_SOURCE_DIRS),
                symlinks=False,
            )
            for relative, _, _ in files:
                copied = destination / Path(relative)
                if not copied.is_file() or _sha256_file(copied) != input_hashes[relative].removeprefix("sha256:"):
                    raise ValueError(f"isolated source hash mismatch: {relative}")
        except Exception:
            if destination.exists():
                shutil.rmtree(destination, ignore_errors=True)
            raise
        return {
            "source_dir": str(source_resolved),
            "isolated_dir": str(destination.resolve()),
            "working_dir": str(destination.resolve()),
            "input_hashes": input_hashes,
            "input_file_count": len(files),
            "input_total_bytes": total_bytes,
            "metadata": {
                "ignored_source_dirs": sorted(IGNORED_SOURCE_DIRS),
                "max_files": file_limit,
                "max_bytes": byte_limit,
            },
        }

    def experiment_start(
        self,
        task_id: str,
        run: ExperimentRun | dict[str, Any] | None = None,
        *,
        source_dir: str | Path | None = None,
        max_files: int | None = None,
        max_bytes: int | None = None,
        max_file_count: int | None = None,
        max_total_bytes: int | None = None,
        **fields: Any,
    ) -> ExperimentRun:
        if isinstance(run, ExperimentRun):
            payload = run.model_dump(mode="json")
        else:
            payload = dict(run or {})
        if fields:
            payload.update(fields)
        if source_dir is None:
            source_dir = payload.pop("source_dir", None)
        else:
            payload.pop("source_dir", None)
        payload_max_files = payload.pop("max_files", None)
        payload_max_file_count = payload.pop("max_file_count", None)
        if max_files is None:
            max_files = payload_max_files if payload_max_files is not None else max_file_count
        payload_max_bytes = payload.pop("max_bytes", None)
        payload_max_total_bytes = payload.pop("max_total_bytes", None)
        if max_bytes is None:
            max_bytes = payload_max_bytes if payload_max_bytes is not None else max_total_bytes
        if max_files is None:
            max_files = payload_max_file_count
        if max_bytes is None:
            max_bytes = payload_max_total_bytes
        record = ExperimentRun.model_validate(payload)
        self._load_manifest(task_id)
        path = self._run_path(task_id, record.run_id)
        if path.exists():
            raise ResearchStoreConflictError(f"experiment run {record.run_id!r} already exists")
        snapshot: dict[str, Any] = {"started_at": record.started_at or _now_iso()}
        if source_dir is not None:
            snapshot.update(
                self._snapshot_source(
                    task_id,
                    record.run_id,
                    source_dir,
                    max_files=max_files,
                    max_bytes=max_bytes,
                )
            )
        payload.update(snapshot)
        record = ExperimentRun.model_validate(payload)
        _atomic_write_json(path, record.model_dump(mode="json"))
        relative = str(path.relative_to(self.task_dir(task_id))).replace("\\", "/")
        self._register_artifact(task_id, f"experiment:{record.run_id}", relative)
        self._update_refs(task_id)
        return record

    def experiment_finish(
        self,
        task_id: str,
        run_id: str,
        run: ExperimentRun | dict[str, Any] | None = None,
        **updates: Any,
    ) -> ExperimentRun:
        path = self._run_path(task_id, run_id)
        payload = _read_json(path, "experiment run")
        if run is not None:
            payload.update(_dump_model(run))
        payload.update(updates)
        payload["run_id"] = _safe_id(run_id, "run id")
        record = ExperimentRun.model_validate(payload)
        if record.status in {"succeeded", "accepted", "rejected"}:
            missing_contract = [
                name
                for name, value in (
                    ("metric_name", record.metric_name),
                    ("metric_direction", record.metric_direction),
                    ("evaluation_command", record.evaluation_command),
                    ("data_hash", record.data_hash),
                )
                if not value
            ]
            if missing_contract:
                raise ValueError(
                    "metric contract requires " + ", ".join(missing_contract)
                )
            if payload.get("metrics"):
                raise ValueError(
                    "metrics_source must be used; direct metric values are not accepted"
                )
            actual = self.read_metric(task_id, run_id, record.metrics_source)  # type: ignore[arg-type]
            payload["metrics"] = {record.metric_name: actual}
        payload["finished_at"] = record.finished_at or _now_iso()
        record = ExperimentRun.model_validate(payload)
        _atomic_write_json(path, record.model_dump(mode="json"))
        relative = str(path.relative_to(self.task_dir(task_id))).replace("\\", "/")
        self._register_artifact(task_id, f"experiment:{record.run_id}", relative)
        return record

    def compare_experiments(
        self, task_id: str, baseline_run_id: str, candidate_run_id: str
    ) -> ExperimentRun:
        """Compare two completed runs using metrics read from their artifacts."""

        baseline = ExperimentRun.model_validate(
            _read_json(self._run_path(task_id, baseline_run_id), "experiment run")
        )
        candidate = ExperimentRun.model_validate(
            _read_json(self._run_path(task_id, candidate_run_id), "experiment run")
        )
        if baseline.status != "succeeded":
            raise ValueError("baseline run must have status succeeded")
        if candidate.status != "succeeded":
            raise ValueError("candidate run must have status succeeded")
        contract_fields = (
            "metric_name", "metric_direction", "data_hash", "evaluation_command"
        )
        for field_name in contract_fields:
            baseline_value = getattr(baseline, field_name)
            candidate_value = getattr(candidate, field_name)
            if not baseline_value or not candidate_value:
                raise ValueError(f"metric contract requires {field_name}")
            if baseline_value != candidate_value:
                raise ValueError(f"metric contract mismatch: {field_name}")
        if baseline.metric_unit != candidate.metric_unit:
            raise ValueError("metric contract mismatch: metric_unit")
        assert baseline.metric_name is not None
        baseline_metric = self.read_metric(
            task_id, baseline.run_id, baseline.metrics_source  # type: ignore[arg-type]
        )
        candidate_metric = self.read_metric(
            task_id, candidate.run_id, candidate.metrics_source  # type: ignore[arg-type]
        )
        if baseline.metrics.get(baseline.metric_name) != baseline_metric:
            raise ValueError("baseline metric does not match its source artifact")
        if candidate.metrics.get(candidate.metric_name) != candidate_metric:
            raise ValueError("candidate metric does not match its source artifact")

        if baseline.metric_direction == "maximize":
            improved = candidate_metric > baseline_metric
        else:
            improved = candidate_metric < baseline_metric
        decision = "accepted" if improved else "rejected"
        baseline_payload = baseline.model_dump(mode="json")
        baseline_payload.update(
            {
                "comparison": "baseline",
                "baseline_value": baseline_metric,
            }
        )
        _atomic_write_json(self._run_path(task_id, baseline.run_id), baseline_payload)
        candidate_payload = candidate.model_dump(mode="json")
        candidate_payload.update(
            {
                "status": decision,
                "comparison": decision,
                "baseline_value": baseline_metric,
                "candidate_value": candidate_metric,
                "decision_reason": (
                    f"candidate {candidate_metric} "
                    f"{'improves' if improved else 'does not improve'} "
                    f"baseline {baseline_metric} ({baseline.metric_direction})"
                ),
            }
        )
        result = ExperimentRun.model_validate(candidate_payload)
        _atomic_write_json(
            self._run_path(task_id, result.run_id), result.model_dump(mode="json")
        )
        return result

    def read_deliverables(self, task_id: str) -> list[DeliverableRecord]:
        path = self._artifact_path(task_id, "deliverables.jsonl", create_parent=False)
        return [
            DeliverableRecord.model_validate(row)
            for row in _read_jsonl(path, "deliverables.jsonl")
        ]

    def deliverable_register(
        self,
        task_id: str,
        deliverable: DeliverableRecord | dict[str, Any],
        **fields: Any,
    ) -> DeliverableRecord:
        if fields:
            if isinstance(deliverable, dict):
                payload = dict(deliverable)
                payload.update(fields)
                deliverable = payload
            else:
                raise TypeError("deliverable fields require a JSON object")
        record = (
            deliverable
            if isinstance(deliverable, DeliverableRecord)
            else DeliverableRecord.model_validate(deliverable)
        )
        self._load_manifest(task_id)
        path = self._artifact_path(task_id, "deliverables.jsonl")
        known_source_ids = {source.source_id for source in self.read_sources(task_id)}
        known_claim_ids = {claim.claim_id for claim in self.read_claims(task_id)}
        known_run_ids = {run.run_id for run in self.read_experiments(task_id)}
        missing = (
            (set(record.source_ids) - known_source_ids)
            | (set(record.claim_ids) - known_claim_ids)
            | (set(record.run_ids) - known_run_ids)
        )
        if missing:
            raise ValueError(
                f"deliverable {record.deliverable_id!r} references missing records: {sorted(missing)}"
            )
        for row in _read_jsonl(path, "deliverables.jsonl"):
            existing = DeliverableRecord.model_validate(row)
            if existing.deliverable_id == record.deliverable_id:
                raise ResearchStoreConflictError(
                    f"deliverable {record.deliverable_id!r} already exists"
                )
        _append_jsonl(path, record.model_dump(mode="json"), "deliverables.jsonl")
        self._register_artifact(task_id, "deliverables", "deliverables.jsonl")
        self._update_refs(task_id)
        return record

    def validate(self, task_id: str) -> dict[str, Any]:
        """Return deterministic ledger errors without repairing any file."""

        manifest = self._load_manifest(task_id)
        errors: list[str] = []
        try:
            sources = self.read_sources(task_id)
            claims = self.read_claims(task_id)
            knowledge_map = self.read_map(task_id)
            runs = self.read_experiments(task_id)
            deliverables = self.read_deliverables(task_id)
        except (ResearchStoreError, ValueError) as exc:
            errors.append(str(exc))
            return {"valid": False, "errors": errors, "warnings": []}

        source_ids = {source.source_id for source in sources}
        claim_ids = {claim.claim_id for claim in claims}
        run_ids = {run.run_id for run in runs}
        deliverable_ids = {record.deliverable_id for record in deliverables}
        for reference_name, known_ids, referenced_ids in (
            ("source", source_ids, manifest.source_ids),
            ("claim", claim_ids, manifest.claim_ids),
            ("node", {node.node_id for node in (knowledge_map.nodes if knowledge_map else [])}, manifest.node_ids),
            ("edge", {edge.edge_id for edge in (knowledge_map.edges if knowledge_map else [])}, manifest.edge_ids),
            ("run", run_ids, manifest.run_ids),
            ("deliverable", deliverable_ids, manifest.deliverable_ids),
        ):
            for missing_id in sorted(set(referenced_ids) - known_ids):
                errors.append(f"manifest references missing {reference_name}: {missing_id}")
        for name, relative_path in manifest.artifacts.items():
            try:
                path = self._artifact_path(task_id, relative_path, create_parent=False)
            except ValueError as exc:
                errors.append(f"artifact {name!r}: {exc}")
                continue
            if not path.is_file():
                errors.append(f"manifest artifact {name!r} is missing: {relative_path}")

        for claim in claims:
            missing = set(claim.source_ids) - source_ids
            if missing:
                errors.append(f"claim {claim.claim_id!r} references missing sources: {sorted(missing)}")
        if knowledge_map:
            for edge in knowledge_map.edges:
                missing = set(edge.source_ids) - source_ids
                if missing:
                    errors.append(f"edge {edge.edge_id!r} references missing sources: {sorted(missing)}")
                missing = set(edge.claim_ids) - claim_ids
                if missing:
                    errors.append(f"edge {edge.edge_id!r} references missing claims: {sorted(missing)}")
            for node in knowledge_map.nodes:
                missing = set(node.source_ids) - source_ids
                if missing:
                    errors.append(f"node {node.node_id!r} references missing sources: {sorted(missing)}")
                missing = set(node.claim_ids) - claim_ids
                if missing:
                    errors.append(f"node {node.node_id!r} references missing claims: {sorted(missing)}")
        for run in runs:
            if run.status in {"succeeded", "accepted", "rejected"}:
                missing_contract = [
                    name
                    for name, value in (
                        ("metric_name", run.metric_name),
                        ("metric_direction", run.metric_direction),
                        ("evaluation_command", run.evaluation_command),
                        ("data_hash", run.data_hash),
                    )
                    if not value
                ]
                if missing_contract:
                    errors.append(
                        f"experiment {run.run_id!r} metric contract missing: "
                        + ", ".join(missing_contract)
                    )
                else:
                    try:
                        actual = self.read_metric(
                            task_id, run.run_id, run.metrics_source  # type: ignore[arg-type]
                        )
                    except (ResearchStoreError, ResearchStoreNotFoundError, ValueError) as exc:
                        errors.append(f"experiment {run.run_id!r} metric invalid: {exc}")
                    else:
                        if run.metrics.get(run.metric_name or "") != actual:
                            errors.append(
                                f"experiment {run.run_id!r} metric does not match source artifact"
                            )
            try:
                run_dir = self._artifact_path(
                    task_id, f"experiments/{run.run_id}", create_parent=False
                )
            except ValueError as exc:
                errors.append(f"experiment {run.run_id!r}: {exc}")
                continue
            for artifact in run.artifact_paths:
                artifact_path = (run_dir / artifact).resolve()
                if not artifact_path.is_relative_to(run_dir.resolve()) or not artifact_path.is_file():
                    errors.append(f"experiment {run.run_id!r} is missing artifact: {artifact}")
            for path_value in (run.stdout_path, run.stderr_path):
                if path_value:
                    try:
                        log_path = self._artifact_path(task_id, path_value, create_parent=False)
                    except ValueError as exc:
                        errors.append(f"experiment {run.run_id!r}: {exc}")
                    else:
                        if not log_path.is_file():
                            errors.append(f"experiment {run.run_id!r} is missing log: {path_value}")
        for record in deliverables:
            missing = (set(record.source_ids) - source_ids) | (
                set(record.claim_ids) - claim_ids
            ) | (set(record.run_ids) - run_ids)
            if missing:
                errors.append(
                    f"deliverable {record.deliverable_id!r} references missing records: {sorted(missing)}"
                )
            try:
                deliverable_path = self._artifact_path(
                    task_id, record.path, create_parent=False
                )
            except ValueError as exc:
                errors.append(f"deliverable {record.deliverable_id!r}: {exc}")
            else:
                if not deliverable_path.is_file():
                    errors.append(
                        f"deliverable {record.deliverable_id!r} is missing file: {record.path}"
                    )
        return {"valid": not errors, "errors": errors, "warnings": []}

    def export(self, task_id: str) -> dict[str, str]:
        """Export a compact, human-readable snapshot after validation."""

        validation = self.validate(task_id)
        if not validation["valid"]:
            raise ValueError("research ledger validation failed: " + "; ".join(validation["errors"]))
        task_dir = self.task_dir(task_id)
        deliverables_dir = task_dir / "deliverables"
        deliverables_dir.mkdir(parents=True, exist_ok=True)
        sources = self.read_sources(task_id)
        claims = self.read_claims(task_id)
        knowledge_map = self.read_map(task_id)
        runs = self.read_experiments(task_id)

        sources_path = deliverables_dir / "sources.csv"
        with sources_path.open("w", encoding="utf-8", newline="") as handle:
            fieldnames = [
                "source_id", "title", "doi", "pmid", "pmcid", "arxiv_id",
                "nct_id", "url", "provider", "published_at", "retrieved_at",
            ]
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for source in sources:
                payload = source.model_dump(mode="json")
                writer.writerow({field: payload.get(field) for field in fieldnames})

        evidence_path = deliverables_dir / "evidence.md"
        evidence_lines = ["# Evidence claims", ""]
        for claim in claims:
            locator = (
                f"{claim.locator.kind}: {claim.locator.value}"
                if claim.locator
                else "unlocated"
            )
            evidence_lines.extend(
                [
                    f"## {claim.claim_id} ({claim.claim_type})",
                    claim.claim_text,
                    f"- Sources: {', '.join(claim.source_ids) or 'none'}",
                    f"- Locator: {locator}",
                    f"- Evidence: {claim.evidence_text or 'not provided'}",
                    "",
                ]
            )
        evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")

        exported: dict[str, str] = {
            "sources_csv": str(sources_path),
            "evidence_md": str(evidence_path),
        }
        if knowledge_map:
            map_path = deliverables_dir / "knowledge_map.md"
            map_path.write_text(_render_knowledge_map_markdown(knowledge_map), encoding="utf-8")
            exported["knowledge_map_md"] = str(map_path)
        if runs:
            experiment_path = deliverables_dir / "experiment_summary.md"
            lines = ["# Experiment summary", ""]
            for run in runs:
                lines.append(
                    f"- `{run.run_id}`: {run.status}; exit code {run.exit_code}; "
                    f"metrics {json.dumps(run.metrics, ensure_ascii=False, sort_keys=True)}"
                )
            experiment_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            exported["experiment_summary_md"] = str(experiment_path)

        manifest = self._load_manifest(task_id)
        manifest_path = deliverables_dir / "research_manifest.json"
        _atomic_write_json(manifest_path, manifest.model_dump(mode="json"))
        exported["research_manifest"] = str(manifest_path)
        return exported


# Short alias for callers that do not need the tool-oriented name.
ResearchStore = ResearchRecordStore

__all__ = [
    "IGNORED_SOURCE_DIRS",
    "MAX_EXPERIMENT_BYTES",
    "MAX_EXPERIMENT_FILES",
    "ResearchRecordStore",
    "ResearchStore",
    "ResearchStoreConflictError",
    "ResearchStoreError",
    "ResearchStoreNotFoundError",
]
