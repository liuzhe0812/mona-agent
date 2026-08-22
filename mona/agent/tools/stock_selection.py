"""Controlled tools for the packaged stock-selection workflow.

The tools are deliberately thin: the stock service owns allowlisted fields,
deterministic screening, cache reads and validation.  This module only
starts the existing ``WorkflowRunner`` or persists/reads its report Artifact.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import re
from pathlib import Path
from typing import Any, Callable

from mona.agent.artifacts import ArtifactRef
from mona.agent.pack_bootstrap import STOCK_ROOM_ID, STOCK_SELECTION_TEMPLATE_REF
from mona.agent.pack_templates import load_pack_template
from mona.agent.partners import AgentRegistry
from mona.agent.run_artifacts import append as append_artifact
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import ArraySchema, IntegerSchema, StringSchema, tool_parameters_schema
from mona.agent.workflow import (
    TERMINAL_RUN_STATUSES,
    RunConflictError,
    WorkflowRunStore,
    serialize_run,
)
from mona.config.paths import get_stock_project_dir, get_workflow_runs_dir

_RUN_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")
_MAX_STRATEGY_BYTES = 16_384
_SERVICE_MODULES = ("mona.services.stock.selection", "mona.services.stock.screening")
_FORBIDDEN_STRATEGY_KEYS = frozenset(
    {"sql", "query", "code", "script", "expression", "formula", "python"}
)
_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")

_STRATEGY_SCHEMA = {
    "type": "object",
    "description": (
        "Structured SelectionStrategy. Use only backend-allowlisted fields; "
        "do not provide SQL, code or arbitrary expressions."
    ),
}

_OPPORTUNITY_CLAIM_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "minLength": 1, "maxLength": 2000},
        "claim_type": {"type": "string", "enum": ["fact", "inference", "unknown"]},
        "source_ids": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "maxItems": 32,
        },
    },
    "required": ["text", "claim_type"],
}

_OPPORTUNITY_CLAIMS_SCHEMA = {
    "type": "array",
    "items": _OPPORTUNITY_CLAIM_SCHEMA,
    "maxItems": 20,
}

_OPPORTUNITY_HORIZON_VIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["available", "insufficient_data"]},
        "summary": _OPPORTUNITY_CLAIM_SCHEMA,
        "supporting_evidence": _OPPORTUNITY_CLAIMS_SCHEMA,
        "counter_evidence": _OPPORTUNITY_CLAIMS_SCHEMA,
        "watch_items": _OPPORTUNITY_CLAIMS_SCHEMA,
        "invalidation_conditions": _OPPORTUNITY_CLAIMS_SCHEMA,
        "data_gaps": _OPPORTUNITY_CLAIMS_SCHEMA,
    },
    "required": [
        "status",
        "summary",
        "supporting_evidence",
        "counter_evidence",
        "watch_items",
        "invalidation_conditions",
        "data_gaps",
    ],
}

_OPPORTUNITY_HORIZON_VIEWS_SCHEMA = {
    "type": "object",
    "properties": {
        "short_term": _OPPORTUNITY_HORIZON_VIEW_SCHEMA,
        "medium_term": _OPPORTUNITY_HORIZON_VIEW_SCHEMA,
        "long_term": _OPPORTUNITY_HORIZON_VIEW_SCHEMA,
    },
    "required": ["short_term", "medium_term", "long_term"],
}

_OPPORTUNITY_EVENT_TRANSMISSION_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["available", "insufficient_data"]},
        "event": _OPPORTUNITY_CLAIM_SCHEMA,
        "direct_impact": _OPPORTUNITY_CLAIM_SCHEMA,
        "industry_chain": _OPPORTUNITY_CLAIMS_SCHEMA,
        "business_exposure": _OPPORTUNITY_CLAIM_SCHEMA,
        "earnings_path": _OPPORTUNITY_CLAIM_SCHEMA,
        "validation_window": _OPPORTUNITY_CLAIM_SCHEMA,
        "priced_in": {
            "type": "string",
            "enum": [
                "not_priced_in",
                "partially_priced_in",
                "fully_priced_in",
                "unknown",
            ],
        },
        "priced_in_basis": {
            "type": ["object", "null"],
            "properties": _OPPORTUNITY_CLAIM_SCHEMA["properties"],
            "required": _OPPORTUNITY_CLAIM_SCHEMA["required"],
        },
        "counter_evidence": _OPPORTUNITY_CLAIMS_SCHEMA,
        "invalidation_conditions": _OPPORTUNITY_CLAIMS_SCHEMA,
        "data_gaps": _OPPORTUNITY_CLAIMS_SCHEMA,
    },
    "required": [
        "status",
        "event",
        "direct_impact",
        "industry_chain",
        "business_exposure",
        "earnings_path",
        "validation_window",
        "priced_in",
        "priced_in_basis",
        "counter_evidence",
        "invalidation_conditions",
        "data_gaps",
    ],
}

_OPPORTUNITY_CANDIDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "instrument_id": {"type": "string", "minLength": 1},
        "research_priority": {"type": "string", "enum": ["high", "medium", "low"]},
        "why_now": _OPPORTUNITY_CLAIM_SCHEMA,
        "thesis": _OPPORTUNITY_CLAIMS_SCHEMA,
        "supporting_evidence": _OPPORTUNITY_CLAIMS_SCHEMA,
        "counter_evidence": _OPPORTUNITY_CLAIMS_SCHEMA,
        "relative_edge": _OPPORTUNITY_CLAIMS_SCHEMA,
        "watch_items": _OPPORTUNITY_CLAIMS_SCHEMA,
        "invalidation_conditions": _OPPORTUNITY_CLAIMS_SCHEMA,
        "data_gaps": _OPPORTUNITY_CLAIMS_SCHEMA,
        "horizon_views": _OPPORTUNITY_HORIZON_VIEWS_SCHEMA,
        "event_transmission": {
            "type": ["object", "null"],
            "properties": _OPPORTUNITY_EVENT_TRANSMISSION_SCHEMA["properties"],
            "required": _OPPORTUNITY_EVENT_TRANSMISSION_SCHEMA["required"],
        },
        "context_id": {"type": "string", "pattern": r"^ctx_[a-z0-9]{12,64}$"},
        "source_ids": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "maxItems": 64,
        },
    },
    "required": ["instrument_id", "why_now", "horizon_views", "context_id"],
}


def _jsonable(value: Any) -> Any:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _snake_key(key: str) -> str:
    """Normalize L1's by-alias payload to the Artifact's canonical keys."""
    if not isinstance(key, str) or not any(char.isupper() for char in key):
        return key
    return _CAMEL_BOUNDARY.sub("_", key).lower()


def _canonical_report(value: Any) -> Any:
    """Recursively normalize pydantic camelCase aliases at the Agent seam."""
    if isinstance(value, dict):
        return {_snake_key(str(key)): _canonical_report(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_canonical_report(child) for child in value]
    return value


def _valid_run_id(raw: str) -> str | None:
    value = raw.strip()
    if not value or any(char not in _RUN_ID_CHARS for char in value):
        return None
    return value


def _validate_strategy(value: Any, path: str = "strategy") -> str | None:
    if not isinstance(value, dict):
        return f"{path} must be an object"
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return f"{path} must be JSON serializable"
    if len(encoded.encode("utf-8")) > _MAX_STRATEGY_BYTES:
        return f"{path} exceeds {_MAX_STRATEGY_BYTES} bytes"
    for key, child in value.items():
        if str(key).strip().lower() in _FORBIDDEN_STRATEGY_KEYS:
            return f"{path}.{key} is not allowed"
        if isinstance(child, dict):
            error = _validate_strategy(child, f"{path}.{key}")
            if error:
                return error
        elif isinstance(child, list):
            for index, item in enumerate(child):
                if isinstance(item, (dict, list)):
                    error = _validate_strategy(item, f"{path}.{key}[{index}]") if isinstance(item, dict) else None
                    if error:
                        return error
    return None


def _has_explicit_selection_logic(strategy: dict[str, Any]) -> bool:
    """Whether a strategy contains a condition or ranking the service can run."""
    filters = strategy.get("filters")
    ranking = strategy.get("ranking")
    return (
        isinstance(filters, list) and bool(filters)
    ) or (
        isinstance(ranking, list) and bool(ranking)
    )


def _load_selection_module() -> Any | None:
    for name in _SERVICE_MODULES:
        try:
            return importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
    return None


def _service_instance(module: Any, workspace: Path) -> Any | None:
    """Return the configured L1 service without constructing a provider-less copy.

    The HTTP stock service already owns the configured failover provider.  The
    agent tools use the same factory seam when it is available; constructing
    ``StockScreeningService(workspace=...)`` directly would silently disable
    market data and always return ``market_data_unavailable``.
    """
    factory = getattr(module, "default_screening_service", None)
    if not callable(factory):
        return None
    provider = None
    try:
        api = importlib.import_module("mona.services.stock.api")
        provider_factory = getattr(api, "_provider", None)
        if callable(provider_factory):
            provider = provider_factory()
    except Exception:
        # A test or alternate service module may intentionally have no HTTP
        # provider.  Let its factory choose its own default.
        provider = None
    attempts = (
        {"provider": provider, "workspace": workspace},
        {"workspace": workspace},
        {"provider": provider},
        {},
    )
    for kwargs in attempts:
        if kwargs.get("provider") is None:
            kwargs = {key: value for key, value in kwargs.items() if key != "provider"}
        try:
            return factory(**kwargs)
        except TypeError:
            continue
    return None


def _find_service_callable(
    module: Any,
    names: tuple[str, ...],
    *,
    workspace: Path,
) -> Callable[..., Any] | None:
    for name in names:
        candidate = getattr(module, name, None)
        if callable(candidate):
            return candidate
    instance = _service_instance(module, workspace)
    if instance is not None:
        for name in names:
            candidate = getattr(instance, name, None)
            if callable(candidate):
                return candidate
    for class_name in ("StockSelectionService", "SelectionService", "ScreeningService"):
        cls = getattr(module, class_name, None)
        if cls is None:
            continue
        # The service contract is intentionally a small module-level seam. A
        # class fallback keeps this tool compatible with the service's natural
        # object-oriented implementation without duplicating the engine.
        def _method(*args: Any, _cls: Any = cls, _names: tuple[str, ...] = names, **kwargs: Any) -> Any:
            try:
                instance = _cls(workspace=kwargs.pop("workspace", None))
            except TypeError:
                instance = _cls()
            for method_name in _names:
                method = getattr(instance, method_name, None)
                if callable(method):
                    return method(*args, **kwargs)
            raise AttributeError(f"selection service has no method in {_names!r}")
        return _method
    return None


async def _call_service(
    operation_names: tuple[str, ...],
    *,
    workspace: Path,
    **kwargs: Any,
) -> Any:
    module = _load_selection_module()
    if module is None:
        raise RuntimeError("stock selection service is not installed")
    function = _find_service_callable(module, operation_names, workspace=workspace)
    if function is None:
        raise RuntimeError(
            "stock selection service does not expose " + ", ".join(operation_names)
        )
    supplied = {"workspace": workspace, **kwargs}
    # L1's object API uses positional values for a few operations and names
    # the compare list ``instrument_ids``.  Normalize at this seam rather than
    # making each Agent tool know the service implementation details.
    function_name = getattr(function, "__name__", "")
    if "compare" in function_name and "symbols" in supplied:
        supplied["instrument_ids"] = supplied.pop("symbols")
    if function_name in {"save_strategy", "strategy_save", "create_strategy"}:
        raw = supplied.pop("strategy", None)
        if raw is not None:
            result = function(raw)
        else:
            result = function(**supplied)
    elif function_name in {"read_report", "read_selection_report", "selection_read", "validation", "read_validation", "read_strategy_validation", "validation_read"}:
        # ``read_report``/``validation`` currently accept one positional run
        # id.  Prefer the canonical key and only fall back to kwargs for
        # alternate service adapters.
        value = supplied.pop("run_id", None)
        if value is None:
            value = supplied.pop("strategy_id", None)
        result = function(value) if value is not None else function(**supplied)
    else:
        try:
            signature = inspect.signature(function)
            accepts_kwargs = any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
            if not accepts_kwargs:
                supplied = {
                    name: value
                    for name, value in supplied.items()
                    if name in signature.parameters
                }
        except (TypeError, ValueError):
            pass
        result = function(**supplied)
    if inspect.isawaitable(result):
        return await result
    return result


def _selection_status_payload(run: Any) -> dict[str, Any]:
    current: list[str] = []
    queued: list[str] = []
    completed: list[str] = []
    failed: list[dict[str, str]] = []
    for step_id, step in run.steps.items():
        if step.status in {"running", "waiting_approval"}:
            current.append(step_id)
        elif step.status == "queued":
            queued.append(step_id)
        elif step.status == "succeeded":
            completed.append(step_id)
        elif step.status == "failed":
            failed.append({"step_id": step_id, "error": step.error or "step failed"})
    return {
        "run_id": run.id,
        "status": run.status,
        "current_steps": current,
        "queued_steps": queued,
        "completed_steps": completed,
        "failed_steps": failed,
        "failure_reason": failed[0]["error"] if failed else None,
        "run": serialize_run(run),
    }


def _read_report_file(workspace: Path, run_id: str) -> dict[str, Any] | None:
    root = get_stock_project_dir(workspace, run_id)
    # ``selection.json`` is the Artifact name.  Read the old service filename
    # only as a restart-compatibility fallback while L1 converges on the same
    # single file; never write that legacy name from this tool.
    for path in (root / "selection.json", root / "stock_selection.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        return _canonical_report(payload) if isinstance(payload, dict) else None
    return None


def _report_markdown(report: dict[str, Any]) -> str:
    strategy = report.get("strategy") or {}
    name = strategy.get("name") or strategy.get("strategy_id") or "自定义策略"
    lines = [
        f"# 机会发现：{name}",
        "",
        f"- 数据时间：{report.get('as_of') or '未提供'}",
        f"- 数据质量：{report.get('data_quality') or '未提供'}",
        f"- 股票池：{report.get('universe_count', '未提供')}",
        f"- 通过筛选：{report.get('filtered_count', '未提供')}",
        "",
        "## 候选",
        "",
    ]
    for candidate in report.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        instrument = candidate.get("instrument") or {}
        label = instrument.get("name") or candidate.get("name") or instrument.get("symbol") or candidate.get("symbol") or "未知标的"
        symbol = instrument.get("symbol") or candidate.get("symbol") or ""
        lines.append(f"### {label}（{symbol}）")
        reasons = candidate.get("selection_reasons") or []
        risks = candidate.get("risk_flags") or []
        if reasons:
            lines.extend(f"- 入选理由：{reason}" for reason in reasons[:3])
        if risks:
            lines.extend(f"- 风险：{risk}" for risk in risks)
        lines.append("")
    return "\n".join(lines)


class _StockSelectionToolBase(Tool, ContextAware):
    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any, manager: Any | None = None):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx
        self._manager = manager
        self._cron_service = getattr(tool_ctx, "cron_service", None)
        self._request_ctx: RequestContext | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            tool_ctx=ctx,
            manager=getattr(ctx, "subagent_manager", None),
        )

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

    @property
    def read_only(self) -> bool:
        return True


@tool_parameters(
    tool_parameters_schema(
        strategy_id=StringSchema(
            "Built-in or saved strategy id. Use strategy for a user-confirmed copy.",
            nullable=True,
        ),
        strategy=_STRATEGY_SCHEMA,
        user_question=StringSchema("Optional natural-language context already confirmed by the user.", nullable=True, max_length=2000),
        limit=IntegerSchema(description="Maximum candidate count; backend caps at 100.", minimum=1, maximum=100, nullable=True),
    )
)
class StockScreenRunTool(_StockSelectionToolBase):
    """Start a selection workflow or execute its deterministic step."""

    @property
    def name(self) -> str:
        return "stock_screen_run"

    @property
    def description(self) -> str:
        return (
            "Start the hidden stock-selection workflow from a partner chat, or "
            "inside that workflow execute the deterministic screening service and "
            "persist selection.json. Never calculate candidates in the model."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def _execute_engine(
        self,
        *,
        run_id: str,
        strategy_id: str | None,
        strategy: dict[str, Any] | None,
        limit: int | None,
    ) -> str:
        if strategy is not None:
            error = _validate_strategy(strategy)
            if error:
                return f"Error: {error}"
            strategy_marker = strategy_id or strategy.get("strategy_id") or strategy.get("strategyId")
            if strategy_marker == "natural_language" and not _has_explicit_selection_logic(strategy):
                return (
                    "Error: natural-language selection needs confirmed allowlisted "
                    "filters or ranking; no empty-condition full-market scan was run."
                )
        try:
            if isinstance(strategy, dict) and limit is not None:
                # ``limit`` is a UI override; L1's canonical ``run`` accepts
                # it through SelectionStrategy, not as a separate argument.
                strategy = {**strategy, "limit": limit}
            result = await _call_service(
                ("run", "run_selection", "screen", "execute_selection"),
                workspace=self._workspace,
                run_id=run_id,
                strategy_id=strategy_id,
                strategy=strategy,
                limit=limit,
            )
        except Exception as exc:
            return f"Error: stock selection failed: {exc}"
        report = _canonical_report(_jsonable(result))
        if isinstance(report, dict) and isinstance(report.get("report"), dict):
            report = report["report"]
        if not isinstance(report, dict):
            return "Error: stock selection service returned a non-object report."
        report.setdefault("schema_version", 1)
        report.setdefault("kind", "stock_selection")
        report.setdefault("report_id", f"stock_selection_{run_id}")
        report.setdefault("workflow_run_id", run_id)
        required = ("as_of", "candidates", "data_quality")
        missing = [field for field in required if field not in report]
        if missing:
            return "Error: stock selection report is missing " + ", ".join(missing)
        try:
            from mona.agent.tools.stock_submit import _atomic_write, _atomic_write_json

            run_dir = get_stock_project_dir(self._workspace, run_id)
            report_path = run_dir / "selection.json"
            # The L1 service owns this report file and writes its public
            # camelCase representation.  Do not overwrite it with the Agent's
            # canonical snake_case view; that would break the HTTP read API.
            # Test/alternate adapters that do not persist one get the same
            # single Artifact file created here.
            if not report_path.is_file():
                _atomic_write_json(report_path, report)
            _atomic_write(run_dir / "selection.md", _report_markdown(report))
            job_id = getattr(self._tool_ctx, "job_id", None)
            ref = ArtifactRef.for_path(
                owner_kind="product",
                owner_id=run_id,
                product="stock",
                root=run_dir,
                path=report_path,
                created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
                job_id=job_id,
                workflow_run_id=run_id,
                room_id=getattr(self._tool_ctx, "room_id", None),
                workflow_step_id=getattr(self._tool_ctx, "workflow_step_id", None),
            )
            if isinstance(job_id, str) and job_id:
                append_artifact(job_id, ref)
        except Exception as exc:
            return f"Error: cannot persist stock selection report: {exc}"
        return json.dumps(
            {
                "report_id": report["report_id"],
                "workflow_run_id": run_id,
                "candidate_count": len(report.get("candidates") or []),
                "as_of": report.get("as_of"),
                "data_quality": report.get("data_quality"),
                "artifact_ref": f"artifact://stock/{run_id}/selection.json",
            },
            ensure_ascii=False,
        )

    async def _start_workflow(
        self,
        *,
        strategy_id: str | None,
        strategy: dict[str, Any] | None,
        user_question: str | None,
        limit: int | None,
    ) -> str:
        manager = self._manager
        if manager is None:
            return "Error: stock selection is unavailable: no workflow manager."
        sessions = getattr(manager, "_sessions", None) or getattr(self._tool_ctx, "sessions", None)
        if sessions is None:
            return "Error: stock selection is unavailable: no session manager."
        store = manager.run_store_for_room(STOCK_ROOM_ID)
        for run in store.list_for_room(STOCK_ROOM_ID):
            if run.status not in TERMINAL_RUN_STATUSES:
                return json.dumps(_selection_status_payload(run), ensure_ascii=False)
        try:
            conversation = sessions.get_or_create(f"websocket:{STOCK_ROOM_ID}").conversation_metadata
            workflow = load_pack_template(STOCK_SELECTION_TEMPLATE_REF)
        except Exception as exc:
            return f"Error: stock selection workflow is unavailable: {exc}"
        inputs: dict[str, Any] = {}
        if strategy_id:
            inputs["strategy_id"] = strategy_id.strip()
        if strategy is not None:
            inputs["strategy"] = strategy
        if user_question and user_question.strip():
            inputs["user_question"] = user_question.strip()
        if limit is not None:
            inputs["limit"] = limit
        runner = manager.workflow_runner_for_room(STOCK_ROOM_ID)

        async def _drive() -> None:
            try:
                await runner.run(
                    room_id=STOCK_ROOM_ID,
                    workflow=workflow,
                    conversation=conversation,
                    registry=AgentRegistry(),
                    inputs=inputs,
                    started_by="a-share-analyst",
                )
            except RunConflictError:
                return
            except Exception:
                return

        task = asyncio.create_task(_drive())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        run: Any | None = None
        for _ in range(20):
            await asyncio.sleep(0)
            candidates = store.list_for_room(STOCK_ROOM_ID, limit=5)
            run = next((item for item in candidates if item.workflow_id == workflow.id), None)
            if run is not None:
                break
        if run is None:
            return "Error: stock selection could not create a durable workflow run."
        return json.dumps(_selection_status_payload(run), ensure_ascii=False)

    async def execute(
        self,
        strategy_id: str | None = None,
        strategy: dict[str, Any] | None = None,
        user_question: str | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> str:
        if not strategy_id and strategy is None:
            return "Error: provide strategy_id or a confirmed strategy object."
        current_run_id = getattr(self._tool_ctx, "workflow_run_id", None)
        if isinstance(current_run_id, str) and current_run_id:
            run_inputs: dict[str, Any] = {}
            try:
                run = WorkflowRunStore(get_workflow_runs_dir()).load(current_run_id)
                run_inputs = run.inputs or {}
            except Exception:
                pass
            strategy_id = strategy_id or run_inputs.get("strategy_id")
            strategy = strategy or run_inputs.get("strategy")
            if strategy is None and isinstance(run_inputs.get("strategy"), dict):
                strategy = run_inputs["strategy"]
            if limit is None and isinstance(run_inputs.get("limit"), int):
                limit = run_inputs["limit"]
            return await self._execute_engine(
                run_id=current_run_id,
                strategy_id=strategy_id if isinstance(strategy_id, str) else None,
                strategy=strategy if isinstance(strategy, dict) else None,
                limit=limit,
            )
        return await self._start_workflow(
            strategy_id=strategy_id,
            strategy=strategy,
            user_question=user_question,
            limit=limit,
        )


@tool_parameters(
    tool_parameters_schema(
        run_id=StringSchema("Workflow run id returned by stock_screen_run.", min_length=1),
        required=["run_id"],
    )
)
class StockScreenReadTool(_StockSelectionToolBase):
    @property
    def name(self) -> str:
        return "stock_screen_read"

    @property
    def description(self) -> str:
        return "Read a persisted stock-selection report by workflow run id after restart."

    async def execute(self, run_id: str, **kwargs: Any) -> str:
        normalized = _valid_run_id(run_id)
        if normalized is None:
            return f"Error: invalid workflow run id {run_id!r}"
        current = getattr(self._tool_ctx, "workflow_run_id", None)
        if current and current != normalized:
            return "Error: selection report belongs to a different workflow run."
        try:
            report = await _call_service(
                ("read_report", "read_selection_report", "selection_read"),
                workspace=self._workspace,
                run_id=normalized,
            )
            payload = _canonical_report(_jsonable(report))
        except RuntimeError:
            payload = _read_report_file(self._workspace, normalized)
        except Exception as exc:
            return f"Error: stock selection report read failed: {exc}"
        if not isinstance(payload, dict):
            return f"Error: stock selection report {normalized!r} not found."
        return json.dumps(payload, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        symbols=ArraySchema(
            StringSchema("A-share instrument id, e.g. XSHG:600519"),
            description="Compare two to five candidates.",
            min_items=2,
            max_items=5,
        ),
        run_id=StringSchema("Optional selection workflow run id.", nullable=True),
        required=["symbols"],
    )
)
class StockScreenCompareTool(_StockSelectionToolBase):
    @property
    def name(self) -> str:
        return "stock_screen_compare"

    @property
    def description(self) -> str:
        return "Compare two to five candidates using the selection service's structured factors and risks."

    async def execute(self, symbols: list[str], run_id: str | None = None, **kwargs: Any) -> str:
        normalized = [item.strip() for item in symbols if isinstance(item, str) and item.strip()]
        if len(normalized) < 2 or len(normalized) > 5:
            return "Error: symbols must contain 2 to 5 non-empty instrument ids."
        selected_run = run_id or getattr(self._tool_ctx, "workflow_run_id", None)
        if selected_run:
            selected_run = _valid_run_id(selected_run)
            if selected_run is None:
                return "Error: invalid workflow run id."
        try:
            result = await _call_service(
                ("compare", "compare_candidates", "compare_selection"),
                workspace=self._workspace,
                run_id=selected_run,
                symbols=normalized,
            )
            return json.dumps(_canonical_report(_jsonable(result)), ensure_ascii=False)
        except RuntimeError:
            if not selected_run:
                return "Error: compare service is unavailable without a selection run."
            report = _read_report_file(self._workspace, selected_run)
            if report is None:
                return f"Error: selection report {selected_run!r} not found."
            candidates = report.get("candidates") or []
            wanted = set(normalized)
            matches = [
                candidate
                for candidate in candidates
                if isinstance(candidate, dict)
                and (
                    candidate.get("symbol") in wanted
                    or (candidate.get("instrument") or {}).get("instrument_id") in wanted
                    or (candidate.get("instrument") or {}).get("symbol") in wanted
                )
            ]
            return json.dumps(
                {"run_id": selected_run, "symbols": normalized, "candidates": matches},
                ensure_ascii=False,
            )
        except Exception as exc:
            return f"Error: stock selection compare failed: {exc}"


@tool_parameters(
    tool_parameters_schema(
        strategy=_STRATEGY_SCHEMA,
        required=["strategy"],
    )
)
class StockScreenStrategySaveTool(_StockSelectionToolBase):
    @property
    def name(self) -> str:
        return "stock_screen_strategy_save"

    @property
    def description(self) -> str:
        return "Save a user-confirmed structured selection strategy; server validates fields and permissions."

    async def execute(self, strategy: dict[str, Any], **kwargs: Any) -> str:
        error = _validate_strategy(strategy)
        if error:
            return f"Error: {error}"
        try:
            result = await _call_service(
                ("save_strategy", "strategy_save", "create_strategy"),
                workspace=self._workspace,
                strategy=strategy,
                agent_id=getattr(self._tool_ctx, "agent_id", None),
            )
        except Exception as exc:
            return f"Error: stock selection strategy save failed: {exc}"
        payload = _canonical_report(_jsonable(result))
        if not isinstance(payload, dict):
            return json.dumps(payload, ensure_ascii=False)
        strategy_id = str(payload.get("strategy_id") or payload.get("strategyId") or strategy.get("strategy_id") or "").strip()
        schedule = payload.get("schedule")
        if isinstance(schedule, dict) and strategy_id:
            from mona.agent.pack_bootstrap import sync_stock_selection_cron

            schedule_result = sync_stock_selection_cron(
                self._cron_service,
                strategy_id,
                schedule,
            )
            payload["schedule_sync"] = schedule_result
            if schedule_result.get("status") == "unavailable":
                # The strategy itself is durable, but the requested automatic
                # run is not.  Keep this status machine-readable so the UI
                # cannot present a false "scheduled" success.
                payload["status"] = "schedule_unavailable"
        return json.dumps(payload, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        candidates=ArraySchema(
            _OPPORTUNITY_CANDIDATE_SCHEMA,
            description=(
                "One to eight candidates from the current selection report. "
                "Each candidate must include short_term, medium_term and long_term "
                "horizon_views. Do not add deterministic_rank; the service injects it."
            ),
            min_items=1,
            max_items=8,
        ),
        comparison_summary=ArraySchema(
            _OPPORTUNITY_CLAIM_SCHEMA,
            description="Optional cross-candidate comparison claims with context-owned sources.",
            max_items=32,
        ),
        required=["candidates"],
    )
)
class StockOpportunitySubmitTool(_StockSelectionToolBase):
    """Submit the hidden analyst's source-traceable opportunity report."""

    @property
    def name(self) -> str:
        return "stock_opportunity_submit"

    @property
    def description(self) -> str:
        return (
            "Submit structured opportunity research for only the current run's "
            "selection candidates. Facts and inferences need context-owned "
            "sources; high or medium priority without support and counter "
            "evidence is downgraded by the service. Every candidate must provide "
            "independent short-, medium- and long-term horizon views. For catalyst "
            "candidates, provide an event_transmission chain from event fact to "
            "business exposure and earnings validation; missing or unverified links "
            "are recorded as insufficient_data rather than inferred."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        candidates: list[dict[str, Any]],
        comparison_summary: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> str:
        run_id = getattr(self._tool_ctx, "workflow_run_id", None)
        if not isinstance(run_id, str) or not _valid_run_id(run_id):
            return "Error: stock_opportunity_submit requires the current workflow run."
        if not isinstance(candidates, list):
            return "Error: candidates must be an array."
        payload = {
            "candidates": candidates,
            "comparison_summary": comparison_summary or [],
        }
        try:
            result = await _call_service(
                ("submit_opportunity_report",),
                workspace=self._workspace,
                run_id=run_id,
                payload=payload,
            )
        except KeyError as exc:
            return f"Error: opportunity research cannot be submitted: {exc}"
        except Exception as exc:
            return f"Error: opportunity research submission failed: {exc}"
        report = _canonical_report(_jsonable(result))
        if not isinstance(report, dict):
            return "Error: opportunity research service returned a non-object report."
        report_path = get_stock_project_dir(self._workspace, run_id) / "opportunity.json"
        if not report_path.is_file():
            return "Error: opportunity research service did not persist opportunity.json."
        job_id = getattr(self._tool_ctx, "job_id", None)
        if isinstance(job_id, str) and job_id:
            try:
                ref = ArtifactRef.for_path(
                    owner_kind="product",
                    owner_id=run_id,
                    product="stock",
                    root=report_path.parent,
                    path=report_path,
                    created_by_agent_id=getattr(
                        self._tool_ctx, "agent_id", "com.mona.stock-selection-analyst"
                    ),
                    job_id=job_id,
                    workflow_run_id=run_id,
                    room_id=getattr(self._tool_ctx, "room_id", None),
                    workflow_step_id=getattr(self._tool_ctx, "workflow_step_id", None),
                )
                append_artifact(job_id, ref)
            except Exception as exc:
                return f"Error: cannot register opportunity artifact: {exc}"
        return json.dumps(
            {
                "report_id": report.get("report_id") or f"stock_opportunity_{run_id}",
                "workflow_run_id": run_id,
                "status": report.get("status"),
                "candidate_count": report.get("candidate_count", len(candidates)),
                "artifact_ref": f"artifact://stock/{run_id}/opportunity.json",
            },
            ensure_ascii=False,
        )


@tool_parameters(
    tool_parameters_schema(
        strategy_id=StringSchema("Built-in or saved strategy id.", min_length=1),
        run_id=StringSchema("Optional selection run id; defaults to the current run.", nullable=True),
        required=["strategy_id"],
    )
)
class StockScreenValidationReadTool(_StockSelectionToolBase):
    @property
    def name(self) -> str:
        return "stock_screen_validation_read"

    @property
    def description(self) -> str:
        return "Read real historical validation metrics or an explicit unavailable reason for a strategy."

    async def execute(self, strategy_id: str, **kwargs: Any) -> str:
        if not strategy_id.strip():
            return "Error: strategy_id must be non-empty."
        # L1's current validation endpoint is report/run scoped.  Inside a
        # workflow the trusted run id is authoritative; callers outside a run
        # may pass an explicit ``run_id`` through the optional argument.
        selected_run = kwargs.get("run_id") or getattr(
            self._tool_ctx, "workflow_run_id", None
        ) or strategy_id.strip()
        try:
            result = await _call_service(
                ("validation", "read_validation", "read_strategy_validation", "validation_read"),
                workspace=self._workspace,
                run_id=selected_run,
            )
        except Exception as exc:
            return f"Error: stock selection validation read failed: {exc}"
        return json.dumps(_canonical_report(_jsonable(result)), ensure_ascii=False)


__all__ = [
    "StockScreenRunTool",
    "StockScreenReadTool",
    "StockScreenCompareTool",
    "StockScreenStrategySaveTool",
    "StockScreenValidationReadTool",
    "StockOpportunitySubmitTool",
]
