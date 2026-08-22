"""Stock query tools (design §6, dev plan L1).

Read-only tools for the A-share pack. Stock data tools live in the ``subagent``
scope only — the reserved Mona agent never sees them, and each package
agent receives exactly the subset named by its manifest allowlist.

Trusted identity fields (``room_id``, ``workflow_run_id``) always come
from the shared ToolContext, never from model input: a ``run_id`` the
model passes is silently ignored.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema
from mona.agent.workflow import WorkflowRunStore
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.material_evidence import MaterialBindingStore
from mona.services.stock.provider import (
    EastMoneyProvider,
    GovernmentResearchProvider,
    InstrumentRef,
    ProviderError,
)
from mona.services.stock.storage import infer_exchange

_EXCHANGES = ("XSHG", "XSHE", "BJSE")
_INSTRUMENT_TYPES = ("equity", "etf", "index")
# Same alphabet as ``workflow._WORKFLOW_ID_CHARS`` (kept local: the workflow
# module's constant is private).
_RUN_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")
_NS_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")
_MAX_ARTIFACT_BYTES = 256 * 1024
_V2_EVIDENCE_SECTIONS = (
    "market_regime",
    "industry_context",
    "policy_context",
    "cycle_context",
    "company_quality",
    "capital_positioning",
    "event_calendar",
    "tradeability",
)
_BASE_EVIDENCE_SECTIONS = (
    "quote",
    "kline",
    "indicators",
    "fundamentals",
    "fundamentals_history",
    "news",
    "policy_documents",
    "macro_documents",
    "relative_benchmarks",
    "materials",
)
_EVIDENCE_SECTION_KEYS = ("evidence_coverage",) + _V2_EVIDENCE_SECTIONS + _BASE_EVIDENCE_SECTIONS
_COMPACT_EVIDENCE_AGENT_IDS = frozenset(
    {
        "com.mona.stock-bull-researcher",
        "com.mona.stock-bear-researcher",
        "com.mona.stock-referee",
    }
)
_COMPACT_SOURCE_FIELDS = (
    "id",
    "provider",
    "published_at",
    "period_end",
    "fetched_at",
)
_COMPACT_COVERAGE_FIELDS = (
    "expected_count",
    "loaded_count",
    "coverage",
    "page_size",
    "requested_limit",
    "complete",
)
_COMPACT_COVERAGE_STATUS_FIELDS = (
    "status",
    "availability_status",
    "claim_type",
    "observed_at",
    "published_at",
    "period_end",
    "research_cutoff_at",
    "missing_fields",
    "source_ids",
)


def _shorten_error(value: str, limit: int = 240) -> str:
    """Keep the degradation reason while removing long provider URLs."""
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _compact_coverage_item(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    compact = {
        key: value[key]
        for key in _COMPACT_COVERAGE_STATUS_FIELDS
        if key in value
    }
    coverage = value.get("coverage")
    if isinstance(coverage, dict):
        compact_coverage = {
            key: coverage[key]
            for key in _COMPACT_COVERAGE_FIELDS
            if key in coverage
        }
        if isinstance(coverage.get("error"), str):
            compact_coverage["error"] = _shorten_error(coverage["error"])
        cache = coverage.get("cache")
        if isinstance(cache, dict):
            compact_coverage["cache"] = {
                key: cache[key]
                for key in (
                    "status",
                    "observation_date",
                    "observed_at",
                    "freshness",
                    "fallback_reason",
                )
                if key in cache
            }
        compact["coverage"] = compact_coverage
    elif "coverage" in value:
        compact["coverage"] = coverage
    return compact


def _compact_evidence_value(value: Any) -> Any:
    """Remove presentation-heavy fields without dropping metrics or refs."""
    if isinstance(value, dict):
        compact: dict[str, Any] = {}
        for key, child in value.items():
            if key in {"url", "content_hash", "summary"}:
                continue
            if key == "error" and isinstance(child, str):
                compact[key] = _shorten_error(child)
            else:
                compact[key] = _compact_evidence_value(child)
        return compact
    if isinstance(value, list):
        return [_compact_evidence_value(child) for child in value]
    return value


def _compact_evidence_coverage(value: Any) -> Any:
    """Keep horizon gates and per-section provenance in a small stable shape."""
    if not isinstance(value, dict):
        return value
    compact: dict[str, Any] = {}
    if "schema_version" in value:
        compact["schema_version"] = value["schema_version"]
    sections = value.get("sections")
    if isinstance(sections, dict):
        compact["sections"] = {
            name: _compact_coverage_item(item)
            for name, item in sections.items()
        }
    for horizon in ("short_term", "medium_term", "long_term"):
        if horizon in value:
            compact[horizon] = _compact_evidence_value(value[horizon])
    return compact


def _compact_sources(sources: list[Any]) -> list[Any]:
    compact: list[Any] = []
    for source in sources:
        if not isinstance(source, dict):
            compact.append(source)
            continue
        compact.append(
            {
                key: source[key]
                for key in _COMPACT_SOURCE_FIELDS
                if key in source
            }
        )
    return compact


def _source_ids(value: Any) -> set[str]:
    """Collect source references recursively from one selected partition."""
    found: set[str] = set()
    if isinstance(value, dict):
        refs = value.get("source_ids")
        if isinstance(refs, list):
            found.update(item for item in refs if isinstance(item, str))
        for child in value.values():
            found.update(_source_ids(child))
    elif isinstance(value, list):
        for child in value:
            found.update(_source_ids(child))
    return found


def _select_evidence_bundle(
    bundle: dict[str, Any], selected: set[str], *, compact: bool = False
) -> dict[str, Any]:
    """Return the run metadata plus only requested evidence partitions."""
    response = {
        key: bundle.get(key)
        for key in (
            "instrument",
            "research_cutoff_at",
            "market_as_of",
            "evidence_coverage",
            "data_quality",
        )
    }
    if compact:
        response["evidence_coverage"] = _compact_evidence_coverage(
            response["evidence_coverage"]
        )
    partitions: dict[str, Any] = {}
    for key in sorted(selected):
        if key == "kline":
            # The raw bars live in the bounded cache referenced by kline_ref;
            # indicators and the cache reference are the complete K-line
            # partition exposed to agents.
            partitions[key] = {
                "indicators": bundle.get("indicators"),
                "kline_ref": bundle.get("kline_ref"),
                "source_ids": [
                    item.get("id")
                    for item in bundle.get("sources") or []
                    if "date" in (item.get("fields") or []) and item.get("id")
                ],
            }
        elif key in bundle:
            partitions[key] = bundle.get(key)
    response.update(partitions)
    if compact:
        response["evidence_coverage"] = _compact_evidence_coverage(
            response["evidence_coverage"]
        )
        for key in list(response):
            if key in {
                "instrument",
                "research_cutoff_at",
                "market_as_of",
                "evidence_coverage",
                "data_quality",
                "sources",
            }:
                continue
            response[key] = _compact_evidence_value(response[key])
    selected_source_ids = _source_ids(partitions)
    sources = [
        source
        for source in bundle.get("sources") or []
        if source.get("id") in selected_source_ids
    ]
    response["sources"] = _compact_sources(sources) if compact else sources
    return response


def _resolve_instrument(symbol: str, instrument_type: str = "equity") -> InstrumentRef:
    """Parse ``EXCHANGE:symbol`` or a bare 6-digit code into an InstrumentRef."""
    raw = symbol.strip()
    if ":" in raw:
        exchange, _, code = raw.partition(":")
        exchange = exchange.upper()
        if exchange not in _EXCHANGES:
            raise ValueError(f"unknown exchange {exchange!r}")
        if len(code) != 6 or not code.isdigit():
            raise ValueError(f"invalid symbol {symbol!r}: expect 6 digits")
    else:
        code = raw
        exchange = infer_exchange(code)  # validates the 6-digit shape
    if instrument_type not in _INSTRUMENT_TYPES:
        raise ValueError(f"invalid instrument_type {instrument_type!r}")
    return InstrumentRef(
        exchange=exchange,
        symbol=code,
        instrument_type=instrument_type,  # type: ignore[arg-type]
    )


def _context_run_id(tool_ctx: Any) -> str | None:
    return getattr(tool_ctx, "workflow_run_id", None) or None


def _read_evidence(workspace: Path, run_id: str, instrument_id: str | None = None):
    """Read-only evidence access; the provider is only used when building."""
    return EvidenceService(workspace=workspace, provider=None).read(
        run_id, instrument_id
    )


def _load_run_for_artifact(workspace: Path, run_id: str):
    """Load the workflow run guarding an artifact read.

    Workflow runs persist in Mona runtime state, independent of the room's
    Agent/product artifact roots.
    """
    from mona.config.paths import get_workflow_runs_dir

    try:
        return WorkflowRunStore(get_workflow_runs_dir()).load(run_id)
    except Exception:
        return None


def _parse_artifact_ref(ref: str) -> tuple[str, str, str]:
    """Split ``artifact://<namespace>/<run_id>/<relative-path>``."""
    if not ref.startswith("artifact://"):
        raise ValueError("expect an artifact:// reference")
    parts = ref[len("artifact://") :].split("/")
    if len(parts) < 3:
        raise ValueError("expect artifact://<namespace>/<run_id>/<file>")
    namespace, run_id = parts[0], parts[1]
    relpath = "/".join(parts[2:])
    if not namespace or any(c not in _NS_CHARS for c in namespace):
        raise ValueError(f"invalid artifact namespace {namespace!r}")
    if not run_id or any(c not in _RUN_ID_CHARS for c in run_id):
        raise ValueError(f"invalid run id {run_id!r}")
    if not relpath or relpath.startswith("/") or "\\" in relpath:
        raise ValueError(f"invalid artifact path {relpath!r}")
    return namespace, run_id, relpath


