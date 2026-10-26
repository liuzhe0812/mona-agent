"""Run one isolated native Vibe research attempt through Mona's model bridge."""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from mona.api.stock_model_bridge import StockModelBridge
from mona.config.loader import load_config
from mona.config.schema import ModelPresetConfig
from mona.runtime.process_tree import OwnedProcess

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMP_ROOT = (REPO_ROOT / ".codex_tmp").resolve()
DEFAULT_SOURCE_ROOT = TEMP_ROOT / "vibe-native-9" / "agent"
DEFAULT_PYTHON = TEMP_ROOT / "vibe-venv-313" / "Scripts" / "python.exe"
DEFAULT_INPUT = TEMP_ROOT / "stock-vibe-data-probe" / "tencent-daily" / "bars.csv"
DEFAULT_OUTPUT = TEMP_ROOT / "stock-vibe-research-probe" / "native"
MAX_REPLY_TOKENS = 4096
MAX_ITERATIONS = 6
ATTEMPT_TIMEOUT_SECONDS = 600
SHUTDOWN_TIMEOUT_SECONDS = 10

OS_ENVIRONMENT_KEYS = {
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "PATHEXT", "LANG", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
}
PROXY_ENVIRONMENT_KEYS = {
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
}
CSV_FIELDS = ["trade_date", "open", "high", "low", "close", "volume"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_source_root(source_root: Path) -> dict[str, Any]:
    if source_root.name != "agent" or source_root.parent.parent.resolve() != TEMP_ROOT:
        raise ValueError("--source-root must be a controlled .codex_tmp/<build>/agent tree")
    receipt_path = source_root / "mona-source.json"
    if not receipt_path.is_file():
        raise ValueError("controlled native source receipt is missing")
    for relative in ("api_server.py", "src/api/mona_routes.py", "src/tools/read_file_tool.py"):
        if not (source_root / relative).is_file():
            raise ValueError(f"required native source file is missing: {relative}")
    return {
        "receipt": json.loads(receipt_path.read_text(encoding="utf-8")),
        "receipt_sha256": _sha256_file(receipt_path),
    }


def _validate_input(csv_path: Path) -> dict[str, Any]:
    if csv_path != DEFAULT_INPUT.resolve():
        raise ValueError("--input must point to the captured Tencent daily fixture")
    source_record = json.loads(
        (DEFAULT_INPUT.parent / "result.json").read_text(encoding="utf-8")
    )
    if (
        source_record.get("status") != "success"
        or source_record.get("source") != "tencent"
        or source_record.get("symbol") != "600519.SH"
        or source_record.get("rows") != 16
    ):
        raise ValueError("Tencent capture record does not match the expected 16-bar result")
    with csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        if reader.fieldnames != CSV_FIELDS or len(rows) != 16:
            raise ValueError("input CSV does not have the expected 16 daily OHLCV rows")
    dates = [row["trade_date"] for row in rows]
    if dates[0] != "2026-09-16" or dates[-1] != "2026-10-15":
        raise ValueError("input CSV date window differs from the recorded Tencent capture")
    return {
        "provider": source_record["provider"],
        "source": source_record["source"],
        "symbol": source_record["symbol"],
        "interval": source_record["interval"],
        "requested_start": source_record["requested_start"],
        "requested_end": source_record["requested_end"],
        "actual_start": source_record["actual_start"],
        "actual_end": source_record["actual_end"],
        "rows": len(rows),
        "fields": reader.fieldnames,
        "adjustment_request": source_record["adjustment_request"],
        "adjustment_observed": source_record["adjustment_observed"],
        "volume_unit": source_record["volume_unit"],
        "captured_at_utc": source_record["fetch_finished_at_utc"],
        "csv_sha256": _sha256_file(csv_path),
        "csv_text_sha256": _sha256_bytes(csv_path.read_text(encoding="utf-8").encode("utf-8")),
        "csv_bytes": csv_path.stat().st_size,
    }


def _native_environment(
    *,
    source_root: Path,
    runtime_home: Path,
    temp_home: Path,
    api_key: str,
    instance_id: str,
    model: str,
    token: str,
    bridge_url: str,
    max_tokens: int,
) -> dict[str, str]:
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
            "TEMP": str(temp_home),
            "TMP": str(temp_home),
            "VIBE_TRADING_HOME": str(runtime_home),
            "VIBE_TRADING_HOSTED": "1",
            "VIBE_TRADING_API_KEY": api_key,
            "ENABLE_SESSION_RUNTIME": "true",
            "MONA_VIBE_INSTANCE_ID": instance_id,
            "VIBE_TRADING_AGENT_MAX_ITERATIONS": str(MAX_ITERATIONS),
            "VIBE_TRADING_ENABLE_SCHEDULER": "false",
            "VIBE_TRADING_CHANNELS_AUTO_START": "false",
            "VIBE_TRADING_LLM_TIMEOUT_SECONDS": "150",
            "VIBE_TRADING_RUN_STALL_TIMEOUT_SECONDS": "300",
            "LANGCHAIN_PROVIDER": "openai",
            "LANGCHAIN_MODEL_NAME": model,
            "LANGCHAIN_MAX_TOKENS": str(max_tokens),
            "LANGCHAIN_USE_RESPONSES_API": "false",
            "TIMEOUT_SECONDS": "150",
            "MAX_RETRIES": "0",
            "OPENAI_MODEL": model,
            "OPENAI_API_KEY": token,
            "OPENAI_BASE_URL": bridge_url,
        }
    )
    return environment


