"""Persistent submit-tool checks for the stock semantic boundary."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mona.agent.tools.stock_submit import (
    SubmitBearCaseTool,
    SubmitBullCaseTool,
    SubmitFundamentalViewTool,
    SubmitNewsViewTool,
    SubmitStockReportStagedTool,
    SubmitTechnicalViewTool,
    _public_text_error,
)
from tests.agent.tools.test_stock_submit_tools import (
    MT,
    RUN_ID,
    _v6_payload,
    build_evidence,
    make_ctx,
    set_decision_readiness,
    source_id,
    view_payload,
)

BAD_PROVIDER_TEXT = "quote unavailable；EastMoney push2 API 连接中断 &#x20;"
CLOSED_SOURCE_ID = "src_semantic_revenue_yoy"
READINESS = {
    "short_term": "failed",
    "medium_term": "failed",
    "long_term": "ready",
}


def _evidence_path(workspace: Path) -> Path:
    return workspace / "stock_projects" / RUN_ID / "evidence.json"


def _read_bundle(workspace: Path) -> dict[str, object]:
    evidence = json.loads(_evidence_path(workspace).read_text(encoding="utf-8"))
    return evidence["symbols"][MT.id]


async def _setup(tmp_path: Path) -> tuple[Path, dict[str, object], Path]:
    workspace = tmp_path / "workspace"
    bundle = await build_evidence(workspace)
    set_decision_readiness(
        workspace,
        status="failed",
        horizon_status=READINESS,
    )
    bundle = _read_bundle(workspace)

    # Keep the fixture explicit: the long claim is backed by Evidence while
    # industry evidence is absent.  The helper's synthetic provider otherwise
    # assigns existing records to every section for provenance tests.
    bundle["industry_context"] = {"status": "missing", "source_ids": []}
    source = dict(bundle["sources"][0])
    source.update(
        id=CLOSED_SOURCE_ID,
        url="fake://semantic/revenue-yoy",
        fields=["revenue_yoy"],
    )
    bundle["sources"].append(source)
    bundle["fundamentals"]["source_ids"] = [CLOSED_SOURCE_ID]
    bundle["fundamentals"]["metrics"]["revenue_yoy"] = 0.625
    _evidence_path(workspace).write_text(
        json.dumps(
            {"schema_version": 1, "symbols": {MT.id: bundle}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return workspace, bundle, _evidence_path(workspace).parent


def _ctx(workspace: Path, job_id: str, agent_id: str) -> object:
    return make_ctx(
        workspace,
        room_id="room1",
        workflow_run_id=RUN_ID,
        job_id=job_id,
        agent_id=agent_id,
    )


def _terms_absent(text: str) -> None:
    for term in (
        "research_ready",
        "quote",
        "EastMoney",
        "push2",
        "API",
        "unavailable",
        "insufficient_data",
        "&#x20;",
    ):
        assert term not in text


@pytest.mark.asyncio
async def test_unavailable_technical_and_news_summaries_are_publicized_on_disk(
    tmp_path,
):
    workspace, bundle, run_dir = await _setup(tmp_path)
    for tool_cls, kind, expected in (
        (SubmitTechnicalViewTool, "technical", "短线已核验"),
        (SubmitNewsViewTool, "news", "中线已核验"),
    ):
        payload = view_payload(
            bundle,
            kind,
            stance="insufficient_data",
            summary=BAD_PROVIDER_TEXT,
        )
        result = await tool_cls(
            workspace, _ctx(workspace, f"job_semantic_{kind}", kind)
        ).execute(**payload)
        assert result == f"Submitted {kind} view: {kind}.json", result

        artifact = json.loads(
            (run_dir / f"{kind}.json").read_text(encoding="utf-8")
        )
        assert artifact["summary"].startswith(expected)
        assert _public_text_error(artifact) is None
        _terms_absent(artifact["summary"])


def _unavailable_case_payload(bundle: dict[str, object]) -> dict[str, object]:
    payload = view_payload(
        bundle,
        "bull",
        stance="insufficient_data",
        summary="多空情景按证据状态记录",
    )
    for case in payload["horizon_cases"].values():
        case.update(
            status="insufficient_data",
            summary=BAD_PROVIDER_TEXT,
            points=[],
            confirmation=[],
            invalidation=[],
            source_ids=[],
        )
    return payload


@pytest.mark.asyncio
async def test_unavailable_bull_and_bear_summaries_do_not_leak_internal_reasons(
    tmp_path,
):
    workspace, bundle, run_dir = await _setup(tmp_path)
    for tool_cls, kind, label in (
        (SubmitBullCaseTool, "bull", "多头情景"),
        (SubmitBearCaseTool, "bear", "空头情景"),
    ):
        result = await tool_cls(
            workspace, _ctx(workspace, f"job_semantic_{kind}", kind)
        ).execute(**_unavailable_case_payload(bundle))
        assert result == f"Submitted {kind} view: {kind}.json", result

        artifact = json.loads(
            (run_dir / f"{kind}.json").read_text(encoding="utf-8")
        )
        assert _public_text_error(artifact) is None
        assert "多空情景" in artifact["summary"]
        for case in artifact["horizon_cases"].values():
            assert label in case["summary"]
            _terms_absent(case["summary"])


def _long_claim_payload(bundle: dict[str, object], claim: str) -> dict[str, object]:
    payload = view_payload(bundle, "fundamental", stance="positive")
    payload["company_quality"] = [
        {
            "claim": claim,
            "evidence": "Evidence 已核验财务数据",
            "claim_type": "fact",
            "source_ids": [CLOSED_SOURCE_ID],
        }
    ]
    return payload


@pytest.mark.asyncio
async def test_evidence_closed_long_claim_is_accepted_and_self_computed_values_rejected(
    tmp_path,
):
    workspace, bundle, run_dir = await _setup(tmp_path)
    tool = SubmitFundamentalViewTool(
        workspace,
        _ctx(workspace, "job_semantic_fundamental", "fundamental"),
    )

    accepted = await tool.execute(
        **_long_claim_payload(bundle, "公司收入同比增长62.5%")
    )
    assert accepted == "Submitted fundamental view: fundamental.json", accepted
    persisted = json.loads(
        (run_dir / "fundamental.json").read_text(encoding="utf-8")
    )
    assert persisted["company_quality"][0]["claim"] == "公司收入同比增长62.5%"

    for claim in ("公司收入同比增长99.9%", "公司收入同比增长20%"):
        rejected = await tool.execute(**_long_claim_payload(bundle, claim))
        assert rejected.startswith("Error:"), rejected
        assert claim.split("增长", 1)[1] in rejected
        assert "numeric closure" in rejected


def _industry_claim_payload(bundle: dict[str, object]) -> dict[str, object]:
    payload = _unavailable_case_payload(bundle)
    long_case = payload["horizon_cases"]["long_term"] = dict(
        payload["horizon_cases"]["long_term"]
    )
    long_case.update(
        status="available",
        summary="行业周期已确认，当前处于复苏中段",
        points=[
            {
                "claim": "行业周期已确认，当前处于复苏中段",
                "evidence": "待补充行业证据",
                "claim_type": "hypothesis",
                "source_ids": [source_id(bundle, "fund")],
            }
        ],
        source_ids=[source_id(bundle, "fund")],
    )
    return payload


@pytest.mark.asyncio
async def test_missing_industry_evidence_rejects_bull_industry_cycle_claim(
    tmp_path,
):
    workspace, bundle, run_dir = await _setup(tmp_path)
    result = await SubmitBullCaseTool(
        workspace, _ctx(workspace, "job_semantic_industry", "bull")
    ).execute(**_industry_claim_payload(bundle))
    assert result.startswith("Error:"), result
    assert "industry" in result
    assert not (run_dir / "bull.json").exists()


def _v6_stage(payload: dict[str, object]) -> dict[str, object]:
    return {
        "summary": payload["summary"],
        "instrument": payload["instrument"],
        "horizon_decisions_v6": payload["horizon_decisions_v6"],
    }


@pytest.mark.asyncio
async def test_v6_finalize_rejects_internal_or_industry_text_then_writes_research_only_report(
    tmp_path,
):
    workspace, bundle, run_dir = await _setup(tmp_path)
    tool = SubmitStockReportStagedTool(
        workspace,
        _ctx(workspace, "job_semantic_referee", "referee"),
    )

    for term in ("research_ready", "quote", "EastMoney", "API", "&#x20;"):
        bad = _v6_payload(bundle, ("long_term",))
        bad["summary"] = term
        assert (
            await tool.execute(section="deep_v6", payload=_v6_stage(bad))
        ).startswith("Saved deep_v6:")
        rejected_text = await tool.execute(section="finalize")
        assert rejected_text.startswith("Error:"), rejected_text
        assert term in rejected_text
        assert not (run_dir / "report.json").exists()

    industry = _v6_payload(bundle, ("long_term",))
    industry["horizon_decisions_v6"]["long_term"][
        "thesis"
    ] = "行业周期已确认，当前处于复苏中段"
    assert (await tool.execute(section="deep_v6", payload=_v6_stage(industry))).startswith(
        "Saved deep_v6:"
    )
    rejected_industry = await tool.execute(section="finalize")
    assert rejected_industry.startswith("Error:"), rejected_industry
    assert "industry" in rejected_industry
    assert not (run_dir / "report.json").exists()

    clean = _v6_payload(bundle, ("long_term",))
    clean["summary"] = "公司盈利结论已按财务证据核验"
    clean["horizon_decisions_v6"]["long_term"][
        "thesis"
    ] = "公司盈利周期处于复苏中段"
    assert (await tool.execute(section="deep_v6", payload=_v6_stage(clean))).startswith(
        "Saved deep_v6:"
    )
    submitted = await tool.execute(section="finalize")
    assert submitted.startswith("Submitted stock_report_v6_"), submitted

    report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    assert report["decision_mode"] == "research_only"
    assert all(
        decision["materialized_plan"] is None
        for decision in report["horizon_decisions"].values()
    )
    assert _public_text_error(report) is None
    assert not any(
        token in json.dumps(report, ensure_ascii=False)
        for token in ("EastMoney", "&#x20;")
    )
