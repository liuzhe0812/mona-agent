from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DRIVER = r'''from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

output, native_home = map(lambda value: Path(value).resolve(), sys.argv[1:])
auth = {"Authorization": "Bearer strict-factor-synthetic-token"}
os.environ.pop("TUSHARE_TOKEN", None)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.mona_operations import register_mona_operations
from src.api.request_ledger import register_native_request_ledger
from src.api.security import require_auth
from src.factors import bench_runner_strict
from src.factors.registry import get_default_registry
from src.tools import alpha_bench_tool

app = FastAPI()
register_native_request_ledger(app, require_auth)
register_mona_operations(app)
client = TestClient(app, client=("127.0.0.1", 50031))

def submit(request_id: str, body: dict) -> dict:
    response = client.post(
        "/mona/operations",
        headers={**auth, "X-Mona-Request-ID": request_id},
        json=body,
    )
    return response

def wait_for(operation_id: str, timeout: float = 240) -> dict:
    deadline = time.monotonic() + timeout
    response = client.get(f"/mona/operations/{operation_id}", headers=auth)
    while response.status_code == 200 and response.json()["status"] in {"queued", "running"}:
        if time.monotonic() >= deadline:
            raise AssertionError("strict factor operation did not finish")
        time.sleep(0.05)
        response = client.get(f"/mona/operations/{operation_id}", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()

base_request = {
    "operation": "strict_factor_validation",
    "zoo": "alpha101",
    "start_date": "2024-01-02",
    "end_date": "2025-02-25",
    "oos_cutoff": "2024-10-10",
    "n_random_seeds": 1,
    "horizon": 1,
    "top": 10,
}

# Strict validation never searches legacy dotenv/global configuration. With no
# explicit TUSHARE_TOKEN the durable request finishes unavailable before the
# loader or runner is called.
loader_calls = []
def forbidden_loader(universe: str, period: str):
    loader_calls.append((universe, period))
    raise AssertionError("loader must not run without an explicit token")

bench_runner_strict._load_universe_panel = forbidden_loader
alpha_bench_tool._load_universe_panel = forbidden_loader
missing_response = submit("1" * 32, base_request)
assert missing_response.status_code == 202, missing_response.text
missing_record = wait_for(missing_response.json()["operation_id"])
assert missing_record["status"] == "failed", missing_record
missing = missing_record["tool_result"]
assert missing["status"] == "error" and missing["experiment_status"] == "unavailable", missing
assert missing["reason_code"] == "tushare_token_unconfigured", missing
assert missing["no_network_attempt"] is True and missing["native_result"] is None, missing
assert loader_calls == [], loader_calls

# Exercise the actual strict runner and the packaged default registry with a
# deterministic cross-sectional fixture. The injected panel is explicitly
# marked synthetic/degraded, so its rows prove the calculation path only and
# the durable operation must not label it as a complete CSI300 result.
dates = pd.bdate_range("2024-01-02", periods=300)
symbols = [f"{index:06d}.SZ" for index in range(1, 9)]
rng = np.random.default_rng(271828)
returns = rng.normal(0.0004, 0.009, size=(len(dates), len(symbols)))
close_values = 20.0 + np.cumsum(returns, axis=0) * 20 + np.arange(len(symbols))[None, :] * 1.7
close = pd.DataFrame(close_values, index=dates, columns=symbols)
open_values = close.to_numpy() * (1 + rng.normal(0, 0.001, size=close.shape))
high_values = np.maximum(open_values, close.to_numpy()) * 1.01
low_values = np.minimum(open_values, close.to_numpy()) * 0.99
volume_values = rng.uniform(100000, 200000, size=close.shape)
panel = {
    "open": pd.DataFrame(open_values, index=dates, columns=symbols),
    "high": pd.DataFrame(high_values, index=dates, columns=symbols),
    "low": pd.DataFrame(low_values, index=dates, columns=symbols),
    "close": close,
    "volume": pd.DataFrame(volume_values, index=dates, columns=symbols),
    "amount": pd.DataFrame(close_values * volume_values, index=dates, columns=symbols),
    "vwap": pd.DataFrame((open_values + high_values + low_values + close_values) / 4, index=dates, columns=symbols),
    "_meta": {
        "universe": "csi300",
        "degraded": True,
        "survivorship_bias": True,
        "constituent_source": "synthetic fixture",
        "constituent_source_date": None,
        "constituent_count": len(symbols),
        "price_adjustment": "synthetic",
    },
}
loader_calls.clear()
def fixture_loader(universe: str, period: str):
    loader_calls.append((universe, period))
    return panel

bench_runner_strict._load_universe_panel = fixture_loader
alpha_bench_tool._load_universe_panel = fixture_loader
# TUSHARE_TOKEN is a market-data process credential. The native strict loader
# uses it in this process; the existing Runner allowlist also forwards it to
# the backtest child because Tushare-backed runs need it, so this is not a
# secret-isolation boundary from signal_engine code. This test only supplies a
# dummy token while both loaders are locally stubbed.
os.environ["TUSHARE_TOKEN"] = "synthetic-test-token-never-used-for-network"
run_request = {
    **base_request,
    "start_date": dates[0].date().isoformat(),
    "end_date": dates[-1].date().isoformat(),
    "oos_cutoff": dates[200].date().isoformat(),
}
run_response = submit("2" * 32, run_request)
assert run_response.status_code == 202, run_response.text
record = wait_for(run_response.json()["operation_id"])
assert record["status"] == "failed", record
result = record["tool_result"]
assert result["status"] == "error" and result["experiment_status"] == "unavailable", result
assert result["reason_code"] == "csi300_constituents_degraded", result
assert result["no_network_attempt"] is False
native = result["native_result"]
assert native["status"] == "ok", native
assert native["random_control"] is True and native["n_random_seeds"] == 1
assert native["universe"] == "csi300" and native["oos_split"] == run_request["oos_cutoff"]
assert native["n_alphas_tested"] > 0 and native["rows"], native
assert native["meta"] == panel["_meta"], native["meta"]
bundle_ids = set(get_default_registry().list(zoo="alpha101"))
assert bundle_ids
assert {row["id"] for row in native["rows"]} <= bundle_ids
assert {row["id"] for row in native["skipped"]} <= bundle_ids
assert loader_calls == [("csi300", f"{run_request['start_date']}/{run_request['end_date']}")]
assert result["inputs"] == {
    "zoo": "alpha101",
    "universe": "csi300",
    "start_date": run_request["start_date"],
    "end_date": run_request["end_date"],
    "oos_cutoff": run_request["oos_cutoff"],
    "period": f"{run_request['start_date']}/{run_request['end_date']}",
    "random_control": True,
    "n_random_seeds": 1,
    "horizon": 1,
    "top": 10,
}
assert record["references"]["universe"] == "csi300"
assert record["references"]["period"] == result["inputs"]["period"]
assert record["source"]["snapshot_id"].startswith("sha256:")
assert any(patch["path"] == "0027-hosted-strict-factor-validation.json" for patch in record["source"]["patches"])
assert "synthetic-test-token-never-used-for-network" not in record["tool_result_raw"]
assert str(native_home) not in record["tool_result_raw"]

# Error results keep the loader metadata and skipped factors too. Four symbols
# are below the native five-pair IC minimum, so the OOS calculation cannot be
# reported as a measured result.
short_panel = {
    key: value.iloc[:, :4].copy() if isinstance(value, pd.DataFrame) else value
    for key, value in panel.items()
}
short_panel["_meta"] = {**panel["_meta"], "constituent_count": 4}
bench_runner_strict._load_universe_panel = lambda universe, period: short_panel
unavailable_native = bench_runner_strict.run_bench_strict(
    zoo="alpha101",
    universe="csi300",
    period=f"{run_request['start_date']}/{run_request['end_date']}",
    random_control=True,
    n_random_seeds=1,
    oos_split=run_request["oos_cutoff"],
    horizon=1,
    top=10,
)
assert unavailable_native["status"] == "error", unavailable_native
assert unavailable_native["rows"] == [] and unavailable_native["skipped"], unavailable_native
assert unavailable_native["meta"] == short_panel["_meta"], unavailable_native["meta"]

# Reject path/code/token expansion and invalid bounds before queueing.
for index, extra in enumerate((
    {"zoo_root": "C:/outside"},
    {"signal_engine": "arbitrary code"},
    {"token": "not-accepted"},
    {"zoo": "fundamental"},
), start=3):
    response = submit(str(index) * 32, {**base_request, **extra})
    assert response.status_code == 422, response.text
bad_period = submit("a" * 32, {**base_request, "end_date": "2030-01-03"})
assert bad_period.status_code == 422, bad_period.text
bad_cutoff = submit("b" * 32, {**base_request, "oos_cutoff": "2025-02-25"})
assert bad_cutoff.status_code == 422, bad_cutoff.text
bad_seed = submit("c" * 32, {**base_request, "n_random_seeds": 6})
assert bad_seed.status_code == 422, bad_seed.text
bad_horizon = submit("d" * 32, {**base_request, "horizon": 22})
assert bad_horizon.status_code == 422, bad_horizon.text

evidence = {
    "missing_token_no_network_attempt": missing["no_network_attempt"],
    "synthetic_core_status": native["status"],
    "synthetic_row_count": len(native["rows"]),
    "synthetic_skip_count": len(native["skipped"]),
    "synthetic_source_not_accepted_as_csi300": result["experiment_status"] == "unavailable",
    "native_meta_preserved": native["meta"] == panel["_meta"],
    "error_meta_preserved": unavailable_native["meta"] == short_panel["_meta"],
    "underpowered_oos_not_measured": unavailable_native["rows"] == [],
    "native_registry_used": True,
    "credential_boundary": "native process token; current backtest child allowlist also forwards TUSHARE_TOKEN",
    "source_snapshot_id": record["source"]["snapshot_id"],
    "source_patch_27_present": True,
    "invalid_expansions_rejected": True,
}
(output / "evidence.json").write_text(
    json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = (
        os.environ.get("STOCK_VIBE_STRICT_FACTOR_SOURCE_ROOT")
        or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT")
    )
    python = (
        os.environ.get("STOCK_VIBE_STRICT_FACTOR_PYTHON")
        or os.environ.get("STOCK_VIBE_TEST_PYTHON")
    )
    if not source or not python:
        pytest.skip("set an explicit fresh 1–27 native source and controlled Python 3.13 environment")
    return Path(source).resolve(), Path(python).resolve()


def _child_environment(source_root: Path, native_home: Path) -> dict[str, str]:
    inherited = (
        "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "HOME",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC",
    )
    environment = {key: os.environ[key] for key in inherited if key in os.environ}
    private_paths = {
        "TEMP": native_home / "temp",
        "TMP": native_home / "temp",
        "APPDATA": native_home / "appdata",
        "LOCALAPPDATA": native_home / "localappdata",
        "XDG_CACHE_HOME": native_home / "cache",
        "XDG_CONFIG_HOME": native_home / "config",
        "MPLCONFIGDIR": native_home / "matplotlib",
    }
    for path in private_paths.values():
        path.mkdir(parents=True, exist_ok=True)
    environment.update(
        {
            "PYTHONPATH": str(source_root),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "VIBE_TRADING_HOME": str(native_home),
            "VIBE_TRADING_HOSTED": "1",
            "HOSTED": "1",
            "API_AUTH_KEY": "strict-factor-synthetic-token",
            "MONA_VIBE_INSTANCE_ID": "strict-factor-synthetic-instance",
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    environment.pop("TUSHARE_TOKEN", None)
    return environment


def test_strict_factor_validation_uses_bundled_runner_and_keeps_provider_gate_truthful() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare fresh source 1–27 and a controlled Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"strict-factor-validation-{uuid.uuid4().hex}"
    output.mkdir(parents=True)
    native_home = output / "native"
    native_home.mkdir()
    driver = output / "strict_factor_validation.py"
    driver.write_text(DRIVER, encoding="utf-8")
    result = subprocess.run(
        [str(python), "-B", str(driver), str(output), str(native_home)],
        cwd=output,
        env=_child_environment(source_root, native_home),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence_path = output / "evidence.json"
    assert evidence_path.is_file(), result.stdout + result.stderr
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["missing_token_no_network_attempt"] is True
    assert evidence["synthetic_core_status"] == "ok"
    assert evidence["synthetic_row_count"] > 0
    assert evidence["synthetic_source_not_accepted_as_csi300"] is True
    assert evidence["native_meta_preserved"] is True
    assert evidence["native_registry_used"] is True
    assert evidence["source_patch_27_present"] is True
    assert evidence["invalid_expansions_rejected"] is True
