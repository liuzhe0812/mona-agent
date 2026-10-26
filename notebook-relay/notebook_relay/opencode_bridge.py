import asyncio
import contextlib
import hmac
import json
import logging
import os
import secrets
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from starlette.requests import ClientDisconnect

from notebook_relay.config import Settings
from notebook_relay.opencode_codec import (
    FREE_MODEL,
    REASONING_EFFORTS,
    CompletionDecoder,
    iter_sse_data,
    prepare_request,
)

logger = logging.getLogger(__name__)
END = object()
SYSTEM_CONFIG_DIRECTORY = Path("C:/ProgramData/opencode" if os.name == "nt" else "/etc/opencode")


class NativeError(Exception):
    def __init__(self, status: int, code: str, message: str, headers=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.headers = headers


@dataclass
class Job:
    id: str
    directory: Path
    context: dict
    session_id: str | None = None
    registered: asyncio.Event = field(default_factory=asyncio.Event)
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    chunks: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=8))
    status: int | None = None
    content_type: str = ""
    retry_after: str = ""
    failure: NativeError | None = None
    closed: bool = False

    async def put(self, value):
        put = asyncio.create_task(self.chunks.put(value))
        cancelled = asyncio.create_task(self.cancelled.wait())
        try:
            done, _ = await asyncio.wait((put, cancelled), return_when=asyncio.FIRST_COMPLETED)
            return put in done and not self.cancelled.is_set()
        finally:
            for task in (put, cancelled):
                task.cancel()
            await asyncio.gather(put, cancelled, return_exceptions=True)


