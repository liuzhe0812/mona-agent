"""Run one bounded native Swarm A-share evidence probe through StockModelBridge."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
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
DEFAULT_SOURCE_ROOT = TEMP_ROOT / "t05-swarm-source-generic" / "agent"
DEFAULT_PYTHON = (
    TEMP_ROOT
    / "stock-vibe-runtime-verify-preflight"
    / "python"
    / "stock-vibe-envs"
    / "6fdf4452ae7d59b2ea6e41d352410619"
    / "Scripts"
    / "python.exe"
)
DEFAULT_OUTPUT = TEMP_ROOT / "stock-vibe-swarm-probe" / "native-generic"
PRESET_NAME = "mona_ashare_research"
MODEL_PRESET_NAME = "stock_vibe_swarm_probe"
MODEL_NAME = "qwen3.7-plus"
MODEL_PROVIDER = "aliyun-bailian-coding"
MAX_REPLY_TOKENS = 4096
MAX_AGENT_ITERATIONS = 6
MAX_REVIEW_ITERATIONS = 2
MAX_MODEL_CALLS = MAX_AGENT_ITERATIONS + MAX_REVIEW_ITERATIONS
RUN_TIMEOUT_SECONDS = 720
SHUTDOWN_TIMEOUT_SECONDS = 12
DEFAULT_SYMBOL = "600519.SH"
DEFAULT_START_DATE = "2026-09-16"
DEFAULT_END_DATE = "2026-10-15"
EVIDENCE_TOOL_PATH = "evidence.md"
EVIDENCE_RUN_PATH = "artifacts/tencent_research/task_tencent_data/evidence.md"
REPORT_RUN_PATH = "artifacts/tencent_research/task_tencent_data/report.md"
OS_ENVIRONMENT_KEYS = {
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PATHEXT",
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
ALLOWED_TOOLS = {"get_market_data", "write_file", "read_file"}
_A_SHARE_SYMBOL_RE = re.compile(r"^\d{6}\.(?:SH|SZ)$")
_NUMBER_RE = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?![\w.])")


class ProbeError(RuntimeError):
    """Raised when a source, runtime, or evidence contract fails."""


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


def _validate_user_vars(symbol: str, start_date: str, end_date: str) -> dict[str, str]:
    if not _A_SHARE_SYMBOL_RE.fullmatch(symbol):
        raise ProbeError("--symbol must be a six-digit A-share code ending in .SH or .SZ")
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except ValueError as exc:
        raise ProbeError("--start-date and --end-date must be valid YYYY-MM-DD dates") from exc
    if start.isoformat() != start_date or end.isoformat() != end_date or start > end:
        raise ProbeError("--date range must be canonical YYYY-MM-DD with start <= end")
    return {"symbol": symbol, "start_date": start_date, "end_date": end_date}


def _report_numbers(text: str) -> set[Decimal]:
    values: set[Decimal] = set()
    for match in _NUMBER_RE.findall(text):
        try:
            values.add(Decimal(match.replace(",", "")))
        except InvalidOperation:
            continue
    return values


def _row_numbers(row: dict[str, Any]) -> set[Decimal]:
    values: set[Decimal] = set()
    for key in ("open", "high", "low", "close", "volume"):
        value = row.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            continue
        try:
            values.add(Decimal(str(value)))
        except InvalidOperation:
            continue
    return values


def _decimal_value(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _file_inventory(root: Path) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ProbeError(f"native run contains a symlink: {path.relative_to(root)}")
        if path.is_file():
            inventory.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "bytes": path.stat().st_size,
                    "sha256": _sha256_file(path),
                }
            )
    return inventory


def _validate_source_root(source_root: Path) -> dict[str, Any]:
    if source_root.name != "agent" or source_root.parent.parent.resolve() != TEMP_ROOT:
        raise ProbeError("--source-root must be a controlled .codex_tmp/<build>/agent tree")
    receipt_path = source_root / "mona-source.json"
    preset_path = source_root / "src" / "swarm" / "presets" / f"{PRESET_NAME}.yaml"
    if not receipt_path.is_file() or not preset_path.is_file():
        raise ProbeError("controlled source receipt or Mona A-share preset is missing")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    patch_path = REPO_ROOT / "third_party" / "vibe-trading" / "patches" / "0007-ashare-preset.json"
    patch_hash = _sha256_file(patch_path)
    applied = {item.get("path"): item.get("sha256") for item in receipt.get("patches", [])}
    if applied.get("0007-ashare-preset.json") != patch_hash:
        raise ProbeError("prepared source does not contain the current 0007 preset patch")
    for relative in ("api_server.py", "src/api/mona_routes.py", "src/swarm/runtime.py"):
        if not (source_root / relative).is_file():
            raise ProbeError(f"required native source file is missing: {relative}")
    return {
        "receipt": receipt,
        "receipt_sha256": _sha256_file(receipt_path),
        "preset_sha256": _sha256_file(preset_path),
        "patch_0007_sha256": patch_hash,
    }


def _filtered_environment() -> dict[str, str]:
    return {
        key: value
        for key, value in os.environ.items()
        if key in OS_ENVIRONMENT_KEYS or key in PROXY_ENVIRONMENT_KEYS
    }


def _native_environment(
    *,
    source_root: Path,
    runtime_home: Path,
    temp_home: Path,
    app_data: Path,
    cache_home: Path,
    native_api_key: str,
    instance_id: str,
    model: str,
    bridge_token: str,
    bridge_url: str,
) -> dict[str, str]:
    environment = _filtered_environment()
    for path in (temp_home, app_data, cache_home, cache_home / "config", cache_home / "matplotlib"):
        path.mkdir(parents=True, exist_ok=True)
    no_proxy = environment.get("NO_PROXY", environment.get("no_proxy", ""))
    loopback_no_proxy = ",".join(filter(None, (no_proxy, "127.0.0.1", "localhost", "::1")))
    environment.update(
        {
            "PYTHONPATH": str(source_root),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "TEMP": str(temp_home),
            "TMP": str(temp_home),
            "APPDATA": str(app_data),
            "LOCALAPPDATA": str(app_data),
            "XDG_CACHE_HOME": str(cache_home),
            "XDG_CONFIG_HOME": str(cache_home / "config"),
            "MPLCONFIGDIR": str(cache_home / "matplotlib"),
            "NO_PROXY": loopback_no_proxy,
            "no_proxy": loopback_no_proxy,
            "VIBE_TRADING_HOME": str(runtime_home),
            "VIBE_TRADING_ALLOWED_FILE_ROOTS": str(runtime_home / "swarm" / "runs"),
            "VIBE_TRADING_HOSTED": "1",
            "HOSTED": "1",
            "VIBE_TRADING_API_KEY": native_api_key,
            "ENABLE_SESSION_RUNTIME": "false",
            "MONA_VIBE_INSTANCE_ID": instance_id,
            "VIBE_TRADING_AGENT_MAX_ITERATIONS": str(MAX_AGENT_ITERATIONS),
            "SWARM_WORKER_MAX_ITER": str(MAX_AGENT_ITERATIONS),
            "SWARM_WORKER_TIMEOUT": "240",
            "SWARM_TIMEOUT": "600",
            "VIBE_TRADING_ENABLE_SCHEDULER": "false",
            "VIBE_TRADING_CHANNELS_AUTO_START": "false",
            "VIBE_TRADING_LLM_TIMEOUT_SECONDS": "150",
            "VIBE_TRADING_RUN_STALL_TIMEOUT_SECONDS": "360",
            "LANGCHAIN_PROVIDER": "openai",
            "LANGCHAIN_MODEL_NAME": model,
            "LANGCHAIN_MAX_TOKENS": str(MAX_REPLY_TOKENS),
            "LANGCHAIN_USE_RESPONSES_API": "false",
            "LANGCHAIN_TRACING_V2": "false",
            "TIMEOUT_SECONDS": "150",
            "MAX_RETRIES": "0",
            "OPENAI_MAX_RETRIES": "0",
            "OPENAI_MODEL": model,
            "OPENAI_API_KEY": bridge_token,
            "OPENAI_BASE_URL": bridge_url,
        }
    )
    if any(key in environment for key in ("DASHSCOPE_API_KEY", "BAILIAN_API_KEY", "ALIYUN_API_KEY")):
        raise ProbeError("native child environment unexpectedly contains a provider credential")
    return environment


class SwarmProbe:
    def __init__(
        self,
        source_root: Path,
        python: Path,
        output: Path,
        *,
        symbol: str,
        start_date: str,
        end_date: str,
    ) -> None:
        self.source_root = source_root
        self.python = python
        self.output = output
        self.user_vars = _validate_user_vars(symbol, start_date, end_date)
        self.runtime_home = output / "runtime"
        self.temp_home = output / "tmp"
        self.app_data = output / "appdata"
        self.cache_home = output / "cache"
        self.manifest: dict[str, Any] = {
            "schema_version": 1,
            "status": "prepared",
            "created_at_utc": _utc_now(),
            "scope": "one native two-node A-share Tencent evidence run; no model-loop replacement",
            "user_vars": self.user_vars,
            "output_root": str(output.relative_to(REPO_ROOT)),
            "runtime_home": str(self.runtime_home.relative_to(REPO_ROOT)),
            "environment_policy": (
                "Child gets allowlisted OS/proxy values with HOME and USERPROFILE unchanged; "
                "VIBE_TRADING_HOME and temporary/app/cache roots point inside this output. "
                "Hosted read access adds only this private instance's Swarm run root for parent-artifact review."
            ),
            "credential_policy": {
                "provider_key": "used only inside the parent-process StockModelBridge snapshot; value never serialized",
                "child_values": [
                    "random per-run native API bearer; value withheld",
                    "random per-run StockModelBridge bearer; value withheld",
                ],
                "provider_key_copied_to_child": False,
            },
            "limits": {
                "model": MODEL_NAME,
                "provider": MODEL_PROVIDER,
                "max_reply_tokens": MAX_REPLY_TOKENS,
                "max_agent_iterations": MAX_AGENT_ITERATIONS,
                "max_review_iterations": MAX_REVIEW_ITERATIONS,
                "max_model_calls": MAX_MODEL_CALLS,
                "max_retries_per_agent": 0,
                "agent_count": 2,
                "task_layers": 2,
                "max_concurrent_workers_by_dag": 1,
                "run_timeout_seconds": RUN_TIMEOUT_SECONDS,
                "scheduler_enabled": False,
                "channels_auto_start": False,
            },
            "native_requests": [],
            "bridge_calls": [],
            "sse_events_file": "sse_events.jsonl",
            "checks": {},
        }
        self.native_api_key = secrets.token_urlsafe(32)
        self.instance_id = uuid.uuid4().hex
        self.run_request_id = uuid.uuid4().hex
        self.secret_values = [self.native_api_key]
        self.bridge: StockModelBridge | None = None
        self.bridge_runner: web.AppRunner | None = None
        self.bridge_token: str | None = None
        self.bridge_url: str | None = None
        self.bridge_port: int | None = None
        self.native_port: int | None = None
        self.client: aiohttp.ClientSession | None = None
        self.owned: OwnedProcess | None = None
        self.source_info: dict[str, Any] = {}
        self._stdout = bytearray()
        self._stderr = bytearray()
        self._log_locks = (threading.Lock(), threading.Lock())
        self._log_threads: list[threading.Thread] = []

    def save_manifest(self) -> None:
        _write_json(self.output / "manifest.json", self.manifest)

    def _redact(self, text: str) -> str:
        for secret in self.secret_values:
            text = text.replace(secret, "<redacted>")
        return text

    @staticmethod
    def _drain_log(stream: Any, buffer: bytearray, lock: threading.Lock) -> None:
        while chunk := stream.read(4096):
            with lock:
                buffer.extend(chunk)
                if len(buffer) > 64 * 1024:
                    del buffer[:-64 * 1024]

    def _start_log_capture(self) -> None:
        assert self.owned is not None
        for stream, buffer, lock in (
            (self.owned.process.stdout, self._stdout, self._log_locks[0]),
            (self.owned.process.stderr, self._stderr, self._log_locks[1]),
        ):
            if stream is None:
                continue
            thread = threading.Thread(
                target=self._drain_log,
                args=(stream, buffer, lock),
                daemon=True,
            )
            thread.start()
            self._log_threads.append(thread)

    def _save_logs(self) -> None:
        sections = []
        for label, buffer, lock in (
            ("stdout", self._stdout, self._log_locks[0]),
            ("stderr", self._stderr, self._log_locks[1]),
        ):
            with lock:
                text = bytes(buffer).decode("utf-8", "replace")
            text = self._redact(text)
            safe_lines = [
                "[redacted sensitive log line]"
                if "authorization" in line.lower() or "api_key" in line.lower() or "api-key" in line.lower()
                else line
                for line in text.splitlines()
            ]
            if safe_lines:
                sections.append(f"[{label}]\n" + "\n".join(safe_lines))
        if sections:
            (self.output / "native-startup.log").write_text(
                "\n\n".join(sections) + "\n", encoding="utf-8"
            )

    async def _inspect_preset(self) -> dict[str, Any]:
        sentinel_vars = {
            "symbol": "600000.SH",
            "start_date": "2026-01-05",
            "end_date": "2026-01-30",
        }
        code = "\n".join(
            (
                "import json",
                "import os",
                "from pathlib import Path",
                "from src.swarm.presets import build_run_from_preset, inspect_preset, load_preset",
                "from src.swarm.worker import build_worker_prompt",
                "name='mona_ashare_research'",
                "preset=load_preset(name)",
                "def render(values):",
                "    run=build_run_from_preset(name,values)",
                "    return {task.id: task.prompt_template.format_map(values) for task in run.tasks}",
                f"sentinel_vars={json.dumps(sentinel_vars)}",
                f"sample_vars={json.dumps(self.user_vars)}",
                "native_run=build_run_from_preset(name,sample_vars)",
                "review_agent=next(agent for agent in native_run.agents if agent.id=='evidence_reviewer')",
                "source_summary=r'EVIDENCE_PATH=C:\\\\swarm\\\\runs\\\\fixture\\\\artifacts\\\\tencent_research\\\\task_tencent_data\\\\evidence.md'",
                "worker_prompt=build_worker_prompt(review_agent,{'upstream_evidence':source_summary},'')",
                "upstream_injection={'summary':source_summary,'summary_present':source_summary in worker_prompt,'section_present':'## Upstream Context (from previous agents)' in worker_prompt,'unresolved_marker':'{upstream_context}' in worker_prompt}",
                "text=(Path(os.environ['PYTHONPATH'])/'src/swarm/presets/mona_ashare_research.yaml').read_text(encoding='utf-8')",
                "print(json.dumps({'inspection':inspect_preset(name),'agents':preset.get('agents',[]),",
                "'tasks':preset.get('tasks',[]),'source_text':text,'rendered_sentinel':render(sentinel_vars),",
                "'rendered_sample':render(sample_vars),'upstream_injection':upstream_injection},ensure_ascii=False))",
            )
        )
        environment = _filtered_environment()
        environment.update(
            {
                "PYTHONPATH": str(self.source_root),
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONNOUSERSITE": "1",
                "VIBE_TRADING_HOME": str(self.runtime_home),
            }
        )
        result = await asyncio.to_thread(
            subprocess.run,
            [str(self.python), "-c", code],
            cwd=self.runtime_home,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            raise ProbeError("native preset inspection failed: " + self._redact(result.stderr[-1000:]))
        try:
            payload = json.loads(result.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as exc:
            raise ProbeError("native preset inspection returned invalid JSON") from exc
        inspection = payload["inspection"]
        agents = payload["agents"]
        tasks = payload["tasks"]
        source_text = payload["source_text"]
        rendered_sentinel = payload["rendered_sentinel"]
        rendered_sample = payload["rendered_sample"]
        upstream_injection = payload["upstream_injection"]
        if not inspection.get("valid") or inspection.get("errors"):
            raise ProbeError(f"native preset validation failed: {inspection.get('errors')}")
        if inspection.get("warnings"):
            raise ProbeError(f"native preset inspection returned warnings: {inspection.get('warnings')}")
        if len(agents) != 2 or len(tasks) != 2:
            raise ProbeError("preset must contain exactly two native agents and two tasks")
        if any(agent.get("model_name") for agent in agents):
            raise ProbeError("preset must inherit the in-memory model binding without model overrides")
        if any(agent.get("max_iterations", MAX_AGENT_ITERATIONS + 1) > MAX_AGENT_ITERATIONS for agent in agents):
            raise ProbeError("preset agent iteration cap exceeds the approved limit")
        review_agent = next((item for item in agents if item.get("id") == "evidence_reviewer"), {})
        if review_agent.get("max_iterations", MAX_REVIEW_ITERATIONS + 1) > MAX_REVIEW_ITERATIONS:
            raise ProbeError("evidence reviewer iteration cap exceeds the one-read bounded limit")
        if any(agent.get("max_retries", 2) != 0 for agent in agents):
            raise ProbeError("preset must not retry failed agents")
        if any(set(agent.get("tools", [])) - ALLOWED_TOOLS for agent in agents):
            raise ProbeError("preset contains a tool outside the native research/artifact allowlist")
        if inspection.get("layers") != [
            [{"task_id": "task_tencent_data", "agent_id": "tencent_research"}],
            [{"task_id": "task_evidence_review", "agent_id": "evidence_reviewer"}],
        ]:
            raise ProbeError("preset tasks are not a strict two-layer dependency chain")
        if tasks[1].get("depends_on") != [tasks[0].get("id")]:
            raise ProbeError("evidence review task is missing its source-task dependency")
        if tasks[1].get("input_from") != {"upstream_evidence": tasks[0].get("id")}:
            raise ProbeError("evidence review task is not wired to the source-node output")
        forbidden_literals = ("600519.SH", "2026-09-16", "2026-10-15")
        if any(value in source_text for value in forbidden_literals):
            raise ProbeError("generic preset still contains the previous fixed symbol/date window")
        sentinel_prompt = rendered_sentinel.get("task_tencent_data", "")
        sample_prompt = rendered_sample.get("task_tencent_data", "")
        if not all(value in sentinel_prompt for value in sentinel_vars.values()):
            raise ProbeError("native prompt rendering did not substitute all sentinel variables")
        if any(value in sentinel_prompt for value in forbidden_literals):
            raise ProbeError("sentinel rendering retained the previous fixed symbol/date window")
        if not all(value in sample_prompt for value in self.user_vars.values()):
            raise ProbeError("native prompt rendering did not substitute the frozen sample variables")
        if (
            not upstream_injection.get("summary_present")
            or not upstream_injection.get("section_present")
            or upstream_injection.get("unresolved_marker")
            or "EVIDENCE_PATH=" not in upstream_injection.get("summary", "")
        ):
            raise ProbeError("native worker prompt did not inject upstream summary and evidence path")
        if '"source":"tencent"' not in sentinel_prompt:
            raise ProbeError("native prompt rendering changed the fixed Tencent source")
        summary = {
            "name": inspection.get("name"),
            "valid": inspection.get("valid"),
            "warnings": inspection.get("warnings"),
            "layers": inspection.get("layers"),
            "agents": [
                {
                    "id": agent.get("id"),
                    "tools": agent.get("tools", []),
                    "model_override": agent.get("model_name"),
                    "max_iterations": agent.get("max_iterations"),
                    "max_retries": agent.get("max_retries"),
                }
                for agent in agents
            ],
            "tasks": inspection.get("tasks"),
            "render_validation": {
                "sentinel_symbol": sentinel_vars["symbol"],
                "sentinel_dates": [sentinel_vars["start_date"], sentinel_vars["end_date"]],
                "sample_user_vars": self.user_vars,
                "fixed_sample_literals_absent_from_preset": True,
                "source_fixed_to_tencent": True,
            },
            "native_worker_upstream_injection": {
                "summary_path_present": "EVIDENCE_PATH=" in upstream_injection["summary"],
                "upstream_context_section_rendered": upstream_injection["section_present"],
                "summary_present_verbatim": upstream_injection["summary_present"],
                "unresolved_marker_absent": not upstream_injection["unresolved_marker"],
            },
        }
        _write_json(self.output / "preset_inspection.json", summary)
        return summary

    async def _start_bridge(self, config: Any) -> None:
        default = config.resolve_default_preset()
        if default.model != MODEL_NAME or default.provider != MODEL_PROVIDER:
            raise ProbeError("Mona's configured default model/provider differs from the authorized boundary")
        max_tokens = min(int(default.max_tokens), MAX_REPLY_TOKENS)
        if max_tokens != MAX_REPLY_TOKENS:
            raise ProbeError("the selected provider preset does not permit the 4096-token cap")
        config.model_presets[MODEL_PRESET_NAME] = ModelPresetConfig(
            model=default.model,
            provider=default.provider,
            max_tokens=max_tokens,
            temperature=default.temperature,
            reasoning_effort=default.reasoning_effort,
        )
        config.stock_vibe.model_preset = MODEL_PRESET_NAME
        self.bridge = StockModelBridge.from_config(config)
        self.bridge_token = self.bridge.token
        self.secret_values.append(self.bridge_token)
        metadata = self.bridge.metadata()
        if metadata.get("model") != MODEL_NAME or metadata.get("max_tokens") != MAX_REPLY_TOKENS:
            raise ProbeError("StockModelBridge snapshot differs from the approved in-memory preset")

        self.manifest["model_selection"] = {
            "model": default.model,
            "provider": default.provider,
            "preset_name": MODEL_PRESET_NAME,
            "preset_location": "in-memory only; Mona config was not saved",
        }
        self.manifest["model_bridge"] = {
            **metadata,
            "backend": "openai_compat",
            "endpoint_scope": "POST /v1/chat/completions on loopback only",
            "provider_key_location": "parent process provider snapshot only; value withheld",
            "child_api_key": "per-run StockModelBridge token; value withheld",
        }
        self.bridge_port = _free_port()

        async def bridge_handler(request: web.Request) -> web.StreamResponse:
            started = time.monotonic()
            raw = await request.read()
            try:
                body = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                body = {}
            requested_limit = body.get("max_tokens", body.get("max_completion_tokens"))
            record: dict[str, Any] = {
                "call_index": len(self.manifest["bridge_calls"]) + 1,
                "method": request.method,
                "path": request.path,
                "request_sha256": _sha256_bytes(raw),
                "request_bytes": len(raw),
                "model": body.get("model"),
                "requested_max_tokens": requested_limit,
                "effective_max_tokens": min(requested_limit, MAX_REPLY_TOKENS)
                if isinstance(requested_limit, int) and not isinstance(requested_limit, bool)
                else MAX_REPLY_TOKENS,
                "message_count": len(body.get("messages", [])) if isinstance(body.get("messages"), list) else None,
                "tool_count": len(body.get("tools", [])) if isinstance(body.get("tools"), list) else 0,
                "stream": body.get("stream", False),
                "started_at_utc": _utc_now(),
            }
            try:
                response = await self.bridge.complete(request)
            except web.HTTPException as exc:
                record.update(status=exc.status, error_type=type(exc).__name__)
                self.manifest["bridge_calls"].append(record)
                _write_json(self.output / "model_calls.json", self.manifest["bridge_calls"])
                self.save_manifest()
                raise
            except Exception as exc:
                record.update(status=502, error_type=type(exc).__name__)
                self.manifest["bridge_calls"].append(record)
                _write_json(self.output / "model_calls.json", self.manifest["bridge_calls"])
                self.save_manifest()
                raise
            response_body = getattr(response, "body", None)
            if isinstance(response_body, bytes):
                record["response_sha256"] = _sha256_bytes(response_body)
                try:
                    parsed = json.loads(response_body)
                except (ValueError, UnicodeDecodeError):
                    parsed = None
                if isinstance(parsed, dict):
                    record["usage"] = parsed.get("usage")
                    choices = parsed.get("choices")
                    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                        record["finish_reason"] = choices[0].get("finish_reason")
            record.update(
                status=response.status,
                elapsed_ms=int((time.monotonic() - started) * 1000),
                completed_at_utc=_utc_now(),
            )
            self.manifest["bridge_calls"].append(record)
            _write_json(self.output / "model_calls.json", self.manifest["bridge_calls"])
            self.save_manifest()
            return response

        app = web.Application()
        app.router.add_post("/v1/chat/completions", bridge_handler)
        self.bridge_runner = web.AppRunner(app, access_log=None)
        await self.bridge_runner.setup()
        await web.TCPSite(self.bridge_runner, "127.0.0.1", self.bridge_port).start()
        self.bridge_url = f"http://127.0.0.1:{self.bridge_port}/v1"
        self.manifest["model_bridge"].update({"bind": "127.0.0.1", "port": self.bridge_port})
        self.save_manifest()

    async def _wait_native_ready(self) -> None:
        assert self.owned is not None and self.native_port is not None
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.owned.poll() is not None:
                raise ProbeError("native API exited before opening its loopback port")
            try:
                with socket.create_connection(("127.0.0.1", self.native_port), timeout=0.25):
                    return
            except OSError:
                await asyncio.sleep(0.25)
        raise TimeoutError("native loopback server did not start within 45 seconds")

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        label: str,
        json_body: Any = None,
        request_id: str | None = None,
        timeout: float = 30,
        store_response: bool = True,
    ) -> Any:
        assert self.client is not None and self.native_port is not None
        body = (
            json.dumps(json_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if json_body is not None
            else b""
        )
        record: dict[str, Any] = {
            "label": label,
            "method": method,
            "path": path,
            "request_id": request_id,
            "request_sha256": _sha256_bytes(body) if body else None,
            "request_bytes": len(body) if body else None,
            "state": "prepared",
            "sent_at_utc": _utc_now(),
        }
        self.manifest["native_requests"].append(record)
        self.save_manifest()
        headers = {"Authorization": f"Bearer {self.native_api_key}"}
        if request_id is not None:
            headers["X-Mona-Request-ID"] = request_id
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        try:
            async with self.client.request(
                method,
                f"http://127.0.0.1:{self.native_port}{path}",
                headers=headers,
                data=body if json_body is not None else None,
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
                    record["response_excerpt"] = self._redact(raw[:500].decode("utf-8", "replace"))
                self.save_manifest()
                if response.status >= 400:
                    raise ProbeError(f"{label} returned HTTP {response.status}")
                if parsed is None:
                    raise ProbeError(f"{label} did not return JSON")
                return parsed
        except Exception as exc:
            if record["state"] == "prepared":
                record["state"] = "unknown"
                record["error"] = {
                    "type": type(exc).__name__,
                    "message": self._redact(str(exc)) if isinstance(exc, ProbeError) else "details withheld",
                }
                self.save_manifest()
            raise

    async def _start_native_server(self) -> None:
        assert self.bridge_token is not None and self.bridge_url is not None
        self.native_port = _free_port()
        environment = _native_environment(
            source_root=self.source_root,
            runtime_home=self.runtime_home,
            temp_home=self.temp_home,
            app_data=self.app_data,
            cache_home=self.cache_home,
            native_api_key=self.native_api_key,
            instance_id=self.instance_id,
            model=MODEL_NAME,
            bridge_token=self.bridge_token,
            bridge_url=self.bridge_url,
        )
        self.manifest["native_server"] = {
            "bind": "127.0.0.1",
            "port": self.native_port,
            "entrypoint": "agent/api_server.py",
            "instance_id": self.instance_id,
            "data_root_sha256": _sha256_bytes(str(self.runtime_home.resolve()).encode("utf-8")),
            "child_api_key_source": "random native API key; value withheld",
            "child_openai_api_key_source": "StockModelBridge token; value withheld",
            "provider_key_copied_to_child": False,
            "extra_read_root": "runtime/swarm/runs",
        }
        self.save_manifest()
        self.owned = OwnedProcess(
            [
                str(self.python),
                str(self.source_root / "api_server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                str(self.native_port),
            ],
            cwd=self.runtime_home,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_timeout=SHUTDOWN_TIMEOUT_SECONDS,
        )
        self._start_log_capture()
        self.manifest["native_server"]["popen_pid"] = self.owned.pid
        self.save_manifest()
        await self._wait_native_ready()
        identity = await self._request_json("GET", "/mona/identity", label="native_identity")
        expected_root_hash = _sha256_bytes(str(self.runtime_home.resolve()).encode("utf-8"))
        checks = {
            "service": identity.get("service") == "mona-stock-vibe",
            "protocol": identity.get("protocol") == 1,
            "instance_id": identity.get("instance_id") == self.instance_id,
            "data_root_sha256": identity.get("data_root_sha256") == expected_root_hash,
            "source_receipt": identity.get("source") == self.source_info["receipt"],
            "owned_process_pid": self.owned.owns_pid(int(identity.get("pid", 0))),
        }
        self.manifest["native_server"]["identity"] = identity
        self.manifest["checks"]["native_identity"] = checks
        self.save_manifest()
        if not all(checks.values()):
            raise ProbeError("native source, instance, data root, or OwnedProcess handshake failed")

    async def _capture_sse(self, run_id: str) -> dict[str, Any]:
        assert self.client is not None and self.native_port is not None
        headers = {"Authorization": f"Bearer {self.native_api_key}"}
        timeout = aiohttp.ClientTimeout(total=RUN_TIMEOUT_SECONDS, sock_read=RUN_TIMEOUT_SECONDS)
        output = self.output / "sse_events.jsonl"
        event_count = 0
        done: dict[str, Any] | None = None
        async with self.client.get(
            f"http://127.0.0.1:{self.native_port}/swarm/runs/{run_id}/events",
            headers=headers,
            timeout=timeout,
        ) as response:
            if response.status != 200:
                raise ProbeError(f"swarm SSE returned HTTP {response.status}")
            self.manifest["sse"] = {"status": response.status, "connected_at_utc": _utc_now()}
            self.save_manifest()
            current_id: str | None = None
            current_type = "message"
            data_lines: list[str] = []
            with output.open("w", encoding="utf-8") as handle:
                async for raw_line in response.content:
                    line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
                    if not line:
                        if data_lines:
                            data = "\n".join(data_lines)
                            try:
                                payload = json.loads(data)
                            except json.JSONDecodeError:
                                payload = data
                            event = {
                                "id": current_id,
                                "event": current_type,
                                "data": payload,
                                "received_at_utc": _utc_now(),
                            }
                            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
                            handle.flush()
                            event_count += 1
                            if current_type == "done":
                                done = payload if isinstance(payload, dict) else {"status": str(payload)}
                                break
                        current_id = None
                        current_type = "message"
                        data_lines = []
                    elif line.startswith("id:"):
                        current_id = line[3:].strip()
                    elif line.startswith("event:"):
                        current_type = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                    if event_count > 10000:
                        raise ProbeError("Swarm SSE exceeded the bounded 10,000-event allowance")
        if done is None:
            raise ProbeError("Swarm SSE closed without a terminal done event")
        result = {"event_count": event_count, "terminal": done}
        self.manifest["sse"].update(result)
        self.save_manifest()
        return result

    async def _run_and_verify(self) -> None:
        assert self.client is not None and self.native_port is not None
        presets = await self._request_json("GET", "/swarm/presets", label="swarm_presets")
        available = any(
            item.get("name") == PRESET_NAME for item in presets if isinstance(item, dict)
        )
        if not available:
            raise ProbeError("native API does not expose the bundled Mona A-share preset")

        request_body = {"preset_name": PRESET_NAME, "user_vars": self.user_vars}
        self.manifest["swarm_enqueue"] = {
            "request_id": self.run_request_id,
            "request_count": 1,
            "state": "prepared",
        }
        self.save_manifest()
        created = await self._request_json(
            "POST",
            "/swarm/runs",
            label="create_swarm_run_once",
            json_body=request_body,
            request_id=self.run_request_id,
            timeout=20,
        )
        run_id = created.get("id")
        if not isinstance(run_id, str) or not run_id:
            raise ProbeError("native Swarm enqueue response did not contain a run id")
        self.manifest["swarm_enqueue"].update(
            {"state": "enqueued", "response": created, "run_id": run_id}
        )
        self.save_manifest()

        initial = await self._request_json(
            "GET", f"/swarm/runs/{run_id}", label="swarm_run_after_enqueue", timeout=20
        )
        self.manifest["swarm_enqueue"]["initial_run_status"] = initial.get("status")
        self.save_manifest()
        sse = await self._capture_sse(run_id)

        deadline = time.monotonic() + 30
        final_run: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            final_run = await self._request_json(
                "GET", f"/swarm/runs/{run_id}", label="swarm_final_run", timeout=20
            )
            if final_run.get("status") in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.5)
        if final_run is None:
            raise ProbeError("native Swarm run status was not readable after SSE completion")
        self.manifest["swarm_final"] = {
            "run_status": final_run.get("status"),
            "task_statuses": [
                {"id": task.get("id"), "agent_id": task.get("agent_id"), "status": task.get("status")}
                for task in final_run.get("tasks", [])
                if isinstance(task, dict)
            ],
            "final_report_sha256": _sha256_bytes(
                str(final_run.get("final_report") or "").encode("utf-8")
            ),
            "sse_terminal": sse["terminal"],
        }
        _write_json(self.output / "final_run.json", final_run)
        self._save_run_snapshot(run_id, final_run)
        if final_run.get("status") != "completed":
            raise ProbeError(f"native Swarm finished with status {final_run.get('status')!r}")
        if not self.manifest["bridge_calls"] or len(self.manifest["bridge_calls"]) > MAX_MODEL_CALLS:
            raise ProbeError("native Swarm model-call count was empty or exceeded the bounded iteration budget")
        if any(
            call.get("status") != 200
            or call.get("model") != MODEL_NAME
            or call.get("effective_max_tokens", MAX_REPLY_TOKENS + 1) > MAX_REPLY_TOKENS
            for call in self.manifest["bridge_calls"]
        ):
            raise ProbeError("one or more StockModelBridge calls violated the model/token contract")
        self._verify_tool_evidence(run_id)

        activity = await self._request_json("GET", "/mona/activity", label="activity_after_run")
        self.manifest["checks"]["activity_after_run"] = activity
        if activity.get("swarm_active") != 0 or activity.get("active") is not False:
            raise ProbeError("Swarm activity projection did not return to idle after completion")

    def _save_run_snapshot(self, run_id: str, final_run: dict[str, Any]) -> None:
        run_dir = (self.runtime_home / "swarm" / "runs" / run_id).resolve(strict=True)
        if not _inside(run_dir, self.runtime_home.resolve()):
            raise ProbeError("native Swarm run directory escaped the private runtime root")
        inventory = _file_inventory(run_dir)
        target = self.output / "native_run_snapshot"
        if target.exists():
            raise ProbeError("native run snapshot destination already exists")
        shutil.copytree(run_dir, target)
        self.manifest["native_run"] = {
            "run_id": run_id,
            "runtime_relative_path": str(run_dir.relative_to(self.runtime_home)),
            "run_status": final_run.get("status"),
            "task_statuses": [
                {"id": task.get("id"), "agent_id": task.get("agent_id"), "status": task.get("status")}
                for task in final_run.get("tasks", [])
                if isinstance(task, dict)
            ],
            "file_count": len(inventory),
            "bytes": sum(item["bytes"] for item in inventory),
            "files": inventory,
            "snapshot_directory": "native_run_snapshot",
        }
        self.save_manifest()

    @staticmethod
    def _messages_tool_calls(path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            raise ProbeError(f"native Swarm message artifact is missing: {path.name}")
        messages = json.loads(path.read_text(encoding="utf-8"))
        calls: list[dict[str, Any]] = []
        result_by_id: dict[str, str] = {}
        unnamed_results: list[tuple[str, str]] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            if message.get("role") == "assistant":
                for call in message.get("tool_calls", []) or []:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function") if isinstance(call.get("function"), dict) else {}
                    arguments: Any = function.get(
                        "arguments", call.get("arguments", call.get("args", {}))
                    )
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except json.JSONDecodeError:
                            arguments = {"unparsed": arguments}
                    calls.append(
                        {
                            "call_id": call.get("id", call.get("tool_call_id")),
                            "tool": function.get("name", call.get("name")),
                            "arguments": arguments if isinstance(arguments, dict) else {},
                            "result": None,
                        }
                    )
            elif message.get("role") in {"tool", "function"}:
                content = message.get("content")
                if isinstance(content, list):
                    content = "".join(
                        str(part.get("text", "")) for part in content if isinstance(part, dict)
                    )
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False, default=str)
                call_id = message.get("tool_call_id")
                name = message.get("name") or ""
                if call_id:
                    result_by_id[str(call_id)] = content
                else:
                    unnamed_results.append((str(name), content))
        fallback_index = 0
        for call in calls:
            call_id = str(call.get("call_id") or "")
            if call_id in result_by_id:
                call["result"] = result_by_id[call_id]
                continue
            for index in range(fallback_index, len(unnamed_results)):
                name, content = unnamed_results[index]
                if name == call.get("tool"):
                    call["result"] = content
                    fallback_index = index + 1
                    break
        return calls

    def _verify_tool_evidence(self, run_id: str) -> None:
        run_dir = self.runtime_home / "swarm" / "runs" / run_id
        tasks = {}
        for path in (run_dir / "tasks").glob("task-*.json"):
            task = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(task, dict) and isinstance(task.get("id"), str):
                tasks[task["id"]] = task
        source_task = tasks.get("task_tencent_data")
        review_task = tasks.get("task_evidence_review")
        if source_task is None or review_task is None:
            raise ProbeError("native run is missing one of the two preset task records")
        if source_task.get("status") != "completed" or review_task.get("status") != "completed":
            raise ProbeError("both native Swarm task nodes must complete before evidence validation")
        if review_task.get("depends_on") != ["task_tencent_data"]:
            raise ProbeError("persisted review task lost its parent dependency identity")
        if review_task.get("input_from") != {"upstream_evidence": "task_tencent_data"}:
            raise ProbeError("persisted review task lost its upstream summary binding")
        if EVIDENCE_RUN_PATH not in source_task.get("artifacts", []):
            raise ProbeError("source task artifact list does not contain its fixed evidence.md output")
        evidence_path = run_dir / EVIDENCE_RUN_PATH
        if not evidence_path.is_file():
            raise ProbeError("native source task did not produce its required evidence artifact")
        evidence_bytes = evidence_path.read_bytes()
        source_messages = self._messages_tool_calls(
            run_dir / "artifacts" / "tencent_research" / "task_tencent_data" / "messages.json"
        )
        review_messages_path = (
            run_dir / "artifacts" / "evidence_reviewer" / "task_evidence_review" / "messages.json"
        )
        review_message_records = json.loads(review_messages_path.read_text(encoding="utf-8"))
        review_system_prompt = next(
            (
                item.get("content", "")
                for item in review_message_records
                if isinstance(item, dict) and item.get("role") == "system"
            ),
            "",
        )
        review_messages = self._messages_tool_calls(review_messages_path)
        market_calls = [item for item in source_messages if item.get("tool") == "get_market_data"]
        write_calls = [item for item in source_messages if item.get("tool") == "write_file"]
        read_calls = [item for item in review_messages if item.get("tool") == "read_file"]
        all_tools = [item.get("tool") for item in source_messages + review_messages]
        if any(tool not in ALLOWED_TOOLS for tool in all_tools):
            raise ProbeError("native Swarm called a tool outside the restricted research/artifact allowlist")
        if len(market_calls) != 1 or len(write_calls) != 2:
            raise ProbeError("source node must make one market fetch and write only evidence.md and report.md")
        if len(read_calls) != 1:
            raise ProbeError("review node must make exactly one read_file call, without path guessing")

        expected_args = {
            "codes": [self.user_vars["symbol"]],
            "start_date": self.user_vars["start_date"],
            "end_date": self.user_vars["end_date"],
            "source": "tencent",
            "interval": "1D",
            "max_rows": 0,
        }
        market_args = market_calls[0].get("arguments", {})
        if any(market_args.get(key) != value for key, value in expected_args.items()):
            raise ProbeError("native get_market_data arguments differ from the supplied Tencent request")
        evidence_write_calls = [
            item for item in write_calls if item.get("arguments", {}).get("path") == EVIDENCE_TOOL_PATH
        ]
        report_write_calls = [
            item for item in write_calls if item.get("arguments", {}).get("path") == "report.md"
        ]
        if len(evidence_write_calls) != 1 or len(report_write_calls) != 1:
            raise ProbeError("source node did not keep evidence.md and report.md as separate task artifacts")
        evidence_write_call = evidence_write_calls[0]
        report_write_call = report_write_calls[0]
        read_args = read_calls[0].get("arguments", {})

        market_raw = market_calls[0].get("result")
        write_raw = evidence_write_call.get("result")
        report_raw = report_write_call.get("result")
        read_raw = read_calls[0].get("result")
        try:
            market_result = json.loads(market_raw) if isinstance(market_raw, str) else {}
            write_result = json.loads(write_raw) if isinstance(write_raw, str) else {}
            report_result = json.loads(report_raw) if isinstance(report_raw, str) else {}
            read_result = json.loads(read_raw) if isinstance(read_raw, str) else {}
        except json.JSONDecodeError as exc:
            raise ProbeError("native market/evidence/report/read tool result was not valid JSON") from exc
        if write_result.get("status") != "ok":
            raise ProbeError("native evidence artifact write did not report success")
        if report_result.get("status") != "ok":
            raise ProbeError("native report.md artifact write did not report success")
        write_path = write_result.get("path")
        expected_write_path = str(evidence_path.resolve())
        if not isinstance(write_path, str) or str(Path(write_path).resolve()) != expected_write_path:
            raise ProbeError("write_file receipt path does not resolve to the fixed parent task artifact")
        report_path = report_result.get("path")
        expected_report_path = str((run_dir / REPORT_RUN_PATH).resolve())
        if (
            not isinstance(report_path, str)
            or str(Path(report_path).resolve()) != expected_report_path
            or not _inside(Path(report_path).resolve(), (run_dir / "artifacts" / "tencent_research" / "task_tencent_data").resolve())
        ):
            raise ProbeError("report.md escaped the source task's private artifact workspace")
        if write_path not in str(source_task.get("summary") or ""):
            raise ProbeError("source task summary omitted the exact artifact path needed by its dependent reviewer")
        if REPORT_RUN_PATH not in source_task.get("artifacts", []):
            raise ProbeError("source task artifact list does not contain its separate report.md output")

        provenance_map = market_result.get("_provenance", {})
        symbol = self.user_vars["symbol"]
        provenance = provenance_map.get(symbol, {}) if isinstance(provenance_map, dict) else {}
        rows_value = market_result.get(symbol, [])
        rows = rows_value.get("data", []) if isinstance(rows_value, dict) else rows_value
        if not isinstance(rows, list):
            rows = []
        actual_dates = sorted(
            str(row.get("trade_date") or row.get("timestamp") or "")[:10]
            for row in rows
            if isinstance(row, dict)
        )
        source_checks = {
            "symbol": symbol,
            "requested_start": self.user_vars["start_date"],
            "requested_end": self.user_vars["end_date"],
            "actual_source": provenance.get("source"),
            "provider": provenance.get("provider"),
            "rows": len(rows),
            "actual_start": actual_dates[0] if actual_dates else None,
            "actual_end": actual_dates[-1] if actual_dates else None,
            "interval": provenance.get("interval") or market_args.get("interval"),
            "interval_source": "provenance" if provenance.get("interval") else "request_arguments",
            "adjustment": provenance.get("adjustment"),
            "volume_unit": provenance.get("volume_unit"),
            "provenance": provenance,
        }
        if source_checks["actual_source"] != "tencent":
            raise ProbeError("native market result provenance did not identify Tencent as the actual source")
        if not rows or not actual_dates:
            raise ProbeError("native Tencent result contained no daily rows")
        if any(not self.user_vars["start_date"] <= date <= self.user_vars["end_date"] for date in actual_dates):
            raise ProbeError("native Tencent result contains a row outside the requested date window")
        if self.user_vars == {
            "symbol": DEFAULT_SYMBOL,
            "start_date": DEFAULT_START_DATE,
            "end_date": DEFAULT_END_DATE,
        } and (
            len(rows) != 16
            or actual_dates[0] != DEFAULT_START_DATE
            or actual_dates[-1] != DEFAULT_END_DATE
        ):
            raise ProbeError("frozen Tencent sample did not contain its recorded 16-row date window")
        if not isinstance(market_raw, str) or not isinstance(write_raw, str):
            raise ProbeError("native market or write_file result was missing")

        native_run_record = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
        grounding_data = native_run_record.get("grounding_data", {})
        grounding_rows = grounding_data.get(symbol, []) if isinstance(grounding_data, dict) else []
        market_by_date = {
            str(row.get("trade_date") or row.get("timestamp") or "")[:10]: row
            for row in rows
            if isinstance(row, dict)
        }
        grounding_by_date = {
            str(row.get("trade_date") or row.get("timestamp") or "")[:10]: row
            for row in grounding_rows
            if isinstance(row, dict)
        }
        grounding_rows_within_user_end = all(
            date_key <= self.user_vars["end_date"] for date_key in grounding_by_date
        )
        grounding_rows_match_market = bool(grounding_rows) and all(
            date_key in market_by_date
            and all(
                _decimal_value(grounding_by_date[date_key].get(key))
                == _decimal_value(market_by_date[date_key].get(key))
                for key in ("open", "high", "low", "close", "volume")
            )
            for date_key in grounding_by_date
        )
        ground_truth_marker = next(
            (
                marker
                for marker in (
                    "## Ground Truth — Requested Window Market Data",
                    "## Ground Truth — Recent Market Data",
                )
                if marker in review_system_prompt
            ),
            None,
        )
        ground_truth_block = (
            review_system_prompt.split(ground_truth_marker, 1)[1].split("## Execution Rules", 1)[0]
            if ground_truth_marker is not None
            else ""
        )
        ground_truth_rows = re.findall(
            r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d,.]+)\s*\|\s*([\d,]+)\s*\|\s*$",
            ground_truth_block,
            re.MULTILINE,
        )
        ground_truth_rows_match_grounding = bool(ground_truth_rows) and all(
            date_key in grounding_by_date
            and _decimal_value(grounding_by_date[date_key].get("close")) == _decimal_value(close)
            and _decimal_value(grounding_by_date[date_key].get("volume"))
            == _decimal_value(volume.replace(",", ""))
            for date_key, close, volume in ground_truth_rows
        )
        ground_truth_rows_match_market = bool(ground_truth_rows) and all(
            date_key in market_by_date
            and _decimal_value(market_by_date[date_key].get("close")) == _decimal_value(close)
            and _decimal_value(market_by_date[date_key].get("volume"))
            == _decimal_value(volume.replace(",", ""))
            for date_key, close, volume in ground_truth_rows
        )
        ground_truth_rows_within_requested_window = all(
            self.user_vars["start_date"] <= date_key <= self.user_vars["end_date"]
            for date_key, _, _ in ground_truth_rows
        )
        if ground_truth_marker is not None and (
            not ground_truth_rows_match_grounding
            or not ground_truth_rows_match_market
            or not ground_truth_rows_within_requested_window
            or not grounding_rows_within_user_end
        ):
            raise ProbeError("native Ground Truth context differs from source data or escapes the requested window")

        review_path = read_result.get("path")
        review_path_matches = (
            isinstance(review_path, str) and str(Path(review_path).resolve()) == expected_write_path
        )
        review_content = read_result.get("content")
        evidence_text = evidence_bytes.decode("utf-8")
        normalized_evidence_text = evidence_text.replace("\r\n", "\n").replace("\r", "\n")
        normalized_review_content = (
            review_content.replace("\r\n", "\n").replace("\r", "\n")
            if isinstance(review_content, str)
            else None
        )
        review_content_matches = normalized_review_content == normalized_evidence_text
        provenance_fields = {
            "source": source_checks["actual_source"],
            "interval": source_checks["interval"],
            "adjustment": source_checks["adjustment"],
            "volume_unit": source_checks["volume_unit"],
        }
        if any(
            not isinstance(provenance_fields[key], str) or not provenance_fields[key]
            for key in ("source", "adjustment", "volume_unit")
        ):
            raise ProbeError("native market result omitted actual source, adjustment, or volume unit")
        if source_checks["interval"] != expected_args["interval"]:
            raise ProbeError("native market result interval differs from the submitted request")
        evidence_rows = [
            row
            for row in rows
            if isinstance(row, dict)
            and any(
                self.user_vars["start_date"] <= str(row.get("trade_date") or "")[:10] <= self.user_vars["end_date"]
                and str(row.get("trade_date") or "")[:10] in line
                and _row_numbers(row).issubset(_report_numbers(line))
                for line in evidence_text.splitlines()
            )
        ]
        provider_reported = (
            str(source_checks["provider"]).lower() in evidence_text.lower()
            if source_checks["provider"] is not None
            else "provider" in evidence_text.lower()
            and any(
                marker in evidence_text.lower()
                for marker in ("not supplied", "not reported", "not provided", "unavailable", "null", "未提供")
            )
            and "provider：tencent" not in evidence_text.lower()
            and "provider: tencent" not in evidence_text.lower()
        )
        evidence_metadata_checks = {
            "symbol_and_dates": all(value in evidence_text for value in self.user_vars.values()),
            "provider_field_reported_without_inference": provider_reported,
            "source_interval_adjustment_volume_unit": all(
                str(value) in evidence_text for value in provenance_fields.values()
            ),
            "all_market_rows_grounded": len(evidence_rows) == len(rows),
        }

        review_summary_path = (
            run_dir / "artifacts" / "evidence_reviewer" / "task_evidence_review" / "summary.md"
        )
        if not review_summary_path.is_file():
            raise ProbeError("native evidence reviewer did not persist a summary report")
        review_summary = review_summary_path.read_text(encoding="utf-8")
        review_summary_lower = review_summary.lower()
        checked_rows_match = re.search(
            r"(?m)^\s*\*{0,2}CHECKED_ROW_DATES\s*=\s*(.+?)\*{0,2}\s*$",
            review_summary,
        )
        checked_row_dates = (
            set(re.findall(r"\d{4}-\d{2}-\d{2}", checked_rows_match.group(1)))
            if checked_rows_match
            else set()
        )
        review_row_dates = checked_row_dates.intersection(actual_dates)
        numeric_claim_text = re.sub(r"\d{4}-\d{2}-\d{2}", "", review_summary)
        numeric_claim_text = numeric_claim_text.replace(symbol, "").replace("1D", "")
        evidence_number_text = re.sub(r"\d{4}-\d{2}-\d{2}", "", evidence_text)
        evidence_number_text = evidence_number_text.replace(symbol, "").replace("1D", "")
        summary_numbers = _report_numbers(numeric_claim_text)
        grounded_evidence_numbers = _report_numbers(evidence_number_text)
        unverified_summary_numbers = sorted(str(value) for value in summary_numbers - grounded_evidence_numbers)
        review_grounding_checks = {
            "symbol_and_dates": all(value.lower() in review_summary_lower for value in self.user_vars.values()),
            "source_adjustment_volume_unit": all(
                str(source_checks[key]).lower() in review_summary_lower
                for key in ("actual_source", "adjustment", "volume_unit")
            ),
            "at_least_two_source_row_dates_checked": len(review_row_dates) >= 2,
            "states_supported_and_falsified_conditions": "SUPPORTS=" in review_summary and "INVALIDATES=" in review_summary,
            "states_next_data_needed": "NEXT=" in review_summary,
            "judgment_passes_evidence_review": bool(
                re.search(r"(?m)^\s*\*{0,2}EVIDENCE_REVIEW=PASS\*{0,2}\s*$", review_summary)
            ),
            "no_unverified_numeric_claims": not unverified_summary_numbers,
        }
        self.manifest["evidence_validation"] = {
            "source_tool_call": {
                "call_id": market_calls[0].get("call_id"),
                "arguments": market_args,
                "result_sha256": _sha256_bytes(market_raw.encode("utf-8")),
                "result_bytes": len(market_raw.encode("utf-8")),
            },
            "source_checks": source_checks,
            "native_grounding": {
                "system_block_present_for_reviewer": ground_truth_marker is not None,
                "system_prompt_sha256": _sha256_bytes(review_system_prompt.encode("utf-8")),
                "grounding_rows": len(grounding_rows),
                "grounding_start": min(grounding_by_date) if grounding_by_date else None,
                "grounding_end": max(grounding_by_date) if grounding_by_date else None,
                "grounding_rows_match_explicit_tencent_result": grounding_rows_match_market,
                "grounding_rows_within_user_end_date": grounding_rows_within_user_end,
                "ground_truth_table_rows": len(ground_truth_rows),
                "ground_truth_rows_match_runtime_snapshot": ground_truth_rows_match_grounding,
                "ground_truth_rows_match_explicit_tencent_result": ground_truth_rows_match_market,
                "ground_truth_rows_within_user_window": ground_truth_rows_within_requested_window,
                "source_provenance_recorded_by_native_prefetch": False,
                "default_a_share_source_order": "Tencent is first; actual selected loader is not serialized in grounding_data",
                "native_prefetch_uses_user_end_date": False,
            },
            "parent_node_dependency": {
                "parent_task_id": source_task.get("id"),
                "parent_agent_id": source_task.get("agent_id"),
                "child_task_id": review_task.get("id"),
                "child_agent_id": review_task.get("agent_id"),
                "child_depends_on": review_task.get("depends_on"),
                "child_input_from": review_task.get("input_from"),
            },
            "artifact": {
                "tool_path": EVIDENCE_TOOL_PATH,
                "run_relative_path": EVIDENCE_RUN_PATH,
                "bytes": len(evidence_bytes),
                "sha256": _sha256_bytes(evidence_bytes),
                "parent_artifacts": source_task.get("artifacts", []),
                "review_artifacts": review_task.get("artifacts", []),
                "review_read_status": read_result.get("status"),
                "review_read_path_matches_parent_artifact": review_path_matches,
                "review_read_content_matches_parent_artifact": review_content_matches,
                "normalized_text_sha256": _sha256_bytes(normalized_evidence_text.encode("utf-8")),
                "review_read_normalized_text_sha256": (
                    _sha256_bytes(normalized_review_content.encode("utf-8"))
                    if normalized_review_content is not None
                    else None
                ),
                "report_path": REPORT_RUN_PATH,
                "report_sha256": _sha256_file(run_dir / REPORT_RUN_PATH),
                "report_bytes": (run_dir / REPORT_RUN_PATH).stat().st_size,
                "source_evidence_checks": evidence_metadata_checks,
                "review_summary": {
                    "run_relative_path": review_summary_path.relative_to(run_dir).as_posix(),
                    "bytes": review_summary_path.stat().st_size,
                    "sha256": _sha256_file(review_summary_path),
                    "checks": review_grounding_checks,
                    "unverified_numeric_claims": unverified_summary_numbers,
                },
            },
            "tool_call_names": {
                "source_node": [item.get("tool") for item in source_messages],
                "review_node": [item.get("tool") for item in review_messages],
            },
        }
        self.save_manifest()
        if (
            read_result.get("status") != "ok"
            or not review_path_matches
            or not review_content_matches
            or read_args.get("path") != write_path
        ):
            raise ProbeError("review node did not read back the exact source evidence artifact")
        failed_evidence_checks = [
            name for name, passed in evidence_metadata_checks.items() if not passed
        ]
        failed_review_checks = [
            name for name, passed in review_grounding_checks.items() if not passed
        ]
        if failed_evidence_checks:
            raise ProbeError("source evidence did not ground all native market rows/metadata: " + ", ".join(failed_evidence_checks))
        if failed_review_checks:
            raise ProbeError("review summary did not substantively verify its source evidence: " + ", ".join(failed_review_checks))


    async def _graceful_shutdown(self) -> None:
        if self.owned is None:
            return
        state = "already_exited"
        if self.owned.poll() is None and self.client is not None and self.native_port is not None:
            try:
                result = await self._request_json(
                    "POST", "/mona/shutdown", label="native_graceful_shutdown", timeout=10
                )
                state = "requested" if result.get("stopping") is True else "request_returned"
            except Exception as exc:
                state = f"request_failed:{type(exc).__name__}"
        deadline = time.monotonic() + SHUTDOWN_TIMEOUT_SECONDS
        while self.owned.poll() is None and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if self.owned.poll() is None:
            state = "owned_process_fallback"
        elif state == "requested":
            state = "graceful_exit"
        self.owned.close()
        self.manifest.setdefault("native_server", {})["shutdown"] = {
            "state": state,
            "returncode": self.owned.process.returncode,
            "owned_process_closed": True,
        }
        self.owned = None
        self.save_manifest()

    async def execute(self) -> int:
        self.output.mkdir(parents=True, exist_ok=False)
        for path in (self.runtime_home, self.temp_home, self.app_data, self.cache_home):
            path.mkdir(parents=True)
        self.save_manifest()
        result_code = 1
        try:
            if not self.python.is_file():
                raise FileNotFoundError(f"native Python interpreter is missing: {self.python}")
            self.source_info = _validate_source_root(self.source_root)
            self.manifest["source"] = {
                "source_root": str(self.source_root.relative_to(TEMP_ROOT)),
                "receipt": self.source_info["receipt"],
                "receipt_sha256": self.source_info["receipt_sha256"],
                "preset_sha256": self.source_info["preset_sha256"],
            }
            self.save_manifest()
            self.manifest["preset_validation"] = await self._inspect_preset()
            config = load_config()
            default = config.resolve_default_preset()
            if default.model != MODEL_NAME or default.provider != MODEL_PROVIDER:
                raise ProbeError("Mona default model/provider differs from the authorized boundary")
            await self._start_bridge(config)
            self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
            await self._start_native_server()
            await self._run_and_verify()
            self.manifest["status"] = "verified"
            self.manifest["completed_at_utc"] = _utc_now()
            result_code = 0
        except Exception as exc:
            self.manifest["status"] = "failed"
            self.manifest["failure"] = {
                "type": type(exc).__name__,
                "message": self._redact(str(exc)) if isinstance(exc, ProbeError) else "details withheld",
            }
            self.manifest["completed_at_utc"] = _utc_now()
            result_code = 1
        finally:
            await self._graceful_shutdown()
            if self.client is not None:
                await self.client.close()
                self.client = None
            if self.bridge_runner is not None:
                await self.bridge_runner.cleanup()
                self.bridge_runner = None
            if self.bridge is not None:
                try:
                    await self.bridge.snapshot.provider.aclose()
                except Exception:
                    self.manifest["bridge_cleanup"] = "provider close raised; run evidence retained"
            self._save_logs()
            if self.manifest.get("status") != "verified":
                self.manifest["status"] = "failed"
            self.save_manifest()
        return result_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--start-date", default=DEFAULT_START_DATE)
    parser.add_argument("--end-date", default=DEFAULT_END_DATE)
    args = parser.parse_args(argv)
    output = args.output.resolve()
    if not _inside(output, TEMP_ROOT) or output == TEMP_ROOT:
        raise SystemExit("--output must be a fresh child of this worktree's .codex_tmp")
    probe = SwarmProbe(
        args.source_root.resolve(strict=True),
        args.python.resolve(strict=True),
        output,
        symbol=args.symbol,
        start_date=args.start_date,
        end_date=args.end_date,
    )
    try:
        return asyncio.run(probe.execute())
    except FileExistsError as exc:
        raise SystemExit(f"--output already exists; preserving prior run: {output}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
