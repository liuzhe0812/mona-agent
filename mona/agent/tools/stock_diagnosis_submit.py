"""Single-agent semantic submission for standard stock diagnosis."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from pydantic import ValidationError

from mona.agent import run_artifacts
from mona.agent.artifacts import ArtifactRef
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.workflow import WorkflowRunStore
from mona.services.stock.diagnosis import DiagnosisService
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.schemas import DiagnosisSemanticSubmission, InstrumentTag

_CLAIM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {"type": "string"},
        "source_ids": {"type": "array", "items": {"type": "string"}},
        "claim_type": {"type": "string", "enum": ["fact", "inference", "hypothesis"]},
    },
    "required": ["text"],
}
_INSTRUMENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "symbol": {"type": "string"},
        "exchange": {"type": "string", "enum": ["XSHG", "XSHE", "BJSE"]},
        "name": {"type": "string"},
        "instrument_type": {"type": "string", "enum": ["equity", "etf", "index"]},
    },
    "required": ["symbol", "exchange"],
}
_SEMANTIC_PROPERTIES: dict[str, Any] = {
    "schema_version": {"type": "integer", "enum": [1]},
    "instrument": {**_INSTRUMENT_SCHEMA, "type": ["object", "null"]},
    "evidence_context_id": {"type": ["string", "null"]},
    "source_ids": {"type": "array", "items": {"type": "string"}},
    "business_understandable": {"type": ["boolean", "null"]},
    "company_understanding": {"type": ["string", "null"]},
    "business_model": {"type": ["string", "null"]},
    "business_model_summary": {"type": ["string", "null"]},
    "revenue_sources": {"type": "array", "items": {"type": "string"}},
}
for _name in (
    "competitive_advantages", "competitive_advantage",
    "competitive_counterevidence", "competitive_advantage_counterevidence",
    "management_governance", "governance", "industry_supply_demand", "industry_context",
    "policy_transmission", "policy_context", "cycle_position", "cycle_context",
    "key_assumptions", "risks", "conclusion_change_conditions", "change_conditions",
):
    _SEMANTIC_PROPERTIES[_name] = {"type": "array", "items": _CLAIM_SCHEMA}
_SEMANTIC_PARAMS = {
    "type": "object",
    "additionalProperties": False,
    "properties": _SEMANTIC_PROPERTIES,
}


def _all_source_ids(value: Any) -> set[str]:
    if isinstance(value, Mapping):
        found = {
            item for item in value.get("source_ids", [])
            if isinstance(item, str) and item
        }
        for child in value.values():
            found.update(_all_source_ids(child))
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for child in value:
            found.update(_all_source_ids(child))
        return found
    return set()


def _instrument_id(instrument: InstrumentTag) -> str:
    return f"{instrument.exchange}:{instrument.symbol}"


def _diagnosis_id(run_id: str, context_id: str, instrument_id: str) -> str:
    digest = hashlib.sha256(
        f"{run_id}\0{context_id}\0{instrument_id}".encode("utf-8")
    ).hexdigest()[:32]
    return f"diagnosis_{digest}"


def _run_inputs(workspace: Path, run_id: str) -> dict[str, Any]:
    try:
        store = WorkflowRunStore(WorkflowRunStore.default_dir(workspace))
        run = store.load(run_id)
    except Exception:
        return {}
    return dict(run.inputs) if isinstance(run.inputs, dict) else {}


def _context_bundle(
    workspace: Path,
    run_id: str,
    context_id: str,
    instrument_id: str,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        context = EvidenceService(workspace=workspace, provider=None).read_context(context_id)
    except ValueError as exc:
        return None, f"Error: invalid evidence context: {exc}"
    if not isinstance(context, Mapping):
        return None, f"Error: evidence context {context_id!r} not found."
    if context.get("context_id") != context_id:
        return None, "Error: evidence context id mismatch."
    owner = context.get("owner")
    owner_run_id = (
        (owner.get("workflow_run_id") or owner.get("run_id"))
        if isinstance(owner, Mapping)
        else None
    )
    if owner_run_id != run_id:
        return None, "Error: evidence context belongs to a different workflow run."
    symbols = context.get("symbols")
    bundle = symbols.get(instrument_id) if isinstance(symbols, Mapping) else None
    if not isinstance(bundle, dict):
        return None, f"Error: evidence context has no exact evidence for {instrument_id}."
    instrument = bundle.get("instrument")
    actual_id = (
        f"{instrument.get('exchange')}:{instrument.get('symbol')}"
        if isinstance(instrument, Mapping)
        else None
    )
    if actual_id != instrument_id:
        return None, "Error: evidence context instrument mismatch."
    source_records = bundle.get("sources")
    if not isinstance(source_records, list):
        return None, "Error: evidence context source closure is invalid."
    source_ids = {
        item.get("id") for item in source_records
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    missing = sorted(_all_source_ids(bundle) - source_ids)
    if missing:
        return None, "Error: evidence context source closure is missing: " + ", ".join(missing)
    return bundle, None


@tool_parameters(_SEMANTIC_PARAMS)
class SubmitStockDiagnosisSemanticTool(Tool):
    """Validate and persist the one allowed semantic diagnosis submission."""

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "submit_stock_diagnosis_semantic"

    @property
    def description(self) -> str:
        return (
            "Submit only company/industry/policy/cycle/governance/risk semantics "
            "for the current immutable Evidence context. Prices, technical and "
            "quantitative fields are rejected; deterministic code finalizes the report."
        )

    async def execute(self, **kwargs: Any) -> str:
        run_id = getattr(self._tool_ctx, "workflow_run_id", None)
        job_id = getattr(self._tool_ctx, "job_id", None)
        if not isinstance(run_id, str) or not run_id or not isinstance(job_id, str) or not job_id:
            return "Error: diagnosis semantic submission is only available inside a workflow run."

        try:
            payload = DiagnosisSemanticSubmission.model_validate(kwargs)
        except ValidationError as exc:
            return f"Error: invalid semantic submission: {exc}"

        inputs = _run_inputs(self._workspace, run_id)
        trusted_context_id = inputs.get("evidence_context_id")
        context_id = payload.evidence_context_id or trusted_context_id
        if not isinstance(context_id, str) or not context_id.strip():
            return "Error: evidence_context_id is required for standard diagnosis."
        context_id = context_id.strip()

        try:
            trusted_instrument = InstrumentTag.model_validate(payload.instrument or {})
        except ValidationError:
            trusted_instrument = None
        run_evidence = EvidenceService(workspace=self._workspace, provider=None).read(run_id) or {}
        run_symbols = run_evidence.get("symbols") if isinstance(run_evidence, Mapping) else None
        if trusted_instrument is None and isinstance(run_symbols, Mapping) and len(run_symbols) == 1:
            raw = next(iter(run_symbols.values())).get("instrument")
            try:
                trusted_instrument = InstrumentTag.model_validate(raw)
            except ValidationError:
                trusted_instrument = None
        if trusted_instrument is None:
            return "Error: current diagnosis instrument is unavailable."
        instrument_id = _instrument_id(trusted_instrument)
        if isinstance(run_symbols, Mapping) and run_symbols and instrument_id not in run_symbols:
            return "Error: semantic submission instrument does not match current run."
        bundle, error = _context_bundle(self._workspace, run_id, context_id, instrument_id)
        if error is not None or bundle is None:
            return error or "Error: immutable evidence context is unavailable."
        # The preflight context proves identity and source closure, while the
        # run Evidence is the enriched immutable snapshot produced before the
        # Agent step.  Quant cross-section and other deterministic additions
        # are attached to the run snapshot, so finalization must consume it
        # instead of the earlier preflight copy.
        run_bundle = run_symbols.get(instrument_id) if isinstance(run_symbols, Mapping) else None
        if isinstance(run_bundle, Mapping):
            run_sources = run_bundle.get("sources")
            if not isinstance(run_sources, list):
                return "Error: current run evidence source closure is invalid."
            run_source_ids = {
                item.get("id") for item in run_sources
                if isinstance(item, Mapping) and isinstance(item.get("id"), str)
            }
            missing_run_sources = sorted(_all_source_ids(run_bundle) - run_source_ids)
            if missing_run_sources:
                return "Error: current run evidence source closure is missing: " + ", ".join(missing_run_sources)
            run_instrument = run_bundle.get("instrument")
            run_instrument_id = (
                f"{run_instrument.get('exchange')}:{run_instrument.get('symbol')}"
                if isinstance(run_instrument, Mapping)
                else None
            )
            if run_instrument_id != instrument_id:
                return "Error: current run evidence instrument mismatch."
            bundle = dict(run_bundle)
        try:
            context_instrument = InstrumentTag.model_validate(bundle.get("instrument") or {})
        except ValidationError:
            return "Error: evidence context instrument is invalid."
        if (
            context_instrument.exchange != trusted_instrument.exchange
            or context_instrument.symbol != trusted_instrument.symbol
            or context_instrument.instrument_type != trusted_instrument.instrument_type
        ):
            return "Error: semantic submission instrument does not match evidence context."
        if payload.instrument is not None and payload.instrument != trusted_instrument:
            return "Error: semantic submission instrument does not match current run."
        if trusted_context_id is not None and trusted_context_id != context_id:
            return "Error: semantic submission evidence_context_id does not match current run."

        context_source_ids = {
            item.get("id") for item in bundle.get("sources", [])
            if isinstance(item, Mapping) and isinstance(item.get("id"), str)
        }
        if not set(payload.source_ids) <= context_source_ids:
            missing = sorted(set(payload.source_ids) - context_source_ids)
            return "Error: semantic submission source closure failed: " + ", ".join(missing)

        diagnosis_id = _diagnosis_id(run_id, context_id, instrument_id)
        # Workflow steps run with an isolated ``stock_projects/<run_id>``
        # workspace.  DiagnosisStore is product-level state, so normalize
        # back to the Mona workspace root before deterministic finalization.
        from mona.config.paths import get_stock_projects_dir

        diagnosis_workspace = get_stock_projects_dir(self._workspace).parent
        service = DiagnosisService(diagnosis_workspace)
        try:
            existing = service.store.read(diagnosis_id)
            if existing is None:
                service.create(
                    instrument=trusted_instrument,
                    evidence_context_id=context_id,
                    evidence=bundle,
                    semantic_research=payload,
                    diagnosis_id=diagnosis_id,
                )
            elif existing.get("status") in {"failed", "cancelled"}:
                service.retry(diagnosis_id)
            result = await service.execute(diagnosis_id)
        except Exception as exc:
            return f"Error: diagnosis finalization failed: {exc}"
        if result.get("status") != "succeeded" or not isinstance(result.get("report"), Mapping):
            return "Error: diagnosis semantic Agent failed; no diagnosis conclusion was generated."

        # A submission arrives after the one semantic Agent has run.  Record
        # that real step explicitly; the service itself performs no second LLM.
        record = service.store.require(diagnosis_id)
        if int(record.get("llm_agent_steps") or 0) != 1:
            service._update(  # noqa: SLF001 - this is the deterministic submit seam
                record,
                agent_steps=[{
                    "step_id": "semantic_research",
                    "kind": "semantic_research",
                    "status": "succeeded",
                }],
                agent_step_count=1,
                llm_agent_steps=1,
            )

        from mona.config.paths import get_stock_project_dir

        run_dir = get_stock_project_dir(diagnosis_workspace, run_id)
        artifact = payload.model_dump(mode="json")
        artifact.update({
            "kind": "diagnosis_semantic_submission",
            "workflow_run_id": run_id,
            "diagnosis_id": diagnosis_id,
            "instrument": trusted_instrument.model_dump(mode="json"),
            "evidence_context_id": context_id,
            "sources": [
                source for source in bundle.get("sources", [])
                if isinstance(source, Mapping) and source.get("id") in set(payload.source_ids)
            ],
        })
        run_dir.mkdir(parents=True, exist_ok=True)
        path = run_dir / "semantic_submission.json"
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
        ref = ArtifactRef.for_path(
            owner_kind="product",
            owner_id=run_id,
            product="stock",
            root=run_dir,
            path=path,
            created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
            job_id=job_id,
            workflow_run_id=run_id,
            room_id=getattr(self._tool_ctx, "room_id", None),
        )
        run_artifacts.append(job_id, ref)
        return f"Submitted standard diagnosis semantic: {ref.relative_path}; finalized {diagnosis_id}"
