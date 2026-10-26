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
import shutil
import sys
from pathlib import Path

output = Path(sys.argv[1]).resolve()
native_home = Path(sys.argv[2]).resolve()
fixture_root = Path(sys.argv[3]).resolve()
uploads = native_home / "uploads"
uploads.mkdir(parents=True, exist_ok=True)
journal_path = uploads / "synthetic-journal.csv"
shutil.copyfile(fixture_root / "journal.csv", journal_path)

bridge = native_home / "data-bridge"
bridge.mkdir(parents=True, exist_ok=True)
bars_path = bridge / "synthetic-bars.csv"
shutil.copyfile(fixture_root / "bars.csv", bars_path)
(bridge / "config.yaml").write_text(
    "sources:\n  - symbol: 600519.SH\n    type: csv\n    path: " + json.dumps(bars_path.as_posix()) + "\n",
    encoding="utf-8",
)

from backtest.loaders.registry import get_default_source_order, refresh_source_order_overrides

local_order = get_default_source_order("a_share")
if "local" not in local_order:
    raise RuntimeError("native source chain has no local loader")
local_order.remove("local")
os.environ["MARKET_DATA_ORDER_A_SHARE"] = ",".join(["local", *local_order])
refresh_source_order_overrides()

from pypdf import PdfReader
from src.shadow_account.backtester import load_cached_result
from src.shadow_account.models import ShadowProfile, ShadowRule
from src.shadow_account.reporter import render_shadow_report
from src.shadow_account.storage import hash_journal, save_profile
from src.tools.shadow_account_tool import RenderShadowReportTool, RunShadowBacktestTool
import src.tools.shadow_account_tool as shadow_tool_module

shadow_id = "shadow_0025a001"
window = ["2025-06-23", "2025-07-01"]
profile = ShadowProfile(
    shadow_id=shadow_id,
    created_at="2025-06-21T12:34:56Z",
    journal_hash=hash_journal(journal_path),
    source_market="china_a",
    profitable_roundtrips=5,
    total_roundtrips=5,
    date_range=("2025-06-09 10:30:00", "2025-06-20 10:30:00"),
    profile_text="Synthetic report metadata contract profile.",
    rules=(ShadowRule(
        rule_id="R1",
        human_text="Synthetic RSI/prior-return rule",
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
        sample_trades=("600519.SH@2025-06-09",),
    ),),
    preferred_markets=("china_a",),
    typical_holding_days=(1.0, 1.0),
)
save_profile(profile)

request = {
    "shadow_id": shadow_id,
    "window_start": window[0],
    "window_end": window[1],
    "source": "local",
    "markets": ["china_a"],
    "per_market_count": 1,
    "journal_path": str(journal_path),
}
backtest = json.loads(RunShadowBacktestTool().execute(**request))
assert backtest["status"] == "ok"
assert backtest["equity_points"] == 7
assert backtest["combined"]["trade_count"] == 0.0
assert backtest["shadow_total_pnl"] == 0.0
assert backtest["real_total_pnl"] is None and backtest["delta_pnl"] is None

def unexpected_scan(*args, **kwargs):
    raise AssertionError("hosted RenderShadowReportTool must not run a market scan")

shadow_tool_module.scan_today_signals = unexpected_scan
report = json.loads(RenderShadowReportTool().execute(**request))
assert report["status"] == "ok", report
assert report["window"] == window
assert report["source"] == "local"
assert report["markets"] == ["china_a"]
assert report["per_market_count"] == 1
assert report["real_total_pnl"] is None and report["delta_pnl"] is None
assert report["shadow_total_pnl"] == 0.0
assert report["account_comparison_status"] == "unavailable"

if report["pdf_path"]:
    provided_pdf = "\n".join(page.extract_text() or "" for page in PdfReader(report["pdf_path"]).pages)
else:
    provided_pdf = Path(report["html_path"]).read_text(encoding="utf-8")
required = (
    "Profile created at: 2025-06-21T12:34:56Z",
    "Report generated at:",
    "Extraction/journal window: 2025-06-09 10:30:00 -> 2025-06-20 10:30:00",
    "Shadow backtest window: 2025-06-23 -> 2025-07-01",
    "Source: local",
    "Markets: china_a",
    "Basket count per market: 1",
    "Signal scan: Not requested",
    "Signal scan was not requested",
    "No completed trades were recorded",
    "this result does not validate strategy effectiveness",
)
for marker in required:
    assert marker.lower() in provided_pdf.lower(), (marker, provided_pdf)