@tool_parameters(
    tool_parameters_schema(
        symbol=StringSchema(
            "A-share code: bare 6 digits (exchange inferred for 6/0/3/8/4 "
            "prefixes) or explicit EXCHANGE:symbol, e.g. 600519 or "
            "XSHE:159915"
        ),
        instrument_type=StringSchema(
            "Instrument type; default equity",
            enum=_INSTRUMENT_TYPES,
        ),
        required=["symbol"],
    )
)
class StockQuoteTool(Tool):
    """Realtime quote snapshot for one A-share instrument."""

    _scopes = {"subagent"}

    def __init__(self, provider: Any | None = None):
        self._provider = provider or EastMoneyProvider()

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def name(self) -> str:
        return "stock_quote"

    @property
    def description(self) -> str:
        return (
            "Fetch a realtime quote snapshot (price, change %, volume) for one "
            "A-share stock or ETF. Use for quick market questions; deep "
            "research reads the prepared evidence bundle instead."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self, symbol: str, instrument_type: str = "equity", **kwargs: Any
    ) -> str:
        try:
            inst = _resolve_instrument(symbol, instrument_type)
        except ValueError as exc:
            return f"Error: {exc}"
        try:
            quote = await self._provider.quote(inst)
        except ProviderError as exc:
            return f"Error: quote fetch failed for {inst.id}: {exc}"
        return json.dumps(
            {
                "instrument_id": quote.instrument_id,
                "instrument_type": quote.instrument_type,
                "name": quote.name,
                "price": quote.price,
                "change_pct": quote.change_pct,
                "volume": quote.volume,
                "as_of": quote.as_of,
                "source_id": quote.source.id,
            },
            ensure_ascii=False,
        )


