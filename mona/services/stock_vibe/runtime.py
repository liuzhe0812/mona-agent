"""Services-owned Vibe process; installation remains with the shared runtime owner."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from filelock import FileLock, Timeout
from loguru import logger

from mona.config.loader import load_config
from mona.config.paths import get_data_dir, get_managed_runtimes_dir
from mona.config.schema import Config
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token
from mona.providers.factory import provider_signature
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.official import ensure_official_runtime_resource
from mona.runtime.process_tree import OwnedProcess, OwnedProcessInfo
from mona.runtime.python_env import PythonEnvironmentBuilder

_TUSHARE_CONFIG_ENV = "MONA_STOCK_VIBE__TUSHARE_TOKEN"


class StockVibeUnavailableError(RuntimeError):
    pass


class StockVibeRuntime:
    def __init__(self, *, runtime_root: Path | None = None, data_root: Path | None = None,
                 config_loader: Callable[[], Config] = load_config,
                 automation_allowed: Callable[[], bool] = lambda: False) -> None:
        self.runtime_root = (runtime_root or get_managed_runtimes_dir()).resolve()
        self.data_root = (data_root or get_data_dir() / "stock-vibe" / "native").resolve()
        self.config_loader = config_loader
        self.automation_allowed = automation_allowed
        self._mutex = asyncio.Lock()
        self._ownership: FileLock | None = None
        self._process: OwnedProcess | None = None
        self._client: httpx.AsyncClient | None = None
        self._log = None
        self._idle_task: asyncio.Task | None = None
        self._leases = 0
        self._last_used = 0.0
        self._signature: str | None = None
        self._instance: str | None = None
        self._gateway_base: str | None = None
        self._baseline_process_ids: set[int] | None = None
        self._receipt: dict | None = None
        self._model_metadata: dict | None = None
        self._attention_supported = False
        self.attention_state: dict | None = None
        self._next_background_start = 0.0
        self.last_error: str | None = None

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def source_identity(self) -> dict:
        if self._receipt is None or self._instance is None:
            raise StockVibeUnavailableError("股票运行环境尚未完成身份校验")
        return {**json.loads(json.dumps(self._receipt)), "instance_id": self._instance,
                "data_root_sha256": hashlib.sha256(str(self.data_root).encode()).hexdigest(),
                "model_binding": dict(self._model_metadata) if self._model_metadata else None}

    @staticmethod
    def _model_signature(config: Config) -> str:
        binding = config.stock_vibe.model_binding
        if binding is not None:
            defaults = config.agents.defaults
            bound = config.model_copy(deep=True)
            bound.agents.defaults.model_preset = None
            window = (defaults.native_context_window_tokens
                      if (defaults.executor, defaults.native_model) == (binding.executor, binding.model) else None)
            payload = json.dumps((binding.model_dump(), config.development.model_dump(),
                                  bound.resolve_default_preset().to_generation_settings(), window),
                                 sort_keys=True, default=str)
            return hashlib.sha256(payload.encode()).hexdigest()
        name = config.stock_vibe.model_preset
        if name is None or name != "default" and name not in config.model_presets:
            return "unconfigured"
        bound = config.model_copy(deep=True)
        bound.agents.defaults.fallback_models = []  # The stock bridge binds one model.
        # The signature stays in memory. Provider keys never enter native files/env.
        payload = json.dumps(provider_signature(bound, preset_name=name), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _tushare_token(config: Config) -> str:
        scoped_env = os.environ.get(_TUSHARE_CONFIG_ENV)
        return scoped_env if scoped_env is not None else config.stock_vibe.tushare_token

    @classmethod
    def _tushare_environment(cls, config: Config) -> dict[str, str]:
        token = cls._tushare_token(config)
        return {"TUSHARE_TOKEN": token} if token else {}

    @classmethod
    def _runtime_signature(cls, config: Config) -> str:
        model_signature = cls._model_signature(config)
        token = cls._tushare_token(config)
        if not token:
            return model_signature
        token_sha256 = hashlib.sha256(token.encode()).hexdigest()
        return hashlib.sha256(f"{model_signature}\0tushare:{token_sha256}".encode()).hexdigest()

    def has_tushare_token(self, config: Config | None = None) -> bool:
        return bool(self._tushare_token(config or self.config_loader()))

    @staticmethod
    def _is_system_conhost(executable: Path) -> bool:
        system_root = os.environ.get("SYSTEMROOT")
        if not system_root:
            return False
        try:
            image = os.path.normcase(os.path.normpath(str(executable.resolve(strict=True))))
        except OSError:
            return False
        expected: set[str] = set()
        for directory in ("System32", "SysWOW64"):
            try:
                candidate = (Path(system_root) / directory / "conhost.exe").resolve(strict=True)
            except OSError:
                continue
            expected.add(os.path.normcase(os.path.normpath(str(candidate))))
        return image in expected

    @classmethod
    def _verified_startup_process_ids(
        cls,
        snapshot: dict[int, OwnedProcessInfo],
        *,
        launcher_pid: int,
        server_pid: int,
    ) -> set[int]:
        if launcher_pid not in snapshot or server_pid not in snapshot:
            raise StockVibeUnavailableError("股票运行进程树身份校验失败")

        ancestry: set[int] = set()
        current_pid = server_pid
        while current_pid != launcher_pid:
            if current_pid in ancestry:
                raise StockVibeUnavailableError("股票运行进程树存在循环")
            ancestry.add(current_pid)
            process = snapshot.get(current_pid)
            if process is None or process.parent_pid not in snapshot:
                raise StockVibeUnavailableError("股票服务进程不是由受控启动器启动")
            current_pid = process.parent_pid
        ancestry.add(launcher_pid)

        startup_ids = set(ancestry)
        for pid, process in snapshot.items():
            if pid in ancestry:
                continue
            if process.parent_pid in ancestry and cls._is_system_conhost(process.executable):
                startup_ids.add(pid)
                continue
            raise StockVibeUnavailableError("股票运行进程树包含未识别的子进程")
        return startup_ids

    @staticmethod
    def _verify_bundle(bundle: Path) -> None:
        receipt = json.loads((bundle / "source-receipt.json").read_text(encoding="utf-8"))
        bundle_root = bundle.resolve()

        def verify_file(item: dict) -> None:
            path = (bundle / item["path"]).resolve(strict=True)
            if not path.is_relative_to(bundle_root) or path.stat().st_size != item["bytes"]:
                raise StockVibeUnavailableError("股票运行组件文件损坏，请修复功能资源")
            if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                raise StockVibeUnavailableError("股票运行组件校验失败，请修复功能资源")

        files = [item for item in receipt["inventory"]["files"] if item["role"] != "wheel"]
        with ThreadPoolExecutor(max_workers=4) as verifier:
            for _ in verifier.map(verify_file, files):
                pass

    async def _bind_model(self, config: Config, instance: str) -> dict:
        self._gateway_base = f"http://127.0.0.1:{config.gateway.port}"
        async with httpx.AsyncClient(trust_env=False, timeout=15) as client:
            response = await client.post(self._gateway_base + "/internal/stock-vibe/models",
                headers={SERVICES_TOKEN_HEADER: get_services_token()}, json={"instance_id": instance})
            if response.status_code != 200:
                raise StockVibeUnavailableError("股票研究模型尚未就绪，请检查模型设置")
            binding = response.json()
        expected = f"/internal/stock-vibe/models/{instance}/v1"
        if binding.get("instance_id") != instance or binding.get("base_path") != expected:
            raise StockVibeUnavailableError("股票研究模型连接身份不匹配")
        self._model_metadata = {key: binding[key] for key in (
            "selection", "binding", "model", "max_tokens", "temperature", "reasoning_effort", "context_window_tokens",
            "context_window_verified",
        ) if key in binding}
        env = {"LANGCHAIN_PROVIDER": "openai", "LANGCHAIN_MODEL_NAME": binding["model"],
               "OPENAI_BASE_URL": self._gateway_base + expected, "OPENAI_API_KEY": binding["api_key"]}
        window = binding.get("context_window_tokens")
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            env["VIBE_TRADING_CONTEXT_WINDOW"] = str(window)
        return env

    async def _start(self, config: Config, signature: str) -> None:
        store = RuntimeComponentStore(self.runtime_root)
        active = store.active("stock-vibe")
        if active is None:
            await ensure_official_runtime_resource("stock_vibe")
            active = store.active("stock-vibe")
        if active is None:
            raise StockVibeUnavailableError("股票运行组件尚未安装")
        manifest, bundle = active
        try:
            await asyncio.to_thread(self._verify_bundle, bundle)
        except (ValueError, KeyError, OSError) as exc:
            logger.warning("Stock Vibe component validation failed: {}", type(exc).__name__)
            raise StockVibeUnavailableError("股票运行组件损坏或不完整，请修复功能资源") from exc
        ref = f"{manifest.id}@{manifest.version}"
        if manifest.python_environment != "stock-vibe":
            raise StockVibeUnavailableError("股票运行组件的依赖环境不匹配")
        python = PythonEnvironmentBuilder(self.runtime_root, store, environment="stock-vibe").python_for([ref])
        if python is None:
            raise StockVibeUnavailableError("股票运行环境不完整，请在功能资源中修复")
        server = (bundle / manifest.entrypoints["server"]).resolve(strict=True)
        if not server.is_relative_to(bundle.resolve()):
            raise StockVibeUnavailableError("股票运行组件入口无效")
        receipt = json.loads((server.parent / "mona-source.json").read_text(encoding="utf-8"))
        self.data_root.mkdir(parents=True, exist_ok=True)
        host = self.data_root.parent / "host"
        host.mkdir(parents=True, exist_ok=True)
        self._ownership = FileLock(host / "engine.lock")
        try:
            self._ownership.acquire(timeout=0)
        except Timeout as exc:
            self._ownership = None
            raise StockVibeUnavailableError("股票运行环境正在由另一个服务使用") from exc
        self._instance = secrets.token_hex(16)
        token = secrets.token_urlsafe(32)
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
            "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATHEXT",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
        }}
        try:
            if config.stock_vibe.model_preset is not None or config.stock_vibe.model_binding is not None:
                env.update(await self._bind_model(config, self._instance))
            env.update(VIBE_TRADING_HOME=str(self.data_root), VIBE_TRADING_HOSTED="1", API_AUTH_KEY=token,
                       MONA_VIBE_INSTANCE_ID=self._instance, ENABLE_SESSION_RUNTIME="true",
                       VIBE_TRADING_ENABLE_SCHEDULER="true" if self.automation_allowed() else "false", VIBE_TRADING_CHANNELS_AUTO_START="false",
                       PYTHONUTF8="1", PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
            env.update(self._tushare_environment(config))
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            self._log = (host / "engine.log").open("a", encoding="utf-8")
            self._process = OwnedProcess([str(python), str(server), "--host", "127.0.0.1", "--port", str(port)],
                cwd=self.data_root, env=env, stdin=subprocess.DEVNULL, stdout=self._log, stderr=self._log)
            self._client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False,
                                            headers={"Authorization": f"Bearer {token}"}, timeout=30)
            deadline = time.monotonic() + 45
            while True:
                if self._process.poll() is not None:
                    raise StockVibeUnavailableError("股票运行环境启动失败，详情已记入诊断日志")
                try:
                    response = await self._client.get("/mona/identity", timeout=2)
                    response.raise_for_status()
                    identity = response.json()
                    if (identity.get("service") != "mona-stock-vibe" or identity.get("protocol") != 1
                        or identity.get("instance_id") != self._instance or identity.get("source") != receipt
                        or identity.get("data_root_sha256") != hashlib.sha256(str(self.data_root).encode()).hexdigest()
                        or not self._process.owns_pid(identity["pid"])):
                        raise StockVibeUnavailableError("股票运行环境身份校验失败")
                    snapshot = self._process.process_snapshot()
                    if os.name == "nt":
                        if snapshot is None:
                            raise StockVibeUnavailableError("股票运行进程树无法核实")
                        self._baseline_process_ids = self._verified_startup_process_ids(
                            snapshot,
                            launcher_pid=self._process.pid,
                            server_pid=identity["pid"],
                        )
                    break
                except httpx.TransportError:
                    if time.monotonic() >= deadline:
                        raise StockVibeUnavailableError("股票运行环境启动超时") from None
                    await asyncio.sleep(0.1)
            self._receipt, self._signature = receipt, signature
            self._attention_supported = any(item.get("path", "").startswith("0018-") for item in receipt["patches"])
            # Older verification packages remain usable for their recorded manual scope.
            if self._attention_supported:
                await self.sync_attention()
            self.last_error = None
            self._last_used = time.monotonic()
            if self._idle_task is None:
                self._idle_task = asyncio.create_task(self._idle_loop())
        except BaseException:
            await self._stop()
            raise

    async def _is_idle(self) -> bool:
        if self._leases or self._client is None or self._process is None:
            return False
        baseline_ids = self._baseline_process_ids
        try:
            process_ids = self._process.process_ids()
        except (OSError, RuntimeError):
            self.last_error = "process_tree_unconfirmed"
            return False
        if baseline_ids is None or process_ids is None or not process_ids.issubset(baseline_ids):
            return False
        try:
            response = await self._client.get("/mona/activity", timeout=3)
            response.raise_for_status()
            activity = response.json()
            return activity.get("work_active", activity.get("active")) is False
        except (httpx.HTTPError, ValueError):
            self.last_error = "activity_unconfirmed"
            return False

    async def sync_attention(self, *, execution_allowed: bool | None = None) -> None:
        from mona.services.stock_vibe.settings import attention_preferences

        if self._client is None or not self._attention_supported:
            return
        response = await self._client.put("/mona/attention", json={
            "preferences": attention_preferences(self.config_loader()),
            "execution_allowed": bool(self.automation_allowed()) if execution_allowed is None else execution_allowed,
        }, timeout=5)
        response.raise_for_status()
        self.attention_state = response.json()

    @asynccontextmanager
    async def lease(self):
        async with self._mutex:
            config = self.config_loader()
            signature = self._runtime_signature(config)
            if self._process is not None and self._process.poll() is not None:
                await self._stop()
            if self._process is not None and signature != self._signature:
                if not await self._is_idle():
                    raise StockVibeUnavailableError("当前股票任务结束后才能应用新的模型设置")
                await self._stop()
            if self._process is None:
                await self._start(config, signature)
            self._leases += 1
            client = self._client
        try:
            yield client
        finally:
            async with self._mutex:
                self._leases -= 1
                self._last_used = time.monotonic()

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            async with self._mutex:
                if self._process is not None and self._process.poll() is not None:
                    await self._stop()
                if self._process is not None and self._runtime_signature(self.config_loader()) != self._signature:
                    try:
                        await self.sync_attention(execution_allowed=False)
                        if await self._is_idle():
                            await self._stop()
                    except httpx.HTTPError:
                        self.last_error = "model_change_unconfirmed"
                if self._process is None and self.automation_allowed() and time.monotonic() >= self._next_background_start:
                    config = self.config_loader()
                    stock = config.stock_vibe
                    if (stock.model_preset or stock.model_binding) and stock.proactive_mode != "manual" and stock.watched_symbols:
                        try:
                            await self._start(config, self._runtime_signature(config))
                        except (StockVibeUnavailableError, httpx.HTTPError, OSError):
                            self.last_error = "background_start_unconfirmed"
                            self._next_background_start = time.monotonic() + 60
                if self._process and self._attention_supported and self._runtime_signature(self.config_loader()) == self._signature:
                    try:
                        await self.sync_attention()
                    except httpx.HTTPError:
                        self.last_error = "attention_sync_unconfirmed"
                timeout = self.config_loader().stock_vibe.idle_timeout_sec
                if (self._process and not (self.attention_state or {}).get("enabled")
                    and time.monotonic() - self._last_used >= timeout and await self._is_idle()):
                    await self._stop()

    async def _stop(self) -> None:
        if self._process is not None:
            if self._client is not None and self._process.poll() is None:
                try:
                    response = await self._client.post("/mona/shutdown", timeout=2)
                    if response.is_success:
                        deadline = time.monotonic() + 4
                        while self._process.poll() is None and time.monotonic() < deadline:
                            await asyncio.sleep(0.05)
                except httpx.HTTPError:
                    self.last_error = "graceful_shutdown_unconfirmed"
            await asyncio.to_thread(self._process.close)
            self._process = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._log is not None:
            self._log.close()
            self._log = None
        if self._ownership is not None:
            self._ownership.release()
            self._ownership = None
        if self._gateway_base and self._instance:
            try:
                async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
                    await client.delete(self._gateway_base + "/internal/stock-vibe/models/" + self._instance,
                                        headers={SERVICES_TOKEN_HEADER: get_services_token()})
            except httpx.HTTPError:
                self.last_error = "bridge_release_unconfirmed"
        self._gateway_base = self._instance = self._signature = None
        self._receipt = None
        self._model_metadata = None
        self._baseline_process_ids = None
        self._attention_supported = False
        self.attention_state = None

    def start_background_owner(self) -> None:
        """Keep the permitted native process alive; all research scheduling stays native."""
        if self._idle_task is None:
            self._idle_task = asyncio.create_task(self._idle_loop())

    async def close(self) -> None:
        if self._idle_task is not None:
            self._idle_task.cancel()
            await asyncio.gather(self._idle_task, return_exceptions=True)
            self._idle_task = None
        async with self._mutex:
            await self._stop()
