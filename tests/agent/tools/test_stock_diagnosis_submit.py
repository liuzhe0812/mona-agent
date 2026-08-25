from __future__ import annotations

import json
from pathlib import Path

import pytest

from mona.agent.tools.context import ToolContext
from mona.agent.tools.stock_diagnosis_submit import SubmitStockDiagnosisSemanticTool

RUN_ID = "run_diagnosis_contract"
CONTEXT_ID = "ctx_diagnosiscontract"
INSTRUMENT = {"exchange": "XSHG", "symbol": "600519", "name": "测试标的"}
INSTRUMENT_ID = "XSHG:600519"
SOURCE_ID = "src_diagnosis_business"


def _seed(
    workspace: Path,
    *,
    owner_run_id: str = RUN_ID,
    run_enrichment: dict | None = None,
) -> None:
    bundle = {
        "instrument": INSTRUMENT,
        "research_cutoff_at": "2026-08-25T10:00:00+08:00",
        "source_ids": [SOURCE_ID],
        "sources": [{"id": SOURCE_ID, "url": "https://example.test/business"}],
        "company_quality": {"source_ids": [SOURCE_ID]},
    }
    context_dir = workspace / "stock_contexts"
    context_dir.mkdir(parents=True)
    (context_dir / f"{CONTEXT_ID}.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "context_id": CONTEXT_ID,
                "owner": {"workflow_run_id": owner_run_id},
                "symbols": {INSTRUMENT_ID: bundle},
            }
        ),
        encoding="utf-8",
    )
    run_dir = workspace / "stock_projects" / RUN_ID
    run_dir.mkdir(parents=True)
    run_bundle = {**bundle, **(run_enrichment or {})}
    (run_dir / "evidence.json").write_text(
        json.dumps({"run_id": RUN_ID, "symbols": {INSTRUMENT_ID: run_bundle}}),
        encoding="utf-8",
    )


def _tool(workspace: Path, *, run_id: str = RUN_ID) -> SubmitStockDiagnosisSemanticTool:
    return SubmitStockDiagnosisSemanticTool(
        workspace,
        ToolContext(
            config=None,
            workspace=str(workspace),
            agent_id="com.mona.stock-diagnosis-semantic-researcher",
            workflow_run_id=run_id,
            job_id="job_diagnosis_contract",
            room_id="stock_ai_diagnosis",
        ),
    )


@pytest.mark.asyncio
async def test_semantic_submission_finalizes_deterministically_and_records_one_agent(tmp_path: Path):
    _seed(tmp_path)
    result = await _tool(tmp_path).execute(
        instrument=INSTRUMENT,
        evidence_context_id=CONTEXT_ID,
        source_ids=[SOURCE_ID],
        business_model="公开证据中的主营业务",
    )
    assert result.startswith("Submitted standard diagnosis semantic:")
    submission = json.loads(
        (tmp_path / "stock_projects" / RUN_ID / "semantic_submission.json").read_text(
            encoding="utf-8"
        )
    )
    assert submission["workflow_run_id"] == RUN_ID
    reports = list((tmp_path / "stock_diagnoses").glob("*/run.json"))
    assert len(reports) == 1
    record = json.loads(reports[0].read_text(encoding="utf-8"))
    assert record["status"] == "succeeded"
    assert record["llm_agent_steps"] == 1
    assert (reports[0].parent / "report.json").is_file()


@pytest.mark.asyncio
async def test_semantic_submission_uses_enriched_run_quant_not_preflight_copy(tmp_path: Path):
    quant = {
        "horizons": {
            horizon: {
                "status": "available",
                "score": 0.8,
                "validation_status": "descriptive",
                "market_sample_count": 30,
                "source_ids": [SOURCE_ID],
            }
            for horizon in ("short_term", "medium_term", "long_term")
        },
        "source_ids": [SOURCE_ID],
    }
    _seed(tmp_path, run_enrichment={"quant_validation": quant})

    result = await _tool(tmp_path).execute(
        instrument=INSTRUMENT,
        evidence_context_id=CONTEXT_ID,
        source_ids=[SOURCE_ID],
        business_model="公开证据中的主营业务",
    )

    assert result.startswith("Submitted standard diagnosis semantic:")
    report_path = next((tmp_path / "stock_diagnoses").glob("*/report.json"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["quant_factors"]["short_term"]["sample_count"] == 30
    assert report["quant_factors"]["short_term"]["factor_score"] == 0.8


@pytest.mark.asyncio
async def test_semantic_submission_rejects_numeric_fields_and_source_escape(tmp_path: Path):
    _seed(tmp_path)
    tool = _tool(tmp_path)
    numeric = await tool.execute(
        instrument=INSTRUMENT,
        evidence_context_id=CONTEXT_ID,
        source_ids=[SOURCE_ID],
        price=10,
    )
    assert numeric.startswith("Error: invalid semantic submission:")
    escaped = await tool.execute(
        instrument=INSTRUMENT,
        evidence_context_id=CONTEXT_ID,
        source_ids=["src_other_run"],
        business_model="不应落盘",
    )
    assert "source closure" in escaped
    assert not list((tmp_path / "stock_diagnoses").glob("*/report.json"))


@pytest.mark.asyncio
async def test_semantic_submission_rejects_context_and_instrument_mismatch(tmp_path: Path):
    _seed(tmp_path, owner_run_id="run_other")
    result = await _tool(tmp_path).execute(
        instrument=INSTRUMENT,
        evidence_context_id=CONTEXT_ID,
        source_ids=[SOURCE_ID],
    )
    assert "different workflow run" in result

    mismatch_workspace = tmp_path / "instrument-mismatch"
    _seed(mismatch_workspace)
    mismatch = dict(INSTRUMENT, symbol="000001")
    result = await _tool(mismatch_workspace).execute(
        instrument=mismatch,
        evidence_context_id=CONTEXT_ID,
        source_ids=[SOURCE_ID],
    )
    assert "does not match current run" in result
