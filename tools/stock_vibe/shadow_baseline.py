"""Run the native Shadow pipeline on fixed synthetic local-only fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from tools.stock_vibe.baseline import (
    OUTPUT_ROOTS,
    _assert_no_dotenv_ancestors,
    _inside,
    _verify_source_receipt,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "shadow"
BACKTEST_START = "2025-06-23"
BACKTEST_END = "2025-07-01"
SCAN_AS_OF = "2025-07-01"
DRIVER = r'''from __future__ import annotations

import json
import math
import os
import sys
import csv
from pathlib import Path

output = Path(sys.argv[1]).resolve()
native_home = Path(sys.argv[2]).resolve()
journal_path = Path(sys.argv[3]).resolve()
backtest_start = "2025-06-23"
backtest_end = "2025-07-01"
evidence = output / "evidence"
evidence.mkdir(parents=True, exist_ok=True)
state_path = evidence / "pipeline.json"
state = {
    "status": "running",
    "steps": {},
    "tool_contracts": {},
    "source_order_override": None,
    "home_unchanged": None,
    "userprofile_unchanged": None,
}
home_before = os.environ.get("HOME")
profile_before = os.environ.get("USERPROFILE")
current_step = "source_order"


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def record_tool(step: str, raw: str) -> dict:
    result = json.loads(raw)
    write_json(evidence / f"{step}.json", result)
    state["steps"][step] = result
    write_json(state_path, state)
    return result


def require_status(step: str, result: dict, expected: set[str] = {"ok"}) -> None:
    if result.get("status") not in expected:
        raise RuntimeError(f"native {step} tool returned status={result.get('status')!r}")


try:
    from backtest.loaders.registry import (
        get_default_source_order,
        refresh_source_order_overrides,
    )

    local_order = get_default_source_order("a_share")
    if "local" not in local_order:
        raise RuntimeError("native A-share source chain has no local loader")
    local_order.remove("local")
    os.environ["MARKET_DATA_ORDER_A_SHARE"] = ",".join(["local", *local_order])
    refresh_source_order_overrides()
    state["source_order_override"] = {
        "market": "a_share",
        "order": ["local", *local_order],
    }
    write_json(state_path, state)

    from src.shadow_account.storage import load_profile, runs_dir
    from src.tools.shadow_account_tool import (
        ExtractShadowStrategyTool,
        RenderShadowReportTool,
        RunShadowBacktestTool,
        ScanShadowSignalsTool,
    )
    backtest_properties = RunShadowBacktestTool.parameters["properties"]
    scan_properties = ScanShadowSignalsTool.parameters["properties"]
    report_properties = RenderShadowReportTool.parameters["properties"]
    if not {"source", "per_market_count"}.issubset(backtest_properties):
        raise RuntimeError("native backtest schema omits source or per_market_count")
    if not {"source", "markets", "per_market_count"}.issubset(report_properties):
        raise RuntimeError("native report schema omits matching backtest inputs")
    if "source" not in scan_properties:
        raise RuntimeError("native scan schema omits source")
    state["tool_contracts"] = {
        "backtest_parameters": sorted(backtest_properties),
        "report_parameters": sorted(report_properties),
        "scan_parameters": sorted(scan_properties),
    }
    write_json(state_path, state)

    current_step = "extract"
    extraction = record_tool(
        current_step,
        ExtractShadowStrategyTool().execute(
            journal_path=str(journal_path), min_support=3, max_rules=1,
        ),
    )
    require_status(current_step, extraction)
    shadow_id = extraction["shadow_id"]
    profile = load_profile(shadow_id)
    if profile.source_market != "china_a" or profile.total_roundtrips < 5:
        raise RuntimeError("extracted profile did not preserve the synthetic A-share roundtrips")

    current_step = "backtest"
    backtest = record_tool(
        current_step,
        RunShadowBacktestTool().execute(
            shadow_id=shadow_id,
            window_start=backtest_start,
            window_end=backtest_end,
            markets=["china_a"],
            journal_path=str(journal_path),
            source="local",
            per_market_count=1,
        ),
    )
    require_status(current_step, backtest)
    if backtest.get("shadow_id") != shadow_id:
        raise RuntimeError("native Shadow backtest changed the profile identity")
    if backtest.get("source") != "local" or backtest.get("per_market_count") != 1:
        raise RuntimeError("native Shadow backtest did not return the requested source and basket count")
    if (
        backtest.get("real_total_pnl") is not None
        or backtest.get("delta_pnl") is not None
        or any(
            value is not None
            for key, value in backtest.get("attribution", {}).items()
            if key.endswith("_pnl")
        )
        or backtest.get("account_comparison_status") != "unavailable"
        or not backtest.get("account_comparison_unavailable_reason")
    ):
        raise RuntimeError("hosted Shadow result exposed an account return without comparable account evidence")

    run_root = runs_dir(shadow_id)
    run_dirs = sorted(path for path in run_root.iterdir() if path.is_dir())
    if len(run_dirs) != 1:
        raise RuntimeError(f"expected one native currency-pool run, found {len(run_dirs)}")
    run_dir = run_dirs[0]
    run_config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    run_card_path = run_dir / "run_card.json"
    state_path_native = run_dir / "state.json"
    if run_config.get("shadow_id") != shadow_id or run_config.get("source") != "local":
        raise RuntimeError("native generated run config lost Shadow identity or explicit local source")
    if run_config.get("codes") != ["600519.SH"]:
        raise RuntimeError(f"native Shadow run used unexpected symbols: {run_config.get('codes')}")
    if not run_card_path.is_file() or not state_path_native.is_file():
        raise RuntimeError("native backtest did not persist run card and state")
    run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
    run_state = json.loads(state_path_native.read_text(encoding="utf-8"))
    if run_state.get("status") != "success":
        raise RuntimeError(f"native backtest state was {run_state.get('status')!r}")
    if run_card.get("backtest", {}).get("source") != "local":
        raise RuntimeError("native run card did not record source=local")
    if "local" not in run_card.get("data_sources", []):
        raise RuntimeError("native run card did not record the local data source")
    artifacts_dir = run_dir / "artifacts"
    required_artifacts = (
        "equity.csv",
        "trades.csv",
        "metrics.csv",
        "ohlcv_600519.SH.csv",
        "positions.csv",
        "fills.jsonl",
    )
    missing_artifacts = [name for name in required_artifacts if not (artifacts_dir / name).is_file()]
    if missing_artifacts:
        raise RuntimeError(f"native backtest omitted artifacts: {missing_artifacts}")

    with (artifacts_dir / "positions.csv").open(encoding="utf-8-sig", newline="") as handle:
        position_rows = list(csv.DictReader(handle))
    with (artifacts_dir / "equity.csv").open(encoding="utf-8-sig", newline="") as handle:
        equity_rows = list(csv.DictReader(handle))
    with (artifacts_dir / "metrics.csv").open(encoding="utf-8-sig", newline="") as handle:
        metric_rows = list(csv.DictReader(handle))
    fill_rows = [
        json.loads(line)
        for line in (artifacts_dir / "fills.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not position_rows or not equity_rows or not metric_rows or not fill_rows:
        raise RuntimeError("native backtest omitted its terminal position, equity, metrics, or fill evidence")
    terminal_positions = {
        symbol: float(value)
        for symbol, value in position_rows[-1].items()
        if symbol != "timestamp" and value not in (None, "")
    }
    if not any(abs(value) > 0 for value in terminal_positions.values()):
        raise RuntimeError("native backtest did not preserve the expected terminal A-share position")
    terminal_equity = float(equity_rows[-1]["equity"])
    metric_final_value = float(metric_rows[-1]["final_value"])
    if not math.isclose(terminal_equity, metric_final_value, rel_tol=1e-9, abs_tol=0.01):
        raise RuntimeError("native final equity does not match the reported final metric")

    entries_by_symbol = {}
    same_day_roundtrips = []
    with (artifacts_dir / "trades.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row_number, row in enumerate(csv.DictReader(handle), start=2):
            code = row.get("code", "")
            event = row.get("event", "")
            trade_date = (row.get("timestamp", "") or "")[:10]
            if event == "entry":
                entries_by_symbol.setdefault(code, []).append(trade_date)
            elif event == "exit" and entries_by_symbol.get(code):
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
    t_plus_one_gate = {
        "status": "failed" if same_day_roundtrips else "passed",
        "rule": "A-share entries cannot be sold on the same trading date",
        "source_artifact": str((artifacts_dir / "trades.csv").relative_to(native_home)),
        "same_day_roundtrips": same_day_roundtrips,
    }

    current_step = "report"
    report = record_tool(
        current_step,
        RenderShadowReportTool().execute(
            shadow_id=shadow_id,
            include_today_signals=False,
            window_start=backtest_start,
            window_end=backtest_end,
            markets=["china_a"],
            source="local",
            per_market_count=1,
            journal_path=str(journal_path),
        ),
    )
    require_status(current_step, report)
    if report.get("shadow_id") != shadow_id:
        raise RuntimeError("native Shadow report changed the profile identity")
    if (
        report.get("window") != [backtest_start, backtest_end]
        or report.get("source") != "local"
        or report.get("markets") != ["china_a"]
        or report.get("per_market_count") != 1
    ):
        raise RuntimeError("native Shadow report did not preserve the matching backtest inputs")
    if (
        report.get("real_total_pnl") is not None
        or report.get("delta_pnl") is not None
        or any(
            value is not None
            for key, value in report.get("attribution", {}).items()
            if key.endswith("_pnl")
        )
        or report.get("account_comparison_status") != "unavailable"
        or not report.get("account_comparison_unavailable_reason")
    ):
        raise RuntimeError("native Shadow report exposed an account return without comparable account evidence")
    report_path = Path(report.get("pdf_path") or report.get("html_path") or "")
    if not report_path.is_file():
        raise RuntimeError("native Shadow report returned no existing PDF or HTML artifact")
    if report_path.suffix.lower() == ".pdf":
        from pypdf import PdfReader

        report_text = "\n".join(page.extract_text() or "" for page in PdfReader(report_path).pages)
    else:
        report_text = report_path.read_text(encoding="utf-8")
    comparison_notice = "complete opening positions, principal, and net-value evidence for the same backtest window are missing"
    if comparison_notice not in report_text.lower():
        raise RuntimeError("Shadow report did not explain the missing same-window account evidence")
    if "71.00" in report_text or "Noise trades" in report_text:
        raise RuntimeError("Shadow report exposed transaction-journal PnL as account performance")

    current_step = "scan"
    scan = record_tool(
        current_step,
        ScanShadowSignalsTool().execute(
            shadow_id=shadow_id,
            date="2025-07-01",
            per_market=1,
            source="auto",
        ),
    )
    if scan.get("status") not in {"ok", "partial"}:
        raise RuntimeError(f"native Shadow scan did not obtain usable local data: {scan.get('status')}")
    if scan.get("shadow_id") != shadow_id:
        raise RuntimeError("native Shadow scan changed the profile identity")
    if scan.get("data_sources", {}).get("600519.SH") != "local":
        raise RuntimeError("native Shadow scan did not use the local loader for the fixture symbol")
    if "600519.SH" not in scan.get("available_symbols", []):
        raise RuntimeError("native Shadow scan did not verify fixture bars for the basket symbol")
    if scan.get("target_date") != "2025-07-01":
        raise RuntimeError("native Shadow scan did not preserve the frozen as-of date")

    state.update(
        {
            "status": "failed_rule_gate" if same_day_roundtrips else "success",
            "execution_status": "completed",
            "rule_gates": {"china_a_t_plus_one": t_plus_one_gate},
            "tool_contracts": state["tool_contracts"],
            "shadow_id": shadow_id,
            "profile": {
                "source_market": profile.source_market,
                "total_roundtrips": profile.total_roundtrips,
                "profitable_roundtrips": profile.profitable_roundtrips,
                "date_range": list(profile.date_range),
                "journal_hash": profile.journal_hash,
                "rules": [rule.to_dict() if hasattr(rule, "to_dict") else {
                    "rule_id": rule.rule_id,
                    "human_text": rule.human_text,
                    "entry_condition": rule.entry_condition,
                    "exit_condition": rule.exit_condition,
                } for rule in profile.rules],
            },
            "run_identity": {
                "shadow_id": shadow_id,
                "native_run_directory": str(run_dir.relative_to(native_home)),
                "currency_pool": run_dir.name,
                "source": run_config["source"],
                "symbols": run_config["codes"],
            },
            "run_artifacts": {
                name: str((artifacts_dir / name).relative_to(native_home))
                for name in required_artifacts
            },
            "terminal_state": {
                "date": equity_rows[-1]["timestamp"],
                "equity": terminal_equity,
                "metric_final_value": metric_final_value,
                "positions": terminal_positions,
                "fill_count": len(fill_rows),
            },
            "report_artifact": str(report_path.relative_to(native_home)),
            "scan_summary": {
                "status": scan.get("status"),
                "data_status": scan.get("data_status"),
                "target_date": scan.get("target_date"),
                "available_symbols": scan.get("available_symbols"),
                "missing_symbols": scan.get("missing_symbols"),
                "unscanned_symbols": scan.get("unscanned_symbols"),
                "data_sources": scan.get("data_sources"),
                "coverage": scan.get("coverage"),
                "matches": scan.get("matches"),
            },
            "home_unchanged": home_before == os.environ.get("HOME"),
            "userprofile_unchanged": profile_before == os.environ.get("USERPROFILE"),
            "runtime_env_paths": {
                key: os.environ.get(key)
                for key in (
                    "VIBE_TRADING_HOME",
                    "TEMP",
                    "TMP",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "XDG_CACHE_HOME",
                    "XDG_CONFIG_HOME",
                    "MPLCONFIGDIR",
                )
            },
        }
    )
    if state["home_unchanged"] is not True or state["userprofile_unchanged"] is not True:
        raise RuntimeError("native Shadow driver changed HOME or USERPROFILE")
    if any(
        Path(path).resolve() != native_home and native_home not in Path(path).resolve().parents
        for path in state["runtime_env_paths"].values()
        if path
    ):
        raise RuntimeError("native Shadow runtime/cache path escaped output/native")
    write_json(state_path, state)
    print("NATIVE_SHADOW_RESULT=" + json.dumps(state, ensure_ascii=False, sort_keys=True, default=str))
except Exception as exc:
    state.update(
        {
            "status": "failed",
            "execution_status": "failed",
            "failed_step": current_step,
            "failure": {"type": type(exc).__name__, "message": str(exc)},
            "home_unchanged": home_before == os.environ.get("HOME"),
            "userprofile_unchanged": profile_before == os.environ.get("USERPROFILE"),
            "runtime_env_paths": {
                key: os.environ.get(key)
                for key in (
                    "VIBE_TRADING_HOME",
                    "TEMP",
                    "TMP",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "XDG_CACHE_HOME",
                    "XDG_CONFIG_HOME",
                    "MPLCONFIGDIR",
                )
            },
        }
    )
    write_json(state_path, state)
    raise
'''


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def _render_local_config(bars_path: Path) -> str:
    return (
        "sources:\n"
        "  - symbol: 600519.SH\n"
        "    type: csv\n"
        f"    path: {json.dumps(bars_path.as_posix())}\n"
    )


def _runtime_environment(source_root: Path, native_home: Path) -> dict[str, str]:
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


def _run_pipeline(source_root: Path, output: Path, python: Path, timeout: int) -> dict[str, object]:
    source_receipt = _verify_source_receipt(source_root)
    _assert_no_dotenv_ancestors(source_root)
    if not python.is_file():
        raise FileNotFoundError(f"Controlled Python interpreter not found: {python}")
    if not any(_inside(output, root) for root in OUTPUT_ROOTS):
        raise ValueError("--output must stay under .codex_tmp or docs/plans/evidence")
    if _inside(output, source_root) or _inside(source_root, output):
        raise ValueError("--output must be separate from the controlled source tree")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"--output is not empty; choose a fresh evidence directory: {output}")
    missing_fixtures = [
        name for name in ("README.md", "journal.csv", "bars.csv")
        if not (FIXTURE_ROOT / name).is_file()
    ]
    if missing_fixtures:
        raise FileNotFoundError(f"missing synthetic fixture files: {missing_fixtures}")
    if not (source_root / "src" / "shadow_account" / "scanner.py").is_file():
        raise FileNotFoundError(f"native Shadow scanner not found under {source_root}")

    output.mkdir(parents=True, exist_ok=True)
    native_home = output / "native"
    journal_path = native_home / "uploads" / "synthetic-shadow-journal.csv"
    bars_path = native_home / "data-bridge" / "synthetic-shadow-bars.csv"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    bars_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE_ROOT / "journal.csv", journal_path)
    shutil.copyfile(FIXTURE_ROOT / "bars.csv", bars_path)
    bridge_config = native_home / "data-bridge" / "config.yaml"
    bridge_config.write_text(_render_local_config(bars_path), encoding="utf-8")

    evidence = output / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    driver_path = evidence / "native_shadow_driver.py"
    driver_path.write_text(DRIVER, encoding="utf-8")
    manifest_path = output / "shadow-baseline.json"
    fixture_info = {}
    for name in ("README.md", "journal.csv", "bars.csv"):
        path = FIXTURE_ROOT / name
        fixture_info[name] = {"sha256": _sha256(path), "size": path.stat().st_size}
    runtime_inputs = {
        name: {
            "path": str(path.relative_to(native_home)),
            "sha256": _sha256(path),
            "size": path.stat().st_size,
        }
        for name, path in (
            ("journal", journal_path),
            ("bars", bars_path),
            ("data_bridge_config", bridge_config),
        )
    }
    manifest: dict[str, object] = {
        "schema_version": 1,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_root": str(source_root),
        "source_receipt": source_receipt,
        "python": str(python),
        "snapshot_id": source_receipt["snapshot_id"],
        "fixture_type": "synthetic contract fixture; not account or market evidence",
        "fixture_hashes": fixture_info,
        "runtime_input_hashes": runtime_inputs,
        "runtime_data_root": str(native_home),
        "data_bridge_config": str(bridge_config.relative_to(native_home)),
        "extraction_trade_range": ["2025-06-09", "2025-06-20"],
        "backtest_window": [BACKTEST_START, BACKTEST_END],
        "scan_as_of": SCAN_AS_OF,
        "steps": {},
    }
    _write_json(manifest_path, manifest)

    command = [str(python), "-B", str(driver_path), str(output), str(native_home), str(journal_path)]
    try:
        result = subprocess.run(
            command,
            cwd=output,
            env=_runtime_environment(source_root, native_home),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        manifest.update(
            {
                "status": "failed",
                "failure": f"native Shadow pipeline timed out after {timeout}s",
                "pipeline_state": str(evidence / "pipeline.json"),
            }
        )
        (evidence / "driver.stdout.txt").write_text(stdout, encoding="utf-8")
        (evidence / "driver.stderr.txt").write_text(stderr, encoding="utf-8")
        _write_json(manifest_path, manifest)
        return manifest

    (evidence / "driver.stdout.txt").write_text(result.stdout, encoding="utf-8")
    (evidence / "driver.stderr.txt").write_text(result.stderr, encoding="utf-8")
    pipeline_path = evidence / "pipeline.json"
    pipeline = json.loads(pipeline_path.read_text(encoding="utf-8")) if pipeline_path.is_file() else None
    if (
        result.returncode
        or not isinstance(pipeline, dict)
        or pipeline.get("execution_status") != "completed"
        or pipeline.get("status") not in {"success", "failed_rule_gate"}
    ):
        manifest.update(
            {
                "status": "failed",
                "execution_status": "failed",
                "runner_exit_code": result.returncode,
                "failure": pipeline.get("failure") if isinstance(pipeline, dict) else "native driver produced no pipeline state",
                "failed_step": pipeline.get("failed_step") if isinstance(pipeline, dict) else None,
                "steps": pipeline.get("steps", {}) if isinstance(pipeline, dict) else {},
                "source_order_override": pipeline.get("source_order_override") if isinstance(pipeline, dict) else None,
                "tool_contracts": pipeline.get("tool_contracts", {}) if isinstance(pipeline, dict) else {},
                "pipeline_state": str(pipeline_path) if pipeline_path.exists() else None,
            }
        )
        _write_json(manifest_path, manifest)
        return manifest

    final_status = pipeline.get("status", "failed")
    manifest.update(
        {
            "status": final_status,
            "execution_status": "completed",
            "rule_gates": pipeline.get("rule_gates", {}),
            "tool_contracts": pipeline.get("tool_contracts", {}),
            "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "steps": pipeline.get("steps", {}),
            "shadow_id": pipeline.get("shadow_id"),
            "profile": pipeline.get("profile"),
            "run_identity": pipeline.get("run_identity"),
            "run_artifacts": pipeline.get("run_artifacts"),
            "terminal_state": pipeline.get("terminal_state"),
            "report_artifact": pipeline.get("report_artifact"),
            "scan_summary": pipeline.get("scan_summary"),
            "home_unchanged": pipeline.get("home_unchanged"),
            "userprofile_unchanged": pipeline.get("userprofile_unchanged"),
            "source_order_override": pipeline.get("source_order_override"),
            "runtime_env_paths": pipeline.get("runtime_env_paths"),
            "pipeline_state": str(pipeline_path),
        }
    )
    _write_json(manifest_path, manifest)
    if final_status == "success":
        print(f"Native Shadow pipeline and rule gates passed; evidence: {output}")
    else:
        print(f"Native Shadow pipeline completed with failed rule gates; evidence: {output}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path, help="controlled Vibe snapshot agent directory")
    parser.add_argument("--output", required=True, type=Path, help="new evidence directory; contains output/native")
    parser.add_argument("--python", required=True, type=Path, help="interpreter with the locked Vibe dependencies")
    parser.add_argument("--timeout", type=int, default=600, help="native pipeline timeout in seconds")
    args = parser.parse_args()
    try:
        manifest = _run_pipeline(
            args.source_root.resolve(), args.output.resolve(), args.python.resolve(), args.timeout,
        )
    except (FileNotFoundError, FileExistsError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"baseline not run: {exc}", file=sys.stderr)
        return 2
    return 0 if manifest.get("status") == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
