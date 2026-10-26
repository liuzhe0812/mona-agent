from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DRIVER = r'''from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

output = Path(sys.argv[1]).resolve()
native_home = Path(sys.argv[2]).resolve()
fixture_root = Path(sys.argv[3]).resolve()
uploads = native_home / "uploads"
uploads.mkdir(parents=True, exist_ok=True)
journal_a = uploads / "synthetic-journal-a.csv"
shutil.copyfile(fixture_root / "journal.csv", journal_a)
journal_b = uploads / "synthetic-journal-b.csv"
journal_b.write_bytes(journal_a.read_bytes() + b"\n")
upload_id = "a" * 32
shutil.copyfile(journal_a, uploads / f"{upload_id}.csv")

from backtest.loaders.registry import get_default_source_order, refresh_source_order_overrides

local_order = get_default_source_order("a_share")
if "local" not in local_order:
    raise RuntimeError("native source chain has no local loader")
local_order.remove("local")
os.environ["MARKET_DATA_ORDER_A_SHARE"] = ",".join(["local", *local_order])
refresh_source_order_overrides()

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfReader
from src.api.mona_operations import _validate_payload, register_mona_operations
from src.shadow_account.models import ShadowProfile, ShadowRule
from src.shadow_account.storage import hash_journal, runs_dir, save_profile
from src.tools.shadow_account_tool import RenderShadowReportTool, RunShadowBacktestTool
import src.tools.shadow_account_tool as shadow_tools

window_start = "2025-06-23"
window_end = "2025-07-01"
shadow_id = "shadow_0022a001"

bridge = native_home / "data-bridge"
bridge.mkdir(parents=True, exist_ok=True)
bars = bridge / "synthetic-shadow-bars.csv"
shutil.copyfile(fixture_root / "bars.csv", bars)
(bridge / "config.yaml").write_text(
    "sources:\n  - symbol: 600519.SH\n    type: csv\n    path: " + json.dumps(bars.as_posix()) + "\n",
    encoding="utf-8",
)

profile = ShadowProfile(
    shadow_id=shadow_id,
    created_at="2025-07-01T00:00:00Z",
    journal_hash=hash_journal(journal_a),
    source_market="china_a",
    profitable_roundtrips=5,
    total_roundtrips=5,
    date_range=("2025-06-09 10:30:00", "2025-06-20 10:30:00"),
    profile_text="Synthetic fixed Shadow profile for the cache contract.",
    rules=(ShadowRule(
        rule_id="R1",
        human_text="Enter China A-share at 10:00, hold 1-2d",
        entry_condition={
            "market": "china_a",
            "entry_hour": {"min": 10, "max": 10},
            "entry_rsi14": {"min": 25.2742, "max": 36.917},
            "prior_5d_return": {"min": -0.0429, "max": -0.0233},
        },
        exit_condition={"holding_days": {"min": 1, "max": 2}},
        holding_days_range=(1, 2),
        support_count=5,
        coverage_rate=1.0,
        sample_trades=(
            "600519.SH@2025-06-09",
            "600519.SH@2025-06-11",
            "600519.SH@2025-06-13",
        ),
    ),),
    preferred_markets=("china_a",),
    typical_holding_days=(1.0, 1.0),
)
save_profile(profile)

backtest_args = {
    "shadow_id": shadow_id,
    "window_start": window_start,
    "window_end": window_end,
    "source": "local",
    "markets": ["china_a"],
    "per_market_count": 1,
    "journal_path": str(journal_a),
}
baseline = json.loads(RunShadowBacktestTool().execute(**backtest_args))
assert baseline["status"] == "ok"
assert baseline["equity_points"] == 7
assert baseline["combined"]["final_value"] == 1_000_000.0
assert baseline["shadow_total_pnl"] == 0.0
assert baseline["real_total_pnl"] is None
assert baseline["delta_pnl"] is None
assert all(value is None for key, value in baseline["attribution"].items() if key.endswith("_pnl"))
assert baseline["account_comparison_status"] == "unavailable"
assert "same backtest window" in baseline["account_comparison_unavailable_reason"]

from src.shadow_account.backtester import _cache_inputs, _cache_key

inputs = _cache_inputs(
    profile,
    window_start=window_start,
    window_end=window_end,
    source="local",
    markets=("china_a",),
    per_market_count=1,
    journal_path=journal_a,
)
cache_file = runs_dir(shadow_id) / f"shadow_result_{_cache_key(profile, window_start, window_end, cache_inputs=inputs)}.json"
cache_payload = json.loads(cache_file.read_text(encoding="utf-8"))
assert cache_payload["cache_inputs"] == inputs
assert inputs["journal_sha256"] == hashlib.sha256(journal_a.read_bytes()).hexdigest()
assert inputs["comparison_policy"] == "account-comparison-unavailable-v1"

report_args = {
    "shadow_id": shadow_id,
    "window_start": window_start,
    "window_end": window_end,
    "source": "local",
    "markets": ["china_a"],
    "per_market_count": 1,
    "journal_path": str(journal_a),
    "include_today_signals": False,
}

# A seeded version-22 cache stays readable for Shadow metrics, while its old
# cross-window comparison is projected to null without rewriting the cache.
legacy_22_inputs = dict(cache_payload["cache_inputs"])
legacy_22_inputs.pop("comparison_policy")
legacy_22 = dict(cache_payload)
legacy_22["cache_inputs"] = legacy_22_inputs
legacy_22["real_total_pnl"] = 71.0
legacy_22["delta_pnl"] = -71.0
legacy_22["attribution"] = dict(legacy_22["attribution"])
legacy_22["attribution"]["missed_signals_pnl"] = -57.0
legacy_22["attribution"]["noise_trades_pnl"] = -14.0
legacy_22_file = runs_dir(shadow_id) / f"shadow_result_{_cache_key(profile, window_start, window_end, cache_inputs=legacy_22_inputs)}.json"
legacy_22_file.write_text(json.dumps(legacy_22, ensure_ascii=False, indent=2), encoding="utf-8")
legacy_22_bytes = legacy_22_file.read_bytes()
current_cache_bytes = cache_file.read_bytes()
cache_file.unlink()
from src.shadow_account.backtester import load_cached_result
legacy_22_result = load_cached_result(
    profile,
    window_start=window_start,
    window_end=window_end,
    source="local",
    markets=("china_a",),
    per_market_count=1,
    journal_path=journal_a,
)
assert legacy_22_result is not None
assert legacy_22_result.shadow_total_pnl == 0.0
assert legacy_22_result.real_total_pnl is None and legacy_22_result.delta_pnl is None
assert all(value is None for value in (
    legacy_22_result.attribution.missed_signals_pnl,
    legacy_22_result.attribution.noise_trades_pnl,
    legacy_22_result.attribution.early_exit_pnl,
    legacy_22_result.attribution.late_exit_pnl,
    legacy_22_result.attribution.overtrading_pnl,
))
assert legacy_22_file.read_bytes() == legacy_22_bytes
legacy_22_report = json.loads(RenderShadowReportTool().execute(**report_args))
assert legacy_22_report["status"] == "ok"
assert legacy_22_report["real_total_pnl"] is None and legacy_22_report["delta_pnl"] is None
assert "same backtest window" in legacy_22_report["account_comparison_unavailable_reason"].lower()
legacy_22_pdf = "\n".join(
    page.extract_text() or "" for page in PdfReader(legacy_22_report["pdf_path"]).pages
)
assert "complete opening positions, principal, and net-value evidence" in legacy_22_pdf.lower()
assert "71.00" not in legacy_22_pdf and "Noise Trades" not in legacy_22_pdf
assert legacy_22_file.read_bytes() == legacy_22_bytes
cache_file.write_bytes(current_cache_bytes)
legacy_22_file.unlink()

# A legacy payload placed at the exact new key is rejected without metadata.
legacy = dict(cache_payload)
legacy.pop("cache_inputs")
cache_file.write_text(json.dumps(legacy), encoding="utf-8")
legacy_report = json.loads(RenderShadowReportTool().execute(**report_args))
assert legacy_report["status"] == "error"
assert legacy_report["reason"] == "backtest_cache_miss"
cache_file.write_text(json.dumps(cache_payload, ensure_ascii=False, indent=2), encoding="utf-8")

calls = []
def unexpected_backtest(*args, **kwargs):
    calls.append((args, kwargs))
    raise AssertionError("hosted report must not implicitly run a backtest")

shadow_tools.run_shadow_backtest = unexpected_backtest
same = json.loads(RenderShadowReportTool().execute(**report_args))
assert same["status"] == "ok", same
assert same["window"] == [window_start, window_end]
assert same["source"] == "local" and same["markets"] == ["china_a"]
assert same["per_market_count"] == 1
assert same["shadow_total_pnl"] == 0.0
assert same["real_total_pnl"] is None and same["delta_pnl"] is None
assert all(value is None for key, value in same["attribution"].items() if key.endswith("_pnl"))
assert same["account_comparison_status"] == "unavailable"
assert "same backtest window" in same["account_comparison_unavailable_reason"]
assert same["pdf_path"] and Path(same["pdf_path"]).is_file()
pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(same["pdf_path"]).pages)
assert "Shadow Backtest - Combined" in pdf_text
assert "Delta Attribution" in pdf_text
assert "complete opening positions, principal, and net-value evidence" in pdf_text
assert "71.00" not in pdf_text
assert "Noise Trades" not in pdf_text

misses = {
    "source": {"source": "auto"},
    "markets": {"markets": ["china_a", "hk"]},
    "per_market_count": {"per_market_count": 2},
    "journal_b": {"journal_path": str(journal_b)},
    "journal_missing": {"journal_path": None},
}
for key, override in misses.items():
    changed = {**report_args, **override}
    if key == "journal_missing":
        changed.pop("journal_path")
    response = json.loads(RenderShadowReportTool().execute(**changed))
    assert response["status"] == "error" and response["reason"] == "backtest_cache_miss", (key, response)
assert not calls

# Native Mona Operation accepts the complete Report contract and rejects omissions or invalid scope.
good_payload = {
    "operation": "render_shadow_report",
    "shadow_id": shadow_id,
    "window_start": window_start,
    "window_end": window_end,
    "source": "local",
    "markets": ["china_a"],
    "per_market_count": 1,
    "upload_id": upload_id,
    "include_today_signals": False,
}
operation, clean, _references = _validate_payload(good_payload)
assert operation == "render_shadow_report"
assert clean["source"] == "local" and clean["markets"] == ["china_a"]
assert clean["per_market_count"] == 1 and Path(clean["_journal_path"]).is_file()
for invalid in (
    {k: v for k, v in good_payload.items() if k != "source"},
    {**good_payload, "window_start": "2025-6-23"},
    {**good_payload, "source": "unsupported"},
    {**good_payload, "markets": ["outside"]},
    {**good_payload, "per_market_count": 0},
):
    try:
        _validate_payload(invalid)
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("invalid hosted report input was accepted")

# A real native Operation on a changed source must persist failed/native_tool_error.
app = FastAPI()
register_mona_operations(app)
client = TestClient(app, client=("127.0.0.1", 50123))
operation_payload = {**good_payload, "source": "auto"}
auth = {"Authorization": f"Bearer {os.environ['API_AUTH_KEY']}"}
created = client.post("/mona/operations", json=operation_payload, headers=auth)
assert created.status_code == 202, created.text
operation_id = created.json()["operation_id"]
record = created.json()
for _ in range(100):
    fetched = client.get(f"/mona/operations/{operation_id}", headers=auth)
    record = fetched.json()
    if record["status"] in {"completed", "failed"}:
        break
    time.sleep(0.02)
assert record["status"] == "failed", record
assert record["error_category"] == "native_tool_error", record
assert record["tool_result"]["status"] == "error"
assert record["tool_result"]["reason"] == "backtest_cache_miss"
assert not calls

result = {
    "baseline": baseline,
    "matching_report": {
        "status": same["status"],
        "window": same["window"],
        "source": same["source"],
        "markets": same["markets"],
        "per_market_count": same["per_market_count"],
    },
    "cache_misses": sorted(misses),
    "legacy_cache_rejected": legacy_report["status"] == "error",
    "report_operation_status": record["status"],
    "report_operation_error_category": record["error_category"],
    "report_pdf_parsed": True,
}
(output / "evidence.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(result, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = os.environ.get("STOCK_VIBE_SHADOW_CACHE_SOURCE_ROOT") or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT") or os.environ.get("STOCK_VIBE_SHADOW_SOURCE_ROOT")
    python = os.environ.get("STOCK_VIBE_SHADOW_CACHE_PYTHON") or os.environ.get("STOCK_VIBE_TEST_PYTHON") or os.environ.get("STOCK_VIBE_SHADOW_PYTHON")
    if not source or not python:
        pytest.skip("set an explicit controlled native source and Python environment")
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
            "VIBE_TRADING_ALLOWED_FILE_ROOTS": str(native_home / "uploads"),
            "MONA_VIBE_INSTANCE_ID": "0022-cache-test-instance",
            "API_AUTH_KEY": "stock-vibe-cache-test-token",
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_hosted_shadow_cache_binds_full_inputs_and_report_does_not_rerun() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare the controlled 1–22 Vibe source and Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"shadow-cache-inputs-test-{uuid.uuid4().hex}"
    output.mkdir(parents=True)
    native_home = output / "native"
    native_home.mkdir()
    driver = output / "native_shadow_cache_inputs.py"
    driver.write_text(DRIVER, encoding="utf-8")
    result = subprocess.run(
        [
            str(python), "-B", str(driver), str(output), str(native_home),
            str(REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "shadow"),
        ],
        cwd=output,
        env=_child_environment(source_root, native_home),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=240,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence_path = output / "evidence.json"
    assert evidence_path.is_file(), result.stdout + result.stderr
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["baseline"]["equity_points"] == 7
    assert evidence["matching_report"]["status"] == "ok"
    assert evidence["cache_misses"] == [
        "journal_b", "journal_missing", "markets", "per_market_count", "source",
    ]
    assert evidence["legacy_cache_rejected"] is True
    assert evidence["report_operation_status"] == "failed"
    assert evidence["report_operation_error_category"] == "native_tool_error"