class OpenCodeBridge:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.jobs: dict[str, Job] = {}
        self.plugin_key = secrets.token_urlsafe(32)
        self.process = None
        self.client = None
        self.root = None
        self.temp = None
        self.stdout_task = None
        self.events_task = None
        self.cleanup_tasks = set()
        self.model_capabilities = {}

    async def start(self):
        raw = self.settings.opencode_executable or shutil.which("opencode")
        if not raw:
            raise RuntimeError("未找到官方 OpenCode，请设置 NOTEBOOK_RELAY_OPENCODE_EXECUTABLE")
        executable = Path(raw).expanduser().resolve(strict=True)
        if not executable.is_file():
            raise RuntimeError("OpenCode 程序路径不是文件")
        try:
            if SYSTEM_CONFIG_DIRECTORY.exists() and (
                not SYSTEM_CONFIG_DIRECTORY.is_dir() or any(SYSTEM_CONFIG_DIRECTORY.iterdir())
            ):
                raise RuntimeError(f"请在没有机器级 OpenCode 配置的独立环境启动：{SYSTEM_CONFIG_DIRECTORY}")
        except OSError:
            raise RuntimeError(f"无法确认机器级 OpenCode 配置目录为空：{SYSTEM_CONFIG_DIRECTORY}") from None
        self.temp = tempfile.TemporaryDirectory(prefix="notebook-relay-native-")
        self.root = Path(self.temp.name).resolve()
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"}
        env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        for key, child in [
            ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"),
            ("OPENCODE_TEST_HOME", "home"), ("TEMP", "tmp"), ("TMP", "tmp"),
        ]:
            folder = self.root / child
            folder.mkdir(exist_ok=True)
            env[key] = str(folder)
        work = self.root / "work"
        work.mkdir()
        plugin = self.root / "plugin"
        plugin.mkdir()
        shutil.copyfile(Path(__file__).with_name("opencode_plugin.mjs"), plugin / "index.mjs")
        (plugin / "package.json").write_text(json.dumps({
            "name": "notebook-relay-opencode", "type": "module", "main": "index.mjs",
        }), encoding="utf-8")
        config_dir = self.root / "config" / "opencode"
        config_dir.mkdir()
        model = "opencode/" + FREE_MODEL
        config = {
            "model": model, "plugins": [plugin.as_posix()], "update": "disable",
            "warming": False, "snapshots": False, "compaction": {"auto": False},
            "agents": {"build": {"model": model, "permissions": [
                {"action": "*", "resource": "*", "effect": "ask"},
            ]}, **{name: {"model": model} for name in ("title", "summary", "compaction")}},
            "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                         {"action": "provider.use", "resource": "opencode", "effect": "allow"}],
            "providers": {"opencode": {"settings": {
                "timeout": int(self.settings.request_timeout_seconds * 1000),
                "headerTimeout": int(self.settings.request_timeout_seconds * 1000),
                "chunkTimeout": int(self.settings.request_timeout_seconds * 1000),
            }}},
        }
        (config_dir / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
        password = secrets.token_urlsafe(32)
        host = "[::1]" if self.settings.host == "::1" else "127.0.0.1"
        env.update(
            OPENCODE_PASSWORD=password, NOTEBOOK_RELAY_PLUGIN_KEY=self.plugin_key,
            NOTEBOOK_RELAY_CONTROL_URL=f"http://{host}:{self.settings.port}",
            OPENCODE_CONFIG_PROJECT_DISABLE="1", NO_COLOR="1", CI="1",
        )
        self.process = await asyncio.create_subprocess_exec(
            str(executable), "serve", "--stdio", "--port", "0", cwd=work, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        endpoint = asyncio.get_running_loop().create_future()

        async def read_stdout():
            while raw_line := await self.process.stdout.readline():
                try:
                    item = json.loads(raw_line)
                except ValueError:
                    continue
                if isinstance(item, dict) and "url" in item and not endpoint.done():
                    endpoint.set_result(item["url"])
            if not endpoint.done():
                endpoint.set_exception(RuntimeError("官方 OpenCode 在就绪前退出"))

        self.stdout_task = asyncio.create_task(read_stdout())
        url = await asyncio.wait_for(endpoint, self.settings.opencode_start_timeout_seconds)
        url = Settings.validate_upstream(url)
        self.client = httpx.AsyncClient(
            base_url=url, auth=httpx.BasicAuth("opencode", password),
            trust_env=False, follow_redirects=False, timeout=10,
        )
        info = await self.api("GET", "/api/info")
        if info.json().get("version") != "2.0.32":
            raise RuntimeError("原生适配当前只验证了官方 OpenCode 2.0.32")
        await self.load_model_capabilities()
        self.events_task = asyncio.create_task(self.watch_events())

    async def load_model_capabilities(self):
        response = await self.api("GET", "/api/model")
        model = next((item for item in response.json().get("data", [])
                      if isinstance(item, dict) and item.get("providerID") == "opencode"
                      and item.get("modelID") == FREE_MODEL), None)
        if model is None:
            raise NativeError(503, "native_model_unavailable", "官方目录中没有目标免费模型")
        capabilities = {}
        context = model.get("limit", {}).get("context")
        if type(context) is int and context > 0:
            capabilities["context_window"] = context
        efforts = []
        for variant in model.get("variants", []):
            effort = variant.get("settings", {}).get("reasoningEffort")
            if effort in REASONING_EFFORTS and effort not in efforts:
                efforts.append(effort)
        if efforts:
            capabilities["reasoning_efforts"] = efforts
            if "high" in efforts:
                capabilities["default_reasoning_effort"] = "high"
        self.model_capabilities = capabilities
        return capabilities

    async def api(self, method, path, **kwargs):
        response = await self.client.request(method, path, **kwargs)
        if not 200 <= response.status_code < 300:
            raise NativeError(502, "native_control_error", "官方客户端控制接口请求失败")
        return response

    async def watch_events(self):
        try:
            async with self.client.stream("GET", "/api/event", timeout=None) as response:
                async for data in iter_sse_data(response.aiter_bytes()):
                    event = json.loads(data)
                    if event.get("type") not in {"session.execution.failed", "session.execution.interrupted"}:
                        continue
                    session_id = event.get("data", {}).get("sessionID")
                    for job in list(self.jobs.values()):
                        if job.session_id == session_id and not job.cancelled.is_set() and job.status is None:
                            job.failure = NativeError(502, "native_execution_failed", "官方客户端未能完成模型请求")
                            job.ready.set()
                            await job.put(END)
        except (httpx.HTTPError, ValueError):
            logger.warning("native_event_stream_unavailable")

    def create_job(self, context):
        if self.process is None or self.process.returncode is not None:
            raise NativeError(503, "native_not_running", "官方客户端服务未运行")
        name = "nr_" + uuid.uuid4().hex
        directory = (self.root / "work" / name).resolve()
        if not directory.is_relative_to(self.root):
            raise RuntimeError("原生会话目录超出隔离范围")
        directory.mkdir()
        job = Job(name, directory, context)
        self.jobs[name] = job
        return job

    async def ready(self):
        job = self.create_job(prepare_request({"model": FREE_MODEL, "messages": [
            {"role": "user", "content": "Readiness only; do not run a model request."},
        ]}))
        try:
            await self.api("GET", "/api/plugin", params={
                "location[directory]": str(job.directory),
            })
            await asyncio.wait_for(job.registered.wait(), 5)
        finally:
            await self.close_job(job)
        return {"ready": True, "backend": "opencode_native", "model": FREE_MODEL}

    async def open(self, payload):
        try:
            context = prepare_request(payload)
            default = self.model_capabilities.get("default_reasoning_effort")
            if default:
                context["options"].setdefault("reasoningEffort", default)
            effort = context["options"].get("reasoningEffort")
            declared = self.model_capabilities.get("reasoning_efforts")
            if declared is not None and effort is not None and effort not in declared:
                raise ValueError("reasoning_effort")
        except ValueError as exc:
            raise NativeError(400, "unsupported_native_request", str(exc)) from None
        job = self.create_job(context)
        try:
            created = await self.api("POST", "/api/session", json={
                "title": "Notebook relay", "agent": "build",
                "model": {"providerID": "opencode", "id": FREE_MODEL},
                "location": {"directory": str(job.directory)},
            })
            job.session_id = created.json()["data"]["id"]
            await self.api("GET", "/api/plugin", params={
                "location[directory]": str(job.directory),
            })
            try:
                await asyncio.wait_for(job.registered.wait(), 5)
            except TimeoutError:
                raise NativeError(503, "native_plugin_not_ready", "原生工具插件未能注册") from None
            await self.api("POST", f"/api/session/{job.session_id}/prompt", json={
                "text": "The registered relay plugin supplies this model request's context.",
            })
            await job.ready.wait()
            if job.failure:
                raise job.failure
            if job.status == 429:
                headers = {"Retry-After": job.retry_after} if job.retry_after.isdecimal() else None
                raise NativeError(429, "native_rate_limited", "官方免费通道已限流，请稍后重试", headers)
            if job.status != 200 or not job.content_type.startswith("text/event-stream"):
                raise NativeError(502, "native_upstream_rejected",
                                  f"官方免费通道未返回兼容流（HTTP {job.status}）")
            return job
        except BaseException:
            await self.close_job(job)
            raise

    async def body(self, job):
        while True:
            chunk = await job.chunks.get()
            if chunk is END:
                if job.failure:
                    raise job.failure
                return
            yield chunk

    async def events(self, job, include_usage=True):
        decoder = CompletionDecoder(FREE_MODEL, job.context["aliases"])
        saw_done = False
        async for data in iter_sse_data(self.body(job)):
            if data == "[DONE]":
                try:
                    decoder.completion()
                except ValueError as exc:
                    logger.warning("native_protocol_error: %s", exc)
                    raise NativeError(502, "native_protocol_error", "官方响应未合法完成") from None
                saw_done = True
                continue
            if saw_done:
                raise NativeError(502, "native_protocol_error", "官方响应结束后仍有额外数据")
            try:
                chunk = decoder.feed(json.loads(data))
            except ValueError as exc:
                logger.warning("native_protocol_error: %s", exc)
                raise NativeError(502, "native_protocol_error", "官方客户端返回了不兼容的响应") from None
            if not include_usage:
                chunk.pop("usage", None)
            yield json.dumps(chunk, ensure_ascii=False)
        if not saw_done:
            raise NativeError(502, "native_incomplete_response", "官方响应提前中断")
        yield "[DONE]"

    async def completion(self, job):
        decoder = CompletionDecoder(FREE_MODEL, job.context["aliases"])
        saw_done = False
        try:
            async for data in iter_sse_data(self.body(job)):
                if data == "[DONE]":
                    saw_done = True
                elif not saw_done:
                    decoder.feed(json.loads(data))
                else:
                    raise ValueError("data after completion")
            if not saw_done:
                raise ValueError("missing completion marker")
            return decoder.completion()
        except ValueError as exc:
            logger.warning("native_protocol_error: %s", exc)
            raise NativeError(502, "native_protocol_error", "官方客户端响应不完整或不兼容") from None

    async def close_job(self, job):
        if job.closed:
            return
        job.closed = True
        job.cancelled.set()
        self.jobs.pop(job.id, None)

        async def dispose():
            if self.client and self.process.returncode is None:
                if job.session_id:
                    for suffix, method in (("/interrupt", "POST"), ("", "DELETE")):
                        try:
                            response = await self.client.request(
                                method, f"/api/session/{job.session_id}{suffix}", timeout=3,
                            )
                            if response.status_code not in {200, 204, 404}:
                                logger.warning("native_session_cleanup_rejected")
                        except httpx.HTTPError:
                            logger.warning("native_session_cleanup_unavailable")
                try:
                    response = await self.client.delete("/api/debug/location", params={
                        "location[directory]": str(job.directory),
                    }, timeout=3)
                    if response.status_code != 204:
                        logger.warning("native_location_cleanup_rejected")
                except httpx.HTTPError:
                    logger.warning("native_location_cleanup_unavailable")
            if not job.directory.resolve().is_relative_to(self.root):
                raise RuntimeError("原生会话清理范围无效")
            try:
                job.directory.rmdir()
            except OSError:
                logger.warning("native_directory_cleanup_deferred")

        task = asyncio.create_task(dispose())
        self.cleanup_tasks.add(task)
        task.add_done_callback(self.cleanup_tasks.discard)
        await asyncio.shield(task)

    async def stop(self):
        for job in list(self.jobs.values()):
            await self.close_job(job)
        if self.cleanup_tasks:
            await asyncio.gather(*list(self.cleanup_tasks))
        if self.events_task:
            self.events_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.events_task
        if self.client:
            await self.client.aclose()
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.stdout_task:
            await self.stdout_task
        if self.temp:
            if self.root.parent != Path(tempfile.gettempdir()).resolve():
                raise RuntimeError("原生工作目录清理范围无效")
            self.temp.cleanup()


def install_native_routes(app, bridge):
    router = APIRouter(prefix="/internal/opencode/contexts")

    def get_job(job_id, request):
        supplied = request.headers.get("X-Relay-Plugin-Key", "")
        if bridge is None or not hmac.compare_digest(supplied.encode(), bridge.plugin_key.encode()):
            raise HTTPException(404)
        job = bridge.jobs.get(job_id)
        if job is None or job.cancelled.is_set():
            raise HTTPException(404)
        return job

    @router.get("/{job_id}")
    async def context(job_id: str, request: Request):
        return get_job(job_id, request).context

    @router.post("/{job_id}/registered")
    async def registered(job_id: str, request: Request):
        job = get_job(job_id, request)
        job.registered.set()
        return Response(status_code=204)

    @router.post("/{job_id}/tool")
    async def tool(job_id: str, request: Request):
        job = get_job(job_id, request)
        await job.cancelled.wait()
        return Response(status_code=409)

    @router.post("/{job_id}/response")
    async def response(job_id: str, request: Request):
        job = get_job(job_id, request)
        if job.ready.is_set():
            raise HTTPException(409)
        try:
            job.status = int(request.headers.get("x-upstream-status", "0"))
        except ValueError:
            raise HTTPException(400) from None
        job.content_type = request.headers.get("x-upstream-content-type", "")
        job.retry_after = request.headers.get("x-upstream-retry-after", "")
        job.ready.set()
        size = 0
        try:
            async for chunk in request.stream():
                size += len(chunk)
                if size > bridge.settings.opencode_max_response_bytes:
                    job.failure = NativeError(502, "native_response_too_large", "模型响应超过大小限制")
                    break
                if not await job.put(chunk):
                    return Response(status_code=409)
        except (OSError, RuntimeError, ClientDisconnect):
            job.failure = NativeError(502, "native_response_interrupted", "官方客户端的响应连接已中断")
        finally:
            await job.put(END)
        return Response(status_code=204)

    app.include_router(router)
