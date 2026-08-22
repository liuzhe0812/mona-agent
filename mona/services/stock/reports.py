"""Read-only stock report queries over ``<workspace>/stock_projects/`` (design §10.2).

Report/digest documents are written by the submit tools (T12) as
``<run_id>/{report,digest}.{json,md}``. This module scans them for the
WebSocket GET routes (T16): list, detail and the watchlist × latest-report
dashboard aggregate. It never writes and never leaves the given directory —
``report_id`` is matched against document content, never used as a path
component.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from mona.services.stock.storage import WatchlistItem, WatchlistStore

_REPORT_ID_RE = re.compile(r"^[a-z0-9_]+$")
_STEMS = ("report", "digest")

_STORE: WatchlistStore | None = None


def _store() -> WatchlistStore:
    """Process-wide watchlist store (``~/.mona/stock``); tests rebind it."""
    global _STORE
    if _STORE is None:
        _STORE = WatchlistStore(Path.home() / ".mona" / "stock")
    return _STORE


def valid_report_id(report_id: str) -> bool:
    return bool(_REPORT_ID_RE.fullmatch(report_id))


def default_watchlist() -> list[WatchlistItem]:
    """The global watchlist (``~/.mona/stock``) the dashboard joins against."""
    return _store().list()


def _read_doc(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Skipping unreadable stock report {}", path)
        return None
    return doc if isinstance(doc, dict) else None


def _instrument_payload(doc: dict[str, Any]) -> dict[str, Any] | None:
    inst = doc.get("instrument")
    if not isinstance(inst, dict):
        return None
    return {
        "instrumentId": f"{inst.get('exchange')}:{inst.get('symbol')}",
        "symbol": inst.get("symbol"),
        "exchange": inst.get("exchange"),
        "name": inst.get("name") or "",
        "instrumentType": inst.get("instrument_type"),
    }


def _is_v4_deep_report(doc: dict[str, Any]) -> bool:
    return doc.get("kind") == "deep_research" and doc.get("schema_version") == 4


def _horizon_stances(doc: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    """Project V4 horizon fields without deriving missing values."""
    views = doc.get("horizon_views")
    if not isinstance(views, dict):
        return None
    return {
        key: {
            "stance": view.get("stance") if isinstance(view, dict) else None,
            "status": view.get("status") if isinstance(view, dict) else None,
        }
        for key, source_key in (
            ("shortTerm", "short_term"),
            ("mediumTerm", "medium_term"),
            ("longTerm", "long_term"),
        )
        for view in (views.get(source_key),)
    }


def _report_projection(doc: dict[str, Any]) -> dict[str, Any]:
    """Return the shared list/dashboard projection for one document."""
    if not _is_v4_deep_report(doc):
        return {
            "stance": doc.get("research_stance"),
            "dataQuality": doc.get("data_quality"),
        }
    return {
        "schemaVersion": doc.get("schema_version"),
        "horizonStances": _horizon_stances(doc),
        "researchCutoffAt": doc.get("research_cutoff_at"),
        "marketAsOf": doc.get("market_as_of"),
        "evidenceCoverage": doc.get("evidence_coverage"),
        # V4 deliberately has no composite stance/quality.
        "stance": None,
        "dataQuality": None,
    }


def _doc_projections(doc: dict[str, Any]) -> list[tuple[str, str | None, str | None]]:
    """``(instrument_id, stance, data_quality)`` for each covered instrument."""
    if doc.get("kind") == "daily_review":
        out: list[tuple[str, str | None, str | None]] = []
        for item in doc.get("items") or []:
            inst = item.get("instrument") or {}
            iid = f"{inst.get('exchange')}:{inst.get('symbol')}"
            out.append((iid, item.get("stance"), item.get("data_quality")))
        return out
    inst = _instrument_payload(doc)
    if inst is None:
        return []
    projection = _report_projection(doc)
    return [(inst["instrumentId"], projection["stance"], projection["dataQuality"])]


def _iter_docs(stock_dir: Path):
    """Yield ``(mtime, run_dir, stem, doc)`` for every readable document."""
    if not stock_dir.is_dir():
        return
    for run_dir in sorted(stock_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        for stem in _STEMS:
            path = run_dir / f"{stem}.json"
            if not path.is_file():
                continue
            doc = _read_doc(path)
            if doc is None:
                continue
            yield path.stat().st_mtime, run_dir, stem, doc


def _list_item(mtime: float, run_dir: Path, doc: dict[str, Any]) -> dict[str, Any]:
    item = {
        "reportId": doc.get("report_id"),
        "runId": doc.get("workflow_run_id") or run_dir.name,
        "kind": doc.get("kind"),
        "instrument": _instrument_payload(doc),
        "symbols": [p[0] for p in _doc_projections(doc)],
        "asOf": doc.get("as_of"),
        "modifiedAt": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
    }
    item.update(_report_projection(doc))
    return item


def scan_reports(stock_dir: Path) -> list[dict[str, Any]]:
    """All report/digest list items, newest document first."""
    entries = [
        (mtime, _list_item(mtime, run_dir, doc))
        for mtime, run_dir, _stem, doc in _iter_docs(stock_dir)
    ]
    entries.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in entries]


def load_report(stock_dir: Path, report_id: str) -> tuple[dict[str, Any], str] | None:
    """``(doc, markdown)`` for ``report_id``; ``None`` when not found."""
    for _mtime, run_dir, stem, doc in _iter_docs(stock_dir):
        if doc.get("report_id") != report_id:
            continue
        md_path = run_dir / f"{stem}.md"
        markdown = md_path.read_text(encoding="utf-8") if md_path.is_file() else ""
        if "source_ids" not in doc:
            sources = doc.get("sources") or []
            if isinstance(sources, list):
                doc = {
                    **doc,
                    "source_ids": [
                        source["id"]
                        for source in sources
                        if isinstance(source, dict) and isinstance(source.get("id"), str)
                    ],
                }
        return doc, markdown
    return None


def delete_report(stock_dir: Path, report_id: str) -> bool:
    """Delete the whole run directory backing ``report_id`` (manual cleanup).

    Design §9: reports are never auto-deleted, but the user gets an explicit
    cleanup entry. The run directory holds the report/digest plus its
    evidence bundle and view artifacts — they are one run's products and go
    away together. ``report_id`` is matched against document content, never
    used as a path component. Returns whether anything was deleted.
    """
    if not valid_report_id(report_id):
        return False
    for _mtime, run_dir, _stem, doc in _iter_docs(stock_dir):
        if doc.get("report_id") != report_id:
            continue
        shutil.rmtree(run_dir, ignore_errors=True)
        logger.info("Deleted stock report {} (run dir {})", report_id, run_dir.name)
        return True
    return False


def build_dashboard(
    stock_dir: Path, watchlist: list[WatchlistItem]
) -> list[dict[str, Any]]:
    """Watchlist items joined with their newest deep-research projection.

    Daily-review digests are a separate, portfolio-level product and must not
    replace a symbol's persisted deep-research result in this index.
    """
    latest: dict[str, tuple[float, dict[str, Any]]] = {}
    for mtime, run_dir, _stem, doc in _iter_docs(stock_dir):
        if doc.get("kind") != "deep_research":
            continue
        for instrument_id, stance, quality in _doc_projections(doc):
            current = latest.get(instrument_id)
            if current is not None and current[0] >= mtime:
                continue
            projection = _report_projection(doc)
            latest[instrument_id] = (
                mtime,
                {
                    "reportId": doc.get("report_id"),
                    "runId": doc.get("workflow_run_id") or run_dir.name,
                    "kind": doc.get("kind"),
                    "asOf": doc.get("as_of"),
                    **projection,
                },
            )
    return [
        {
            "instrumentId": item.id,
            "name": item.name,
            "instrumentType": item.instrument_type,
            "focus": item.focus,
            "latest": (latest.get(item.id) or (0.0, None))[1],
        }
        for item in watchlist
    ]
