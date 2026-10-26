"""Run a fixed offline A-share contract backtest against the controlled Vibe snapshot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "backtest"
OUTPUT_ROOTS = (
    (REPO_ROOT / ".codex_tmp").resolve(),
    (REPO_ROOT / "docs" / "plans" / "evidence").resolve(),
)
RUN_FILES = (
    "run_card.json",
    "run_card.md",
    "artifacts/equity.csv",
    "artifacts/fills.jsonl",
    "artifacts/metrics.csv",
    "artifacts/positions.csv",
    "artifacts/target_positions.csv",
    "artifacts/trades.csv",
    "artifacts/ohlcv_600000.SH.csv",
)
SOURCE_FILES = (
    "backtest/runner.py",
    "backtest/loaders/local_loader.py",
    "backtest/engines/china_a.py",
    "backtest/engines/base.py",
    "backtest/run_card.py",
)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_source_receipt(source_root: Path) -> dict[str, object]:
    temporary_root = (REPO_ROOT / ".codex_tmp").resolve()
    if source_root.name != "agent" or source_root.parent.parent.resolve() != temporary_root:
        raise ValueError("--source-root must be an agent directory in a controlled .codex_tmp build")

    lock_path = REPO_ROOT / "third_party" / "vibe-trading" / "source-lock.json"
    patch_root = REPO_ROOT / "third_party" / "vibe-trading" / "patches"
    receipt_path = source_root / "mona-source.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("schema_version") != 1 or receipt.get("snapshot_id") != lock.get("snapshot_id"):
        raise ValueError("controlled source receipt does not match the locked snapshot")

    patch_hashes = {path.name: _sha256(path) for path in patch_root.glob("*.json")}
    receipt_patches = receipt.get("patches")
    if not isinstance(receipt_patches, list) or not receipt_patches:
        raise ValueError("controlled source receipt has no applied isolation patches")
    received: dict[str, str] = {}
    for patch in receipt_patches:
        if not isinstance(patch, dict) or not isinstance(patch.get("path"), str):
            raise ValueError("controlled source receipt contains an invalid patch entry")
        name = patch["path"]
        if Path(name).name != name or name in received:
            raise ValueError("controlled source receipt contains a duplicate or unsafe patch path")
        received[name] = str(patch.get("sha256", ""))
    if received != patch_hashes:
        raise ValueError("controlled source receipt patch hashes do not match the reviewed patch set")
    return receipt


def _assert_no_dotenv_ancestors(source_root: Path) -> None:
    current = source_root
    while True:
        if (current / ".env").exists():
            raise ValueError(f"refusing to run because dotenv discovery could read {current / '.env'}")
        if current.parent == current:
            break
        current = current.parent


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _render_local_config(bars_path: Path, halt_path: Path) -> str:
    return (
        "sources:\n"
        "  - symbol: 600000.SH\n"
        "    type: csv\n"
        f"    path: {json.dumps(bars_path.as_posix())}\n"
        "  - symbol: 600001.SH\n"
        "    type: csv\n"
        f"    path: {json.dumps(halt_path.as_posix())}\n"
    )


def _run(command: list[str], *, source_root: Path, runtime_home: Path, run_dir: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    temporary_root = runtime_home / "temp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    environment.update(
        {
            "PYTHONPATH": str(source_root),
            "PYTHON_DOTENV_DISABLED": "1",
            "TEMP": str(temporary_root),
            "TMP": str(temporary_root),
            "VIBE_TRADING_HOME": str(runtime_home),
            "VIBE_TRADING_HOSTED": "1",
            "VIBE_TRADING_ALLOWED_RUN_ROOTS": str(run_dir),
        }
    )
    return subprocess.run(
        command,
        cwd=source_root,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def _read_trades(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _check_rule_evidence(evidence: dict[str, object], trades: list[dict[str, str]]) -> list[str]:
    failures: list[str] = []
    t_plus_one = evidence.get("t_plus_one", {})
    if t_plus_one.get("same_day_sell_allowed") is not False:
        failures.append("native A-share engine did not block same-day selling")
    if t_plus_one.get("next_day_sell_allowed") is not True:
        failures.append("native A-share engine did not allow selling on the next day")

    lots = evidence.get("lots", {})
    if lots.get("round_size_250") != 200 or lots.get("round_size_99") != 0:
        failures.append("native A-share engine did not round purchases down to 100-share lots")
    if any(int(float(row["qty"])) % 100 for row in trades):
        failures.append("native backtest emitted a trade quantity outside 100-share lots")

    limits = evidence.get("price_limit_bands", {})
    for name, expected in (("main_board", 0.10), ("chinext", 0.20), ("star", 0.20), ("beijing", 0.30)):
        if not math.isclose(float(limits.get(name, -1)), expected, abs_tol=1e-12):
            failures.append(f"native price-limit band for {name} did not match {expected:.0%}")
    blocked = evidence.get("price_limit_fill_blocks", {})
    if blocked.get("main_board_limit_up_buy_allowed") is not False:
        failures.append("native engine allowed a main-board limit-up buy")
    if blocked.get("main_board_limit_down_sell_allowed") is not False:
        failures.append("native engine allowed a main-board limit-down sell")

    fees = evidence.get("fees", {})
    if not math.isclose(float(fees.get("buy_1000_shares_at_10", -1)), 5.1, abs_tol=1e-8):
        failures.append("native buy fee did not match the configured minimum plus transfer fee")
    if not math.isclose(float(fees.get("sell_1000_shares_at_10", -1)), 10.1, abs_tol=1e-8):
        failures.append("native sell fee did not include the expected stamp tax")

    missing_bar = evidence.get("missing_bar", {})
    if missing_bar.get("gap_day_loaded") is not False or missing_bar.get("order_rejected_as_no_bar") is not True:
        failures.append("native local loader/engine did not omit and reject the fixed missing-bar date")
    if missing_bar.get("halt_marker_columns_present"):
        failures.append("native local loader exposed an unreviewed suspension-marker column")
    return failures


def _run_baseline(source_root: Path, output: Path, python: Path, timeout: int) -> int:
    source_receipt = _verify_source_receipt(source_root)
    _assert_no_dotenv_ancestors(source_root)
    if not (source_root / "backtest" / "runner.py").is_file():
        raise ValueError(f"native backtest runner not found under {source_root}")
    if not (source_root / "backtest" / "loaders" / "local_loader.py").is_file():
        raise ValueError(f"native local loader not found under {source_root}")
    if not python.is_file():
        raise ValueError(f"Python interpreter does not exist: {python}")

    if not any(_inside(output, root) for root in OUTPUT_ROOTS):
        raise ValueError("--output must stay under .codex_tmp or docs/plans/evidence")
    if _inside(output, source_root) or _inside(source_root, output):
        raise ValueError("--output must be separate from the controlled source tree")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"--output is not empty; choose a new evidence directory: {output}")

    output.mkdir(parents=True, exist_ok=True)
    inputs = output / "inputs"
    shutil.copytree(
        FIXTURE_ROOT,
        inputs,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    runtime_home = output / "native-home"
    run_dir = runtime_home / "runs" / "backtest"
    (run_dir / "code").mkdir(parents=True)
    shutil.copy2(inputs / "signal_engine.py", run_dir / "code" / "signal_engine.py")
    config = json.loads((inputs / "config.json").read_text(encoding="utf-8"))
    if (
        config.get("source") != "local"
        or not config.get("codes")
        or any(not isinstance(code, str) or not code.startswith("local:") for code in config["codes"])
        or config.get("benchmark")
    ):
        raise ValueError("contract fixture must use only local: symbols and no external benchmark")
    (run_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    driver = output / "native_tool_driver.py"
    driver.write_text(
        "import sys\n"
        "from src.tools.backtest_tool import run_backtest\n"
        "print('NATIVE_BACKTEST_RESULT=' + run_backtest(sys.argv[1]))\n",
        encoding="utf-8",
    )

    bridge_config = runtime_home / "data-bridge" / "config.yaml"
    bridge_config.parent.mkdir(parents=True, exist_ok=True)
    bridge_config.write_text(
        _render_local_config(inputs / "bars.csv", inputs / "halt_gap.csv"),
        encoding="utf-8",
    )

    manifest_path = output / "baseline_manifest.json"
    manifest: dict[str, object] = {
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_root": str(source_root),
        "source_receipt": source_receipt,
        "source_sha256": {
            relative: _sha256(source_root / relative)
            for relative in SOURCE_FILES
        },
        "fixture_sha256": {
            path.relative_to(inputs).as_posix(): _sha256(path)
            for path in sorted(inputs.rglob("*"))
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        },
        "native_entry": "src.tools.backtest_tool.run_backtest -> src.core.runner.Runner -> backtest/runner.py",
        "command": [str(python), str(driver), str(run_dir)],
        "run_dir": str(run_dir),
        "runtime_home": str(runtime_home),
        "data_source": "local",
        "market_data_kind": "synthetic fixed contract fixture; not a market-source sample",
    }
    _write_json(manifest_path, manifest)

    command = [str(python), str(driver), str(run_dir)]
    try:
        result = _run(command, source_root=source_root, runtime_home=runtime_home, run_dir=run_dir, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else exc.stdout or ""
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr or ""
        (output / "native-runner.stdout.txt").write_text(stdout, encoding="utf-8")
        (output / "native-runner.stderr.txt").write_text(stderr, encoding="utf-8")
        manifest.update({"status": "failed", "failure": f"native runner timed out after {timeout}s"})
        _write_json(manifest_path, manifest)
        return 1

    (output / "native-runner.stdout.txt").write_text(result.stdout, encoding="utf-8")
    (output / "native-runner.stderr.txt").write_text(result.stderr, encoding="utf-8")
    result_line = next(
        (line.partition("=")[2] for line in result.stdout.splitlines() if line.startswith("NATIVE_BACKTEST_RESULT=")),
        None,
    )
    try:
        native_result = json.loads(result_line) if result_line is not None else None
    except json.JSONDecodeError:
        native_result = None
    if result.returncode or not isinstance(native_result, dict) or native_result.get("status") != "ok" or native_result.get("exit_code") != 0:
        manifest.update(
            {
                "status": "failed",
                "runner_exit_code": result.returncode,
                "native_result": native_result,
            }
        )
        _write_json(manifest_path, manifest)
        return result.returncode or 1

    state_path = run_dir / "state.json"
    if not state_path.is_file() or json.loads(state_path.read_text(encoding="utf-8")).get("status") != "success":
        manifest.update({"status": "failed", "failure": "native run_backtest did not record successful run state"})
        _write_json(manifest_path, manifest)
        return 1

    missing = [relative for relative in RUN_FILES if not (run_dir / relative).is_file()]
    if missing:
        manifest.update({"status": "failed", "failure": "missing native artifacts", "missing_artifacts": missing})
        _write_json(manifest_path, manifest)
        return 1

    card = json.loads((run_dir / "run_card.json").read_text(encoding="utf-8"))
    if card.get("backtest", {}).get("source") != "local" or "local" not in card.get("data_sources", []):
        manifest.update({"status": "failed", "failure": "run card did not confirm local-only source"})
        _write_json(manifest_path, manifest)
        return 1

    trades = _read_trades(run_dir / "artifacts" / "trades.csv")
    fills = [
        json.loads(line)
        for line in (run_dir / "artifacts" / "fills.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    entries = [row for row in trades if row.get("event") == "entry"]
    exits = [row for row in trades if row.get("event") == "exit"]
    if not entries or not exits or not fills or not any(float(fill["fee"]) > 0 for fill in fills):
        manifest.update({"status": "failed", "failure": "native run produced no verifiable round trip and fees"})
        _write_json(manifest_path, manifest)
        return 1

    probe_command = [str(python), str(inputs / "rule_probe.py"), str(run_dir / "config.json")]
    try:
        probe = _run(probe_command, source_root=source_root, runtime_home=runtime_home, run_dir=run_dir, timeout=timeout)
    except subprocess.TimeoutExpired:
        manifest.update({"status": "failed", "failure": f"native rule probe timed out after {timeout}s"})
        _write_json(manifest_path, manifest)
        return 1
    (output / "rule-probe.stdout.txt").write_text(probe.stdout, encoding="utf-8")
    (output / "rule-probe.stderr.txt").write_text(probe.stderr, encoding="utf-8")
    if probe.returncode:
        manifest.update({"status": "failed", "failure": "native rule probe failed", "probe_exit_code": probe.returncode})
        _write_json(manifest_path, manifest)
        return probe.returncode
    try:
        rule_evidence = json.loads(probe.stdout)
    except json.JSONDecodeError as exc:
        manifest.update({"status": "failed", "failure": f"rule probe returned invalid JSON: {exc}"})
        _write_json(manifest_path, manifest)
        return 1

    _write_json(output / "rule-probe.json", rule_evidence)
    rule_failures = _check_rule_evidence(rule_evidence, trades)
    if rule_failures:
        manifest.update({"status": "failed", "rule_failures": rule_failures})
        _write_json(manifest_path, manifest)
        return 1
    (output / "evidence").mkdir(exist_ok=True)
    _write_json(
        output / "evidence" / "trade-summary.json",
        {
            "run_card": "../native-home/runs/backtest/run_card.json",
            "metrics": "../native-home/runs/backtest/artifacts/metrics.csv",
            "trades": trades,
            "fills": fills,
        },
    )
    manifest.update(
        {
            "status": "success",
            "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "artifacts": [str(run_dir / relative) for relative in RUN_FILES],
        "native_result": native_result,
            "trade_rows": len(trades),
            "entry_fills": len(entries),
            "exit_fills": len(exits),
            "fill_fees_total": round(sum(float(fill["fee"]) for fill in fills), 8),
            "rule_evidence": str(output / "rule-probe.json"),
        }
    )
    _write_json(manifest_path, manifest)
    print(f"Native backtest and rule probes passed; evidence: {output}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path, help="controlled Vibe snapshot agent directory")
    parser.add_argument("--output", required=True, type=Path, help="new isolated evidence directory")
    parser.add_argument("--python", type=Path, default=Path(sys.executable), help="interpreter with the locked Vibe dependencies")
    parser.add_argument("--timeout", type=int, default=300, help="per native process timeout in seconds")
    args = parser.parse_args()
    try:
        return _run_baseline(args.source_root.resolve(), args.output.resolve(), args.python.resolve(), args.timeout)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"baseline not run: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
