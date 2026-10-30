"""Website Work API, independently launched on Ubuntu loopback behind a trusted tunnel."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import quote

from aiohttp import web
from pydantic import ValidationError

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import check_request_host, is_public_resource, website_origin
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.contracts import (
    AccountLogin,
    NewSession,
    NewTurn,
    WorkError,
    identifier,
)
from mona.hosted_work.executor import ProcessExecutor
from mona.hosted_work.frontend import register_frontend
from mona.hosted_work.sandbox_files import relative_path
from mona.hosted_work.store import WorkStore


class WorkService:
    def __init__(self, config: HostedWorkConfig, store: WorkStore, auth: AuthClient, executor: ProcessExecutor):
        self.config, self.store, self.auth, self.executor = config, store, auth, executor
        self.active_users: set[str] = set()
        self.active_engines: set[str] = set()
        self.tasks: dict[tuple[str, str], asyncio.Task] = {}

    def _acquire(self, owner: str, model_id: str | None = None) -> str | None:
        if owner in self.active_users:
            raise WorkError("user_busy", "已有工作区操作正在进行，请稍后重试。", 409)
        if len(self.active_users) + self.store.unknown_count() >= self.config.max_concurrent_runs:
            raise WorkError("capacity", "在线任务已满，请稍后重试。", 429)
        engine = None
        if model_id:
            model = self.config.models.get(model_id)
            if model is None:
                raise WorkError("invalid_model", "所选模型未开放。")
            if model.source != "mona":
                engine = str(Path(model.native_config_path).resolve()) + ":" + model.source
                for uncertain_id in self.store.unknown_models():
                    uncertain = self.config.models.get(uncertain_id)
                    if uncertain is None or (uncertain.source == model.source and
                            Path(uncertain.native_config_path).resolve() == Path(model.native_config_path).resolve()):
                        raise WorkError("model_pending", "此模型来源有待核对的执行，暂不接收新任务。", 409)
                if engine in self.active_engines:
                    raise WorkError("model_busy", "此模型来源正在处理任务，请稍后重试。", 429)
        self.active_users.add(owner)
        if engine:
            self.active_engines.add(engine)
        return engine

    def _release(self, owner: str, engine: str | None):
        self.active_users.discard(owner)
        if engine:
            self.active_engines.discard(engine)

    async def submit(self, owner: str, token: str, session_id: str, request: NewTurn):
        # Observe an accepted request before admission checks: retries never start a second job.
        try:
            existing = self.store.run(owner, request.request_id)
        except WorkError as exc:
            if exc.status != 404:
                raise
        else:
            if existing["input"] != request.model_dump() or existing["session_id"] != session_id:
                raise WorkError("request_conflict", "发送请求的内容已变化，未重复执行。", 409)
            return existing
        engine = self._acquire(owner, request.model_id)
        try:
            run, created = self.store.create_run(owner, session_id, request)
            if not created:
                self._release(owner, engine)
                return run
            task = asyncio.create_task(self._drive(owner, token, run, engine))
            self.tasks[(owner, run["id"])] = task
            task.add_done_callback(lambda _: self.tasks.pop((owner, run["id"]), None))
            return run
        except BaseException:
            self._release(owner, engine)
            raise

    async def _drive(self, owner: str, token: str, run: dict, engine: str | None):
        run_id, sid = run["id"], run["session_id"]
        async def event(kind: str, value: dict):
            if kind == "history":
                self.store.save_history(owner, run_id, value["messages"])
            elif kind == "checkpoint":
                self.store.save_checkpoint(owner, run_id, value)
            elif kind == "artifact":
                # Do not publish download IDs before a saved snapshot is verified.
                return
            else:
                self.store.event(owner, run_id, kind, value)
        try:
            payload = {"action": "turn", "owner": owner, "run_id": run_id,
                       "model_id": run["input"]["model_id"], "account_token": token,
                       "history": json.loads(self.store.session(owner, sid)["history"]),
                       "attachments": [self.store.file(owner, sid, fid) for fid in run["input"]["attachment_ids"]]}
            result = await self.executor.execute(payload, event)
            if result.get("workspace_saved"):
                for artifact in result.get("artifacts", []):
                    info = self._file_info(artifact)
                    fid = hashlib.sha256((sid + info["path"] + info["sha256"]).encode()).hexdigest()[:32]
                    self.store.add_file(owner, sid, fid, info)
            # Internal file paths and diagnostic details do not become default UI output.
            public = {key: result[key] for key in ("content", "message", "workspace_saved", "usage") if key in result}
            self.store.finish(owner, run_id, result["status"], public)
        except BaseException:
            self.store.finish(owner, run_id, "unknown", {
                "message": "任务结果待核对，不会自动重新执行。请保留此会话并联系管理员。", "workspace_saved": False})
        finally:
            self._release(owner, engine)

    @staticmethod
    def _file_info(value: dict) -> dict:
        path = relative_path(value["path"])
        size, digest = value["size"], value["sha256"]
        if (isinstance(size, bool) or not isinstance(size, int) or size < 0
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise WorkError("invalid_file", "文件结果未通过校验。", 503)
        return {"path": path, "name": path.rsplit("/", 1)[-1], "size": size, "sha256": digest}

    async def stop(self, owner: str, run_id: str):
        run = self.store.run(owner, run_id)
        if run["status"] in {"running", "cancelling"}:
            self.store.cancelling(owner, run_id)
            self.executor.cancel(owner, run_id)
        return self.store.run(owner, run_id)

    async def upload(self, owner: str, sid: str, file_id: str, name: str, content: bytes):
        self.store.session(owner, sid)
        identifier(file_id)
        if not name or len(name) > 160 or any(c in name for c in "/\\\x00\r\n") or name in {".", ".."}:
            raise WorkError("invalid_filename", "文件名无效。")
        if len(content) > self.config.max_file_bytes:
            raise WorkError("file_limit", "文件超过上传上限。", 413)
        digest = hashlib.sha256(content).hexdigest()
        try:
            old = self.store.file(owner, sid, file_id)
        except WorkError as exc:
            if exc.status != 404:
                raise
        else:
            if old["sha256"] != digest or old["size"] != len(content):
                raise WorkError("file_conflict", "同一上传请求的内容已变化。", 409)
            return {key: value for key, value in old.items() if key != "path"}
        self.store.require_idle(owner)
        engine = self._acquire(owner)
        known = False
        try:
            self.store.begin_file_operation(owner, file_id, "upload")
            relative = "uploads/" + file_id + "/" + name
            result = await self.executor.execute({"action": "upload", "owner": owner, "run_id": file_id,
                "file_request": {"action": "upload", "path": relative, "data": base64.b64encode(content).decode()}},
                self._no_event)
            known = result.get("status") in {"completed", "failed", "cancelled"}
            if result.get("status") != "completed" or not result.get("workspace_saved"):
                raise WorkError("upload_failed", "文件未确认保存，请核对后重试原上传。", 503)
            info = self._file_info(result["file"])
            if info["sha256"] != digest or info["size"] != len(content) or info["path"] != relative:
                raise WorkError("upload_failed", "上传文件校验失败。", 503)
            return self.store.add_file(owner, sid, file_id, info)
        finally:
            self.store.finish_file_operation(owner, file_id, known=known)
            self._release(owner, engine)

    async def download(self, owner: str, sid: str, file_id: str):
        from uuid import uuid4

        info = self.store.file(owner, sid, file_id)
        self.store.require_idle(owner)
        engine = self._acquire(owner)
        operation_id, known = uuid4().hex, False
        try:
            self.store.begin_file_operation(owner, operation_id, "download")
            result = await self.executor.execute({"action": "download", "owner": owner, "run_id": operation_id,
                "file_request": {"action": "download", "path": info["path"]}}, self._no_event)
            known = result.get("status") in {"completed", "failed", "cancelled"}
            if result.get("status") != "completed":
                raise WorkError("download_failed", "文件暂时无法下载，已有记录保留。", 503)
            current = result["file"]
            if current["sha256"] != info["sha256"] or current["size"] != info["size"]:
                raise WorkError("file_changed", "文件已被后续任务修改，请重新交付当前版本。", 409)
            data = base64.b64decode(current["data"], validate=True)
            if len(data) != info["size"] or hashlib.sha256(data).hexdigest() != info["sha256"]:
                raise WorkError("download_failed", "下载文件校验失败。", 503)
            return info["name"], data
        finally:
            self.store.finish_file_operation(owner, operation_id, known=known)
            self._release(owner, engine)

    @staticmethod
    async def _no_event(kind, value):
        raise WorkError("protocol_error", "文件操作返回了意外执行事件。", 503)

    async def close(self):
        for owner, run_id in list(self.tasks):
            self.executor.cancel(owner, run_id)
        pending = list(self.tasks.values())
        if pending:
            try:
                await asyncio.wait_for(asyncio.gather(*pending), 30)
            except TimeoutError:
                await asyncio.gather(*pending, return_exceptions=True)


def create_app(service: WorkService) -> web.Application:
    public_origin = website_origin(service.config)
    inflight = 0
    uploading_users: set[str] = set()

    @web.middleware
    async def boundary(request: web.Request, handler):
        nonlocal inflight
        if inflight >= max(8, service.config.max_concurrent_runs * 4):
            return web.json_response({"error": "request_capacity", "message": "请求较多，请稍后重试。"}, status=429,
                                     headers={"Cache-Control": "no-store"})
        inflight += 1
        try:
            check_request_host(request, service.config, public_origin)
            if is_public_resource(request):
                response = await handler(request)
                response.headers.update({"X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin"})
                return response
            origin = request.headers.get("Origin")
            if origin and origin != public_origin:
                raise WorkError("origin_denied", "当前网页无权访问在线工作区。", 403)
            if request.path == "/api/work/auth/login" and request.method == "POST":
                if request.content_length is not None and request.content_length > 8192:
                    raise WorkError("invalid_request", "登录请求过大。", 413)
                async with asyncio.timeout(20):
                    return await handler(request)
            authorization = request.headers.get("Authorization", "")
            if not authorization.startswith("Bearer "):
                raise WorkError("login_required", "请先登录 Mona 账号。", 401)
            token = authorization[7:]
            owner = await service.auth.identity(token)
            request["owner"], request["account_token"] = owner, token
            async with asyncio.timeout(service.config.tool_timeout_seconds + 60):
                response = await handler(request)
        except WorkError as exc:
            response = web.json_response({"error": exc.code, "message": exc.message}, status=exc.status)
        except (ValidationError, ValueError, KeyError, TypeError):
            response = web.json_response({"error": "invalid_request", "message": "请求内容无效，未执行操作。"}, status=400)
        except web.HTTPException:
            raise
        except Exception:
            response = web.json_response({"error": "service_error", "message": "在线服务暂时不可用，请核对已有任务后重试。"}, status=503)
        finally:
            inflight -= 1
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        return response

    app = web.Application(middlewares=[boundary], client_max_size=service.config.max_file_bytes + 65536)

    async def health(request):
        return web.json_response({"service": "mona-hosted-work", "status": "alive",
                                  "models_configured": bool(service.config.models)},
                                 headers={"Cache-Control": "no-store"})

    async def login(request):
        body = bytearray()
        async for chunk in request.content.iter_chunked(8192):
            body.extend(chunk)
            if len(body) > 8192:
                raise WorkError("invalid_request", "登录请求过大。", 413)
        credentials = AccountLogin.model_validate_json(body)
        value = await service.auth.login(credentials.account, credentials.password)
        return web.json_response(value, headers={"Cache-Control": "no-store"})

    async def logout(request):
        await service.auth.logout(request["account_token"])
        return web.json_response({"message": "已退出登录。"}, headers={"Cache-Control": "no-store"})

    async def models(request):
        return web.json_response({"models": [{"id": key, "label": model.label, "source": model.source}
                                            for key, model in service.config.models.items()],
                                  "max_file_bytes": service.config.max_file_bytes})

    async def sessions(request):
        if request.method == "GET":
            return web.json_response({"sessions": service.store.list_sessions(request["owner"])})
        return web.json_response(service.store.create_session(request["owner"], NewSession.model_validate(await request.json())), status=201)

    async def session_detail(request):
        return web.json_response(service.store.session_detail(request["owner"], request.match_info["sid"]))

    async def submit(request):
        result = await service.submit(request["owner"], request["account_token"], request.match_info["sid"],
                                      NewTurn.model_validate(await request.json()))
        return web.json_response(result, status=202)

    async def events(request):
        return web.json_response(service.store.events(request["owner"], request.match_info["rid"], int(request.query.get("after", "0"))))

    async def stop(request):
        if await request.json() != {"confirmed": True}:
            raise WorkError("confirmation_required", "请确认停止本轮任务。")
        return web.json_response(await service.stop(request["owner"], request.match_info["rid"]))

    async def upload(request):
        owner, sid = request["owner"], request.match_info["sid"]
        service.store.session(owner, sid)
        identifier(request.match_info["fid"])
        if owner in uploading_users:
            raise WorkError("upload_busy", "已有文件正在上传，请等待当前结果。", 409)
        if request.content_length is not None and request.content_length > service.config.max_file_bytes:
            raise WorkError("file_limit", "文件超过上传上限。", 413)
        uploading_users.add(owner)
        try:
            return web.json_response(await service.upload(owner, sid, request.match_info["fid"],
                request.query.get("name", ""), await request.read()), status=201)
        finally:
            uploading_users.discard(owner)

    async def download(request):
        name, data = await service.download(request["owner"], request.match_info["sid"], request.match_info["fid"])
        return web.Response(body=data, content_type="application/octet-stream",
                            headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe="")})

    app.router.add_get("/healthz", health)
    app.router.add_post("/api/work/auth/login", login)
    app.router.add_post("/api/work/auth/logout", logout)
    register_frontend(app, service.config)
    app.router.add_get("/api/work/models", models)
    app.router.add_get("/api/work/sessions", sessions)
    app.router.add_post("/api/work/sessions", sessions)
    app.router.add_get("/api/work/sessions/{sid}", session_detail)
    app.router.add_post("/api/work/sessions/{sid}/runs", submit)
    app.router.add_get("/api/work/runs/{rid}/events", events)
    app.router.add_post("/api/work/runs/{rid}/stop", stop)
    app.router.add_put("/api/work/sessions/{sid}/files/{fid}", upload)
    app.router.add_get("/api/work/sessions/{sid}/files/{fid}", download)
    return app
