"""Tools that expose the academic providers and research ledger to agents.

The provider and record implementations live in :mod:`mona.academic`.  This
module only translates tool calls into those deterministic APIs.  ToolUniverse
is optional and imported inside ``ScientificTool`` so an absent SDK cannot
prevent the rest of Mona's tools from loading.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import re
from datetime import datetime, timezone
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, Callable

from mona.academic.providers import (
    PROVIDERS,
    ProviderError,
    ProviderPage,
    merge_records,
)
from mona.academic.scientific import ApprovedScientificBackend
from mona.academic.store import (
    ResearchRecordStore,
    ResearchStoreConflictError,
    ResearchStoreNotFoundError,
)
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return [_dump(item) for item in value]
    return value


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


_CITATION_DIRECTIONS = {"references", "cited_by", "all"}
_PROVIDER_CITATION_DIRECTION = {
    "openalex": "cited_by",
    "crossref": "references",
    "europe_pmc": "references",
}


def _error_code(exc: Exception, *, action: str = "") -> str:
    if isinstance(exc, ResearchStoreNotFoundError):
        return "not_found"
    if isinstance(exc, ResearchStoreConflictError):
        return "conflict"
    message = str(exc).lower()
    if "task id" in message or "run id" in message:
        return "invalid_task_id" if "task id" in message else "invalid_run_id"
    if action in {"source_upsert", "claim_append", "map_write", "experiment_start", "experiment_finish", "experiment_compare", "deliverable_register"}:
        return "invalid_record"
    return "invalid_request"


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Search action.",
            enum=["search", "metadata", "citations"],
        ),
        query=StringSchema(
            "Free-text academic query; required for search.",
            nullable=True,
        ),
        identifier=StringSchema(
            "DOI, PMID/PMCID, arXiv ID, OpenAlex work ID, or NCT ID.",
            nullable=True,
        ),
        providers=ArraySchema(
            StringSchema("Canonical provider name."),
            description="Providers to query; defaults to all supported providers.",
            nullable=True,
        ),
        year_from=IntegerSchema(
            description="Inclusive publication year lower bound.",
            minimum=0,
            maximum=9999,
            nullable=True,
        ),
        year_to=IntegerSchema(
            description="Inclusive publication year upper bound.",
            minimum=0,
            maximum=9999,
            nullable=True,
        ),
        source_type=StringSchema(
            "Optional source type filter (paper, preprint, trial, ...).",
            nullable=True,
        ),
        limit=IntegerSchema(
            20,
            description="Maximum records returned per provider.",
            minimum=1,
            maximum=100,
        ),
        cursor=StringSchema(
            "Optional provider cursor.",
            nullable=True,
        ),
        direction=StringSchema(
            "Citation direction recorded in the query log.",
            enum=["references", "cited_by", "all"],
        ),
        required=["action"],
    )
)
class AcademicSearchTool(Tool):
    """Search and normalize records from the supported academic providers."""

    _scopes = {"core", "subagent"}
    agent_allowlist = frozenset({"com.mona.academic-researcher"})

    def __init__(self, providers: dict[str, Any] | None = None) -> None:
        self._providers = {
            name: provider() if isinstance(provider, type) else provider
            for name, provider in (providers or {name: cls for name, cls in PROVIDERS.items()}).items()
        }

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(providers=getattr(ctx, "academic_providers", None))

    @property
    def name(self) -> str:
        return "academic_search"

    @property
    def description(self) -> str:
        return (
            "Search, retrieve metadata, or inspect citations through OpenAlex, Crossref, "
            "Europe PMC, arXiv, and ClinicalTrials.gov. Returns normalized records, "
            "provider errors, paging cursors, and per-provider completeness; it never "
            "invents missing metadata."
        )

    @property
    def read_only(self) -> bool:
        return True

    @staticmethod
    def _page_from_result(provider_name: str, result: Any) -> ProviderPage:
        if isinstance(result, ProviderPage):
            return result
        if isinstance(result, dict):
            error = result.get("error")
            if isinstance(error, ProviderError):
                provider_error = error
            elif isinstance(error, dict):
                provider_error = ProviderError(
                    provider=str(error.get("provider") or provider_name),
                    code=str(error.get("code") or "provider_error"),
                    message=str(error.get("message") or "provider failed"),
                    status_code=error.get("status_code"),
                    retry_after=error.get("retry_after"),
                    retryable=bool(error.get("retryable", False)),
                )
            else:
                provider_error = None
            return ProviderPage(
                provider=str(result.get("provider") or provider_name),
                records=list(result.get("records") or []),
                next_cursor=result.get("next_cursor"),
                error=provider_error,
            )
        if isinstance(result, list):
            return ProviderPage(provider_name, records=result)
        return ProviderPage(
            provider_name,
            error=ProviderError(provider_name, "invalid_response", "provider returned an unsupported response"),
        )

    async def _call_provider(
        self,
        provider_name: str,
        provider: Any,
        action: str,
        *,
        query: str | None,
        identifier: str | None,
        limit: int,
        cursor: str | None,
        direction: str,
    ) -> tuple[ProviderPage, str | None]:
        relation_direction: str | None = None
        if action == "citations":
            relation_direction = _PROVIDER_CITATION_DIRECTION.get(provider_name)
            if direction != "all" and relation_direction != direction:
                supported = relation_direction or "none"
                return (
                    ProviderPage(
                        provider_name,
                        error=ProviderError(
                            provider_name,
                            "unsupported_direction",
                            f"{provider_name} supports citation direction {supported}",
                        ),
                    ),
                    None,
                )
            if relation_direction is None:
                return (
                    ProviderPage(
                        provider_name,
                        error=ProviderError(
                            provider_name,
                            "unsupported_direction",
                            f"{provider_name} does not expose a supported citation direction",
                        ),
                    ),
                    None,
                )
        method = getattr(provider, action, None)
        if not callable(method):
            return (
                ProviderPage(
                    provider_name,
                    error=ProviderError(provider_name, "unsupported", f"provider does not support {action}"),
                ),
                relation_direction,
            )
        try:
            if action == "search":
                result = method(query or "", limit=limit, cursor=cursor)
            elif action == "metadata":
                result = method(identifier or "")
            else:
                result = method(identifier or "", limit=limit, cursor=cursor)
            if inspect.isawaitable(result):
                result = await result
            return self._page_from_result(provider_name, result), relation_direction
        except Exception as exc:  # Provider failures are data, not empty results.
            return (
                ProviderPage(
                    provider_name,
                    error=ProviderError(provider_name, "provider_exception", str(exc)),
                ),
                relation_direction,
            )

    @staticmethod
    def _matches_filters(
        record: Any,
        *,
        year_from: int | None,
        year_to: int | None,
        source_type: str | None,
    ) -> bool:
        payload = _dump(record)
        published = str(payload.get("published_at") or "") if isinstance(payload, dict) else ""
        try:
            year = int(published[:4]) if published[:4].isdigit() else None
        except ValueError:
            year = None
        if year_from is not None and (year is None or year < year_from):
            return False
        if year_to is not None and (year is None or year > year_to):
            return False
        if source_type and (payload.get("source_type") if isinstance(payload, dict) else None) != source_type:
            return False
        return True

    async def execute(
        self,
        action: str,
        query: str | None = None,
        identifier: str | None = None,
        providers: list[str] | None = None,
        year_from: int | None = None,
        year_to: int | None = None,
        source_type: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
        direction: str = "references",
        **kwargs: Any,
    ) -> str:
        action = action.strip().lower()
        if action not in {"search", "metadata", "citations"}:
            return _json({"ok": False, "error_code": "unsupported_action", "action": action})
        if direction not in _CITATION_DIRECTIONS:
            return _json({"ok": False, "error_code": "unsupported_direction", "direction": direction})
        if action == "search" and not (query or "").strip():
            return _json({"ok": False, "error_code": "query_required", "message": "search requires query"})
        if action in {"metadata", "citations"} and not (identifier or "").strip():
            return _json({"ok": False, "error_code": "identifier_required", "message": f"{action} requires identifier"})
        selected = [name for name in (providers or self._providers.keys())]
        unknown = [name for name in selected if name not in self._providers]
        if unknown:
            return _json({"ok": False, "error_code": "unsupported_provider", "providers": unknown})
        if cursor and len(selected) > 1:
            return _json(
                {
                    "ok": False,
                    "error_code": "cursor_requires_single_provider",
                    "providers": selected,
                    "message": "A provider cursor can only be resumed for one provider at a time",
                }
            )

        started = _now_iso()
        page_results = await asyncio.gather(
            *(
                self._call_provider(
                    name,
                    self._providers[name],
                    action,
                    query=query,
                    identifier=identifier,
                    limit=limit,
                    cursor=cursor,
                    direction=direction,
                )
                for name in selected
            )
        )
        pages = [page for page, _ in page_results]
        if action == "citations":
            records: list[Any] = []
            for page, relation_direction in page_results:
                if relation_direction is None:
                    continue
                for record in page.records:
                    if not self._matches_filters(
                        record,
                        year_from=year_from,
                        year_to=year_to,
                        source_type=source_type,
                    ):
                        continue
                    payload = _dump(record)
                    if isinstance(payload, dict):
                        payload["citation_direction"] = relation_direction
                    records.append(payload)
        else:
            raw_records = [record for page in pages for record in page.records]
            records = [
                record
                for record in merge_records(raw_records)
                if self._matches_filters(
                    record,
                    year_from=year_from,
                    year_to=year_to,
                    source_type=source_type,
                )
            ]
        provider_errors = [
            page.error.to_dict()
            for page in pages
            if page.error is not None
        ]
        next_cursors = {
            page.provider: page.next_cursor
            for page in pages
            if page.next_cursor is not None
        }
        provider_status = {
            page.provider: {
                "ok": page.error is None,
                "returned_count": len(page.records),
                "has_more": page.next_cursor is not None,
                **(
                    {"error_code": page.error.code}
                    if page.error is not None
                    else {}
                ),
            }
            for page in pages
        }
        coverage_complete = not provider_errors and not next_cursors
        finished = _now_iso()
        return _json(
            {
                "ok": True,
                "records": [_dump(record) for record in records],
                "provider_errors": provider_errors,
                "provider_status": provider_status,
                "coverage_complete": coverage_complete,
                "truncated": bool(next_cursors),
                "next_cursors": next_cursors,
                "query_log": {
                    "action": action,
                    "query": query,
                    "identifier": identifier,
                    "providers": selected,
                    "filters": {
                        "year_from": year_from,
                        "year_to": year_to,
                        "source_type": source_type,
                    },
                    "limit": limit,
                    "limit_per_provider": limit,
                    "cursor": cursor,
                    "citation_direction": direction,
                    "provider_directions": {
                        page.provider: relation_direction
                        for page, relation_direction in page_results
                    }
                    if action == "citations"
                    else {},
                    "started_at": started,
                    "finished_at": finished,
                },
            }
        )


_RECORD_ACTIONS = [
    "init",
    "status",
    "source_upsert",
    "claim_append",
    "map_write",
    "experiment_start",
    "experiment_finish",
    "experiment_compare",
    "deliverable_register",
    "validate",
    "export",
]


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema("Research ledger action.", enum=_RECORD_ACTIONS),
        task_id=StringSchema("Safe research task identifier."),
        goal=StringSchema("Goal used by init.", nullable=True),
        record=ObjectSchema(
            description="Validated record payload for source, claim, map, run, or deliverable actions.",
            additional_properties=True,
            nullable=True,
        ),
        run_id=StringSchema("Existing experiment run identifier.", nullable=True),
        baseline_run_id=StringSchema("Baseline experiment run identifier.", nullable=True),
        candidate_run_id=StringSchema("Candidate experiment run identifier.", nullable=True),
        fields=ObjectSchema(
            description=(
                "Additional fields for experiment_finish or deliverable_register. "
                "Deliverable paths may be task-relative (deliverables/report.md) or "
                "research/<same task_id>/deliverables/report.md."
            ),
            additional_properties=True,
            nullable=True,
        ),
        required=["action", "task_id"],
    )
)
class ResearchRecordTool(Tool):
    """Validate and persist research records in the current workspace."""

    _scopes = {"subagent"}
    agent_allowlist = frozenset({"com.mona.academic-researcher"})

    def __init__(self, workspace: str | Path | None = None) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace)

    @property
    def name(self) -> str:
        return "research_record"

    @property
    def description(self) -> str:
        return (
            "Validate and append sources, evidence claims, knowledge maps, experiment runs, "
            "deliverables, and task manifests under the current workspace research directory. "
            "deliverable_register accepts task-relative paths such as deliverables/report.md "
            "or research/<same task_id>/deliverables/report.md; absolute, traversal, and "
            "other-task paths are rejected."
        )

    def _active_workspace(self) -> Path:
        return get_current_workspace(self._workspace) or self._workspace

    @staticmethod
    def _normalize_deliverable_path(task_id: str, raw_path: Any) -> str:
        """Convert one same-task workspace path to the store's task-relative path."""

        safe_task_id = ResearchRecordStore.validate_task_id(task_id)
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError("deliverable path must be a non-empty relative path")
        candidate = raw_path.strip().replace("\\", "/")
        if candidate.startswith(("/", "~")) or re.match(r"^[A-Za-z]:/", candidate):
            raise ValueError("deliverable path must be relative")
        parts = candidate.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("deliverable path contains an unsafe path segment")

        workspace_prefix = f"research/{safe_task_id}/"
        if candidate.startswith("research/"):
            if not candidate.startswith(workspace_prefix):
                raise ValueError("workspace-relative deliverable path must match the current task")
            candidate = candidate[len(workspace_prefix):]
            if not candidate:
                raise ValueError("deliverable path must name a file")
        return candidate

    @staticmethod
    def _result(action: str, record: Any = None, **extra: Any) -> str:
        payload: dict[str, Any] = {"ok": True, "action": action}
        if record is not None:
            payload["record"] = _dump(record)
        payload.update({key: _dump(value) for key, value in extra.items()})
        return _json(payload)

    async def execute(
        self,
        action: str,
        task_id: str,
        goal: str | None = None,
        record: dict[str, Any] | None = None,
        run_id: str | None = None,
        baseline_run_id: str | None = None,
        candidate_run_id: str | None = None,
        fields: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str:
        action = action.strip().lower()
        store = ResearchRecordStore(self._active_workspace())
        payload = dict(record or {})
        try:
            if action == "init":
                return self._result(action, store.init(task_id, goal=goal or ""))
            if action == "status":
                return self._result(action, manifest=store.status(task_id))
            if action == "source_upsert":
                return self._result(action, store.source_upsert(task_id, payload))
            if action == "claim_append":
                return self._result(action, store.claim_append(task_id, payload))
            if action == "map_write":
                return self._result(action, store.map_write(task_id, payload))
            if action == "experiment_start":
                return self._result(action, store.experiment_start(task_id, payload))
            if action == "experiment_finish":
                if not run_id:
                    raise ValueError("run id is required for experiment_finish")
                return self._result(
                    action,
                    store.experiment_finish(task_id, run_id, payload or None, **(fields or {})),
                )
            if action == "experiment_compare":
                if not baseline_run_id or not candidate_run_id:
                    raise ValueError(
                        "baseline_run_id and candidate_run_id are required for experiment_compare"
                    )
                return self._result(
                    action,
                    store.compare_experiments(task_id, baseline_run_id, candidate_run_id),
                )
            if action == "deliverable_register":
                deliverable_payload = dict(payload)
                deliverable_payload.update(fields or {})
                if "path" not in deliverable_payload:
                    raise ValueError("deliverable path is required")
                deliverable_payload["path"] = self._normalize_deliverable_path(
                    task_id, deliverable_payload["path"]
                )
                return self._result(
                    action,
                    store.deliverable_register(task_id, deliverable_payload),
                )
            if action == "validate":
                return self._result(action, validation=store.validate(task_id))
            if action == "export":
                return self._result(action, exported=store.export(task_id))
            return _json({"ok": False, "error_code": "unsupported_action", "action": action})
        except Exception as exc:
            return _json(
                {
                    "ok": False,
                    "action": action,
                    "error_code": _error_code(exc, action=action),
                    "message": str(exc),
                }
            )


def _load_tooluniverse() -> Any | None:
    """Instantiate the optional SDK without importing it at module load time."""

    try:
        module = importlib.import_module("tooluniverse")
        cls = getattr(module, "ToolUniverse", None)
        if cls is None:
            return None
        return cls()
    except Exception:
        return None


def _load_default_scientific_backend() -> Any:
    """Use ToolUniverse when available, otherwise the approved read-only backend."""

    return _load_tooluniverse() or ApprovedScientificBackend()


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Scientific tool action.",
            enum=["discover", "inspect", "run", "status"],
        ),
        query=StringSchema("Tool name/description search text.", nullable=True),
        tool_id=StringSchema("ToolUniverse tool name.", nullable=True),
        arguments=ObjectSchema(
            description="Arguments validated by the inspected ToolUniverse tool.",
            additional_properties=True,
            nullable=True,
        ),
        limit=IntegerSchema(
            10,
            description="Maximum discovered tools.",
            minimum=1,
            maximum=50,
        ),
        required=["action"],
    )
)
class ScientificTool(Tool):
    """Fixed discover/inspect/run/status wrapper around optional ToolUniverse."""

    _scopes = {"subagent"}
    agent_allowlist = frozenset({"com.mona.academic-researcher"})

    def __init__(
        self,
        backend: Any | None = None,
        backend_loader: Callable[[], Any | None] | None = None,
    ) -> None:
        self._backend = backend
        self._backend_loader = backend_loader or _load_default_scientific_backend
        self._backend_loaded = backend is not None
        self._inspected: dict[str, dict[str, Any]] = {}
        self._loaded_tools: set[str] = set()

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(backend=getattr(ctx, "scientific_backend", None))

    @property
    def name(self) -> str:
        return "scientific_tool"

    @property
    def description(self) -> str:
        return (
            "Discover, inspect, run, or check status for a ToolUniverse scientific tool or "
            "the approved read-only PubChem/UniProt fallback. Unavailable means no result "
            "is simulated."
        )

    def _get_backend(self) -> Any | None:
        if not self._backend_loaded:
            try:
                self._backend = self._backend_loader()
            except Exception:
                self._backend = None
            self._backend_loaded = True
        return self._backend

    @staticmethod
    def _version(backend: Any) -> str | None:
        version = getattr(backend, "__version__", None)
        if version:
            return str(version)
        try:
            return importlib_metadata.version("tooluniverse")
        except importlib_metadata.PackageNotFoundError:
            return None

    @staticmethod
    async def _call(method: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        result = method(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    def _unavailable(self, action: str) -> str:
        return _json(
            {
                "ok": False,
                "status": "unavailable",
                "action": action,
                "error_code": "tooluniverse_unavailable",
                "message": "No scientific backend is installed or could be initialized",
            }
        )

    @staticmethod
    def _backend_failure_code(status: Any) -> str | None:
        normalized = str(status or "").strip().lower()
        if normalized == "unavailable":
            return "backend_unavailable"
        if normalized in {"error", "failed"}:
            return "backend_error"
        return None

    async def _discover(self, backend: Any, query: str, limit: int) -> dict[str, Any]:
        custom = getattr(backend, "discover", None)
        if callable(custom):
            result = await self._call(custom, query=query, limit=limit)
            return {"ok": True, "tools": list(result.get("tools", result) if isinstance(result, dict) else result)}

        method = getattr(backend, "list_built_in_tools", None)
        if not callable(method):
            raise RuntimeError("ToolUniverse backend does not expose list_built_in_tools")
        specs = await self._call(method, mode="list_spec", scan_all=False)
        if not isinstance(specs, list):
            specs = []
        needle = (query or "").casefold().strip()
        matches = [
            spec
            for spec in specs
            if isinstance(spec, dict)
            and (
                not needle
                or needle in str(spec.get("name", "")).casefold()
                or needle in str(spec.get("description", "")).casefold()
                or needle in str(spec.get("type", "")).casefold()
            )
        ]
        return {"ok": True, "tools": matches[:limit]}

    async def _inspect(self, backend: Any, tool_id: str) -> dict[str, Any] | None:
        custom = getattr(backend, "inspect", None)
        if callable(custom):
            result = await self._call(custom, tool_id=tool_id)
        else:
            method = getattr(backend, "tool_specification", None)
            if callable(method):
                result = await self._call(method, tool_id, return_prompt=False)
            else:
                method = getattr(backend, "get_one_tool_by_one_name", None)
                if not callable(method):
                    raise RuntimeError("ToolUniverse backend does not expose tool specification")
                result = await self._call(method, tool_id, return_prompt=False)
        return result if isinstance(result, dict) else None

    async def _ensure_loaded(self, backend: Any, tool_id: str) -> None:
        if tool_id in self._loaded_tools:
            return
        method = getattr(backend, "load_tools", None)
        if callable(method):
            try:
                result = method(include_tools=[tool_id], quiet=True)
            except TypeError:
                result = method(include_tools=[tool_id])
            if inspect.isawaitable(result):
                await result
        self._loaded_tools.add(tool_id)

    async def _run(self, backend: Any, tool_id: str, arguments: dict[str, Any]) -> Any:
        await self._ensure_loaded(backend, tool_id)
        custom = getattr(backend, "run_tool", None)
        if callable(custom):
            return await self._call(custom, tool_id=tool_id, arguments=arguments)
        method = getattr(backend, "run", None)
        if not callable(method):
            raise RuntimeError("ToolUniverse backend does not expose run")
        return await self._call(method, {"name": tool_id, "arguments": arguments})

    async def _status(self, backend: Any, tool_id: str | None) -> Any:
        custom = getattr(backend, "status", None)
        if callable(custom):
            return await self._call(custom, tool_id=tool_id)
        health = getattr(backend, "get_tool_health", None)
        if callable(health) and tool_id:
            return await self._call(health, tool_id)
        return {"status": "ready", "tool_id": tool_id, "inspected": tool_id in self._inspected if tool_id else False}

    async def execute(
        self,
        action: str,
        query: str | None = None,
        tool_id: str | None = None,
        arguments: dict[str, Any] | None = None,
        limit: int = 10,
        **kwargs: Any,
    ) -> str:
        action = action.strip().lower()
        backend = self._get_backend()
        if backend is None:
            return self._unavailable(action)
        version = self._version(backend)
        try:
            if action == "discover":
                payload = await self._discover(backend, query or "", limit)
                payload.update({"action": action, "version": version})
                return _json(payload)
            if action == "inspect":
                if not (tool_id or "").strip():
                    return _json({"ok": False, "error_code": "tool_id_required", "action": action})
                tool = await self._inspect(backend, tool_id)
                if tool is None:
                    return _json({"ok": False, "error_code": "tool_not_found", "tool_id": tool_id})
                self._inspected[tool_id] = tool
                return _json({"ok": True, "action": action, "tool_id": tool_id, "version": version, "tool": tool})
            if action == "run":
                if not (tool_id or "").strip():
                    return _json({"ok": False, "error_code": "tool_id_required", "action": action})
                if tool_id not in self._inspected:
                    return _json({"ok": False, "error_code": "inspect_required", "tool_id": tool_id})
                params = dict(arguments or {})
                started = _now_iso()
                raw = await self._run(backend, tool_id, params)
                finished = _now_iso()
                raw_payload = raw if isinstance(raw, dict) else {"value": raw}
                raw_status = raw_payload.get("status", "succeeded")
                data_sources = raw_payload.get("data_sources") or raw_payload.get("sources") or []
                failure_code = self._backend_failure_code(raw_status)
                if failure_code:
                    return _json(
                        {
                            "ok": False,
                            "action": action,
                            "status": raw_status,
                            "error_code": failure_code,
                            "tool_id": tool_id,
                            "version": version,
                            "parameters": params,
                            "data_sources": data_sources,
                            "started_at": started,
                            "finished_at": finished,
                            "raw_status": raw_status,
                            "result": raw,
                        }
                    )
                return _json(
                    {
                        "ok": True,
                        "action": action,
                        "status": raw_status,
                        "tool_id": tool_id,
                        "version": version,
                        "parameters": params,
                        "data_sources": data_sources,
                        "started_at": started,
                        "finished_at": finished,
                        "raw_status": raw_status,
                        "result": raw,
                    }
                )
            if action == "status":
                status = await self._status(backend, tool_id)
                status_payload = _dump(status) if isinstance(status, dict) else {"status": status}
                raw_status = status_payload.get("status") if isinstance(status_payload, dict) else status
                failure_code = self._backend_failure_code(raw_status)
                if failure_code:
                    return _json(
                        {
                            "ok": False,
                            "action": action,
                            "tool_id": tool_id,
                            "version": version,
                            "status": raw_status,
                            "error_code": failure_code,
                            "result": status,
                        }
                    )
                return _json({"ok": True, "action": action, "tool_id": tool_id, "version": version, **status_payload})
            return _json({"ok": False, "error_code": "unsupported_action", "action": action})
        except Exception as exc:
            return _json(
                {
                    "ok": False,
                    "action": action,
                    "error_code": "scientific_tool_error",
                    "message": str(exc),
                }
            )


__all__ = ["AcademicSearchTool", "ResearchRecordTool", "ScientificTool"]
