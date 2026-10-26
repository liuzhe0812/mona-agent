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
from dataclasses import replace
from pathlib import Path

output = Path(sys.argv[1]).resolve()
native_home = Path(sys.argv[2]).resolve()
fixture_root = Path(sys.argv[3]).resolve()
native_home.mkdir(parents=True, exist_ok=True)
uploads = native_home / "uploads"
uploads.mkdir(parents=True, exist_ok=True)
journal = uploads / "synthetic-shadow-journal.csv"
shutil.copyfile(fixture_root / "journal.csv", journal)

from backtest.loaders.registry import get_default_source_order, refresh_source_order_overrides

local_order = get_default_source_order("a_share")
if "local" not in local_order:
    raise RuntimeError("native source chain has no local loader")
local_order.remove("local")
os.environ["MARKET_DATA_ORDER_A_SHARE"] = ",".join(["local", *local_order])
refresh_source_order_overrides()

from pypdf import PdfReader
from src.shadow_account.backtester import load_cached_result
from src.shadow_account.models import ShadowProfile
from src.shadow_account.reporter import render_shadow_report
from src.shadow_account.storage import load_profile, save_profile
from src.tools.shadow_account_tool import ExtractShadowStrategyTool, RunShadowBacktestTool

window_start = "2025-06-23"
window_end = "2025-07-01"


extraction = json.loads(ExtractShadowStrategyTool().execute(
    journal_path=str(journal), min_support=3, max_rules=1,
))
if extraction.get("status") != "ok":
    raise RuntimeError(f"synthetic journal extraction failed: {extraction.get('error')}")
base_profile = load_profile(extraction["shadow_id"])


def profile(shadow_id: str) -> ShadowProfile:
    return replace(base_profile, shadow_id=shadow_id)


def run(shadow_id: str, markets: list[str], journal_path: str | None) -> tuple[ShadowProfile, dict]:
    saved = profile(shadow_id)
    save_profile(saved)
    args = {
        "shadow_id": shadow_id,
        "window_start": window_start,
        "window_end": window_end,
        "markets": markets,
        "per_market_count": 1,
        "source": "local",
    }
    if journal_path is not None:
        args["journal_path"] = journal_path
    return saved, json.loads(RunShadowBacktestTool().execute(**args))


def report(
    saved: ShadowProfile,
    report_dir: Path,
    markets: list[str],
    journal_path: str | None,
) -> tuple[str, str]:
    result = load_cached_result(
        saved,
        window_start=window_start,
        window_end=window_end,
        source="local",
        markets=tuple(markets),
        per_market_count=1,
        journal_path=journal_path,
    )
    if result is None:
        raise RuntimeError("native Shadow result cache was not written")
    rendered = render_shadow_report(saved, result, output_dir=report_dir)
    html = Path(rendered["html_path"]).read_text(encoding="utf-8")
    if not rendered["pdf_path"]:
        raise RuntimeError("native report did not render a PDF")
    pdf = "\n".join(page.extract_text() or "" for page in PdfReader(rendered["pdf_path"]).pages)
    assert rendered["sections"]["real_pnl"] is None
    assert rendered["sections"]["delta_pnl"] is None
    assert not rendered["sections"]["attribution_available"]
    return html, pdf


evidence = {"fixture": "synthetic contract fixture; not account or market evidence"}

# No local source data: hosted operation must fail instead of returning zeros.
no_data_profile, no_data = run("shadow_unavailable_no_data", ["china_a"], str(journal))
evidence["no_data"] = no_data
assert no_data["status"] == "error"
assert no_data["reason"] == "no_usable_metrics"
assert no_data["source"] == "local" and no_data["markets"] == ["china_a"]
assert no_data["window"] == [window_start, window_end] and no_data["per_market_count"] == 1
assert "Data source 'local' is unavailable" in (no_data.get("original_error") or "")
assert str(native_home) not in json.dumps(no_data)
assert no_data["real_total_pnl"] is None and no_data["delta_pnl"] is None
no_data_html, no_data_pdf = report(
    no_data_profile, output / "reports" / "no-data", ["china_a"], str(journal),
)
assert "No usable Shadow performance metrics" in no_data_html
assert "Counterfactual analysis was not calculated" in no_data_html
assert "No material counterfactual trades" not in no_data_html
assert "Counterfactual analysis was not calculated" in no_data_pdf

