"""Probe free native Vibe A-share data loaders in isolated subprocesses."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mona.runtime.process_tree import OwnedProcess

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE_ROOT = REPO_ROOT / ".codex_tmp" / "vibe-native-9" / "agent"
DEFAULT_PYTHON = REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe"
DEFAULT_OUTPUT = REPO_ROOT / ".codex_tmp" / "stock-vibe-data-probe"
DAILY_WINDOW = ("2026-09-16", "2026-10-15")
MINUTE_DATE = "2026-10-15"
SYMBOL = "600519.SH"
PROBE_TIMEOUT_SECONDS = 120.0
SHUTDOWN_TIMEOUT_SECONDS = 8.0

OS_ENVIRONMENT_KEYS = {
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "LANG",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
}
PROXY_ENVIRONMENT_KEYS = {
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
}

NATIVE_DRIVER = '''
from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sys
import time

import pandas as pd


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def describe_frame(frame):
    index = pd.DatetimeIndex(frame.index)
    cadence = index.to_series().diff().dropna().dt.total_seconds()
    return {
        "rows": len(frame),
        "fields": [str(column) for column in frame.columns],
        "index_name": frame.index.name,
        "actual_start": index.min().isoformat() if len(index) else None,
        "actual_end": index.max().isoformat() if len(index) else None,
        "median_interval_seconds": float(cadence.median()) if not cadence.empty else None,
        "frame_attrs": {str(key): value for key, value in frame.attrs.items()},
    }


def main():
    source, interval, start_date, end_date, output = sys.argv[1:]
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)
    started_at = utc_now()
    start = time.monotonic()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s", force=True)
    if source == "tencent":
        from backtest.loaders.tencent_loader import DataLoader

        provider = "Tencent Finance"
        endpoint = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
        adjustment_request = "qfq (forward-adjusted); raw companion may be converted when available"
        supported_intervals = ["1D", "d", "day", "daily"]
    elif source == "eastmoney":
        from backtest.loaders import eastmoney_client
        from backtest.loaders.eastmoney_loader import DataLoader

        provider = "Eastmoney"
        endpoint = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        adjustment_request = "fqt=1 (forward-adjusted); fqt=0 raw companion may be converted when available"
        supported_intervals = sorted(eastmoney_client.KLT_BY_INTERVAL)
    else:
        raise ValueError(f"unsupported direct source: {source}")

    loader = DataLoader()
    record = {
        "source": loader.name,
        "provider": provider,
        "endpoint": endpoint,
        "requires_auth": bool(getattr(loader, "requires_auth", True)),
        "symbol": "600519.SH",
        "interval": interval,
        "supported_intervals": supported_intervals,
        "requested_start": start_date,
        "requested_end": end_date,
        "adjustment_request": adjustment_request,
        "volume_unit": getattr(loader, "volume_units", {}).get("a_share"),
        "fetch_started_at_utc": started_at,
    }
    try:
        result = loader.fetch(["600519.SH"], start_date, end_date, interval=interval)
        frame = result.get("600519.SH") if isinstance(result, dict) else None
        record["returned_symbols"] = sorted(result) if isinstance(result, dict) else []
        if frame is None or frame.empty:
            record["status"] = "empty"
            record["rows"] = 0
            record["fields"] = []
        else:
            frame_info = describe_frame(frame)
            record.update(frame_info)
            record["status"] = "success"
            record["adjustment_observed"] = frame.attrs.get("adjustment", "unreported")
            record["csv"] = "bars.csv"
            frame.to_csv(output_dir / "bars.csv", index=True, index_label=frame.index.name or "timestamp")
    except Exception as exc:
        record["status"] = "error"
        record["error"] = {"type": type(exc).__name__, "message": str(exc)}
    record["fetch_finished_at_utc"] = utc_now()
    record["duration_seconds"] = round(time.monotonic() - start, 3)
    (output_dir / "result.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\\n",
        encoding="utf-8",
    )
    print(json.dumps(record, ensure_ascii=False, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_source_root(source_root: Path) -> None:
    temp_root = (REPO_ROOT / ".codex_tmp").resolve()
    if source_root.name != "agent" or source_root.parent.parent.resolve() != temp_root:
        raise ValueError("--source-root must be .codex_tmp/<controlled-build>/agent")
    if not (source_root / "mona-source.json").is_file():
        raise ValueError("controlled Vibe source receipt is missing")
    for relative in (
        "backtest/loaders/tencent_loader.py",
        "backtest/loaders/eastmoney_loader.py",
        "backtest/loaders/eastmoney_client.py",
    ):
        if not (source_root / relative).is_file():
            raise ValueError(f"native loader source is missing: {relative}")


def _isolated_environment(source_root: Path, runtime_home: Path, temp_root: Path) -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in OS_ENVIRONMENT_KEYS or key in PROXY_ENVIRONMENT_KEYS
    }
    environment.update(
        {
            "PYTHONPATH": str(source_root),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "TEMP": str(temp_root),
            "TMP": str(temp_root),
            "VIBE_TRADING_HOME": str(runtime_home),
            "VIBE_TRADING_HOSTED": "1",
            "VIBE_TRADING_DATA_CACHE": "false",
            "VIBE_TRADING_DATA_CACHE_ROOT": str(runtime_home / "cache" / "loaders"),
        }
    )
    return environment


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def _run_one(
    *,
    source_root: Path,
    python: Path,
    output: Path,
    name: str,
    source: str,
    interval: str,
    start_date: str,
    end_date: str,
    timeout: float,
) -> dict[str, Any]:
    probe_dir = output / name
    probe_dir.mkdir(parents=True, exist_ok=True)
    runtime_home = output / "runtime" / name
    temp_root = output / "tmp" / name
    runtime_home.mkdir(parents=True, exist_ok=True)
    temp_root.mkdir(parents=True, exist_ok=True)
    driver = output / "native_data_probe.py"
    driver.write_text(NATIVE_DRIVER, encoding="utf-8")
    command = [str(python), str(driver), source, interval, start_date, end_date, str(probe_dir)]
    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    environment = _isolated_environment(source_root, runtime_home, temp_root)
    result: dict[str, Any] = {
        "name": name,
        "source": source,
        "interval": interval,
        "requested_start": start_date,
        "requested_end": end_date,
        "command": command,
        "environment_keys": sorted(environment),
        "runtime_home": str(runtime_home),
        "process_started_at_utc": started_at,
        "status": "running",
    }
    owned: OwnedProcess | None = None
    stdout = ""
    stderr = ""
    try:
        owned = OwnedProcess(
            command,
            cwd=source_root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            close_timeout=SHUTDOWN_TIMEOUT_SECONDS,
        )
        try:
            stdout, stderr = owned.process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            result["status"] = "timeout"
            result["timeout_seconds"] = timeout
            try:
                owned.close(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except Exception as exc:  # preserve cleanup failure as evidence
                result["cleanup_error"] = {"type": type(exc).__name__, "message": str(exc)}
            try:
                stdout, stderr = owned.process.communicate(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                result["output_drain_error"] = "pipes did not close after owned tree shutdown"
        else:
            result["exit_code"] = owned.process.returncode
            try:
                owned.close(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except Exception as exc:
                result["cleanup_error"] = {"type": type(exc).__name__, "message": str(exc)}
                result["status"] = "cleanup_error"
    except Exception as exc:
        result["status"] = "launch_error"
        result["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        if owned is not None and owned.poll() is None:
            try:
                owned.close(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except Exception as exc:
                result.setdefault(
                    "cleanup_error",
                    {"type": type(exc).__name__, "message": str(exc)},
                )

    (probe_dir / "stdout.txt").write_text(stdout, encoding="utf-8")
    (probe_dir / "stderr.txt").write_text(stderr, encoding="utf-8")
    driver_result_path = probe_dir / "result.json"
    if result.get("status") == "running":
        if driver_result_path.is_file():
            driver_result = json.loads(driver_result_path.read_text(encoding="utf-8"))
            result.update(driver_result)
            result["probe_status"] = driver_result.get("status")
            result["status"] = "completed"
        else:
            result["status"] = "missing_result"
    elif driver_result_path.is_file():
        result["partial_result"] = json.loads(driver_result_path.read_text(encoding="utf-8"))
    result["stdout_file"] = str(probe_dir / "stdout.txt")
    result["stderr_file"] = str(probe_dir / "stderr.txt")
    result["result_file"] = str(driver_result_path) if driver_result_path.is_file() else None
    result["process_finished_at_utc"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True, help="controlled native9 agent source root")
    parser.add_argument("--python", type=Path, required=True, help="locked Vibe Python interpreter")
    parser.add_argument("--output", type=Path, required=True, help="new evidence directory under .codex_tmp")
    parser.add_argument("--timeout", type=float, default=PROBE_TIMEOUT_SECONDS)
    args = parser.parse_args()

    source_root = args.source_root.resolve()
    python = args.python.resolve()
    output = args.output.resolve()
    temp_root = (REPO_ROOT / ".codex_tmp").resolve()
    _validate_source_root(source_root)
    if not python.is_file():
        raise FileNotFoundError(f"Vibe Python interpreter not found: {python}")
    if not _inside(output, temp_root):
        raise ValueError("--output must be inside .codex_tmp")
    if _inside(output, source_root) or _inside(source_root, output):
        raise ValueError("--output must be separate from the source tree")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"output directory is not empty; use a new path: {output}")
    output.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "status": "running",
        "symbol": SYMBOL,
        "daily_window": {"start": DAILY_WINDOW[0], "end": DAILY_WINDOW[1]},
        "minute_window": {"start": MINUTE_DATE, "end": MINUTE_DATE},
        "market_data_kind": "live free-provider request; no authentication supplied",
        "source_root": str(source_root),
        "python": str(python),
        "home_policy": "HOME and USERPROFILE are not inherited; VIBE_TRADING_HOME is private per probe",
        "environment_policy": "OS, proxy, controlled PYTHONPATH, and private VIBE runtime only",
        "probes": [],
    }
    manifest_path = output / "manifest.json"
    _write_json(manifest_path, manifest)

    probes = [
        ("tencent-daily", "tencent", "1D", *DAILY_WINDOW),
        ("eastmoney-daily", "eastmoney", "1D", *DAILY_WINDOW),
        ("eastmoney-1m", "eastmoney", "1m", MINUTE_DATE, MINUTE_DATE),
    ]
    for name, source, interval, start_date, end_date in probes:
        record = _run_one(
            source_root=source_root,
            python=python,
            output=output,
            name=name,
            source=source,
            interval=interval,
            start_date=start_date,
            end_date=end_date,
            timeout=args.timeout,
        )
        manifest["probes"].append(record)
        _write_json(manifest_path, manifest)

    manifest["status"] = "complete"
    manifest["completed_at_utc"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    _write_json(manifest_path, manifest)
    print(f"Data probe evidence saved under {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
