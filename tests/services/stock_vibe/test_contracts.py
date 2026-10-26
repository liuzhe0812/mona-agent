import pytest
from pydantic import ValidationError

from mona.services.stock_vibe.contracts import OPERATION_INPUT, CreateSession, SendMessage


def test_trade_review_research_is_bound_only_by_native_operation_id():
    assert CreateSession(journal_operation_id="a" * 32).journal_operation_id == "a" * 32
    for value in ("../private", "c:/trades.csv", "a" * 31):
        with pytest.raises(ValidationError):
            CreateSession(journal_operation_id=value)
    with pytest.raises(ValidationError):
        CreateSession(journal_operation_id="a" * 32, workbench={"symbol": "002460.SZ", "mode": "swing", "task": "risk"})


def test_research_message_keeps_content_only_receipt_identity_and_validates_context():
    assert SendMessage(content="研究一下").model_dump(mode="json") == {"content": "研究一下"}
    body = {
        "content": "分析附件里的风险",
        "research": {"symbol": None, "mode": "swing"},
        "attachments": [{"file_path": "uploads/" + "a" * 32 + ".pdf", "filename": "年报.PDF"}],
    }
    assert SendMessage.model_validate(body).model_dump(mode="json") == body
    for invalid in (
        {"research": {"symbol": "600519", "mode": "swing"}},
        {"research": {"symbol": None, "mode": "unknown"}},
        {"research": {"symbol": None, "mode": "swing", "system_prompt": "extra"}},
        {"attachments": [{"file_path": "uploads/../private.pdf", "filename": "a.pdf"}]},
        {"attachments": [{"file_path": "C:/private.pdf", "filename": "a.pdf"}]},
        {"attachments": [{"file_path": "uploads/" + "a" * 32 + ".pdf", "filename": "../年报.pdf"}]},
        {"attachments": [{"file_path": "uploads/" + "a" * 32 + ".pdf", "filename": "年报.docx"}]},
        {"attachments": body["attachments"] * 2},
        {"system_prompt": "extra"},
    ):
        with pytest.raises(ValidationError):
            SendMessage.model_validate({**body, **invalid})


def test_retired_opportunity_writes_are_not_supported_but_native_backtest_remains():
    for operation in ("opportunity_screen", "opportunity_history", "opportunity_history_range", "opportunity_history_continue"):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({"operation": operation})

    parsed = OPERATION_INPUT.validate_python({"operation": "backtest", "run_id": "run_123"})
    assert parsed.model_dump(mode="json") == {"operation": "backtest", "run_id": "run_123"}


def test_journal_analysis_accepts_only_a_confirmed_upload_identity():
    body = {"operation": "analyze_trade_journal", "upload_id": "a" * 32}
    assert OPERATION_INPUT.validate_python(body).upload_id == "a" * 32
    for extra in ({"file_path": "C:/private.csv"}, {"filter_expr": "symbol=600519.SH"}, {"analysis_type": "strategy"}):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({**body, **extra})


def test_shadow_report_requires_the_completed_backtest_inputs():
    backtest = OPERATION_INPUT.validate_python({"operation": "run_shadow_backtest", "shadow_id": "shadow_1234abcd"})
    assert (backtest.source, backtest.markets, backtest.per_market_count) == ("auto", ["china_a"], 5)
    body = {"operation": "render_shadow_report", "shadow_id": "shadow_1234abcd", "window_start": "2025-06-23",
            "window_end": "2025-07-01", "source": "local", "markets": ["china_a"], "per_market_count": 1}
    report = OPERATION_INPUT.validate_python(body)
    assert report.include_today_signals is False
    for required in ("window_start", "window_end", "source", "markets", "per_market_count"):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({key: value for key, value in body.items() if key != required})
    for invalid in ({"markets": []}, {"markets": None}, {"markets": ["hk"]}, {"per_market_count": 0}, {"include_today_signals": True}):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({**body, **invalid})


