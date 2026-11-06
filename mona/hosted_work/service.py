"""Website Work API, independently launched on Ubuntu loopback behind a trusted tunnel."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import re
from pathlib import Path
from urllib.parse import quote

from aiohttp import web
from loguru import logger
from pydantic import ValidationError

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import check_request_host, is_public_resource, website_origin
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.billing import (
    BillingError,
    HostedBilling,
    actual_units,
    charge_id,
    settlement_usage,
)
from mona.hosted_work.contracts import (
    AccountLogin,
    NewSession,
    NewTurn,
    WorkError,
    identifier,
)
from mona.hosted_work.executor import ProcessExecutor
from mona.hosted_work.frontend import register_frontend
from mona.hosted_work.model_policy import model_available, require_model_available
from mona.hosted_work.sandbox_files import relative_path
from mona.hosted_work.store import WorkStore


class WorkService:
    def __init__(self, config: HostedWorkConfig, store: WorkStore, auth: AuthClient, executor: ProcessExecutor):
        self.config, self.store, self.auth, self.executor = config, store, auth, executor
        self.active_users: set[str] = set()
        self.active_engines: set[str] = set()
        self.tasks: dict[tuple[str, str], asyncio.Task] = {}
        self.desktop = None
        self._billing_recovery: asyncio.Task | None = None

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
            require_model_available(model, self.config)
            if model.source != "mona":
                admin = None
                if model.source == "codex":
                    from mona.hosted_work.providers import codex_native_home, codex_operator

                    admin = codex_operator(self.config)
                    engine = str(codex_native_home(admin)) + ":codex"
                else:
                    engine = str(Path(model.native_config_path).resolve()) + ":" + model.source
                for uncertain_id in self.store.unknown_models():
                    uncertain = self.config.models.get(uncertain_id)
                    if (uncertain is None or model.source == "codex" and uncertain.source == "codex"
                            or model.source != "codex" and uncertain.source == model.source and
                            Path(uncertain.native_config_path).resolve() == Path(model.native_config_path).resolve()):
                        raise WorkError("model_pending", "此模型来源有待核对的执行，暂不接收新任务。", 409)
                if engine in self.active_engines:
                    raise WorkError("model_busy", "此模型来源正在处理任务，请稍后重试。", 429)
                if admin is not None:
                    try:
                        self.config.codex = admin._read()[3]
                    except (OSError, ValueError) as exc:
                        raise WorkError("native_unavailable", "平台尚未配置该模型来源。", 503) from exc
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
            if NewTurn.model_validate(existing["input"]).model_dump() != request.model_dump() or existing["session_id"] != session_id:
                raise WorkError("request_conflict", "发送请求的内容已变化，未重复执行。", 409)
            return existing
        engine = self._acquire(owner, request.model_id)
        billing = None
        model = self.config.models[request.model_id].model_copy(deep=True)
        run = None
        created = False
        reserved = False
        dispatch_started = False
        journal_started = False
        billing_id = None
        try:
            if model.source == "codex" and model.billing_mode == "wallet":
                billing = HostedBilling(self.config)
            run, created = self.store.create_run(owner, session_id, request)
            if not created:
                self._release(owner, engine)
                return run
            if billing is not None:
                billing_id = charge_id(owner, run["id"])
                self.store.billing_begin(owner, run["id"], billing_id)
                journal_started = True
                reservation = await billing.reserve(billing_id, token, model)
                if reservation["status"] != "reserved":
                    raise BillingError("billing_unknown", "计费状态尚未确认，请核对后继续。", 503)
                reserved = True
                self.store.billing_update(owner, run["id"], "reserved")
                self.store.billing_update(owner, run["id"], "dispatching")
                dispatch_started = True
                dispatched = await billing.dispatch(billing_id)
                if dispatched["status"] != "running":
                    raise BillingError("billing_unknown", "计费状态尚未确认，请核对后继续。", 503)
                self.store.billing_update(owner, run["id"], "running")
            task = asyncio.create_task(self._drive(owner, token, run, engine, billing=billing,
                                                   model=model, billing_id=billing_id))
            self.tasks[(owner, run["id"])] = task
            task.add_done_callback(lambda _: self.tasks.pop((owner, run["id"]), None))
            return run
        except BaseException as exc:
            if run is not None and created:
                rejected = isinstance(exc, BillingError) and exc.rejected and not reserved
                if journal_started and rejected:
                    self.store.billing_update(owner, run["id"], "rejected")
                elif journal_started and dispatch_started:
                    self.store.billing_update(owner, run["id"], "uncertain")
                    try:
                        await asyncio.shield(billing.uncertain(billing_id, "provider_outcome_unknown"))
                    except Exception:
                        pass
                self.store.finish(owner, run["id"], "failed" if rejected else "unknown", {
                    "message": exc.message if rejected else "计费状态待核对，本次任务不会自动重新执行。",
                    "workspace_saved": False,
                    "diagnostic": {"stop_reason": "billing_rejected" if rejected else "billing_unknown"},
                })
            self._release(owner, engine)
            raise

    async def _drive(self, owner: str, token: str, run: dict, engine: str | None, *,
                     billing=None, model=None, billing_id=None):
        run_id, sid = run["id"], run["session_id"]
        billing_finished = False
        title_before = self.store.session(owner, sid)["title"]
        async def event(kind: str, value: dict):
            if kind == "history":
                self.store.save_history(owner, run_id, value["messages"])
            elif kind == "checkpoint":
                self.store.save_checkpoint(owner, run_id, value)
            elif kind == "context":
                self.store.save_context(owner, sid, value)
            elif kind == "title":
                title = value.get("title")
                if not isinstance(title, str) or not title.strip() or len(title) > 60 or any(ord(c) < 32 for c in title):
                    raise WorkError("protocol_error", "会话名称格式无效。", 503)
                if not self._title_user_edited(owner, sid):
                    changed = self.store.db.execute("UPDATE sessions SET title=? WHERE owner=? AND id=? AND title=?",
                        (title, owner, sid, title_before)).rowcount
                    if changed and self.desktop is not None:
                        await self.desktop.wire.emit_to_chat(owner, sid, {"event": "session_updated", "scope": "metadata"})
            elif kind == "artifact":
                # Do not publish download IDs before a saved snapshot is verified.
                return
            else:
                self.store.event(owner, run_id, kind, value)
                if self.desktop is not None:
                    await self.desktop.wire.on_run_event(owner, run, kind, value)
        try:
            desktop_run = self.desktop.state.get(owner, "run:" + run_id, {}) if self.desktop else {}
            if self.desktop is not None and hasattr(self.desktop, "inputs"):
                await self.desktop.inputs.start(owner, sid, run_id, task=asyncio.current_task())
            payload = {"action": "turn", "owner": owner, "run_id": run_id,
                       "session_id": sid, "metadata": run["input"].get("metadata", {}),
                       "desktop_ui": bool(self.desktop and self.desktop.state.get(owner, "run:" + run_id)),
                       "model_id": run["input"]["model_id"], "account_token": token,
                       "history": json.loads(self.store.session(owner, sid)["history"]),
                       "context_state": self.store.context_state(owner, sid),
                       "task_id": desktop_run.get("frame", {}).get("task_id") or run_id,
                       "input_id": desktop_run.get("input_id"),
                       "title_user_edited": self._title_user_edited(owner, sid),
                       "attachments": [self.store.file(owner, sid, fid) for fid in run["input"]["attachment_ids"]]}
            if billing is not None:
                payload["billing_authorized"] = True
            result = await self.executor.execute(payload, event)
            if billing is not None:
                try:
                    usage = settlement_usage(result.get("billing_usage"))
                    if usage is None:
                        self.store.billing_update(owner, run_id, "uncertain")
                        await billing.uncertain(billing_id, "usage_unavailable")
                        raise BillingError("billing_unknown", "用量待核对。", 503)
                    expected = actual_units(model, usage)
                    self.store.billing_update(owner, run_id, "usage_ready", usage=usage, expected_units=expected)
                    settlement = await billing.settle(billing_id, usage)
                    if settlement["status"] == "uncertain":
                        self.store.billing_update(owner, run_id, "uncertain")
                    if settlement["status"] != "settled" or settlement["actual_units"] != expected:
                        raise BillingError("billing_unknown", "结算结果待核对。", 503)
                    self.store.billing_update(owner, run_id, "settled")
                    billing_finished = True
                except BillingError:
                    result.update(status="unknown", message="本轮已执行，计费状态待核对；请勿重复发送。")
                    result["diagnostic"] = {"stop_reason": "billing_unknown",
                                            "billing_reasons": result.get("billing_issue_codes", [])}
            if result.get("workspace_saved"):
                for artifact in result.get("artifacts", []):
                    info = self._file_info(artifact)
                    fid = hashlib.sha256((sid + info["path"] + info["sha256"]).encode()).hexdigest()[:32]
                    self.store.add_file(owner, sid, fid, info)
                    if self.desktop is not None:
                        index = self.desktop.state.get(owner, "artifact_index:" + sid, [])
                        index = [item for item in index if item["path"] != info["path"]]
                        logical = "/workspace/" + info["path"].removeprefix("/workspace/")
                        ui_task = self.desktop.state.get(owner, "run:" + run_id, {}).get("frame", {}).get("task_id") or run_id
                        index.append({"path": info["path"], "task_id": ui_task, "run_id": run_id, "delivered": True,
                            "file": {"path": logical, "absolute_path": logical, "name": info["name"],
                                "size": info["size"], "size_human": f"{info['size']} B", "sha256": info["sha256"],
                                "mime": mimetypes.guess_type(info["name"])[0] or "application/octet-stream"}})
                        self.desktop.state.set(owner, "artifact_index:" + sid, index)
            # Internal file paths and diagnostic details do not become default UI output.
            public = {key: result[key] for key in ("content", "message", "workspace_saved", "usage", "final_usage", "diagnostic") if key in result}
            if result["status"] != "completed":
                diagnostic = result.get("diagnostic") or {}
                logger.warning("Hosted Work run={} status={} reason={} iterations={} provider_status={} stage={} exception_type={}",
                    run_id, result["status"], diagnostic.get("stop_reason", "execution_failure"),
                    diagnostic.get("iterations"), diagnostic.get("provider_status"), diagnostic.get("stage"),
                    diagnostic.get("exception_type"))
            self.store.finish(owner, run_id, result["status"], public)
        except BaseException as exc:
            logger.warning("Hosted Work run={} result_unconfirmed exception_type={}", run_id, type(exc).__name__)
            if billing is not None and not billing_finished:
                try:
                    await asyncio.shield(billing.uncertain(billing_id, "provider_outcome_unknown"))
                except Exception:
                    pass
            try:
                self.store.finish(owner, run_id, "unknown", {
                    "message": "任务结果待核对，不会自动重新执行。请保留此会话并联系管理员。", "workspace_saved": False,
                    "diagnostic": {"stop_reason": "execution_unknown", "stage": "child_transport", "exception_type": type(exc).__name__}})
            except WorkError as exc:
                if exc.status != 404:
                    raise
        finally:
            try:
                if self.desktop is not None and hasattr(self.desktop, "questions"):
                    await self.desktop.questions.cancel_run(owner, sid, run_id)
                if self.desktop is not None and hasattr(self.desktop, "inputs"):
                    await self.desktop.inputs.finish(owner, sid, run_id)
            finally:
                self._release(owner, engine)
        if self.desktop is not None:
            try:
                await self.desktop.wire.on_run_finish(owner, run, {})
            except WorkError as exc:
                if exc.status != 404:
                    raise

    @staticmethod
    def _file_info(value: dict) -> dict:
        path = relative_path(value["path"])
        size, digest = value["size"], value["sha256"]
        if (isinstance(size, bool) or not isinstance(size, int) or size < 0
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise WorkError("invalid_file", "文件结果未通过校验。", 503)
        return {"path": path, "name": path.rsplit("/", 1)[-1], "size": size, "sha256": digest}

    def _title_user_edited(self, owner: str, sid: str) -> bool:
        if self.store.session(owner, sid)["initial_title"] != "新任务":
            return True
        if self.desktop is not None:
            overrides = self.desktop.state.sidebar(owner).get("title_overrides", {})
            return bool(overrides.get("websocket:" + sid) or overrides.get(sid))
        return False

    async def stop(self, owner: str, run_id: str):
        run = self.store.run(owner, run_id)
        if run["status"] in {"running", "cancelling"}:
            self.store.cancelling(owner, run_id)
            if self.desktop is not None and hasattr(self.desktop, "questions"):
                await self.desktop.questions.cancel_run(owner, run["session_id"], run_id)
            if self.desktop is not None and hasattr(self.desktop, "inputs"):
                await self.desktop.inputs.pause(owner, run["session_id"], run_id)
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

    async def mutate_file(self, owner: str, sid: str, file_id: str, action: str, *,
                          expected_sha256: str, destination: str | None = None) -> dict:
        from uuid import uuid4

        info = self.store.file(owner, sid, file_id)
        if expected_sha256 != info["sha256"]:
            raise WorkError("file_changed", "文件已变化，请刷新后核对。", 409)
        if action not in {"rename", "trash"}:
            raise WorkError("invalid_request", "此文件操作不可用。")
        target = relative_path(destination) if action == "rename" else info["path"]
        if action == "rename" and target.rsplit("/", 1)[:-1] != info["path"].rsplit("/", 1)[:-1]:
            raise WorkError("invalid_path", "请在文件所在位置更改名称。")
        self.store.require_idle(owner)
        engine = self._acquire(owner)
        operation_id, known = uuid4().hex, False
        try:
            self.store.begin_file_operation(owner, operation_id, action)
            command = {"action": action, "path": info["path"], "expected_sha256": expected_sha256}
            if action == "rename":
                command["destination"] = target
            result = await self.executor.file(owner, operation_id, command, self._no_event)
            known = result.get("status") in {"failed", "cancelled"}
            if result.get("status") != "completed" or not result.get("workspace_saved"):
                error = result.get("error", {})
                messages = {"file_not_found": (404, "未找到该文件，请刷新后核对。"),
                            "file_exists": (409, "同名文件已存在，请更换名称。"),
                            "file_changed": (409, "文件已变化，请刷新后核对。"),
                            "invalid_file_operation": (400, "文件操作无效。")}
                code = error.get("code") if isinstance(error, dict) else None
                status, message = messages.get(code, (503, "文件操作未能确认，请刷新后核对，勿重复提交。"))
                raise WorkError(code if code in messages else "file_operation_failed", message, status)
            try:
                current = self._file_info(result["file"])
            except (KeyError, TypeError, ValueError, WorkError):
                raise WorkError("file_operation_unknown", "文件操作结果无法核对，请联系管理员，勿重复提交。", 503) from None
            if (current["path"] != target or current["size"] != info["size"] or current["sha256"] != expected_sha256
                    or action == "trash" and result["file"].get("trashed") is not True):
                known = False
                raise WorkError("file_operation_unknown", "文件操作结果无法核对，请联系管理员，勿重复提交。", 503)
            with self.store.transaction():
                if action == "rename":
                    self.store.db.execute("UPDATE files SET path=?,name=? WHERE owner=? AND path=?",
                                          (target, current["name"], owner, info["path"]))
                else:
                    self.store.db.execute("DELETE FROM files WHERE owner=? AND path=?", (owner, info["path"]))
            known = True
            return current
        finally:
            self.store.finish_file_operation(owner, operation_id, known=known)
            self._release(owner, engine)

    @staticmethod
    async def _no_event(kind, value):
        raise WorkError("protocol_error", "文件操作返回了意外执行事件。", 503)

    async def _recover_billing_once(self):
        if not self.store.billing_pending():
            return
        try:
            billing = HostedBilling(self.config)
        except BillingError:
            return
        for record in self.store.billing_pending():
            owner, run_id, billing_id, stage = (record[key] for key in ("owner", "run_id", "charge_id", "stage"))
            if owner in self.active_users or (owner, run_id) in self.tasks:
                continue
            try:
                if record["usage"] is not None and stage in {"usage_ready", "uncertain"}:
                    result = await billing.settle(billing_id, record["usage"])
                    if result["status"] == "settled" and result["actual_units"] == record["expected_units"]:
                        self.store.billing_update(owner, run_id, "settled")
                elif stage in {"reserving", "reserved"}:
                    result = await billing.get(billing_id)
                    if result["status"] == "reserved":
                        result = await billing.release(billing_id)
                    if result["status"] == "released":
                        self.store.billing_update(owner, run_id, "released")
                elif stage in {"dispatching", "running"}:
                    result = await billing.uncertain(billing_id, "provider_outcome_unknown")
                    if result["status"] == "uncertain":
                        self.store.billing_update(owner, run_id, "uncertain")
            except (BillingError, WorkError):
                # A missing or ambiguous remote record is not proof it is safe to release.
                continue

    async def _billing_recovery_loop(self):
        while True:
            await self._recover_billing_once()
            await asyncio.sleep(30)

    async def close(self):
        if self._billing_recovery is not None:
            self._billing_recovery.cancel()
            await asyncio.gather(self._billing_recovery, return_exceptions=True)
        for owner, run_id in list(self.tasks):
            self.executor.cancel(owner, run_id)
        pending = list(self.tasks.values())
        if pending:
            try:
                await asyncio.wait_for(asyncio.gather(*pending), 30)
            except TimeoutError:
                await asyncio.gather(*pending, return_exceptions=True)


def create_app(service: WorkService, *, operator_config_path: Path | None = None) -> web.Application:
    from mona.hosted_work.desktop_api import DesktopAPI
    from mona.hosted_work.editor_bridge import EditorBridge

    desktop = None
    def get_desktop():
        nonlocal desktop
        if desktop is None:
            desktop = DesktopAPI(service)
            service.desktop = desktop
            bridge = EditorBridge(desktop)
            desktop.tool_handler = bridge.tool
            desktop.platform_handler = bridge.platform
        return desktop
    public_origin = website_origin(service.config)
    inflight = 0
    uploading_users: set[str] = set()

    @web.middleware
    async def boundary(request: web.Request, handler):
        nonlocal inflight
        socket = DesktopAPI.is_socket(request)
        if not socket and inflight >= max(8, service.config.max_concurrent_runs * 4):
            return web.json_response({"error": "request_capacity", "message": "请求较多，请稍后重试。"}, status=429,
                                     headers={"Cache-Control": "no-store"})
        if not socket:
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
            if socket:
                return await get_desktop().socket(request)
            if DesktopAPI.is_file_ticket(request):
                async with asyncio.timeout(service.config.tool_timeout_seconds + 60):
                    return await get_desktop().file_ticket(request)
            if request.path == "/api/work/auth/login" and request.method == "POST":
                if request.content_length is not None and request.content_length > 8192:
                    raise WorkError("invalid_request", "登录请求过大。", 413)
                async with asyncio.timeout(20):
                    return await handler(request)
            authorization = request.headers.get("Authorization", "")
            if not authorization.startswith("Bearer "):
                raise WorkError("login_required", "请先登录 Mona 账号。", 401)
            token = authorization[7:]
            owner = await (service.auth.admin_identity(token) if request.path.startswith("/api/work/admin/")
                           else service.auth.identity(token))
            request["owner"], request["account_token"] = owner, token
            async with asyncio.timeout(service.config.tool_timeout_seconds + 60):
                response = await handler(request)
        except WorkError as exc:
            body = {"error": exc.code, "message": exc.message}
            if isinstance(getattr(exc, "field", None), str):
                body["field"] = exc.field
            response = web.json_response(body, status=exc.status)
        except (ValidationError, ValueError, KeyError, TypeError):
            response = web.json_response({"error": "invalid_request", "message": "请求内容无效，未执行操作。"}, status=400)
        except web.HTTPException:
            raise
        except Exception:
            response = web.json_response({"error": "service_error", "message": "在线服务暂时不可用，请核对已有任务后重试。"}, status=503)
        finally:
            if not socket:
                inflight -= 1
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        return response

    app = web.Application(middlewares=[boundary], client_max_size=max(service.config.max_file_bytes + 65536,
                                                                  service.config.max_history_bytes * 4 // 3 + 65536))
    async def recover_billing(_app):
        service._billing_recovery = asyncio.create_task(service._billing_recovery_loop())
    app.on_startup.append(recover_billing)
    if operator_config_path is not None:
        from mona.hosted_work.admin import CodexAdmin
        from mona.hosted_work.model_admin import ModelAdmin
        from mona.hosted_work.model_discovery import register_model_discovery

        admin = CodexAdmin(operator_config_path, service.config)
        admin.register(app)
        ModelAdmin(admin, service).register(app)
        register_model_discovery(app, service.config)
    async def desktop_request(request):
        return await get_desktop().handle(request)
    app.router.add_route("*", "/api/work/desktop/{path:.*}", desktop_request)
    async def close_desktop(_app):
        await service.close()
        if desktop is not None:
            await desktop.close()
    app.on_cleanup.append(close_desktop)

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
                                            for key, model in service.config.models.items() if model_available(model, service.config)],
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
