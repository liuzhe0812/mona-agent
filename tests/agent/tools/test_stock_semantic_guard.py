import json
from copy import deepcopy

import pytest

from mona.agent.tools.stock_submit import (
    SubmitBullCaseTool,
    _numeric_closure_error,
    _public_text_error,
    _publicize_unavailable_artifact,
    _v6_industry_claim_error,
)
from tests.agent.tools.test_stock_submit_tools import (
    JOB_ID,
    RUN_ID,
    build_evidence,
    make_ctx,
    set_decision_readiness,
    view_payload,
)


def _bundle(*, short="failed", medium="failed", long="failed"):
    return {
        "decision_readiness": {
            "research_ready": {
                "horizons": {
                    "short_term": {"status": short, "available": ["kline"]},
                    "medium_term": {"status": medium, "available": ["fundamentals"]},
                    "long_term": {"status": long, "available": ["fundamentals"]},
                }
            }
        },
        "industry_context": {"status": "missing", "source_ids": []},
        "fundamentals": {
            "metrics": {"roe": 0.166},
            "source_ids": ["src_fund"],
        },
    }


def test_public_text_guard_rejects_run_958_style_provider_and_internal_terms():
    error = _public_text_error(
        {
            "summary": (
                "短线研究结论不可用：quote 分区与衍生技术指标均缺失，"
                "EastMoney push2 API 连接中断"
            )
        }
    )
    assert error is not None
    assert "summary" in error


def test_public_text_guard_rejects_single_word_internal_fields():
    for term in ("quote", "kline", "tradeability"):
        error = _public_text_error({"summary": f"{term} 已失效"})
        assert error is not None
        assert "summary" in error


def test_unavailable_views_and_cases_use_deterministic_public_summary():
    bundle = _bundle()
    view = _publicize_unavailable_artifact(
        {"stance": "insufficient_data", "summary": "industry_context unavailable"},
        bundle,
        "fundamental",
    )
    assert "行业" not in view["summary"]
    assert "unavailable" not in view["summary"]
    assert "交易计划" in view["summary"]

    cases = _publicize_unavailable_artifact(
        {
            "horizon_cases": {
                "medium_term": {
                    "status": "insufficient_data",
                    "summary": "证据不足，insufficient_data",
                }
            }
        },
        bundle,
        "bull",
    )
    assert "多头情景" in cases["horizon_cases"]["medium_term"]["summary"]
    assert "insufficient_data" not in cases["horizon_cases"]["medium_term"]["summary"]


def test_numeric_closure_accepts_scaled_percent_and_ignores_report_period():
    bundle = _bundle()
    assert _numeric_closure_error(
        {
            "summary": "2026Q2报告显示ROE为16.6%",
            "source_ids": ["src_fund"],
        },
        bundle,
    ) is None


def test_numeric_closure_rejects_unsourced_inferred_percent_with_field_path():
    error = _numeric_closure_error(
        {
            "horizon_decisions": {
                "long_term": {
                    "key_reasons": [
                        {
                            "claim": "隐含盈利增速为20%",
                            "source_ids": ["src_fund"],
                        }
                    ]
                }
            }
        },
        _bundle(),
    )
    assert error is not None
    assert "horizon_decisions.long_term.key_reasons[0].claim" in error
    assert "20%" in error


def test_numeric_closure_keeps_business_percent_after_report_period():
    bundle = _bundle()
    bundle["fundamentals"]["metrics"]["revenue_yoy"] = 0.625
    assert _numeric_closure_error(
        {"summary": "2026H1收入同比增长62.5%", "source_ids": ["src_fund"]},
        bundle,
    ) is None
    error = _numeric_closure_error(
        {"summary": "2026H1收入同比增长99.9%", "source_ids": ["src_fund"]},
        bundle,
    )
    assert error is not None
    assert "99.9%" in error
    assert _numeric_closure_error(
        {"summary": "报告期为2026-08-24，ROE为16.6%", "source_ids": ["src_fund"]},
        bundle,
    ) is None


def test_industry_positive_claim_is_rejected_without_industry_evidence():
    error = _v6_industry_claim_error(
        {"summary": "行业周期已确认，当前处于复苏中段"},
        _bundle(),
    )
    assert error is not None
    assert "summary" in error


def test_company_earnings_cycle_is_not_mistaken_for_industry_claim():
    assert _v6_industry_claim_error(
        {"summary": "公司盈利周期处于复苏中段"},
        _bundle(),
    ) is None


def test_professional_abbreviations_are_allowed():
    assert _public_text_error(
        {"summary": "MACD、RSI、ATR与PE/PB、ROE、ROIC均可核验"}
    ) is None


@pytest.mark.asyncio
async def test_upstream_artifact_rejects_industry_positive_claim_without_evidence(tmp_path):
    ws = tmp_path / "ws"
    bundle = await build_evidence(ws)
    set_decision_readiness(ws)
    evidence_path = ws / "stock_projects" / RUN_ID / "evidence.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    instrument_id = f"{bundle['instrument']['exchange']}:{bundle['instrument']['symbol']}"
    evidence["symbols"][instrument_id]["industry_context"] = {
        "status": "missing",
        "source_ids": [],
    }
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False), encoding="utf-8")

    payload = view_payload(bundle, "bull")
    active = payload["horizon_cases"]["short_term"]
    payload["horizon_cases"] = {
        horizon: deepcopy(active)
        for horizon in ("short_term", "medium_term", "long_term")
    }
    payload["horizon_cases"]["short_term"]["points"][0]["claim"] = "行业周期复苏中段"
    result = await SubmitBullCaseTool(
        ws,
        make_ctx(ws, room_id="room1", workflow_run_id=RUN_ID, job_id=JOB_ID),
    ).execute(**payload)
    assert result.startswith("Error:")
    assert "行业" in result