@tool_parameters(
    tool_parameters_schema(
        symbol=StringSchema(
            "A-share code: bare 6 digits or EXCHANGE:symbol. The evidence "
            "bundle of the current workflow run is looked up for this "
            "instrument."
        ),
        sections=ArraySchema(
            StringSchema("Evidence partition", enum=_EVIDENCE_SECTION_KEYS),
            description=(
                "Optional subset of at most four V2/base partitions. Use a "
                "role-specific subset to avoid loading the full evidence bundle."
            ),
            max_items=4,
        ),
        detail=StringSchema(
            "Optional response detail. compact keeps metrics, coverage and source "
            "provenance while omitting presentation-heavy document fields.",
            enum=("full", "compact"),
        ),
        required=["symbol"],
    )
)
class StockEvidenceReadTool(Tool):
    """Read the trimmed evidence bundle for the current workflow run."""

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "stock_evidence_read"

    @property
    def description(self) -> str:
        return (
            "Read the prepared V2 evidence bundle for an instrument in the "
            "current workflow run. It includes the eight deterministic "
            "sections (market regime, industry, policy, four cycles, company "
            "quality, public capital signals, events and tradeability), their "
            "source_ids, research_cutoff_at and missing_fields, plus quote, "
            "indicators, fundamentals, news and source records. Read "
            "evidence_coverage before forming a horizon view. Optionally pass "
            "up to four sections (technical: market_regime/capital_positioning/"
            "tradeability/kline; fundamental: company_quality/fundamentals/"
            "fundamentals_history; news: industry_context/policy_context/"
            "cycle_context/event_calendar; benchmark: relative_benchmarks) to "
            "keep the response focused. Use detail=compact for debate and "
            "referee reads; it preserves metrics, coverage, timestamps and "
            "source_ids while omitting document URLs and summaries. This "
            "is the only market data you may cite — never invent numbers."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        symbol: str,
        sections: list[str] | None = None,
        detail: str | None = None,
        **kwargs: Any,
    ) -> str:
        run_id = _context_run_id(self._tool_ctx)
        if run_id is None:
            return "Error: stock_evidence_read is only available inside a workflow run."
        try:
            instrument_id = _resolve_instrument(symbol).id
        except ValueError as exc:
            return f"Error: {exc}"
        bundle = _read_evidence(self._workspace, run_id, instrument_id)
        if bundle is None:
            return f"Error: no evidence for {instrument_id} in run {run_id}."
        selected: set[str] | None = None
        if sections is not None:
            if not isinstance(sections, list) or any(
                not isinstance(item, str) for item in sections
            ):
                return "Error: sections must be an array of strings."
            selected = {item.strip().lower() for item in sections}
            if not selected:
                return "Error: sections must contain at least one partition."
            if len(selected) > 4:
                return "Error: sections supports at most 4 partitions."
            unknown = selected - set(_EVIDENCE_SECTION_KEYS)
            if unknown:
                return f"Error: unknown evidence sections: {sorted(unknown)}"
        if detail is not None and detail not in {"full", "compact"}:
            return "Error: detail must be either full or compact."
        compact = detail == "compact" or (
            detail is None
            and getattr(self._tool_ctx, "agent_id", None) in _COMPACT_EVIDENCE_AGENT_IDS
        )
        payload = (
            bundle
            if selected is None and not compact
            else _select_evidence_bundle(
                bundle,
                selected or set(_EVIDENCE_SECTION_KEYS),
                compact=compact,
            )
        )
        return json.dumps(payload, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        symbol=StringSchema(
            "A-share code: bare 6 digits or EXCHANGE:symbol. Builds a direct-chat "
            "evidence context with quote, technical indicators, fundamentals and news."
        ),
        sections=ArraySchema(
            StringSchema(
                "Evidence section",
                enum=("quote", "kline", "fundamentals", "news", "materials"),
            ),
            description="Optional subset of evidence sections; omitted means all sections.",
            max_items=4,
        ),
        material_binding_ids=ArraySchema(
            StringSchema("已确认财报材料的绑定记录编号。"),
            description="可选；仅加入本次明确选择的财报材料，最多 8 份。",
            max_items=8,
        ),
        required=["symbol"],
    )
)
class StockContextReadTool(Tool, ContextAware):
    """Build a traceable evidence context for a normal partner conversation."""

    _scopes = {"subagent"}

    def __init__(
        self,
        workspace: str | Path,
        tool_ctx: Any,
        provider: Any | None = None,
        research_provider: Any | None = None,
    ):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx
        self._provider = provider or EastMoneyProvider()
        self._research_provider = research_provider
        self._request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        # Context reads use the same quote/kline failover path as workflow
        # evidence; the direct quote tool remains intentionally unchanged.
        from mona.services.stock.run_init import _default_provider

        return cls(
            workspace=ctx.workspace,
            tool_ctx=ctx,
            provider=_default_provider(),
            research_provider=GovernmentResearchProvider(),
        )

    @property
    def name(self) -> str:
        return "stock_context_read"

    @property
    def description(self) -> str:
        return (
            "Build a standardized, source-traceable A-share evidence context for "
            "the current conversation or workflow. Returns context_id, source "
            "ids, data quality and the current evidence snapshot; do not invent "
            "missing fields."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        symbol: str,
        sections: list[str] | None = None,
        material_binding_ids: list[str] | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            inst = _resolve_instrument(symbol)
        except ValueError as exc:
            return f"Error: {exc}"
        selected: set[str] | None = None
        if sections is not None:
            if not isinstance(sections, list) or any(not isinstance(item, str) for item in sections):
                return "Error: sections must be an array of strings."
            selected = {item.strip().lower() for item in sections}
            unknown = selected - {"quote", "kline", "fundamentals", "news", "materials"}
            if unknown:
                return f"Error: unknown evidence sections: {sorted(unknown)}"
        if material_binding_ids is not None:
            if (
                not isinstance(material_binding_ids, list)
                or not material_binding_ids
                or len(material_binding_ids) > 8
                or any(not isinstance(item, str) or not item.strip() for item in material_binding_ids)
            ):
                return "Error: 材料绑定记录编号必须是 1 至 8 个非空字符串。"
            if len(set(material_binding_ids)) != len(material_binding_ids):
                return "Error: 材料绑定记录编号不能重复。"
        import uuid

        context_id = f"ctx_{uuid.uuid4().hex[:12]}"
        build_sections = (
            selected - {"materials"}
            if selected is not None
            else None
        )
        owner = {
            key: value
            for key, value in {
                "agent_id": getattr(self._tool_ctx, "agent_id", None),
                "workflow_run_id": _context_run_id(self._tool_ctx),
                "conversation_id": (
                    getattr(self._request_ctx, "chat_id", None)
                    or getattr(self._tool_ctx, "conversation_id", None)
                ),
            }.items()
            if isinstance(value, str) and value
        }
        try:
            if material_binding_ids is not None:
                MaterialBindingStore(self._workspace).confirmed_projections(
                    material_binding_ids,
                    instrument_id=inst.id,
                )
            payload = await EvidenceService(
                workspace=self._workspace,
                provider=self._provider,
                research_provider=self._research_provider,
            ).build_context(
                context_id,
                inst,
                sections=build_sections,
                owner=owner,
                material_binding_ids=material_binding_ids,
            )
        except Exception as exc:
            return f"Error: 股票上下文构建失败：{exc}"
        bundle = (payload.get("symbols") or {}).get(inst.id)
        if not isinstance(bundle, dict):
            return "Error: 股票上下文没有找到该股票的证据。"
        return json.dumps(
            {
                "context_id": context_id,
                "instrument_id": inst.id,
                "as_of": bundle.get("as_of"),
                "evidence": bundle,
                "sources": bundle.get("sources") or [],
                "data_quality": bundle.get("data_quality") or {},
            },
            ensure_ascii=False,
        )


@tool_parameters(
    tool_parameters_schema(
        source_id=StringSchema(
            "Source record id (src_...) from the current run's evidence bundle"
        ),
        context_id=StringSchema(
            "Context id returned by stock_context_read. Required for context "
            "sources; omit only for a workflow evidence bundle.",
            nullable=True,
        ),
        required=["source_id"],
    )
)
class StockSourceOpenTool(Tool, ContextAware):
    """Open a provenance record from the current run's evidence bundle."""

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx
        self._request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "stock_source_open"

    @property
    def description(self) -> str:
        return (
            "Open a source provenance record (provider, url, timestamps, "
            "content hash) by its id. Pass context_id for stock_context_read "
            "sources; otherwise workflow calls use the current run bundle."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        source_id: str,
        context_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        run_id = _context_run_id(self._tool_ctx)
        if not source_id.strip():
            return "Error: source_id must be non-empty."
        context_id = context_id.strip() if isinstance(context_id, str) else ""
        if context_id:
            try:
                data = EvidenceService(
                    workspace=self._workspace,
                    provider=None,
                ).read_context(context_id)
            except ValueError as exc:
                return f"Error: {exc}"
            if data is None:
                return f"Error: stock context {context_id!r} not found."
            owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
            owner_run_id = owner.get("workflow_run_id") or owner.get("run_id")
            if owner_run_id and owner_run_id != run_id:
                return "Error: stock context belongs to a different workflow run."
            if run_id is not None and owner_run_id != run_id:
                return "Error: stock context is not bound to the current workflow run."
            current_agent = getattr(self._tool_ctx, "agent_id", None)
            current_conversation = (
                getattr(self._request_ctx, "chat_id", None)
                or getattr(self._tool_ctx, "conversation_id", None)
            )
            if owner.get("agent_id") and owner.get("agent_id") != current_agent:
                return "Error: stock context belongs to a different agent."
            if owner.get("conversation_id") and owner.get("conversation_id") != current_conversation:
                return "Error: stock context belongs to a different conversation."
            bundles = data.get("symbols") or {}
            run_label = f"context {context_id}"
        elif run_id is None:
            return "Error: context_id is required outside a workflow run."
        else:
            data = _read_evidence(self._workspace, run_id)
            if data is None:
                return f"Error: no evidence bundle for run {run_id}."
            bundles = (data.get("symbols") or {}) if "symbols" in data else {"_": data}
            run_label = f"run {run_id}"
        for bundle in bundles.values():
            for source in bundle.get("sources") or []:
                if source.get("id") == source_id:
                    return json.dumps(source, ensure_ascii=False)
        return f"Error: source {source_id!r} not found in {run_label} evidence."


@tool_parameters(
    tool_parameters_schema(
        report_id=StringSchema(
            "Report id from a generated stock report or review digest"
        ),
        required=["report_id"],
    )
)
class StockReportReadTool(Tool):
    """Read a generated report/digest by report_id from ``stock_projects/``."""

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path):
        self._workspace = Path(workspace)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace)

    @property
    def name(self) -> str:
        return "stock_report_read"

    @property
    def description(self) -> str:
        return (
            "Read a previously generated stock report or daily-review digest "
            "(JSON + markdown) by its report_id."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, report_id: str, **kwargs: Any) -> str:
        report_id = report_id.strip()
        if not report_id or any(c in report_id for c in ("/", "\\", "..")):
            return f"Error: invalid report_id {report_id!r}"
        from mona.config.paths import get_stock_projects_dir

        root = get_stock_projects_dir(self._workspace)
        if root.is_dir():
            for run_dir in sorted(root.iterdir()):
                if not run_dir.is_dir():
                    continue
                for kind in ("report", "digest"):
                    path = run_dir / f"{kind}.json"
                    if not path.is_file():
                        continue
                    try:
                        payload = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    if payload.get("report_id") != report_id:
                        continue
                    md_path = run_dir / f"{kind}.md"
                    markdown = (
                        md_path.read_text(encoding="utf-8")
                        if md_path.is_file()
                        else ""
                    )
                    return json.dumps(
                        {
                            "kind": kind,
                            "run_id": run_dir.name,
                            "report": payload,
                            "markdown": markdown,
                        },
                        ensure_ascii=False,
                    )
        return f"Error: report {report_id!r} not found"