class Probe:
    def __init__(
        self,
        source_root: Path,
        python: Path,
        csv_path: Path,
        output: Path,
        *,
        continue_manifest: dict[str, Any] | None = None,
        continue_manifest_path: Path | None = None,
    ) -> None:
        self.source_root = source_root
        self.python = python
        self.csv_path = csv_path
        self.output = output
        self.continue_manifest = continue_manifest
        self.continue_manifest_path = continue_manifest_path
        self.runtime_home = (
            Path(str(continue_manifest["runtime_home"])).resolve()
            if continue_manifest is not None
            else output / "runtime"
        )
        self.temp_home = output / "tmp"
        self.manifest: dict[str, Any] = {
            "status": "prepared",
            "created_at_utc": _utc_now(),
            "scope": (
                "one continuation attempt in a previously completed native session"
                if continue_manifest is not None
                else "one native research attempt using a 16-row captured Tencent daily CSV"
            ),
            "output_root": str(output),
            "source_root": str(source_root),
            "python": str(python),
            "runtime_home": str(self.runtime_home),
            "environment_policy": (
                "Child inherits allowlisted OS/proxy variables, including existing HOME and USERPROFILE "
                "unchanged; only VIBE_TRADING_HOME is redirected to the private runtime root."
            ),
            "child_credentials": [
                "temporary Mona model-bridge bearer; value withheld",
                "temporary native API bearer; value withheld",
            ],
            "native_limits": {
                "agent_iterations": MAX_ITERATIONS,
                "max_reply_tokens": None,
                "attempt_timeout_seconds": ATTEMPT_TIMEOUT_SECONDS,
                "schedulers_enabled": False,
                "channels_auto_start": False,
            },
            "requests": [],
            "sse_events_file": "sse_events.jsonl",
            "checks": {},
        }
        self.bridge: StockModelBridge | None = None
        self.bridge_runner: web.AppRunner | None = None
        self.owned: OwnedProcess | None = None
        self.client: aiohttp.ClientSession | None = None
        self.api_key = secrets.token_urlsafe(32)
        self.instance_id = uuid.uuid4().hex
        self.secret_values: list[str] = [self.api_key]
        self.sse_events: list[dict[str, Any]] = []
        self.sse_ready = asyncio.Event()
        self.sse_terminal = asyncio.Event()
        self.sse_task: asyncio.Task | None = None
        self.sse_result: dict[str, Any] = {"state": "not_started"}
        self.session_id: str | None = None
        self.attempt_id: str | None = None
        self.previous_session_id: str | None = None
        self.previous_attempt_id: str | None = None
        self._stdout_log = bytearray()
        self._stderr_log = bytearray()
        self._log_locks = (threading.Lock(), threading.Lock())
        self._log_threads: list[threading.Thread] = []

    def save_manifest(self) -> None:
        _write_json(self.output / "manifest.json", self.manifest)

    def _append_request(self, record: dict[str, Any]) -> None:
        self.manifest["requests"].append(record)
        self.save_manifest()

    def _redact_text(self, value: str) -> str:
        for secret in self.secret_values:
            value = value.replace(secret, "<redacted>")
        return value

    @staticmethod
    def _drain_log(stream: Any, buffer: bytearray, lock: threading.Lock) -> None:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                return
            with lock:
                buffer.extend(chunk)
                if len(buffer) > 64 * 1024:
                    del buffer[:-64 * 1024]

    def _start_log_capture(self) -> None:
        assert self.owned is not None
        for stream, buffer, lock, label in (
            (self.owned.process.stdout, self._stdout_log, self._log_locks[0], "native-stdout"),
            (self.owned.process.stderr, self._stderr_log, self._log_locks[1], "native-stderr"),
        ):
            if stream is None:
                continue
            thread = threading.Thread(
                target=self._drain_log,
                args=(stream, buffer, lock),
                name=label,
                daemon=True,
            )
            thread.start()
            self._log_threads.append(thread)

    def _save_startup_logs(self) -> None:
        if not self._log_threads or self.manifest.get("checks", {}).get("native_identity"):
            return
        for thread in self._log_threads:
            thread.join(timeout=1)
        sections = []
        for label, buffer, lock in (
            ("stdout", self._stdout_log, self._log_locks[0]),
            ("stderr", self._stderr_log, self._log_locks[1]),
        ):
            with lock:
                value = bytes(buffer).decode("utf-8", "replace")
            value = self._redact_text(value)
            safe_lines = []
            for line in value.splitlines():
                if re.search(r"(?i)(authorization|api[_-]?key)\s*[:=]", line):
                    safe_lines.append("[redacted sensitive log line]")
                else:
                    safe_lines.append(line)
            if safe_lines:
                sections.append(f"[{label}]\n" + "\n".join(safe_lines))
        if sections:
            (self.output / "native-startup.log").write_text("\n\n".join(sections) + "\n", encoding="utf-8")

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        label: str,
        json_body: Any = None,
        form: aiohttp.FormData | None = None,
        body_sha256: str | None = None,
        body_bytes: int | None = None,
        timeout: float = 30,
        store_response: bool = True,
    ) -> Any:
        assert self.client is not None
        request_id = uuid.uuid4().hex
        body = (
            json.dumps(json_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if json_body is not None
            else b""
        )
        record: dict[str, Any] = {
            "label": label,
            "request_id": request_id,
            "method": method,
            "path": path,
            "request_sha256": body_sha256 or (_sha256_bytes(body) if body else None),
            "request_bytes": body_bytes if body_bytes is not None else (len(body) if body else None),
            "state": "prepared",
            "sent_at_utc": _utc_now(),
        }
        self._append_request(record)
        headers = {"X-Mona-Request-ID": request_id, "Authorization": f"Bearer {self.api_key}"}
        try:
            async with self.client.request(
                method,
                f"{self.native_url}{path}",
                headers=headers,
                json=json_body,
                data=form,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as response:
                raw = await response.read()
                record["http_status"] = response.status
                record["response_sha256"] = _sha256_bytes(raw)
                record["received_at_utc"] = _utc_now()
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parsed = None
                record["state"] = "responded" if response.status < 400 else "http_error"
                if parsed is not None and store_response:
                    record["response"] = parsed
                elif parsed is None:
                    record["response_excerpt"] = self._redact_text(raw[:500].decode("utf-8", "replace"))
                self.save_manifest()
                if response.status >= 400:
                    raise RuntimeError(f"{label} returned HTTP {response.status}")
                if parsed is None:
                    raise RuntimeError(f"{label} did not return JSON")
                return parsed
        except Exception as exc:
            if record["state"] == "prepared":
                record["state"] = "unknown"
                record["error"] = {"type": type(exc).__name__, "message": self._redact_text(str(exc))}
                self.save_manifest()
            raise

    @property
    def native_url(self) -> str:
        return f"http://127.0.0.1:{self.native_port}"

    async def _start_bridge(self, model: str, max_tokens: int) -> None:
        app = web.Application()
        self.bridge = StockModelBridge.from_config(self.in_memory_config)
        app.router.add_post("/v1/chat/completions", self.bridge.complete)
        self.bridge_runner = web.AppRunner(app, access_log=None)
        await self.bridge_runner.setup()
        self.bridge_port = _free_port()
        site = web.TCPSite(self.bridge_runner, "127.0.0.1", self.bridge_port)
        await site.start()
        self.secret_values.append(self.bridge.token)
        bridge_url = f"http://127.0.0.1:{self.bridge_port}/v1"
        metadata = self.bridge.metadata()
        if metadata.get("model") != model or metadata.get("max_tokens") != max_tokens:
            raise RuntimeError("bridge snapshot differs from the in-memory named preset")
        self.manifest["model_bridge"] = {
            "model": metadata["model"],
            "max_tokens": metadata["max_tokens"],
            "temperature": metadata["temperature"],
            "reasoning_effort": metadata["reasoning_effort"],
            "backend": "openai_compat",
            "endpoint_scope": "POST /v1/chat/completions on loopback only",
        }
        self.manifest["native_limits"]["max_reply_tokens"] = max_tokens
        self.bridge_url = bridge_url
        self.save_manifest()

    async def _wait_native_ready(self) -> None:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.owned is None or self.owned.poll() is not None:
                raise RuntimeError("native server exited before opening its loopback port")
            try:
                with socket.create_connection(("127.0.0.1", self.native_port), timeout=0.25):
                    return
            except OSError:
                await asyncio.sleep(0.25)
        raise TimeoutError("native loopback server did not start within 45 seconds")

    async def _start_sse(self, session_id: str) -> None:
        assert self.client is not None
        request_id = uuid.uuid4().hex
        record = {
            "label": "session_events",
            "request_id": request_id,
            "method": "GET",
            "path": f"/sessions/{session_id}/events?replay=active",
            "state": "prepared",
            "sent_at_utc": _utc_now(),
        }
        self._append_request(record)

        async def consume() -> None:
            event_name = "message"
            data_lines: list[str] = []
            headers = {"X-Mona-Request-ID": request_id, "Authorization": f"Bearer {self.api_key}"}
            try:
                async with self.client.get(
                    f"{self.native_url}/sessions/{session_id}/events?replay=active",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=35),
                ) as response:
                    record["http_status"] = response.status
                    record["state"] = "streaming" if response.status == 200 else "http_error"
                    self.sse_result.update({"state": record["state"], "http_status": response.status})
                    self.sse_ready.set()
                    self.save_manifest()
                    if response.status != 200:
                        return
                    async for raw_line in response.content:
                        line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
                        if line.startswith("event:"):
                            event_name = line[6:].strip()
                        elif line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
                        elif not line:
                            if data_lines:
                                raw_data = "\n".join(data_lines)
                                try:
                                    payload = json.loads(raw_data)
                                except json.JSONDecodeError:
                                    payload = {"raw": raw_data}
                                event = {"type": event_name, "data": payload}
                                self.sse_events.append(event)
                                with (self.output / "sse_events.jsonl").open("a", encoding="utf-8") as sink:
                                    sink.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                                if event_name in {"attempt.completed", "attempt.failed", "attempt.cancelled"}:
                                    self.sse_terminal.set()
                                    break
                            event_name = "message"
                            data_lines = []
            except Exception as exc:
                self.sse_result.update(
                    {"state": "stream_error", "error": {"type": type(exc).__name__, "message": self._redact_text(str(exc))}}
                )
                self.sse_ready.set()
            finally:
                self.sse_result["finished_at_utc"] = _utc_now()
                record["state"] = self.sse_result.get("state", "closed")
                record["received_events"] = len(self.sse_events)
                record["received_at_utc"] = _utc_now()
                self.save_manifest()

        self.sse_task = asyncio.create_task(consume())
        await asyncio.wait_for(self.sse_ready.wait(), timeout=15)
        if self.sse_result.get("http_status") != 200:
            raise RuntimeError("native session event stream did not authenticate")

    async def _collect_attempt(self, session_id: str, attempt_id: str | None) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        assert self.client is not None
        deadline = time.monotonic() + ATTEMPT_TIMEOUT_SECONDS
        session_state: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if self.owned is None or self.owned.poll() is not None:
                raise RuntimeError("native server exited while the research attempt was active")
            try:
                session_state = await self._request_json(
                    "GET", f"/sessions/{session_id}", label="poll_session", timeout=15
                )
                discovered = session_state.get("last_attempt_id")
                if isinstance(discovered, str) and discovered:
                    if self.previous_attempt_id and discovered == self.previous_attempt_id:
                        await asyncio.sleep(1)
                        continue
                    if attempt_id is not None and attempt_id != discovered:
                        raise RuntimeError("session last_attempt_id differs from the sent request response")
                    attempt_id = discovered
                    self.attempt_id = discovered
                    attempt_path = self.runtime_home / "sessions" / session_id / "attempts" / attempt_id / "attempt.json"
                    if attempt_path.is_file():
                        attempt_state = json.loads(attempt_path.read_text(encoding="utf-8"))
                        if attempt_state.get("status") in {"completed", "failed", "cancelled", "interrupted"}:
                            return attempt_state, [session_state]
            except Exception as exc:
                self.manifest.setdefault("poll_errors", []).append(
                    {"type": type(exc).__name__, "message": self._redact_text(str(exc)), "at_utc": _utc_now()}
                )
                self.save_manifest()
            try:
                await asyncio.wait_for(self.sse_terminal.wait(), timeout=4)
            except asyncio.TimeoutError:
                pass
        if attempt_id:
            attempt_path = self.runtime_home / "sessions" / session_id / "attempts" / attempt_id / "attempt.json"
            if attempt_path.is_file():
                return json.loads(attempt_path.read_text(encoding="utf-8")), [session_state] if session_state else []
        return None, [session_state] if session_state else []

    def _native_tool_results(self, attempt_id: str, upload_path: str) -> dict[str, Any]:
        if not self.session_id:
            raise RuntimeError("session_id is required to read the native tool trace")
        trace_root = self.runtime_home / "sessions" / self.session_id
        trace_path = trace_root / "trace.jsonl"
        if not trace_path.is_file():
            raise FileNotFoundError("native session trace is missing")
        all_rows = [
            json.loads(line)
            for line in trace_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        starts = [index for index, row in enumerate(all_rows) if row.get("type") == "start"]
        if not starts:
            raise RuntimeError("native session trace has no attempt start marker")
        rows = all_rows[starts[-1] :]
        calls = [row for row in rows if row.get("type") == "tool_call"]
        results = {row.get("call_id"): row for row in rows if row.get("type") == "tool_result"}
        recorded: list[dict[str, Any]] = []
        market_result: dict[str, Any] | None = None
        file_result: dict[str, Any] | None = None
        source_rows = list(csv.DictReader(self.csv_path.open(encoding="utf-8", newline="")))
        source_by_date = {row["trade_date"]: row for row in source_rows}
        text_hash = self.manifest["input_data"]["csv_text_sha256"]

        for call in calls:
            tool_name = str(call.get("tool") or "")
            if tool_name not in {"get_market_data", "read_file"}:
                recorded.append({"tool": tool_name, "call_id": call.get("call_id"), "arguments": call.get("args")})
                continue
            result = results.get(call.get("call_id"))
            if result is None:
                continue
            raw = result.get("result")
            result_path = result.get("result_path")
            if isinstance(result_path, str):
                sidecar = (trace_root / result_path).resolve()
                if not _inside(sidecar, trace_root.resolve()):
                    raise RuntimeError("native tool-result sidecar escaped the session directory")
                raw = sidecar.read_text(encoding="utf-8")
            parsed = json.loads(raw) if isinstance(raw, str) else None
            number = len([item for item in recorded if item.get("tool") in {"get_market_data", "read_file"}]) + 1
            result_file = f"native_tool_result_{number}_{tool_name}.txt"
            result_hash = None
            result_bytes = None
            if isinstance(raw, str):
                encoded = raw.encode("utf-8")
                (self.output / result_file).write_bytes(encoded)
                result_hash = _sha256_bytes(encoded)
                result_bytes = len(encoded)
            item: dict[str, Any] = {
                "tool": tool_name,
                "call_id": call.get("call_id"),
                "arguments": call.get("args"),
                "status": result.get("status"),
                "result_file": result_file if result_hash else None,
                "result_sha256": result_hash,
                "result_bytes": result_bytes,
            }
            if tool_name == "get_market_data" and isinstance(parsed, dict):
                provenance = parsed.get("_provenance", {})
                symbol_provenance = provenance.get("600519.SH", {}) if isinstance(provenance, dict) else {}
                rows_value = parsed.get("600519.SH", [])
                data_rows = rows_value.get("data", []) if isinstance(rows_value, dict) else rows_value
                matches: list[bool] = []
                if isinstance(data_rows, list):
                    for data_row in data_rows:
                        if not isinstance(data_row, dict):
                            continue
                        trade_date = str(data_row.get("trade_date") or data_row.get("timestamp") or "")[:10]
                        expected = source_by_date.get(trade_date)
                        if expected is None:
                            matches.append(False)
                            continue
                        matches.append(all(
                            key in data_row
                            and abs(float(data_row[key]) - float(expected[key])) <= 1e-6
                            for key in ("open", "high", "low", "close", "volume")
                        ))
                item["actual_source"] = symbol_provenance.get("source") if isinstance(symbol_provenance, dict) else None
                item["provenance"] = symbol_provenance
                item["rows"] = len(data_rows) if isinstance(data_rows, list) else 0
                item["actual_start"] = min((str(row.get("trade_date") or row.get("timestamp") or "")[:10] for row in data_rows if isinstance(row, dict)), default=None) if isinstance(data_rows, list) else None
                item["actual_end"] = max((str(row.get("trade_date") or row.get("timestamp") or "")[:10] for row in data_rows if isinstance(row, dict)), default=None) if isinstance(data_rows, list) else None
                item["all_rows_match_captured_csv"] = len(data_rows) == len(source_rows) and len(matches) == len(source_rows) and all(matches) if isinstance(data_rows, list) else False
                item["csv_text_sha256"] = text_hash
                market_result = item
            elif tool_name == "read_file" and isinstance(parsed, dict):
                content = parsed.get("content")
                content_hash = _sha256_bytes(content.encode("utf-8")) if isinstance(content, str) else None
                item["resolved_path"] = parsed.get("path")
                item["content_sha256"] = content_hash
                item["content_matches_uploaded_csv"] = content_hash == text_hash
                item["requested_upload_path"] = upload_path
                file_result = item if item.get("status") == "ok" and parsed.get("status") == "ok" else file_result
            recorded.append(item)

        return {
            "trace_path": str(trace_path),
            "attempt_id": attempt_id,
            "tool_order": [call.get("tool") for call in calls],
            "results": recorded,
            "market_data": market_result,
            "read_file": file_result,
            "requested_upload_path": upload_path,
        }

    async def _prepare_session(self, data_info: dict[str, Any]) -> tuple[str, str]:
        if self.continue_manifest is None:
            form = aiohttp.FormData()
            form.add_field(
                "file",
                self.csv_path.read_bytes(),
                filename=self.csv_path.name,
                content_type="text/csv",
            )
            uploaded = await self._request_json(
                "POST",
                "/upload",
                label="upload_tencent_daily_csv",
                form=form,
                body_sha256=data_info["csv_sha256"],
                body_bytes=data_info["csv_bytes"],
            )
            upload_path = uploaded.get("file_path")
            if uploaded.get("status") != "ok" or not isinstance(upload_path, str) or not upload_path.startswith("uploads/"):
                raise RuntimeError("native upload did not return an uploads-relative CSV path")
            self.manifest["upload"] = {
                "response": uploaded,
                "file_sha256": data_info["csv_sha256"],
                "native_relative_path": upload_path,
            }
            created = await self._request_json(
                "POST", "/sessions", label="create_session", json_body={"title": "600519.SH 16日线样本研究"}
            )
            session_id = created.get("session_id")
            if not isinstance(session_id, str) or not session_id:
                raise RuntimeError("native session creation returned no session_id")
            self.session_id = session_id
            self.manifest["session"] = {"session_id": session_id, "create_response": created}
            _write_json(self.output / "session_create_response.json", created)
            self.save_manifest()
            return session_id, upload_path

        previous = self.continue_manifest
        session_id = str(previous["session"]["create_response"]["session_id"])
        previous_attempt_id = str(previous["session"]["attempt_id"])
        expected_csv_hash = str(previous["input_data"]["csv_sha256"])
        if expected_csv_hash != data_info["csv_sha256"]:
            raise ValueError("--input differs from the completed session's original CSV")
        previous_attempt_path = (
            self.runtime_home / "sessions" / session_id / "attempts" / previous_attempt_id / "attempt.json"
        )
        if not previous_attempt_path.is_file():
            raise FileNotFoundError("completed continuation attempt record is missing")
        previous_attempt = json.loads(previous_attempt_path.read_text(encoding="utf-8"))
        if previous_attempt.get("status") != "completed":
            raise RuntimeError("continuation requires the previous attempt to be completed")

        current_session = await self._request_json(
            "GET", f"/sessions/{session_id}", label="verify_previous_session", timeout=15
        )
        messages = await self._request_json(
            "GET", f"/sessions/{session_id}/messages", label="verify_previous_messages", timeout=20,
            store_response=False,
        )
        previous_assistant = next(
            (
                message for message in reversed(messages)
                if message.get("role") == "assistant" and message.get("linked_attempt_id") == previous_attempt_id
            ),
            None,
        )
        if current_session.get("last_attempt_id") != previous_attempt_id:
            raise RuntimeError("session advanced since the completed attempt; refusing to append a new request")
        if previous_assistant is None or previous_assistant.get("metadata", {}).get("status") != "completed":
            raise RuntimeError("previous completed assistant message is missing")

        prior_upload = previous.get("upload", {})
        upload_path = prior_upload.get("native_relative_path")
        if not isinstance(upload_path, str) or not upload_path.startswith("uploads/") or ".." in Path(upload_path).parts:
            raise ValueError("previous manifest has an invalid upload path")
        uploaded_file = (self.runtime_home / Path(upload_path)).resolve()
        if not _inside(uploaded_file, (self.runtime_home / "uploads").resolve()) or not uploaded_file.is_file():
            raise FileNotFoundError("previously uploaded CSV is missing from the private runtime")
        if _sha256_file(uploaded_file) != expected_csv_hash:
            raise RuntimeError("previous uploaded CSV hash differs from the original source file")

        self.session_id = session_id
        self.previous_session_id = session_id
        self.previous_attempt_id = previous_attempt_id
        self.manifest["continuation"] = {
            "previous_manifest": str(self.continue_manifest_path),
            "previous_attempt_id": previous_attempt_id,
            "previous_attempt_status": previous_attempt.get("status"),
            "previous_assistant_message_id": previous_assistant.get("message_id"),
            "previous_final_report_sha256": previous.get("session", {}).get("persisted_assistant", {}).get("final_report_sha256"),
            "session_state_before_new_message": current_session,
            "new_message_sent_once": None,
            "new_message_send_count": 0,
            "new_message_send_state": "not_sent",
            "prior_attempt_preserved": True,
        }
        self.manifest["session"] = {"session_id": session_id}
        self.manifest["upload"] = {
            "reused_from_previous_attempt": True,
            "native_relative_path": upload_path,
            "file_sha256": expected_csv_hash,
            "no_new_upload_request": True,
        }
        _write_json(
            self.output / "continuation_preflight.json",
            {
                "session_state": current_session,
                "previous_attempt": previous_attempt,
                "previous_assistant": {
                    "message_id": previous_assistant.get("message_id"),
                    "linked_attempt_id": previous_assistant.get("linked_attempt_id"),
                    "metadata": previous_assistant.get("metadata"),
                    "content_sha256": _sha256_bytes(str(previous_assistant.get("content") or "").encode("utf-8")),
                },
                "upload_path": upload_path,
                "upload_sha256": _sha256_file(uploaded_file),
            },
        )
        self.save_manifest()
        return session_id, upload_path

    def _save_grounding_evidence(self, attempt_state: dict[str, Any]) -> dict[str, Any] | None:
        run_value = attempt_state.get("run_dir")
        if not isinstance(run_value, str) or not run_value:
            return None
        run_dir = Path(run_value).resolve()
        if not _inside(run_dir, self.runtime_home.resolve()):
            raise RuntimeError("native attempt run directory escaped the private VIBE_TRADING_HOME")
        evidence_path = run_dir / "artifacts" / "grounding_evidence.json"
        if not evidence_path.is_file():
            return None
        raw = evidence_path.read_bytes()
        destination = self.output / "grounding_evidence.json"
        destination.write_bytes(raw)
        evidence = json.loads(raw.decode("utf-8"))
        validations = evidence.get("validations", [])
        latest = validations[-1] if validations else None
        summary = {
            "source_file": str(evidence_path),
            "evidence_file": destination.name,
            "sha256": _sha256_bytes(raw),
            "evidence_count": len(evidence.get("evidence", [])),
            "analysis_evidence_count": len(evidence.get("analysis_evidence", [])),
            "tool_failures": evidence.get("tool_failures", []),
            "validation_count": len(validations),
            "last_validation_valid": latest.get("valid") if isinstance(latest, dict) else None,
            "last_validation_issue_count": len(latest.get("issues", [])) if isinstance(latest, dict) else None,
        }
        return summary

    async def execute(self) -> int:
        self.output.mkdir(parents=True, exist_ok=True)
        self.save_manifest()
        native_result = 1
        try:
            source_info = _validate_source_root(self.source_root)
            if not self.python.is_file():
                raise FileNotFoundError(f"Vibe interpreter not found: {self.python}")
            data_info = _validate_input(self.csv_path)
            self.manifest["source"] = {
                "receipt": source_info["receipt"],
                "receipt_sha256": source_info["receipt_sha256"],
            }
            self.manifest["input_data"] = data_info
            self.manifest["input_data"]["kind"] = "prior real free-provider capture; not a synthetic backtest fixture"
            self.manifest["input_data"]["adjustment_limit"] = (
                "Tencent requested qfq, but the captured frame did not report an observed adjustment attribute."
            )
            self.runtime_home.mkdir(parents=True, exist_ok=True)
            self.temp_home.mkdir(parents=True, exist_ok=True)

            config = load_config()
            default = config.resolve_default_preset()
            if default.model != "qwen3.7-plus" or default.provider != "aliyun-bailian-coding":
                raise RuntimeError("Mona default model/provider differs from the approved research boundary")
            max_tokens = min(default.max_tokens, MAX_REPLY_TOKENS)
            preset_name = "stock_vibe_research_probe"
            config.model_presets[preset_name] = ModelPresetConfig(
                model=default.model,
                provider=default.provider,
                max_tokens=max_tokens,
                temperature=default.temperature,
                reasoning_effort=default.reasoning_effort,
            )
            config.stock_vibe.model_preset = preset_name
            self.in_memory_config = config
            self.manifest["model_selection"] = {
                "model": default.model,
                "provider": default.provider,
                "preset_name": preset_name,
                "preset_location": "in-memory only; no user config was saved",
            }
            await self._start_bridge(default.model, max_tokens)

            self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
            self.native_port = _free_port()
            self.manifest["native_server"] = {
                "bind": "127.0.0.1",
                "port": self.native_port,
                "entrypoint": "api_server.py",
                "popen_pid": None,
                "instance_id": self.instance_id,
                "data_root_sha256": _sha256_bytes(str(self.runtime_home.resolve()).encode("utf-8")),
            }
            environment = _native_environment(
                source_root=self.source_root,
                runtime_home=self.runtime_home,
                temp_home=self.temp_home,
                api_key=self.api_key,
                instance_id=self.instance_id,
                model=default.model,
                token=self.bridge.token,
                bridge_url=self.bridge_url,
                max_tokens=max_tokens,
            )
            self.owned = OwnedProcess(
                [str(self.python), str(self.source_root / "api_server.py"), "--host", "127.0.0.1", "--port", str(self.native_port)],
                cwd=self.runtime_home,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_timeout=SHUTDOWN_TIMEOUT_SECONDS,
            )
            self._start_log_capture()
            self.manifest["native_server"]["popen_pid"] = self.owned.pid
            self.manifest["native_server"]["environment_policy"] = (
                "Allowlisted OS/proxy values, including HOME and USERPROFILE, pass through unchanged; "
                "VIBE_TRADING_HOME is the private runtime root and credential values are withheld."
            )
            self.save_manifest()
            await self._wait_native_ready()

            identity = await self._request_json("GET", "/mona/identity", label="native_identity")
            expected_root_hash = _sha256_bytes(str(self.runtime_home.resolve()).encode("utf-8"))
            identity_pid = int(identity.get("pid", 0))
            identity_checks = {
                "service": identity.get("service") == "mona-stock-vibe",
                "protocol": identity.get("protocol") == 1,
                "instance_id": identity.get("instance_id") == self.instance_id,
                "data_root_sha256": identity.get("data_root_sha256") == expected_root_hash,
                "source_receipt": identity.get("source") == source_info["receipt"],
                "actual_server_pid_in_owned_job": self.owned.owns_pid(identity_pid),
            }
            self.manifest["native_server"]["identity"] = identity
            self.manifest["checks"]["native_identity"] = identity_checks
            self.save_manifest()
            if not all(identity_checks.values()):
                raise RuntimeError("native source, instance, data-root, or OwnedProcess handshake failed")

            self.session_id, upload_path = await self._prepare_session(data_info)
            read_path = f"../{upload_path}"
            if self.continue_manifest is not None:
                prompt = (
                    "这是上一轮已完成后的新追问。上一轮回答被安全门拒绝；请保留旧结果，基于本条消息重新完成一次研究。\n\n"
                    "第一步必须调用 get_market_data，参数必须严格为："
                    '{"codes":["600519.SH"],"start_date":"2026-09-16","end_date":"2026-10-15",'
                    '"source":"tencent","interval":"1D","max_rows":0}。'
                    "只认返回值 `_provenance` 中 600519.SH 的实际 `source`；请求参数本身不能证明来源。"
                    "如果实际 source 不是 tencent、没有完整16行或数据失败，明确说明不足，不要用其他源兜底。\n\n"
                    f"随后必须调用 read_file，path 参数为 `{read_path}`，读取之前已上传的 CSV 并与行情工具返回值核对；"
                    "该 CSV 仅作比对附件。若两者不一致，指出字段和日期差异，不要混用。\n\n"
                    "只根据本次 get_market_data 成功取得且实际来源为 Tencent 的 OHLCV 数字作结论。"
                    "引用原始价格/成交量时注明日期与字段；任何衍生数值都必须紧邻写出可复核公式，否则不要报该数值。"
                    "不要调用其他工具、来源、行情、账户、交易、个性化仓位、财报、PIT 或概率预测；不提供交易建议。\n\n"
                    "用中文按以下结构回答：克制的判断、至少两项带日期和字段的证据、证据边界、"
                    "会确认或推翻观察的后续条件、下一步需要的数据。明确说明16根日线不足以代表未来表现。"
                )
            else:
                prompt = (
                    f"请先调用 read_file，path 参数必须为 {read_path}，完整读取这份 CSV；在该调用成功前不要调用任何其他工具。\n\n"
                    "这份文件是 600519.SH（贵州茅台）2026-09-16 至 2026-10-15 的 16 根日线 OHLCV。"
                    "后续分析只能使用文件中的这 16 行，不得查询其他来源、行情、账户、交易、个性化仓位、"
                    "财报、PIT 数据或预测概率；不得推测 CSV 未提供的事实。\n\n"
                    "读完后用中文给出一份简短研究记录，包含：明确但克制的判断；至少两项带日期和数值的样本证据；"
                    "证据的局限；哪些后续观测会确认或推翻当前观察；下一步需要补充的数据。"
                    "明确说明 16 根日线不足以构成交易建议，也不能代表未来表现。"
                )
            (self.output / "research_request.md").write_text(prompt + "\n", encoding="utf-8")
            await self._start_sse(self.session_id)
            message_body = {"content": prompt}
            if self.continue_manifest is not None:
                self.manifest["continuation"]["new_message_send_count"] = 1
                self.manifest["continuation"]["new_message_send_state"] = "prepared"
                self.save_manifest()
            try:
                submitted = await self._request_json(
                    "POST",
                    f"/sessions/{self.session_id}/messages",
                    label="submit_one_research_message",
                    json_body=message_body,
                    timeout=20,
                )
                self.attempt_id = submitted.get("attempt_id") if isinstance(submitted.get("attempt_id"), str) else None
                self.manifest["session"]["message_response"] = submitted
                if self.attempt_id:
                    self.manifest["session"]["attempt_id"] = self.attempt_id
                if self.continue_manifest is not None:
                    self.manifest["continuation"]["new_message_send_state"] = "responded"
                    self.manifest["continuation"]["new_message_request_id"] = self.manifest["requests"][-1]["request_id"]
                    self.manifest["continuation"]["new_message_sent_once"] = True
                _write_json(self.output / "message_submit_response.json", submitted)
            except Exception as exc:
                # The POST is never repeated. Its result may be unknown; inspect the
                # session state and event stream using read-only requests only.
                self.manifest["session"]["message_response"] = {
                    "state": "unknown",
                    "error": {"type": type(exc).__name__, "message": self._redact_text(str(exc))},
                    "resubmitted": False,
                }
                if self.continue_manifest is not None:
                    self.manifest["continuation"]["new_message_send_state"] = "unknown"
                    self.manifest["continuation"]["new_message_request_id"] = self.manifest["requests"][-1]["request_id"]
            self.save_manifest()

            attempt_state, states = await self._collect_attempt(self.session_id, self.attempt_id)
            if attempt_state is None:
                self.manifest["session"]["final_state"] = "unknown"
                self.manifest["session"]["last_polled_session"] = states[-1] if states else None
                self.save_manifest()
                return 2
            self.attempt_id = attempt_state.get("attempt_id")
            self.manifest["session"]["attempt_id"] = self.attempt_id
            self.manifest["session"]["attempt_status"] = attempt_state.get("status")
            self.manifest["session"]["attempt_state"] = attempt_state
            _write_json(self.output / "attempt_state.json", attempt_state)
            self.save_manifest()

            messages = await self._request_json(
                "GET",
                f"/sessions/{self.session_id}/messages",
                label="load_persisted_messages",
                timeout=30,
                store_response=False,
            )
            _write_json(self.output / "session_messages.json", messages)
            assistant = next(
                (
                    message
                    for message in reversed(messages)
                    if message.get("role") == "assistant"
                    and message.get("linked_attempt_id") == self.attempt_id
                ),
                None,
            )
            if assistant is None:
                raise RuntimeError("completed native attempt has no persisted assistant message")
            _write_json(self.output / "tool_trail.json", assistant.get("tool_trail", []))
            final_report = str(assistant.get("content") or "")
            (self.output / "final-report.md").write_text(final_report.rstrip() + "\n", encoding="utf-8")
            trail = assistant.get("tool_trail", [])
            first_tool = next((item for item in trail if isinstance(item, dict) and item.get("tool")), None)
            native_tool_results = self._native_tool_results(self.attempt_id, upload_path)
            _write_json(self.output / "native_tool_results.json", native_tool_results)
            grounding_summary = self._save_grounding_evidence(attempt_state)
            tool_order = native_tool_results.get("tool_order", [])
            sse_tool_order = [
                event.get("data", {}).get("tool")
                for event in self.sse_events
                if event.get("type") == "tool_call" and isinstance(event.get("data"), dict)
            ]
            if self.continue_manifest is not None:
                market_data = native_tool_results.get("market_data") or {}
                file_result = native_tool_results.get("read_file") or {}
                validations = (json.loads((self.output / "grounding_evidence.json").read_text(encoding="utf-8")).get("validations", [])
                               if (self.output / "grounding_evidence.json").is_file() else [])
                latest_validation = validations[-1] if validations else {}
                final_report_accepted = (
                    attempt_state.get("status") == "completed"
                    and latest_validation.get("valid") is True
                    and not final_report.lstrip().startswith("我的回答被安全门槛拒绝")
                )
                tool_checks = {
                    "first_persisted_tool_is_get_market_data": isinstance(first_tool, dict) and first_tool.get("tool") == "get_market_data",
                    "native_tool_order_is_market_data_then_read_file": tool_order[:2] == ["get_market_data", "read_file"],
                    "native_tool_order_contains_only_requested_tools": bool(tool_order) and set(tool_order) <= {"get_market_data", "read_file"},
                    "actual_provider_is_tencent": market_data.get("actual_source") == "tencent",
                    "market_data_rows_match_csv": market_data.get("all_rows_match_captured_csv") is True,
                    "read_file_result_matches_uploaded_csv": file_result.get("content_matches_uploaded_csv") is True,
                    "grounding_evidence_contains_prices": bool(grounding_summary and grounding_summary.get("evidence_count", 0) > 0),
                    "final_grounding_validation_valid": bool(grounding_summary and grounding_summary.get("last_validation_valid") is True),
                    "terminal_research_answer_accepted": final_report_accepted,
                    "first_sse_tool_call_is_get_market_data": bool(sse_tool_order and sse_tool_order[0] == "get_market_data"),
                }
            else:
                successful_read_file = any(
                    isinstance(item, dict) and item.get("tool") == "read_file" and item.get("status") == "ok"
                    for item in trail
                )
                tool_checks = {
                    "persisted_assistant_status": assistant.get("metadata", {}).get("status") == "completed",
                    "first_persisted_tool_is_read_file": isinstance(first_tool, dict) and first_tool.get("tool") == "read_file",
                    "successful_read_file_persisted": successful_read_file,
                    "raw_native_read_file_result_verified": bool(native_tool_results.get("read_file", {}).get("content_matches_uploaded_csv")),
                    "first_sse_tool_call_is_read_file": bool(sse_tool_order and sse_tool_order[0] == "read_file"),
                    "grounding_evidence_has_no_blocking_refusal": bool(grounding_summary and grounding_summary.get("last_validation_valid") is True),
                }
            self.manifest["session"]["persisted_assistant"] = {
                "message_id": assistant.get("message_id"),
                "linked_attempt_id": assistant.get("linked_attempt_id"),
                "metadata": assistant.get("metadata"),
                "final_report_file": "final-report.md",
                "final_report_sha256": _sha256_file(self.output / "final-report.md"),
                "final_report_bytes": (self.output / "final-report.md").stat().st_size,
            }
            self.manifest["session"]["tool_trail_file"] = "tool_trail.json"
            self.manifest["session"]["native_tool_results_file"] = "native_tool_results.json"
            self.manifest["session"]["tool_order"] = tool_order
            self.manifest["session"]["grounding_evidence"] = grounding_summary
            self.manifest["checks"]["research_result"] = {
                "attempt_completed": attempt_state.get("status") == "completed",
                **tool_checks,
            }
            self.manifest["sse"] = self.sse_result
            self.manifest["sse"]["event_types"] = [event.get("type") for event in self.sse_events]
            self.manifest["completed_at_utc"] = _utc_now()
            passed = (
                attempt_state.get("status") == "completed"
                and all(identity_checks.values())
                and all(tool_checks.values())
                and any(event.get("type") == "attempt.completed" for event in self.sse_events)
            )
            self.manifest["status"] = "passed" if passed else "failed_acceptance"
            native_result = 0 if passed else 1
            return native_result
        except Exception as exc:
            self.manifest["status"] = "failed"
            self.manifest["failure"] = {
                "type": type(exc).__name__,
                "message": self._redact_text(str(exc)),
                "at_utc": _utc_now(),
            }
            return native_result
        finally:
            await self.close()
            self.manifest["native_cleanup"] = {
                "owned_process_closed": self.owned is None
                or (self.owned.poll() is not None and "native_cleanup_error" not in self.manifest)
            }
            self.manifest["model_bridge_active_requests_at_cleanup"] = self.bridge.active if self.bridge else None
            if self.manifest.get("status") in {"prepared", "running"}:
                self.manifest["status"] = "incomplete"
            self.manifest["finished_at_utc"] = _utc_now()
            self.save_manifest()

    async def close(self) -> None:
        if self.sse_task is not None and not self.sse_task.done():
            self.sse_task.cancel()
            await asyncio.gather(self.sse_task, return_exceptions=True)
        if self.owned is not None:
            try:
                self.owned.close(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except Exception as exc:
                self.manifest["native_cleanup_error"] = {
                    "type": type(exc).__name__,
                    "message": self._redact_text(str(exc)),
                }
        self._save_startup_logs()
        if self.client is not None:
            await self.client.close()
        if self.bridge_runner is not None:
            await self.bridge_runner.cleanup()
        if self.bridge is not None:
            await self.bridge.snapshot.provider.aclose()


async def _run(args: argparse.Namespace) -> int:
    source_root = args.source_root.resolve()
    python = args.python.resolve()
    csv_path = args.input.resolve()
    output = args.output.resolve()
    if not _inside(output, TEMP_ROOT):
        raise ValueError("--output must be inside .codex_tmp")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"output directory is not empty; choose a new path: {output}")
    if _inside(output, source_root) or _inside(source_root, output):
        raise ValueError("--output must be separate from the native source tree")
    if not _inside(csv_path, TEMP_ROOT) or _inside(output, csv_path) or _inside(csv_path, output):
        raise ValueError("--input must be a separate captured file under .codex_tmp")
    previous_manifest = None
    previous_manifest_path = None
    if args.continue_from is not None:
        previous_path = args.continue_from.resolve()
        previous_manifest_path = previous_path / "manifest.json" if previous_path.is_dir() else previous_path
        if not _inside(previous_manifest_path, TEMP_ROOT) or not previous_manifest_path.is_file():
            raise ValueError("--continue-from must point to a prior manifest inside .codex_tmp")
        previous_manifest = json.loads(previous_manifest_path.read_text(encoding="utf-8"))
        previous_root = Path(str(previous_manifest.get("output_root", ""))).resolve()
        previous_runtime = Path(str(previous_manifest.get("runtime_home", ""))).resolve()
        if previous_manifest.get("status") != "failed_acceptance":
            raise ValueError("--continue-from requires a preserved failed_acceptance result")
        if previous_manifest.get("session", {}).get("attempt_status") != "completed":
            raise ValueError("--continue-from requires a completed previous native attempt")
        if previous_manifest.get("native_cleanup", {}).get("owned_process_closed") is not True:
            raise ValueError("--continue-from requires the previous native process tree to be closed")
        if source_root != Path(str(previous_manifest.get("source_root", ""))).resolve():
            raise ValueError("--source-root must match the previous native build")
        if python != Path(str(previous_manifest.get("python", ""))).resolve():
            raise ValueError("--python must match the previous Vibe interpreter")
        if previous_runtime != (previous_root / "runtime").resolve():
            raise ValueError("previous manifest runtime root is outside its evidence directory")
        if _inside(output, previous_root) or _inside(previous_root, output):
            raise ValueError("continuation output must be separate from the preserved previous result")
    probe = Probe(
        source_root,
        python,
        csv_path,
        output,
        continue_manifest=previous_manifest,
        continue_manifest_path=previous_manifest_path,
    )
    return await probe.execute()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--continue-from",
        type=Path,
        help="continue one completed native session from a failed_acceptance manifest",
    )
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(args))
    except Exception as exc:
        print(f"Research probe setup failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(f"Research probe status: {result}; evidence: {args.output.resolve() / 'manifest.json'}")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
