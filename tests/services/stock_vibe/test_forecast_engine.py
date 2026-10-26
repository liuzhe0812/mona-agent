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
import json

import numpy as np
import pandas as pd
from src.api import mona_forecast_engine as engine

rng = np.random.default_rng(43)
count = 800
index = pd.bdate_range("2023-01-02", periods=count)
signal = rng.normal(size=count)
noise = rng.normal(0, 0.001, size=count)
returns = np.zeros(count)
returns[1:] = 0.006 * signal[:-1] + noise[1:]
close = 50 * np.exp(np.cumsum(returns))
daily = pd.DataFrame({"close": close}, index=index)
features = pd.DataFrame(
    {
        "signal": signal,
        "noise": rng.normal(size=count),
        "duplicate": signal * 1.001 + rng.normal(0, 0.001, size=count),
        "missing": np.where(rng.random(count) < 0.3, np.nan, signal),
        "constant": np.ones(count),
    },
    index=index,
)

# All daily targets end at or before the observation cutoff; every training
# label is purged before its validation window begins for each horizon.
for horizon in (1, 5):
    positions, _, _ = engine.training_samples(daily, features, horizon, False)
    assert positions[-1] + horizon <= len(daily) - 1
    assert np.all(positions + horizon <= len(daily) - 1)
    splits = list(engine.time_splits(daily, positions, horizon, False))
    assert len(splits) >= 2
    for train, test in splits:
        assert positions[train].max() + horizon < positions[test].min()
        assert not set(train) & set(test)

# Missingness, clipping, redundancy, ranking and scaling are learned from the
# training prefix only. A 30%-missing or constant input is not retained.
train_features = features.iloc[:499]
train_targets = (returns[1:500] > 0).astype(int)
transform = engine.FeatureTransform().fit(train_features, train_targets)
assert "signal" in transform.names
assert not ({"signal", "duplicate"} <= set(transform.names))
assert "missing" not in transform.names and "constant" not in transform.names
assert np.allclose(transform.scaler.mean_, transform._values(train_features).mean(axis=0))
future = features.iloc[500:].copy()
future["signal"] = 1_000_000
future["noise"] = -1_000_000
future_values = transform._values(future)
signal_column = transform.names.index("signal")
assert future_values[:, signal_column].max() <= transform.upper["signal"]
assert np.isfinite(transform.transform(future)).all()

# The first 360 observations contain a strong, causal synthetic relationship.
# This is an algorithm-path check, not evidence of financial skill.
positive_daily = daily.iloc[:360]
positive_features = features.iloc[:360]
selected = engine.fit_horizon(positive_daily, positive_features, 1, False)
assert selected["model"].name in (*engine.BASE_MODELS, "blend")
assert selected["validation"]["model_id"] in (*engine.BASE_MODELS, "blend")
assert selected["validation"]["balanced_direction_accuracy"] > .85
assert selected["validation"]["mae"] < selected["validation"]["baseline_mae"]
assert selected["audit"]["final_selection"]["folds"] >= 2
coverage = selected["validation"]["interval_coverage"]
assert coverage is None or 0 <= coverage <= 1

