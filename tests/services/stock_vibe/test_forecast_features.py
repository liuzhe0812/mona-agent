from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"
PROBE = r'''
import ast
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
from src.api import mona_forecast_features as features
from src.factors.base import ts_rank
from src.factors.registry import get_default_registry

rng = np.random.default_rng(7)
count = 600
close = 50 * np.exp(np.cumsum(rng.normal(0, 0.015, count)))
daily = pd.DataFrame({
    "open": close * (1 + rng.uniform(-0.004, 0.004, count)),
    "high": close * 1.015,
    "low": close * 0.985,
    "close": close,
    "volume": rng.uniform(10000, 100000, count),
}, index=pd.bdate_range("2023-01-02", periods=count))
values, audit = features.daily_features(daily, "002460.SZ")
registry = get_default_registry()
native_ids = set(registry.list())
computed = {entry["id"] for entry in audit["computed"]}
excluded = {entry["id"]: entry["reason"] for entry in audit["excluded"]}
eligible = {entry["id"] for entry in audit["eligible"]}
assert len(native_ids) == audit["counts"]["registry_total"] == 478
assert {entry["id"] for entry in audit["attempted"]} == native_ids
assert computed == set(values.columns) and len(computed) > 7
assert computed <= eligible
assert computed.isdisjoint(excluded)
assert computed | set(excluded) == native_ids
for stage in ("attempted", "eligible", "computed", "excluded"):
    assert audit["counts"][stage] == len(audit[stage])
    assert all(entry["id"] in native_ids and entry["reason"] for entry in audit[stage])
assert set(audit["input_columns"]) == {"open", "high", "low", "close", "volume"}
assert values.index.equals(daily.index) and values.isna().any().any()
assert any(reason.startswith("cross_sectional_panel_required:") for reason in excluded.values())
assert "native_notes_mark_degraded_proxy_or_unimplemented" in excluded.values()
assert any(reason.startswith("missing_observed_columns:") for reason in excluded.values())
assert any("ts_rank(" in registry.get_source(factor_id) for factor_id in computed)

# Match all ten formulas against Vibe's executable original skill example,
# rather than a second hand-written copy of our adapter's calculations.
skill = Path(features.__file__).resolve().parents[1] / "skills/ml-strategy/SKILL.md"
example = skill.read_text(encoding="utf-8").split("```python", 1)[1].split("```", 1)[0]
function = next(node for node in ast.parse(example).body
                if isinstance(node, ast.FunctionDef) and node.name == "build_features")
namespace = {"np": np, "pd": pd}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(skill), "exec"), namespace)
template_features = namespace["build_features"]
strategy = features.ml_strategy_features(daily)
assert strategy.shape == (count, 10)
assert strategy.columns.tolist() == [
    "f_ret_5d", "f_ret_20d", "f_vol_20d", "f_ma_ratio", "f_volume_ratio",
    "f_rsi_14", "f_bb_position", "f_high_low_ratio", "f_close_open_ratio", "f_skew_20d",
]
pd.testing.assert_frame_equal(strategy, template_features(daily))
assert strategy.iloc[:5]["f_ret_5d"].isna().all()
assert strategy.iloc[:20]["f_ret_20d"].isna().all()
assert not np.isinf(strategy.to_numpy()).any()
for cut in (40, 200, 500):
    pd.testing.assert_frame_equal(strategy.iloc[:cut], features.ml_strategy_features(daily.iloc[:cut]))

flat = pd.DataFrame({"open": 50., "high": 50., "low": 50., "close": 50., "volume": 0.}, index=daily.index[:60])
flat_values = features.ml_strategy_features(flat)
pd.testing.assert_frame_equal(flat_values, template_features(flat))
assert flat_values[["f_rsi_14", "f_bb_position", "f_volume_ratio"]].isna().all().all()
assert not np.isinf(flat_values.to_numpy()).any()
zero_open = daily.copy()
zero_open.loc[zero_open.index[50], "open"] = 0
assert pd.isna(features.ml_strategy_features(zero_open).iloc[50]["f_close_open_ratio"])

# Native factors cannot revise earlier values when later prices and volumes
# change. Compare all commonly computable factors, including their warmup NaNs.
changed = daily.copy()
price_columns = ["open", "high", "low", "close"]
changed.loc[changed.index[-100:], price_columns] *= np.linspace(0.4, 2.4, 100)[:, None]
changed.loc[changed.index[-100:], "volume"] *= np.linspace(3, 12, 100)
changed_values, changed_audit = features.daily_features(changed, "002460.SZ")
changed_strategy = features.ml_strategy_features(changed)
pd.testing.assert_frame_equal(strategy.iloc[:-100], changed_strategy.iloc[:-100])
common = values.columns.intersection(changed_values.columns)
assert len(common) > 7
np.testing.assert_allclose(
    values.loc[:, common].iloc[:-100].to_numpy(),
    changed_values.loc[:, common].iloc[:-100].to_numpy(),
    rtol=1e-8, atol=1e-10, equal_nan=True,
)

# The data dependency is replaced only at the registry boundary. The actual
# applicability and prefix guard must reject future-shift/global-mean factors.
class LeafRegistry:
    def list(self):
        return ["causal_ts_rank", "future_shift", "whole_history_mean", "cross_rank_alias"]

    def get(self, factor_id):
        return SimpleNamespace(meta={
            "universe": ["equity_cn"], "frequency": ["1d"],
            "columns_required": ["close"], "min_warmup_bars": 10,
        })

    def get_source(self, factor_id):
        if factor_id == "causal_ts_rank":
            return 'def compute(panel): return ts_rank(panel["close"], 10)'
        if factor_id == "cross_rank_alias":
            return 'from src.factors.base import rank as cross_rank\ndef compute(panel): return cross_rank(panel["close"])'
        return 'def compute(panel): return panel["close"]'

    def compute(self, factor_id, panel):
        price = panel["close"]
        if factor_id == "future_shift":
            return price.shift(-1)
        if factor_id == "whole_history_mean":
            return price / price.mean()
        assert factor_id == "causal_ts_rank"
        return ts_rank(price, 10)

with patch.object(features, "get_default_registry", return_value=LeafRegistry()):
    safe_values, unsafe_audit = features.daily_features(daily, "002460.SZ")
assert safe_values.columns.tolist() == ["causal_ts_rank"]
unsafe = {entry["id"]: entry["reason"] for entry in unsafe_audit["excluded"]}
assert unsafe["future_shift"] == unsafe["whole_history_mean"] == "historical_prefix_changed_future_information_dependency"
assert unsafe["cross_rank_alias"] == "cross_sectional_panel_required:rank"

rows = []
for day, positions in (
    ("2026-10-16", list(range(40)) + list(range(45, 90))),
    ("2026-10-19", list(range(70))),
):
    for position in positions:
        rows.append({"day": day, "position": position,
                     "close": 40 + len(rows) * 0.02, "volume": 100 + len(rows)})
minute = pd.DataFrame(rows)
minute_values, minute_audit = features.minute_features(minute)
assert minute_values.shape == (len(minute), 11)
assert minute_audit["counts"]["computed"] == 11
assert not minute_audit["daily_factor_library_applied"]
assert set(minute_audit["native_ops"]) == {"delta", "safe_div", "ts_mean", "ts_std"}
assert np.isclose(minute_values.loc[19, "minute_return_5"], minute.loc[19, "close"] / minute.loc[14, "close"] - 1)
for start in (40, 85):  # First row after the missing-minute gap and overnight.
    assert minute_values.loc[start].drop("session_position").isna().all()
    assert minute_values.loc[start:start + 13, "minute_volume_ratio_15"].isna().all()
    assert np.isfinite(minute_values.loc[start + 14, "minute_volume_ratio_15"])
    assert minute_values.loc[start:start + 14, "minute_return_15"].isna().all()
    assert np.isfinite(minute_values.loc[start + 15, "minute_return_15"])
    assert minute_values.loc[start:start + 29, "minute_volatility_30"].isna().all()
    assert np.isfinite(minute_values.loc[start + 30, "minute_volatility_30"])
minute_changed = minute.copy()
minute_changed.loc[100:, "close"] *= 5
minute_changed.loc[100:, "volume"] *= 4
minute_later, _ = features.minute_features(minute_changed)
pd.testing.assert_frame_equal(minute_values.iloc[:100], minute_later.iloc[:100])
assert not np.isinf(minute_values.to_numpy()).any()

print(json.dumps({
    "all_native_factors_audited": True,
    "native_applicability_and_ts_rank": True,
    "daily_future_data_isolation": True,
    "native_ml_strategy_template_and_prefix": True,
    "prefix_guard_rejects_future_dependencies": True,
    "minute_session_gap_and_future_isolation": True,
}))
'''


def test_native_forecast_feature_applicability_and_causality(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0035-directional-curve.json" for patch in receipt["patches"])
    home = tmp_path / "private-home"
    home.mkdir()
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
            "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        }
    }
    environment.update(
        PYTHONPATH=str(source / "agent"),
        PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1",
        VIBE_TRADING_HOME=str(home),
        VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1",
    )
    result = subprocess.run(
        [str(PYTHON), "-c", PROBE],
        cwd=home,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