@tool_parameters(
    tool_parameters_schema(
        ref=StringSchema(
            "Artifact reference, e.g. artifact://stock/<run_id>/technical.json"
        ),
        detail=StringSchema(
            "Optional response detail. compact removes only the duplicated top-level sources ledger from JSON artifacts.",
            enum=("full", "compact"),
        ),
        required=["ref"],
    )
)
class ArtifactReadTool(Tool):
    """Read one artifact produced inside the current workflow run."""

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "artifact_read"

    @property
    def description(self) -> str:
        return (
            "Read a structured artifact produced by another step of the "
            "current workflow run, referenced as "
            "artifact://<namespace>/<run_id>/<file>. Only artifacts of your "
            "own run in your own room are readable."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self, ref: str, detail: str | None = None, **kwargs: Any
    ) -> str:
        if detail is not None and detail not in {"full", "compact"}:
            return "Error: detail must be either full or compact."
        run_id = _context_run_id(self._tool_ctx)
        room_id = getattr(self._tool_ctx, "room_id", None) or None
        if run_id is None or room_id is None:
            return "Error: artifact_read is only available inside a workflow run."
        try:
            namespace, ref_run_id, relpath = _parse_artifact_ref(ref.strip())
        except ValueError as exc:
            return f"Error: {exc}"
        if ref_run_id != run_id:
            return "Error: artifact belongs to a different workflow run."
        run = _load_run_for_artifact(self._workspace, ref_run_id)
        if run is None:
            return f"Error: workflow run {ref_run_id} not found."
        if run.room_id != room_id:
            return "Error: artifact belongs to a different room."
        from mona.config.paths import get_stock_project_dir

        if namespace != "stock":
            return f"Error: unsupported artifact namespace {namespace!r}."
        run_dir = get_stock_project_dir(self._workspace, ref_run_id).resolve()
        target = (run_dir / relpath).resolve()
        if not target.is_relative_to(run_dir):
            return "Error: artifact path escapes the run directory."
        if not target.is_file():
            return f"Error: artifact {ref!r} not found."
        if target.stat().st_size > _MAX_ARTIFACT_BYTES:
            return f"Error: artifact {ref!r} exceeds {_MAX_ARTIFACT_BYTES} bytes."
        text = target.read_text(encoding="utf-8")
        compact = detail == "compact" or (
            detail is None
            and getattr(self._tool_ctx, "agent_id", None) in _COMPACT_EVIDENCE_AGENT_IDS
        )
        if not compact:
            return text
        try:
            payload = json.loads(text)
        except (TypeError, json.JSONDecodeError):
            return text
        if not isinstance(payload, dict) or "sources" not in payload:
            return text
        payload = dict(payload)
        payload.pop("sources", None)
        return json.dumps(payload, ensure_ascii=False)