# The last outer window is a sealed holdout. Changing its inputs and outcomes
# leaves the pre-holdout selected family and empirical band unchanged.
# A bad holdout is reported, never used to switch or suppress the family.
holdout_start = selected["audit"]["outer_folds"][-1]["test_first_position"]
assert selected["audit"]["outer_folds"][-1]["training_last_position"] + 1 < holdout_start
assert selected["audit"]["final_selection"]["family"] == selected["audit"]["outer_folds"][-1]["family"]
assert selected["audit"]["selection_last_outcome_position"] < holdout_start
calibration_end = selected["audit"]["calibration_last_outcome_position"]
assert calibration_end is not None and calibration_end < holdout_start
assert selected["validation"]["calibration_excludes_holdout"]
changed_daily = positive_daily.copy()
scale = np.ones(len(positive_daily))
scale[holdout_start:] = np.exp(np.where(np.arange(len(positive_daily))[holdout_start:] % 2, 0.3, -0.25))
changed_daily["close"] *= scale
changed_features = positive_features.copy()
changed_features.iloc[holdout_start:, :] = changed_features.iloc[holdout_start:, :].fillna(0) * 100 + 10000
sealed = engine.fit_horizon(changed_daily, changed_features, 1, False)
assert not np.allclose(positive_daily["close"].iloc[holdout_start:], changed_daily["close"].iloc[holdout_start:])
assert selected["audit"]["outer_folds"][0] == sealed["audit"]["outer_folds"][0]
assert selected["audit"]["final_selection"]["family"] == sealed["audit"]["final_selection"]["family"]
assert sealed["model"].name != "zero"
changed_positions, changed_x, changed_y = engine.training_samples(changed_daily, changed_features, 1, False)
changed_train, changed_test = list(engine.time_splits(changed_daily, changed_positions, 1, False))[-1]
frozen = engine._fit(sealed["audit"]["final_selection"]["family"], changed_x.iloc[changed_train], changed_y[changed_train])
assert np.isclose(sealed["validation"]["mae"], np.mean(np.abs(changed_y[changed_test] - frozen.predict(changed_x.iloc[changed_test]))))
assert np.isclose(sealed["validation"]["baseline_mae"], np.mean(np.abs(changed_y[changed_test])))
assert selected["audit"]["final_selection"] == sealed["audit"]["final_selection"]
assert selected["band"] == sealed["band"]
assert sealed["audit"]["calibration_last_outcome_position"] < holdout_start

# Intraday target windows stay inside one day and do not bridge missing
# trading-minute positions; each validation test window holds out a full day.
rows = []
minute_close = 40.0
minute_rng = np.random.default_rng(93)
for day_number, day in enumerate(pd.bdate_range("2026-09-01", periods=6)):
    session_positions = list(range(110)) + list(range(115, 242))
    for position in session_positions:
        minute_close *= 1 + minute_rng.normal(0, 0.0005)
        rows.append({"day": day.date().isoformat(), "position": position, "close": minute_close})
minutes = pd.DataFrame(rows)
minute_features = pd.DataFrame({"signal": np.arange(len(minutes), dtype=float)})
minute_positions, _, _ = engine.training_samples(minutes, minute_features, 5, True)
for position in minute_positions:
    assert minutes.iloc[position]["day"] == minutes.iloc[position + 5]["day"]
    assert minutes.iloc[position + 5]["position"] - minutes.iloc[position]["position"] == 5
one_step, _, _ = engine.training_samples(minutes, minute_features, 1, True)
assert not any(minutes.iloc[position]["position"] == 109 for position in one_step)
for train, test in engine.time_splits(minutes, minute_positions, 5, True):
    assert minutes.iloc[minute_positions[train]]["day"].max() < minutes.iloc[minute_positions[test]]["day"].min()
    assert minutes.iloc[minute_positions[test]]["day"].nunique() == 1

# Four observed training dates can provide outer holdouts, but the final
# pre-holdout family selection has only one inner day and must say so.
short_minutes = minutes.loc[minutes["day"].isin(sorted(minutes["day"].unique())[:4])].reset_index(drop=True)
short_features = pd.DataFrame({"signal": np.random.default_rng(21).normal(size=len(short_minutes))})
short = engine.fit_horizon(short_minutes, short_features, 1, True)
assert short["validation"]["selection_validated"] is False
assert short["audit"]["final_selection"]["folds"] < 2
assert short["audit"]["final_selection"]["reason"] == "limited_validation"
assert short["model"].name == "forest"
assert np.isfinite(short["model"].predict(short_features.iloc[-1:])).all()

