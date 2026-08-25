"""Local V6 risk-profile and manual holding-context store tests."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from mona.services.stock.risk_profile import (
    LocalRiskProfileStore,
    RiskProfileStorageError,
)


def test_default_is_conservative_and_not_persisted(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    profile = store.get_risk_profile()
    context = store.get_portfolio_context("XSHG:600000")
    assert profile.profile_name == "conservative_default"
    assert profile.configured is False
    assert context.holding_state == "not_holding"
    assert not (tmp_path / "risk.json").exists()


def test_explicit_profile_is_validated_and_marked_configured(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    saved = store.save_risk_profile(
        {
            "profile_name": "稳健",
            "risk_budget_pct": 0.5,
            "max_single_position_pct": 15,
            "max_industry_exposure_pct": 25,
            "max_correlated_exposure_pct": 40,
            "configured": False,
        }
    )
    assert saved.configured is True
    assert store.get_risk_profile() == saved
    payload = json.loads((tmp_path / "risk.json").read_text(encoding="utf-8"))
    assert payload["risk_profile"]["configured"] is True


@pytest.mark.parametrize(
    "profile",
    [
        {"risk_budget_pct": 0},
        {"max_single_position_pct": 101},
        {"max_industry_exposure_pct": -1},
        {"unknown_field": 1},
    ],
)
def test_profile_boundaries_are_rejected(tmp_path: Path, profile: dict) -> None:
    with pytest.raises(ValueError):
        LocalRiskProfileStore(tmp_path / "risk.json").save_risk_profile(profile)


def test_percentage_context_normalizes_legacy_fields_and_derives_state(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    saved = store.save_portfolio_context(
        "XSHG:600000",
        {
            "position_input_mode": "percentage",
            "holding_state": "not_holding",
            "portfolio_value_yuan": 100000,
            "current_position_pct": 12,
            "holding_quantity": 100,
            "industry_exposure_pct": 18,
            "correlated_exposure_pct": 20,
            "today_bought_quantity": 100,
            "holding_cost": 10.25,
        },
    )
    assert saved.holding_state == "holding"
    assert saved.position_input_mode == "percentage"
    assert saved.portfolio_value_yuan is None
    assert saved.holding_quantity is None
    assert saved.industry_exposure_pct == 0
    assert saved.correlated_exposure_pct == 0
    assert saved.today_bought_quantity is None
    assert saved.holding_cost is None
    assert store.get_portfolio_context("XSHG:600000") == saved
    assert store.get_portfolio_context("XSHE:600000").holding_state == "not_holding"

    returned = store.get_portfolio_context("XSHG:600000")
    returned.current_position_pct = 99
    assert store.get_portfolio_context("XSHG:600000").current_position_pct == 12


def test_instrument_key_and_context_boundaries_are_strict(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    for key in ("600000", "XSHG:60000", "XSHG:600000:extra", "xshg:600000"):
        with pytest.raises(ValueError):
            store.get_portfolio_context(key)
    with pytest.raises(ValueError):
        store.save_portfolio_context("XSHG:600000", {"current_position_pct": 101})


@pytest.mark.parametrize(
    "context",
    [
        {"position_input_mode": "assets_shares", "holding_quantity": 10},
        {"position_input_mode": "assets_shares", "portfolio_value_yuan": 100000},
        {
            "position_input_mode": "assets_shares",
            "portfolio_value_yuan": 100000,
            "holding_quantity": 10,
        },
        {
            "position_input_mode": "assets_shares",
            "portfolio_value_yuan": 100000,
            "holding_quantity": 1.5,
        },
        {
            "position_input_mode": "assets_shares",
            "portfolio_value_yuan": 100000,
            "holding_quantity": 0,
            "current_position_pct": 1,
        },
        {
            "position_input_mode": "assets_shares",
            "portfolio_value_yuan": 100000,
            "holding_quantity": 10,
            "current_position_pct": 0,
        },
    ],
)
def test_assets_shares_context_requires_valid_total_assets_and_quantity(
    tmp_path: Path, context: dict
) -> None:
    with pytest.raises(ValueError):
        LocalRiskProfileStore(tmp_path / "risk.json").save_portfolio_context(
            "XSHG:600000", context
        )


def test_assets_shares_context_preserves_inputs(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    saved = store.save_portfolio_context(
        "XSHG:600000",
        {
            "position_input_mode": "assets_shares",
            "portfolio_value_yuan": 100000,
            "holding_quantity": 300,
            "current_position_pct": 12,
        },
    )
    assert saved.position_input_mode == "assets_shares"
    assert saved.portfolio_value_yuan == 100000
    assert saved.holding_quantity == 300
    assert saved.holding_state == "holding"


def test_legacy_context_file_remains_readable(tmp_path: Path) -> None:
    path = tmp_path / "risk.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "risk_profile": None,
                "portfolio_contexts": {
                    "XSHG:600000": {
                        "holding_state": "holding",
                        "portfolio_value_yuan": 100000,
                        "current_position_pct": 8,
                        "today_bought_quantity": 100,
                        "holding_cost": 10.25,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    context = LocalRiskProfileStore(path).get_portfolio_context("XSHG:600000")
    assert context.position_input_mode == "percentage"
    assert context.portfolio_value_yuan == 100000
    assert context.current_position_pct == 8
    assert context.holding_state == "holding"
    assert context.today_bought_quantity == 100


def test_delete_one_context_returns_default_without_batch_delete(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")
    store.save_portfolio_context("XSHG:600000", {"current_position_pct": 10})
    store.save_portfolio_context("XSHE:000001", {"current_position_pct": 10})
    deleted = store.delete_portfolio_context("XSHG:600000")
    assert deleted.holding_state == "not_holding"
    assert store.get_portfolio_context("XSHG:600000").holding_state == "not_holding"
    assert store.get_portfolio_context("XSHE:000001").holding_state == "holding"


def test_concurrent_context_updates_are_atomic_and_lossless(tmp_path: Path) -> None:
    store = LocalRiskProfileStore(tmp_path / "risk.json")

    def save(index: int) -> None:
        store.save_portfolio_context(
            f"XSHG:{600000 + index:06d}",
            {"holding_state": "holding", "today_bought_quantity": index},
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(save, range(12)))
    contexts = store.list_portfolio_contexts()
    assert len(contexts) == 12
    assert json.loads((tmp_path / "risk.json").read_text(encoding="utf-8"))["schema_version"] == 1


def test_corrupt_store_is_an_explicit_error(tmp_path: Path) -> None:
    path = tmp_path / "risk.json"
    path.write_text("{not-json", encoding="utf-8")
    store = LocalRiskProfileStore(path)
    with pytest.raises(RiskProfileStorageError, match="cannot be read"):
        store.get_risk_profile()
    with pytest.raises(RiskProfileStorageError):
        store.clear_risk_profile()


def test_display_metadata_lists_supported_and_future_fields() -> None:
    metadata = LocalRiskProfileStore.display_metadata()
    profile_keys = {item["key"] for item in metadata["risk_profile"]["supported_fields"]}
    assert "risk_budget_pct" in profile_keys
    assert "risk_level" in profile_keys
    assert "total_funds_range" in profile_keys
    assert metadata["risk_profile"]["future_fields"] == []
    context_keys = {
        item["key"] for item in metadata["portfolio_context"]["supported_fields"]
    }
    assert context_keys == {
        "position_input_mode",
        "portfolio_value_yuan",
        "holding_quantity",
        "current_position_pct",
    }