assert "Not provided" not in provided_pdf
assert "71.00" not in provided_pdf and "Noise trades" not in provided_pdf

scan_request = json.loads(RenderShadowReportTool().execute(**request, include_today_signals=True))
assert scan_request["status"] == "error", scan_request
assert scan_request["reason"] == "separate_scan_required", scan_request

# A caller without confirmed report inputs is shown as unknown; the journal
# window is not copied into the Shadow backtest window.
result = load_cached_result(
    profile,
    window_start=window[0],
    window_end=window[1],
    source="local",
    markets=("china_a",),
    per_market_count=1,
    journal_path=journal_path,
)
if result is None:
    raise RuntimeError("matching Shadow cache is missing")
missing_metadata = render_shadow_report(
    profile,
    result,
    output_dir=output / "report-without-input-metadata",
    report_inputs=None,
)
sections = missing_metadata["sections"]
assert sections["journal_window"] == "2025-06-09 10:30:00 -> 2025-06-20 10:30:00"
assert sections["shadow_backtest_window"] == "Not provided"
assert sections["report_source"] == "Not provided"
assert sections["report_markets"] == "Not provided"
assert sections["report_per_market_count"] == "Not provided"
assert sections["report_scan_status"] == "Not provided"
if missing_metadata["pdf_path"]:
    unknown_pdf = "\n".join(page.extract_text() or "" for page in PdfReader(missing_metadata["pdf_path"]).pages)
else:
    unknown_pdf = Path(missing_metadata["html_path"]).read_text(encoding="utf-8")
assert "Shadow backtest window: Not provided" in unknown_pdf
assert "Extraction/journal window: 2025-06-09 10:30:00 -> 2025-06-20 10:30:00" in unknown_pdf
assert "Shadow backtest window: 2025-06-09" not in unknown_pdf
assert "Signal scan: Not provided" in unknown_pdf
assert "Signal scan status was not provided" in unknown_pdf

evidence = {
    "fixture": "synthetic contract fixture; not account or market evidence",
    "backtest": {
        "equity_points": backtest["equity_points"],
        "trade_count": backtest["combined"]["trade_count"],
        "shadow_total_pnl": backtest["shadow_total_pnl"],
        "real_total_pnl": backtest["real_total_pnl"],
        "delta_pnl": backtest["delta_pnl"],
    },
    "report": {
        "window": report["window"],
        "source": report["source"],
        "markets": report["markets"],
        "per_market_count": report["per_market_count"],
        "pdf_verified": True,
    },
    "missing_metadata_is_not_inferred": True,
    "hosted_report_scan_not_requested": True,
    "explicit_scan_request_rejected": scan_request["reason"] == "separate_scan_required",
}
(output / "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(evidence, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = (
        os.environ.get("STOCK_VIBE_REPORT_METADATA_SOURCE_ROOT")
        or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT")
        or os.environ.get("STOCK_VIBE_SHADOW_SOURCE_ROOT")
    )
    python = (
        os.environ.get("STOCK_VIBE_REPORT_METADATA_PYTHON")
        or os.environ.get("STOCK_VIBE_TEST_PYTHON")
        or os.environ.get("STOCK_VIBE_SHADOW_PYTHON")
    )
    if not source or not python:
        pytest.skip("set an explicit controlled native source and Python 3.13 environment")
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
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_report_pdf_names_both_windows_and_explicit_backtest_inputs() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare fresh Vibe source 25 and the controlled Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"shadow-report-metadata-test-{uuid.uuid4().hex}"
    output.mkdir(parents=True)
    native_home = output / "native"
    native_home.mkdir()
    driver = output / "native_shadow_report_metadata.py"
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
    assert evidence["backtest"]["equity_points"] == 7
    assert evidence["backtest"]["trade_count"] == 0.0
    assert evidence["backtest"]["shadow_total_pnl"] == 0.0
    assert evidence["backtest"]["real_total_pnl"] is None
    assert evidence["backtest"]["delta_pnl"] is None
    assert evidence["report"]["pdf_verified"] is True
    assert evidence["missing_metadata_is_not_inferred"] is True
