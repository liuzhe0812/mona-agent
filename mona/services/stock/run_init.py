"""Workflow-run evidence bootstrap (stock-module design §5.2, dev plan T21).

Before the first step of a stock workflow run executes, every symbol in
``run.inputs["symbols"]`` gets its trimmed, immutable EvidenceBundle under
``<workspace>/stock_projects/<run_id>/evidence.json`` — analysts read this
prepared data and never fetch their own (design §5.2). Instrument types
(``equity`` / ``etf``) come from the watchlist, so an ETF keeps its template
fields end to end; unknown symbols default to ``equity``.

Failures are explicit: an invalid symbol or an unavailable trading calendar
raises, the runner marks the run failed, and no agent ever runs against a
half-built bundle.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.workflow import WorkflowRun
from mona.config.paths import get_stock_project_dir
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.failover import FailoverProvider
from mona.services.stock.material_evidence import MaterialBindingError, MaterialBindingStore
from mona.services.stock.provider import (
    EastMoneyProvider,
    GovernmentResearchProvider,
    InstrumentRef,
)
from mona.services.stock.provider_tencent import TencentProvider
from mona.services.stock.storage import WatchlistStore

_EXCHANGES = ("XSHG", "XSHE", "BJSE")
_SELECTION_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_SELECTION_ORIGIN_USAGE_NOTE = (
    "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。"
)
_SELECTION_REASON_LIMIT = 3
_SELECTION_REASON_MAX_LENGTH = 240
_FOCUS_QUESTION_LIMIT = 12
_FOCUS_QUESTION_MAX_LENGTH = 240


def _default_provider() -> Any:
    """Real data source; tests rebind this seam with a mock."""
    return FailoverProvider(TencentProvider(), EastMoneyProvider())


def _default_watchlist_root() -> Path:
    """Global watchlist root (``~/.mona/stock``); tests rebind it."""
    return Path.home() / ".mona" / "stock"


def _default_cache_root() -> Path:
    """Raw-kline TTL cache root (``~/.mona/stock/cache``); tests rebind it."""
    return Path.home() / ".mona" / "stock" / "cache"


def _parse_symbol(entry: Any) -> str:
    """Validate one ``EXCHANGE:symbol`` input entry; returns it normalized."""
    if not isinstance(entry, str):
        raise ValueError(f"run inputs symbols entries must be strings, got {entry!r}")
    exchange, sep, symbol = entry.strip().partition(":")
    if not sep or exchange.upper() not in _EXCHANGES:
        raise ValueError(f"invalid symbol {entry!r}: expect EXCHANGE:symbol")
    if len(symbol) != 6 or not symbol.isdigit():
        raise ValueError(f"invalid symbol {entry!r}: expect 6 digits")
    return f"{exchange.upper()}:{symbol}"


def _report_value(payload: dict[str, Any], name: str) -> Any:
    """Read persisted reports written by either snake- or camel-case models."""
    if name in payload:
        return payload[name]
    parts = name.split("_")
    return payload.get(parts[0] + "".join(part.title() for part in parts[1:]))


def _read_report(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"{label} not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is unreadable") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be an object")
    return payload


def _claim_texts(value: Any, *, limit: int, max_length: int) -> list[str]:
    """Extract bounded text from persisted opportunity claims only."""
    if not isinstance(value, list):
        return []
    if len(value) > limit:
        raise ValueError("selection_origin text array exceeds the allowed limit")
    texts: list[str] = []
    for item in value:
        if isinstance(item, dict):
            text = item.get("text") or item.get("claim")
        elif isinstance(item, str):
            # Keep legacy opportunity payloads readable, but never accept
            # arbitrary browser text here: the value must come from the file.
            text = item
        else:
            raise ValueError("selection_origin text array contains an invalid item")
        if not isinstance(text, str):
            raise ValueError("selection_origin text array contains a non-string text")
        text = text.strip()
        if not text or len(text) > max_length:
            raise ValueError("selection_origin text exceeds the allowed length")
        if text in texts:
            continue
        texts.append(text)
    if len(texts) > limit:
        raise ValueError("selection_origin text array exceeds the allowed limit")
    return texts


def _canonical_selection_origin(
    run: Any, *, workspace: Path, raw_origin: Any
) -> dict[str, Any]:
    """Derive the only safe selection handoff from durable stock reports."""
    if not isinstance(raw_origin, dict):
        raise ValueError("run inputs 'selection_origin' must be an object")
    inputs = run.inputs if isinstance(getattr(run, "inputs", None), dict) else {}
    raw_symbols = inputs.get("symbols")
    if not isinstance(raw_symbols, list) or len(raw_symbols) != 1:
        raise ValueError("selection_origin requires exactly one symbol")
    instrument_id = _parse_symbol(raw_symbols[0])

    selection_run_id = raw_origin.get("selection_run_id")
    if (
        not isinstance(selection_run_id, str)
        or not _SELECTION_RUN_ID_RE.fullmatch(selection_run_id)
    ):
        raise ValueError("selection_origin selection_run_id is invalid")
    project_dir = get_stock_project_dir(workspace, selection_run_id)
    selection = _read_report(project_dir / "selection.json", "selection report")
    selection_workflow_run_id = _report_value(selection, "workflow_run_id")
    if selection_workflow_run_id is not None and selection_workflow_run_id != selection_run_id:
        raise ValueError("selection report does not belong to selection_run_id")
    selection_report_id = _report_value(selection, "report_id")
    if (
        not isinstance(selection_report_id, str)
        or not selection_report_id
        or len(selection_report_id) > 128
    ):
        raise ValueError("selection report is missing report_id")

    candidates = _report_value(selection, "candidates")
    if not isinstance(candidates, list):
        raise ValueError("selection report has no candidates")
    matches = [
        item
        for item in candidates
        if isinstance(item, dict)
        and (_report_value(item, "instrument_id") == instrument_id)
    ]
    if len(matches) != 1:
        raise ValueError("selection_origin instrument is not a unique selection candidate")
    selected = matches[0]
    strategy = _report_value(selection, "strategy")
    if not isinstance(strategy, dict):
        raise ValueError("selection report is missing strategy")
    strategy_id = _report_value(strategy, "strategy_id")
    strategy_name = _report_value(strategy, "name")
    strategy_horizon = _report_value(strategy, "horizon")
    if not all(
        isinstance(value, str) and value
        for value in (strategy_id, strategy_name, strategy_horizon)
    ) or len(strategy_id) > 64 or len(strategy_name) > 80:
        raise ValueError("selection report strategy is incomplete")
    deterministic_rank = _report_value(selected, "rank")
    if (
        not isinstance(deterministic_rank, int)
        or isinstance(deterministic_rank, bool)
        or deterministic_rank < 1
        or deterministic_rank > 100
    ):
        raise ValueError("selection candidate deterministic rank is invalid")
    selection_reasons = _claim_texts(
        _report_value(selected, "selection_reasons"),
        limit=_SELECTION_REASON_LIMIT,
        max_length=_SELECTION_REASON_MAX_LENGTH,
    )
    opportunity_report_id: str | None = None
    why_now: str | None = None
    research_priority: str | None = None
    focus_questions: list[str] = []
    source_count = 0
    opportunity_path = project_dir / "opportunity.json"
    if opportunity_path.is_file():
        opportunity = _read_report(opportunity_path, "opportunity report")
        opportunity_workflow_run_id = _report_value(opportunity, "workflow_run_id")
        if opportunity_workflow_run_id is not None and opportunity_workflow_run_id != selection_run_id:
            raise ValueError("opportunity report does not belong to selection_run_id")
        opportunity_candidates = _report_value(opportunity, "candidates")
        if not isinstance(opportunity_candidates, list):
            raise ValueError("opportunity report has no candidates")
        opportunity_matches = [
            item
            for item in opportunity_candidates
            if isinstance(item, dict)
            and _report_value(item, "instrument_id") == instrument_id
        ]
        if len(opportunity_matches) > 1:
            raise ValueError("opportunity report has duplicate instrument candidates")
        if opportunity_matches:
            opportunity_report_id_value = _report_value(opportunity, "report_id")
            if (
                not isinstance(opportunity_report_id_value, str)
                or not opportunity_report_id_value
                or len(opportunity_report_id_value) > 128
            ):
                raise ValueError("opportunity report is missing report_id")
            opportunity_report_id = opportunity_report_id_value
            opportunity_candidate = opportunity_matches[0]
            why_now_claim = _report_value(opportunity_candidate, "why_now")
            if isinstance(why_now_claim, dict):
                text = why_now_claim.get("text") or why_now_claim.get("claim")
                if isinstance(text, str) and text.strip():
                    why_now = text.strip()
                    if len(why_now) > 2000:
                        raise ValueError("opportunity why_now exceeds the allowed length")
            priority = _report_value(opportunity_candidate, "research_priority")
            if priority is not None:
                if priority not in {"high", "medium", "low"}:
                    raise ValueError("opportunity research_priority is invalid")
                research_priority = priority
            watch_items = _report_value(opportunity_candidate, "watch_items")
            data_gaps = _report_value(opportunity_candidate, "data_gaps")
            focus_questions = _claim_texts(
                [
                    *(watch_items if isinstance(watch_items, list) else []),
                    *(data_gaps if isinstance(data_gaps, list) else []),
                ],
                limit=_FOCUS_QUESTION_LIMIT,
                max_length=_FOCUS_QUESTION_MAX_LENGTH,
            )
            source_ids = _report_value(opportunity_candidate, "source_ids")
            if (
                not isinstance(source_ids, list)
                or len(source_ids) > 64
                or any(
                    not isinstance(item, str) or not item.strip()
                    for item in source_ids
                )
            ):
                raise ValueError("opportunity candidate source_ids is invalid")
            source_count = len({item.strip() for item in source_ids})

    selection_as_of = _report_value(selection, "as_of")
    if selection_as_of is not None and (
        not isinstance(selection_as_of, str) or len(selection_as_of) > 128
    ):
        raise ValueError("selection report as_of is invalid")

    canonical = {
        "schema_version": 1,
        "selection_run_id": selection_run_id,
        "selection_report_id": selection_report_id,
        "opportunity_report_id": opportunity_report_id,
        "instrument_id": instrument_id,
        "strategy_id": strategy_id,
        "strategy_name": strategy_name,
        "strategy_horizon": strategy_horizon,
        "deterministic_rank": deterministic_rank,
        "selection_reasons": selection_reasons,
        "why_now": why_now,
        "research_priority": research_priority,
        "focus_questions": focus_questions,
        "source_count": source_count,
        "selection_as_of": selection_as_of,
        "usage_note": _SELECTION_ORIGIN_USAGE_NOTE,
    }
    if raw_origin != canonical:
        raise ValueError("selection_origin does not match persisted selection and opportunity reports")
    return canonical


async def build_run_evidence(
    run: WorkflowRun,
    *,
    workspace: Path,
    provider: Any | None = None,
    watchlist_root: Path | None = None,
    cache_root: Path | None = None,
) -> list[str]:
    """Build the EvidenceBundle for every symbol in ``run.inputs["symbols"]``.

    Returns the normalized instrument ids actually prepared. A run without
    ``inputs.symbols`` (non-stock ad-hoc usage of the room) is a no-op.
    Idempotent per symbol — the evidence service reloads existing bundles.
    """
    inputs = run.inputs if isinstance(getattr(run, "inputs", None), dict) else {}
    selection_origin = inputs.get("selection_origin")
    if selection_origin is not None:
        _canonical_selection_origin(
            run,
            workspace=Path(workspace),
            raw_origin=selection_origin,
        )
    raw = inputs.get("symbols")
    material_binding_ids = inputs.get("material_binding_ids")
    if material_binding_ids is not None:
        if not isinstance(raw, list) or len(raw) != 1:
            raise ValueError("选择财报材料时只能对应一只股票")
        instrument_for_materials = _parse_symbol(raw[0])
        if (
            not isinstance(material_binding_ids, list)
            or not material_binding_ids
            or len(material_binding_ids) > 8
            or any(not isinstance(item, str) for item in material_binding_ids)
        ):
            raise ValueError("财报材料选择必须是 1 至 8 个绑定记录编号")
        if len(set(material_binding_ids)) != len(material_binding_ids):
            raise ValueError("财报材料绑定记录编号不能重复")
        try:
            MaterialBindingStore(Path(workspace)).confirmed_projections(
                material_binding_ids,
                instrument_id=instrument_for_materials,
            )
        except MaterialBindingError as exc:
            raise ValueError(f"材料绑定不可用于本次投研：{exc.message}") from exc
    if not raw:
        return []
    if not isinstance(raw, list):
        raise ValueError("run inputs 'symbols' must be a list")

    context_id = (run.inputs or {}).get("evidence_context_id")
    if context_id is not None:
        if not isinstance(context_id, str) or not context_id.strip():
            raise ValueError("run inputs 'evidence_context_id' must be a non-empty string")
        if len(raw) != 1:
            raise ValueError("evidence_context_id requires exactly one symbol")
        instrument_id = _parse_symbol(raw[0])
        # Promotion is a local immutable copy.  In particular, do not create
        # the default provider here: a confirmed preflight must not refetch.
        service = EvidenceService(
            workspace=Path(workspace),
            provider=None,
            cache_root=cache_root or _default_cache_root(),
        )
        if material_binding_ids:
            await service.promote_context(
                context_id.strip(),
                run.id,
                instrument_id,
                material_binding_ids=material_binding_ids,
            )
        else:
            await service.promote_context(
                context_id.strip(), run.id, instrument_id
            )
        logger.info(
            "Stock run {} reused preflight evidence context {} for {}",
            run.id,
            context_id.strip(),
            instrument_id,
        )
        return [instrument_id]

    using_default_provider = provider is None
    provider = provider if provider is not None else _default_provider()
    watchlist = WatchlistStore(watchlist_root or _default_watchlist_root())
    types = {item.id: item.instrument_type for item in watchlist.list()}

    instruments: list[InstrumentRef] = []
    seen: set[str] = set()
    for entry in raw:
        instrument_id = _parse_symbol(entry)
        if instrument_id in seen:
            continue
        seen.add(instrument_id)
        exchange, _, symbol = instrument_id.partition(":")
        instruments.append(
            InstrumentRef(
                exchange=exchange,
                symbol=symbol,
                instrument_type=types.get(instrument_id, "equity"),
            )
        )

    service = EvidenceService(
        workspace=Path(workspace),
        provider=provider,
        research_provider=GovernmentResearchProvider() if using_default_provider else None,
        cache_root=cache_root or _default_cache_root(),
    )
    if material_binding_ids:
        await service.build_batch(
            run.id,
            instruments,
            material_binding_ids=material_binding_ids,
        )
    else:
        await service.build_batch(run.id, instruments)
    logger.info(
        "Stock run {} evidence ready: {} instruments ({})",
        run.id,
        len(instruments),
        ", ".join(sorted(seen)),
    )
    return sorted(seen)