# The explicit local fixture is a deterministic seven-bar valid baseline.
bridge = native_home / "data-bridge"
bridge.mkdir(parents=True, exist_ok=True)
bars = bridge / "synthetic-shadow-bars.csv"
shutil.copyfile(fixture_root / "bars.csv", bars)
(bridge / "config.yaml").write_text(
    "sources:\n  - symbol: 600519.SH\n    type: csv\n    path: " + json.dumps(bars.as_posix()) + "\n",
    encoding="utf-8",
)
baseline_profile, baseline = run("shadow_unavailable_baseline", ["china_a"], str(journal))
evidence["baseline"] = baseline
assert baseline["status"] == "ok"
assert baseline["equity_points"] == 7
assert baseline["combined"]["final_value"] == 1_000_000.0
assert baseline["combined"]["total_return"] == 0.0
assert baseline["shadow_total_pnl"] == 0.0
assert baseline["real_total_pnl"] is None
assert baseline["delta_pnl"] is None
assert all(value is None for key, value in baseline["attribution"].items() if key.endswith("_pnl"))
assert baseline["account_comparison_status"] == "unavailable"
assert "same backtest window" in baseline["account_comparison_unavailable_reason"].lower()
baseline_html, baseline_pdf = report(
    baseline_profile, output / "reports" / "baseline", ["china_a"], str(journal),
)
assert "complete opening positions, principal, and net-value evidence" in baseline_html.lower()
assert "trade journal is transaction evidence only" in baseline_html.lower()
assert "complete opening positions, principal, and net-value evidence" in baseline_pdf.lower()
assert "Noise trades" not in baseline_pdf
assert "71.00" not in baseline_pdf

# Valid Shadow performance without a journal retains Shadow metrics only.
no_journal_profile, no_journal = run("shadow_unavailable_no_journal", ["china_a"], None)
evidence["no_journal"] = no_journal
assert no_journal["status"] == "ok"
assert no_journal["equity_points"] == 7
assert no_journal["shadow_total_pnl"] == 0.0
assert no_journal["real_total_pnl"] is None and no_journal["delta_pnl"] is None
assert all(value is None for key, value in no_journal["attribution"].items() if key.endswith("_pnl"))
no_journal_html, no_journal_pdf = report(
    no_journal_profile, output / "reports" / "no-journal", ["china_a"], None,
)
assert "complete opening positions, principal, and net-value evidence" in no_journal_html.lower()
assert "Counterfactual analysis was not calculated" in no_journal_html
assert "Noise trades" not in no_journal_html
assert "No material counterfactual trades" not in no_journal_html
assert "complete opening positions, principal, and net-value evidence" in no_journal_pdf.lower()
assert "Shadow PnL\n+0.00" in no_journal_pdf
assert "Counterfactual analysis was not calculated" in no_journal_pdf
assert "Noise trades" not in no_journal_pdf

# Only A-share fixture data exists; the requested HK market remains unavailable.
partial_profile, partial = run("shadow_unavailable_partial", ["china_a", "hk"], None)
evidence["partial_market"] = partial
assert partial["status"] == "ok"
assert partial["per_market"]["china_a"]
assert partial["per_market"]["hk"] == {}
partial_html, partial_pdf = report(
    partial_profile, output / "reports" / "partial-market", ["china_a", "hk"], None,
)
hk_row = partial_html.split("</tr>", 1)[1]
assert "HK equity" in hk_row and hk_row.count("N/A") >= 3
assert "HK equity" in partial_pdf and "N/A" in partial_pdf

evidence["checks"] = {
    "no_data_is_unavailable": True,
    "valid_fixture_baseline_unchanged": True,
    "account_comparison_unavailable_even_with_journal": True,
    "partial_market_is_na": True,
    "reports_rendered_to_html_and_pdf": True,
}
(output / "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(evidence, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = os.environ.get("STOCK_VIBE_SHADOW_UNAVAILABLE_SOURCE_ROOT") or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT") or os.environ.get("STOCK_VIBE_SHADOW_SOURCE_ROOT")
    python = os.environ.get("STOCK_VIBE_SHADOW_UNAVAILABLE_PYTHON") or os.environ.get("STOCK_VIBE_TEST_PYTHON") or os.environ.get("STOCK_VIBE_SHADOW_PYTHON")
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
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_hosted_shadow_metrics_and_reports_preserve_unavailable_state() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare the controlled 1–21 Vibe source and Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"shadow-unavailable-test-{uuid.uuid4().hex}"
    output.mkdir(parents=True)
    native_home = output / "native"
    native_home.mkdir()
    driver = output / "native_shadow_unavailable.py"
    driver.write_text(DRIVER, encoding="utf-8")
    result = subprocess.run(
        [str(python), "-B", str(driver), str(output), str(native_home), str(REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "shadow")],
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
    assert "api init error" not in (result.stdout + result.stderr).lower()
    assert "tushare pro" not in (result.stdout + result.stderr).lower()
    evidence_path = output / "evidence.json"
    assert evidence_path.is_file(), result.stdout + result.stderr
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["checks"] == {
        "no_data_is_unavailable": True,
        "valid_fixture_baseline_unchanged": True,
        "account_comparison_unavailable_even_with_journal": True,
        "partial_market_is_na": True,
        "reports_rendered_to_html_and_pdf": True,
    }
    assert evidence["no_data"]["status"] == "error"
    assert evidence["baseline"]["status"] == "ok"
    assert evidence["no_journal"]["real_total_pnl"] is None
    assert evidence["partial_market"]["per_market"]["hk"] == {}