def test_strategy_oos_validation_defaults_to_source_costs_and_preserves_stress_inputs():
    default = OPERATION_INPUT.validate_python({
        "operation": "strategy_oos_validation",
        "run_id": "mona-run-1",
        "window_start": "2026-06-23",
        "window_end": "2026-07-01",
    })
    assert default.model_dump(mode="json", exclude_none=True)["cost_scenarios"] == [
        {"scenario_id": "source_config", "overrides": {}}
    ]

    body = {
        "operation": "strategy_oos_validation",
        "run_id": "mona-run-1",
        "window_start": "2026-06-23",
        "window_end": "2026-07-01",
        "cost_scenarios": [
            {"scenario_id": "source_config", "overrides": {}},
            {"scenario_id": "stress_costs", "overrides": {
                "commission_rate": 0.001, "commission_min": 5,
                "stamp_tax": 0.001, "transfer_fee": 0.00001, "slippage": 0.01,
            }},
            {"scenario_id": "stress_minimum", "overrides": {"commission_min": 10}},
        ],
    }
    parsed = OPERATION_INPUT.validate_python(body)
    assert parsed.model_dump(mode="json", exclude_none=True) == body


@pytest.mark.parametrize("invalid", [
    {"cost_scenarios": [{"scenario_id": "stress", "overrides": {"slippage": 0.01}}]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_min": 1}},
        {"scenario_id": "stress", "overrides": {"slippage": 0.01}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {"commission_min": 0}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "Stress", "overrides": {"commission_min": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"arbitrary_config": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_rate": True}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_rate": "0.01"}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_rate": -0.01}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_rate": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"stamp_tax": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"transfer_fee": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"slippage": 1}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_min": float("inf")}},
    ]},
    {"cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"slippage": float("inf")}},
    ]},
    {"window_start": "2026-6-23"},
    {"window_start": "2026-07-02"},
    {"private_path": "C:/outside"},
])
def test_strategy_oos_validation_rejects_invalid_windows_scenarios_and_overrides(invalid):
    body = {
        "operation": "strategy_oos_validation",
        "run_id": "mona-run-1",
        "window_start": "2026-06-23",
        "window_end": "2026-07-01",
    }
    with pytest.raises(ValidationError):
        OPERATION_INPUT.validate_python({**body, **invalid})


def test_strict_factor_validation_applies_native_defaults_without_open_scope_fields():
    parsed = OPERATION_INPUT.validate_python({
        "operation": "strict_factor_validation",
        "zoo": "alpha101",
        "start_date": "2021-01-01",
        "end_date": "2026-01-01",
        "oos_cutoff": "2024-01-01",
    })
    assert parsed.model_dump(mode="json") == {
        "operation": "strict_factor_validation",
        "zoo": "alpha101",
        "start_date": "2021-01-01",
        "end_date": "2026-01-01",
        "oos_cutoff": "2024-01-01",
        "n_random_seeds": 5,
        "horizon": 1,
        "top": 20,
    }


@pytest.mark.parametrize("invalid", [
    {"zoo": "custom"},
    {"zoo_root": "C:/factor-zoo"},
    {"token": "synthetic-secret"},
    {"threshold": 0.7},
    {"start_date": "2021-1-01"},
    {"oos_cutoff": "2021-01-01"},
    {"oos_cutoff": "2026-01-01"},
    {"end_date": "2026-01-02"},
    {"n_random_seeds": 0},
    {"n_random_seeds": 6},
    {"n_random_seeds": True},
    {"horizon": 22},
    {"horizon": 1.5},
    {"top": 101},
    {"top": False},
])
def test_strict_factor_validation_rejects_unbounded_or_open_inputs(invalid):
    body = {
        "operation": "strict_factor_validation",
        "zoo": "qlib158",
        "start_date": "2021-01-01",
        "end_date": "2025-01-01",
        "oos_cutoff": "2023-01-01",
    }
    with pytest.raises(ValidationError):
        OPERATION_INPUT.validate_python({**body, **invalid})


def test_strict_factor_validation_accepts_five_calendar_years_across_leap_day():
    parsed = OPERATION_INPUT.validate_python({
        "operation": "strict_factor_validation",
        "zoo": "qlib158",
        "start_date": "2024-02-29",
        "end_date": "2029-02-28",
        "oos_cutoff": "2026-06-30",
    })
    assert parsed.end_date.isoformat() == "2029-02-28"
