from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
BASELINE_BARS_SHA256 = "ce6ab2a6624efdc8f4e969cb5d585d9a860d84330e57ae19cd1cea152bcd313f"


def _controlled_runtime() -> tuple[Path, Path]:
    source_root = Path(
        os.environ.get(
            "STOCK_VIBE_SHADOW_SOURCE_ROOT",
            REPO_ROOT / ".codex_tmp" / "vibe-native-terminal-v2" / "agent",
        )
    ).resolve()
    python = Path(
        os.environ.get(
            "STOCK_VIBE_SHADOW_PYTHON",
            REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe",
        )
    ).resolve()
    return source_root, python


def _child_environment(source_root: Path, native_home: Path) -> dict[str, str]:
    keys = (
        "PATH",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "COMSPEC",
    )
    environment = {key: os.environ[key] for key in keys if key in os.environ}
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
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_native_shadow_pipeline_uses_local_fixture_and_preserves_identity() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare the controlled Vibe build and Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"shadow-source-test-{uuid.uuid4().hex}"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "tools.stock_vibe.shadow_baseline",
            "--source-root",
            str(source_root),
            "--output",
            str(output),
            "--python",
            str(python),
        ],
        cwd=REPO_ROOT,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
        check=False,
    )
    manifest_path = output / "shadow-baseline.json"
    assert manifest_path.is_file(), result.stdout + result.stderr
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["execution_status"] == "completed"
    assert manifest["fixture_type"] == "synthetic contract fixture; not account or market evidence"
    assert manifest["fixture_hashes"]["bars.csv"]["sha256"] == BASELINE_BARS_SHA256
    assert manifest["home_unchanged"] is True
    assert manifest["userprofile_unchanged"] is True
    assert manifest["source_order_override"]["order"][0] == "local"
    assert manifest["runtime_input_hashes"]["journal"]["sha256"] == manifest["fixture_hashes"]["journal.csv"]["sha256"]
    assert manifest["runtime_input_hashes"]["bars"]["sha256"] == manifest["fixture_hashes"]["bars.csv"]["sha256"]

    shadow_id = manifest["shadow_id"]
    pipeline = json.loads((output / "evidence" / "pipeline.json").read_text(encoding="utf-8"))
    assert pipeline["shadow_id"] == shadow_id
    assert all(pipeline["steps"][step]["shadow_id"] == shadow_id for step in ("extract", "backtest", "report", "scan"))
    assert {"source", "per_market_count"} <= set(pipeline["tool_contracts"]["backtest_parameters"])
    assert {"source", "markets", "per_market_count"} <= set(pipeline["tool_contracts"]["report_parameters"])
    assert "source" in pipeline["tool_contracts"]["scan_parameters"]
    assert pipeline["steps"]["backtest"]["source"] == "local"
    assert pipeline["steps"]["backtest"]["per_market_count"] == 1
    backtest_step = pipeline["steps"]["backtest"]
    assert backtest_step["shadow_total_pnl"] is not None
    assert backtest_step["real_total_pnl"] is None
    assert backtest_step["delta_pnl"] is None
    assert backtest_step["account_comparison_status"] == "unavailable"
    assert "same backtest window" in backtest_step["account_comparison_unavailable_reason"].lower()
    assert all(
        value is None
        for key, value in backtest_step["attribution"].items()
        if key.endswith("_pnl")
    )
    report_step = pipeline["steps"]["report"]
    assert report_step["window"] == ["2025-06-23", "2025-07-01"]
    assert report_step["source"] == "local"
    assert report_step["markets"] == ["china_a"]
    assert report_step["per_market_count"] == 1
    assert report_step["shadow_total_pnl"] is not None
    assert report_step["real_total_pnl"] is None and report_step["delta_pnl"] is None
    assert report_step["account_comparison_status"] == "unavailable"
    assert "same backtest window" in report_step["account_comparison_unavailable_reason"].lower()
    assert manifest["profile"]["source_market"] == "china_a"
    assert manifest["profile"]["profitable_roundtrips"] == 5
    assert manifest["profile"]["date_range"][1][:10] <= "2025-06-23"

    run_identity = manifest["run_identity"]
    assert run_identity["shadow_id"] == shadow_id
    assert run_identity["source"] == "local"
    assert run_identity["symbols"] == ["600519.SH"]
    native_home = output / "native"
    run_dir = native_home / run_identity["native_run_directory"]
    run_config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    assert run_config["shadow_id"] == shadow_id
    assert run_config["source"] == "local"
    assert run_config["start_date"] == "2025-06-23"
    assert run_config["end_date"] == "2025-07-01"

    trades_path = run_dir / "artifacts" / "trades.csv"
    with trades_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    entries_by_symbol: dict[str, list[str]] = {}
    same_day_roundtrips = []
    for row_number, row in enumerate(rows, start=2):
        code = row.get("code", "")
        trade_date = (row.get("timestamp", "") or "")[:10]
        if row.get("event") == "entry":
            entries_by_symbol.setdefault(code, []).append(trade_date)
        elif row.get("event") == "exit" and entries_by_symbol.get(code):
            entry_date = entries_by_symbol[code].pop(0)
            if entry_date == trade_date:
                same_day_roundtrips.append(
                    {
                        "code": code,
                        "entry_date": entry_date,
                        "exit_date": trade_date,
                        "exit_reason": row.get("reason"),
                        "trades_csv_row": row_number,
                    }
                )
    t_plus_one_gate = manifest["rule_gates"]["china_a_t_plus_one"]
    assert t_plus_one_gate["same_day_roundtrips"] == same_day_roundtrips
    assert t_plus_one_gate["status"] == ("failed" if same_day_roundtrips else "passed")
    expected_status = "failed_rule_gate" if same_day_roundtrips else "success"
    assert manifest["status"] == expected_status
    assert result.returncode == (0 if expected_status == "success" else 1), result.stdout + result.stderr

    fills_path = run_dir / "artifacts" / "fills.jsonl"
    fills = [json.loads(line) for line in fills_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert any(fill.get("action") == "open" for fill in fills)
    with (run_dir / "artifacts" / "positions.csv").open(encoding="utf-8-sig", newline="") as handle:
        terminal_positions = list(csv.DictReader(handle))[-1]
    assert float(terminal_positions["600519.SH"]) > 0.5
    with (run_dir / "artifacts" / "equity.csv").open(encoding="utf-8-sig", newline="") as handle:
        final_equity = float(list(csv.DictReader(handle))[-1]["equity"])
    with (run_dir / "artifacts" / "metrics.csv").open(encoding="utf-8-sig", newline="") as handle:
        final_metric = float(list(csv.DictReader(handle))[-1]["final_value"])
    assert final_equity > 1_000_000
    assert final_equity == pytest.approx(final_metric)
    assert manifest["terminal_state"]["date"] == "2025-07-01"
    assert manifest["terminal_state"]["positions"]["600519.SH"] > 0.5

    report_path = native_home / manifest["report_artifact"]
    assert report_path.is_file()
    scan = manifest["scan_summary"]
    assert scan["target_date"] == "2025-07-01"
    assert scan["data_sources"]["600519.SH"] == "local"
    assert "600519.SH" in scan["available_symbols"]
    assert scan["status"] == "partial"
    assert scan["coverage"]["600519.SH"]["last_bar"] == scan["target_date"]
    assert len(scan["unscanned_symbols"]) == 4

    for value in manifest["runtime_env_paths"].values():
        if value:
            path = Path(value).resolve()
            assert path == native_home.resolve() or native_home.resolve() in path.parents


def test_native_scan_reports_local_data_failure_instead_of_empty_success() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare the controlled Vibe build and Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"shadow-no-data-test-{uuid.uuid4().hex}"
    native_home = output / "native"
    native_home.mkdir(parents=True)
    driver = output / "scan_no_data.py"
    driver.write_text(
        """import json, os
from src.shadow_account.models import ShadowProfile, ShadowRule
from src.shadow_account.storage import save_profile
from src.tools.shadow_account_tool import ScanShadowSignalsTool

home_before = os.environ.get('HOME')
profile_before = os.environ.get('USERPROFILE')
profile = ShadowProfile(
    shadow_id='shadow_no_data_fixture',
    created_at='2025-07-01T00:00:00Z',
    journal_hash='synthetic-fixture',
    source_market='china_a',
    profitable_roundtrips=5,
    total_roundtrips=5,
    date_range=('2025-06-09', '2025-06-20'),
    profile_text='Synthetic no-data contract profile.',
    rules=(ShadowRule(
        rule_id='R1', human_text='synthetic rule',
        entry_condition={'market': 'china_a', 'prior_5d_return': {'min': 0.0, 'max': 1.0}},
        exit_condition={'holding_days': {'min': 1, 'max': 2}},
        holding_days_range=(1, 2), support_count=5, coverage_rate=1.0,
        sample_trades=('600519.SH@2025-06-09',),
    ),),
    preferred_markets=('china_a',),
    typical_holding_days=(1.0, 1.0),
)
save_profile(profile)
result = json.loads(ScanShadowSignalsTool().execute(
    shadow_id=profile.shadow_id, date='2025-07-01', per_market=1, source='local',
))
print(json.dumps({
    'result': result,
    'home_unchanged': home_before == os.environ.get('HOME'),
    'userprofile_unchanged': profile_before == os.environ.get('USERPROFILE'),
}, ensure_ascii=False))
""",
        encoding="utf-8",
    )
    result = subprocess.run(
        [str(python), "-B", str(driver)],
        cwd=output,
        env=_child_environment(source_root, native_home),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    (output / "scan-result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    scan = payload["result"]
    assert payload["home_unchanged"] is True
    assert payload["userprofile_unchanged"] is True
    assert scan["status"] == "error"
    assert scan["data_status"] == "error"
    assert scan["source_requested"] == "local"
    assert scan["matches"] == []
    assert scan["available_symbols"] == []
    assert scan["errors"]
    assert {error["type"] for error in scan["errors"].values()} == {"NoAvailableSourceError"}