# An unpredictable series still returns its mathematical estimate; neither a
# poor test nor noise gets turned into a misleading forced-flat forecast.
noise_rng = np.random.default_rng(93)
noise_daily = pd.DataFrame(
    {"close": 50 * np.exp(np.cumsum(noise_rng.normal(0, 0.006, count)))}, index=index
)
noise_features = pd.DataFrame(
    {name: noise_rng.normal(size=count) for name in ("a", "b", "c", "d")}, index=index
)
noise_a = engine.fit_horizon(noise_daily, noise_features, 1, False)
noise_b = engine.fit_horizon(noise_daily, noise_features, 1, False)
assert noise_a["model"].name == noise_b["model"].name != "zero"
assert noise_a["model"].predict(noise_features.iloc[-1:])[0] != 0
assert noise_a["band"] == noise_b["band"]
assert noise_a["validation"] == noise_b["validation"]
assert noise_a["validation"]["balanced_direction_accuracy"] < .6

# Curve returns are exactly probability-weighted training return magnitudes,
# and the stored distribution can reconstruct every inference.
model = selected["model"]
current = positive_features.iloc[-1:]
probability = model.predict_probability(current)
distribution = model.return_distribution
assert np.all((probability >= 0) & (probability <= 1))
expected = (probability * distribution["positive_mean"]
            + (1 - probability) * distribution["nonpositive_mean"])
assert np.array_equal(model.predict(current), expected)
_, _, all_targets = engine.training_samples(positive_daily, positive_features, 1, False)
assert distribution["positive_mean"] == all_targets[all_targets > 0].mean()
assert distribution["nonpositive_mean"] == all_targets[all_targets <= 0].mean()
assert distribution["positive_count"] + distribution["nonpositive_count"] == len(all_targets)
assert selected["audit"]["return_distribution"] == distribution
assert "ml-strategy/SKILL.md" in selected["audit"]["method_source"]
assert len(model.transform.names) <= 12

constant_daily = pd.DataFrame({"close": np.full(count, 50.0)}, index=index)
constant = engine.fit_horizon(constant_daily, noise_features, 1, False)
assert constant["model"].name == "historical_distribution"
assert constant["model"].predict(noise_features.iloc[-1:]).tolist() == [0]
assert constant["model"].return_distribution["positive_count"] == 0
assert constant["audit"]["published_model"] == "historical_distribution"

# With no varying features, use the observed return distribution explicitly.
unusable = pd.DataFrame({"constant": np.ones(count)}, index=index)
reference = engine.fit_horizon(noise_daily, unusable, 1, False)
assert reference["model"].name == "historical_distribution"
_, _, reference_y = engine.training_samples(noise_daily, unusable, 1, False)
assert np.isclose(reference["model"].predict(unusable.iloc[-1:])[0], reference_y.mean())

# Fifty observed labels suffice to fit; a short history cannot manufacture
# historical evaluation scores or uncertainty bands.
limited = engine.fit_horizon(daily.iloc[:60], features.iloc[:60], 1, False)
assert limited["model"].name == "forest"
assert limited["validation"]["samples"] == 0
assert limited["validation"]["mae"] is None
assert limited["validation"]["beat_baseline"] is None
assert limited["band"] is None
assert limited["audit"]["final_selection"]["reason"] == "limited_validation"
try:
    engine.fit_horizon(daily.iloc[:50], features.iloc[:50], 1, False)
except ValueError as exc:
    assert str(exc) == "insufficient labeled observations"
else:
    raise AssertionError("fewer than 50 known labels must not fit")

print(json.dumps({
    "daily_target_cutoff_and_purge": True,
    "train_only_feature_transform": True,
    "causal_positive_control": True,
    "short_history_and_frozen_family": True,
    "holdout_and_band_isolation": True,
    "intraday_day_and_gap_boundaries": True,
    "distribution_curve_and_noise_honesty": True,
    "minimum_labels_and_limited_validation": True,
}))
'''


def test_native_forecast_engine_validation_contract(tmp_path: Path) -> None:
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
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
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
        timeout=180,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
