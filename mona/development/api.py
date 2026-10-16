"""Authenticated Gateway API for the desktop development workbench."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

from aiohttp import web
from loguru import logger
from pydantic import Field, ValidationError

from mona.config.loader import load_config, resolve_config_env_vars
from mona.config.paths import get_data_dir
from mona.development.context import load_project_context
from mona.development.contracts import (
    Contract,
    DevelopmentView,
    ExecutorId,
    Identifier,
    PermissionMode,
    ReviewSource,
)
from mona.development.executors.diagnostics import ERRORS as NATIVE_ERRORS
from mona.development.executors.rpc import RpcError
from mona.development.model_selection import coding_models, resolve_coding_model
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError
from mona.development.workspace import (
    directory_entries,
    git_diff,
    git_summary,
    read_project_file,
    save_project_file,
)
from mona.materials.auth import SERVICES_TOKEN_HEADER, is_valid_services_token

RUNTIME_KEY = web.AppKey("development_runtime", DevelopmentRuntime)
PREFIX = "/api/development"


class ProjectBody(Contract):
    path: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=200)


class SessionBody(Contract):
    executor: ExecutorId = ExecutorId.MONA
    title: str = Field(default="新开发任务", min_length=1, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    model_provider: str | None = Field(default=None, min_length=1, max_length=200)
    model_reasoning_effort: str | None = Field(default=None, max_length=32)
    readonly: bool = False
    parent_session_id: Identifier | None = None


class SessionUpdate(Contract):
    revision: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None


class PermissionBody(Contract):
    revision: int = Field(ge=0)
    mode: PermissionMode
    confirmed: bool = False


class WorkModelSourceBody(Contract):
    executor: ExecutorId
    model: str = Field(min_length=1, max_length=200)
    provider: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=32)


class ForkBody(Contract):
    revision: int = Field(ge=0)
    request_id: Identifier
    message_id: Identifier


class ModelUpdate(Contract):
    revision: int = Field(ge=0)
    model: str | None = Field(default=None, max_length=200)


class ExecutorUpdate(ModelUpdate):
    executor: ExecutorId


class ModelSourceUpdate(ExecutorUpdate):
    provider: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=32)


class ReconnectBody(Contract):
    revision: int = Field(ge=0)
    binding_id: Identifier


class CloseUnknownBody(ReconnectBody):
    confirmed: bool = Field(strict=True)


class ExecutorSettingsUpdate(Contract):
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    values: dict[str, str | None] = Field(default_factory=dict)
    enabled_engines: list[Literal["codex", "claude", "codebuddy"]] | None = None


class PrepareResourceBody(Contract):
    pack_ref: str = Field(min_length=1, max_length=150)
    repair: bool = False


class RemoveManagedProgramBody(Contract):
    version: str | None = Field(default=None, max_length=100)


class DelegateBody(Contract):
    review_source: ReviewSource | None = None
    request_id: Identifier
    executor: ExecutorId
    goal: str = Field(min_length=1, max_length=16000)
    expected_output: str = Field(default="", max_length=8000)
    readonly: bool = False
    model: str | None = Field(default=None, max_length=200)


class DecisionBody(Contract):
    value: Any


class SendBody(Contract):
    request_id: Identifier
    content: str = Field(default="", max_length=200_000)
    intent: Literal["steering", "follow_up"] = "follow_up"
    target_run_id: Identifier | None = None
    doc_paths: list[str] = Field(default_factory=list, max_length=16)
    document_names: list[str] = Field(default_factory=list, max_length=16)


class GuideInputBody(Contract):
    revision: int = Field(ge=0)
    target_run_id: Identifier


class SaveBody(Contract):
    path: str = Field(min_length=1, max_length=4096)
    content: str = Field(max_length=1_048_576)
    expected_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ViewBody(Contract):
    view: DevelopmentView
    expected_revision: int | None = Field(default=None, ge=0)


def _wire(value: Any) -> Any:
    return value.model_dump(mode="json", by_alias=True)


def get_runtime(request: web.Request) -> DevelopmentRuntime:
    runtime = request.app.get(RUNTIME_KEY)
    if runtime is None:
        def config_loader():
            return resolve_config_env_vars(load_config())
        loop = request.app["agent_loop"]
        runtime = DevelopmentRuntime(DevelopmentStore(get_data_dir() / "development" / "state.sqlite3"),
                                     loop.sessions, config_loader, attachment_root=Path(loop.workspace))
        request.app[RUNTIME_KEY] = runtime
    return runtime


async def _body(request: web.Request, model: type[Contract]):
    return model.model_validate(await request.json())


@web.middleware
async def development_auth(request: web.Request, handler):
    if request.path != PREFIX and not request.path.startswith(PREFIX + "/"):
        return await handler(request)
    if request.method == "OPTIONS":
        return await handler(request)
    if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
        if request.path == PREFIX + "/work-model-source":
            logger.warning("Work model selection rejected: unauthorized")
        return web.json_response({"error": {"code": "unauthorized", "message": "开发服务认证失败，请重新连接 Mona。"}}, status=401)
    try:
        return await handler(request)
    except NotFoundError as exc:
        return web.json_response({"error": {"code": exc.code, "message": str(exc)}}, status=404)
    except ConflictError as exc:
        return web.json_response({"error": {"code": exc.code, "message": str(exc)}}, status=409)
    except RpcError as exc:
        if request.path == PREFIX + "/work-model-source":
            logger.warning("Work model selection rejected: {}", exc.code)
        known = NATIVE_ERRORS.get(exc.code)
        message = f"{known[1]}{known[2]}" if known else "原生执行者连接或协议检查未完成，请检查执行者设置。"
        if exc.outcome_unknown:
            message = "原生执行结果暂时无法确认，原任务仍保留；没有自动重新执行。"
        return web.json_response({"error": {"code": exc.code, "message": message}}, status=503 if exc.outcome_unknown else 422)
    except DevelopmentError as exc:
        if request.path == PREFIX + "/work-model-source":
            logger.warning("Work model selection rejected: {}", exc.code)
        return web.json_response({"error": {"code": exc.code, "message": str(exc)}}, status=422)
    except (ValidationError, ValueError, TypeError):
        if request.path == PREFIX + "/work-model-source":
            logger.warning("Work model selection rejected: invalid_request")
        return web.json_response({"error": {"code": "invalid_request", "message": "请求内容无效，请检查项目、会话和输入参数。"}}, status=400)
    except FileNotFoundError:
        return web.json_response({"error": {"code": "path_missing", "message": "文件或目录不存在，请刷新工作区。"}}, status=404)
    except PermissionError:
        return web.json_response({"error": {"code": "access_denied", "message": "当前路径不可访问，未读取或修改。"}}, status=403)
    except asyncio.TimeoutError:
        return web.json_response({"error": {"code": "read_timeout", "message": "读取超时，请缩小范围或稍后重试。"}}, status=504)
    except web.HTTPException:
        raise
    except Exception as exc:
        logger.error("Development request failed ({})", type(exc).__name__)
        return web.json_response({"error": {"code": "internal_error", "message": "开发服务操作失败，未自动重试。请查看已保留的状态。"}}, status=500)


async def native_login_status(request):
    result = await get_runtime(request).native.login_status(
        request.match_info.get("project_id"), ExecutorId(request.match_info["executor"]),
        cancel_id=request.match_info.get("login_id") if request.method == "DELETE" else None)
    return web.json_response(result)


async def native_account_usage_changes(request):
    after = int(request.query.get("after", "-1"))
    return web.json_response(await get_runtime(request).native.account_usage_changes(ExecutorId(request.match_info["executor"]), after), headers={"Cache-Control": "no-store"})


async def native_account_usage(request):
    return web.json_response(await get_runtime(request).native.account_usage(ExecutorId(request.match_info["executor"])), headers={"Cache-Control": "no-store"})


async def provider_executors(request):
    # Read-only detection. Merely opening settings never starts or logs in a CLI.
    runtime = get_runtime(request)
    return web.json_response({"executors": await asyncio.to_thread(runtime.native.describe)})


async def select_work_model_source(request):
    from mona.config.loader import save_config
    from mona.webui.settings_api import settings_payload, update_agent_settings

    body = await _body(request, WorkModelSourceBody)
    runtime = get_runtime(request)
    if body.executor == ExecutorId.MONA:
        resolve_coding_model(runtime.config_loader(), body.model, body.provider, body.effort, require_visible=True)
        query = {"provider": [body.provider], "model": [body.model], "provider_model": [body.model],
                 "reasoning_effort": [body.effort or "none"]}
        return web.json_response(update_agent_settings(query))
    if body.provider is not None:
        raise DevelopmentError("invalid_model_source", "请选择该引擎自身的模型来源。")
    source = next((item for item in await asyncio.to_thread(runtime.native.describe)
                   if item["id"] == body.executor.value), None)
    if not source or not source["available"]:
        raise DevelopmentError("executor_unavailable", "此模型来源不可用，请在模型设置中检查连接。")
    if (source["probe"].get("authentication") != "ready"
            or not any(item["id"] == body.model for item in source["models"])):
        probe = await runtime.native.probe(None, body.executor)
        if probe.get("errorCode") and probe["errorCode"] != "authentication_required":
            raise RpcError(probe["errorCode"], "模型来源检查未完成。")
        source = next((item for item in await asyncio.to_thread(runtime.native.describe)
                       if item["id"] == body.executor.value), None)
        if not source or not source["available"]:
            raise DevelopmentError("executor_unavailable", "此模型来源不可用，请在模型设置中检查连接。")
    if source["probe"].get("authentication") != "ready":
        raise DevelopmentError("authentication_required", "请先在模型设置中连接此账号。")
    choice = next((item for item in source["models"] if item["id"] == body.model), None)
    if not choice:
        raise DevelopmentError("invalid_model", "模型目录已变化，请刷新后重新选择。")
    if body.effort is not None and body.effort not in choice.get("reasoningEfforts", []):
        raise DevelopmentError("unsupported_reasoning_effort", "当前模型不支持所选思考强度。")
    config = runtime.config_loader()
    config.agents.defaults.executor = body.executor.value
    config.agents.defaults.native_model = body.model
    config.agents.defaults.native_reasoning_effort = body.effort
    config.agents.defaults.native_context_window_tokens = choice.get("contextWindow")
    config.agents.defaults.model_preset = None
    await asyncio.to_thread(save_config, config)
    return web.json_response(await asyncio.to_thread(settings_payload))


async def capabilities(request):
    runtime = get_runtime(request)
    config = runtime.config_loader()
    preset = config.resolve_preset(config.development.model_preset)
    def preset_row(name, value):
        provider = value.provider if value.provider != "auto" else config.get_provider_name(value.model)
        return {"id": name, "label": f"{name or '默认'} · {value.model}", "model": value.model,
                "provider": provider, "providerLabel": provider, "preset": True}
    models = [preset_row("", preset)]
    models.extend(preset_row(name, p) for name, p in config.model_presets.items())
    models.extend(await asyncio.to_thread(coding_models, config))
    executors = [{"id": "mona", "name": "Mona Coding", "available": True, "reason": "", "models": models}]
    executors.extend(await asyncio.to_thread(runtime.native.describe, request.query.get("projectId")))
    return web.json_response({"executors": executors, "schemaVersion": 1})


async def projects(request):
    runtime = get_runtime(request)
    if request.method == "POST":
        body = await _body(request, ProjectBody)
        return web.json_response(_wire(runtime.store.open_project(Path(body.path), body.name)))
    return web.json_response([_wire(p) for p in runtime.store.list_projects()])


async def sessions(request):
    runtime = get_runtime(request)
    project_id = request.match_info["project_id"]
    if request.method == "POST":
        body = await _body(request, SessionBody)
        if body.executor == ExecutorId.MONA:
            if body.model_provider is not None:
                resolve_coding_model(runtime.config_loader(), body.model, body.model_provider,
                                     body.model_reasoning_effort, require_visible=True)
            elif body.model_reasoning_effort is not None:
                raise DevelopmentError("invalid_model_source", "请通过模型来源选择推理强度。")
            elif body.model:
                runtime.config_loader().resolve_preset(body.model)
        elif body.model_provider is not None:
            raise DevelopmentError("unsupported_model_route", "原生引擎使用自己的模型来源，请选择对应来源的模型。")
        else:
            if body.executor.value not in runtime.config_loader().development.enabled_engines:
                raise DevelopmentError("engine_disabled", "此模型来源已停用，请在模型设置中启用后再调用。")
            runtime.native.validate_effort(project_id, body.executor, body.model, body.model_reasoning_effort)
        value = runtime.store.create_session(project_id, body.executor, body.title, body.model,
                                            readonly=body.readonly, parent_session_id=body.parent_session_id,
                                            model_provider=body.model_provider,
                                            model_reasoning_effort=body.model_reasoning_effort,
                                            permission_mode=PermissionMode(runtime.config_loader().development.permissions.default_mode))
        return web.json_response(_wire(value))
    latest = runtime.store.latest_runs_for_project(project_id)
    values = [runtime.resolve_session_title(item) for item in runtime.store.list_sessions(project_id)]
    return web.json_response([{**_wire(s), "latestRun": _wire(latest[s.id]) if s.id in latest else None}
                              for s in values])


async def update_permissions(request):
    body = await _body(request, PermissionBody)
    value = await get_runtime(request).set_permission_mode(request.match_info["session_id"], body.revision,
        body.mode, confirmed=body.confirmed)
    return web.json_response(_wire(value))


async def update_session(request):
    runtime = get_runtime(request)
    body = await _body(request, SessionUpdate)
    return web.json_response(_wire(runtime.store.update_session(request.match_info["session_id"], body.revision,
                                       title=body.title, pinned=body.pinned, archived=body.archived)))


async def fork_session(request):
    from mona.development.fork import fork_session as fork

    body = await _body(request, ForkBody)
    result = await fork(get_runtime(request), request.match_info["session_id"], body.revision, body.request_id, body.message_id)
    return web.json_response(_wire(result))


async def select_model_source(request):
    body = await _body(request, ModelSourceUpdate)
    result = await get_runtime(request).select_model_source(request.match_info["session_id"],
        body.revision, body.executor, body.model, body.provider, body.effort)
    return web.json_response(_wire(result))


async def update_model(request):
    runtime = get_runtime(request)
    body = await _body(request, ModelUpdate)
    session = runtime.store.get_session(request.match_info["session_id"])
    if session.model_provider:
        result = await runtime.select_model_source(session.id, body.revision, session.executor, body.model,
                                                  session.model_provider, None)
    elif session.executor == ExecutorId.MONA:
        runtime.config_loader().resolve_preset(body.model)
        result = runtime.store.update_model(session.id, body.revision, body.model)
    else:
        result = await runtime.switch_executor(session.id, body.revision, session.executor, body.model)
    return web.json_response(_wire(result))


async def switch_executor(request):
    body = await _body(request, ExecutorUpdate)
    result = await get_runtime(request).switch_executor(request.match_info["session_id"], body.revision, body.executor, body.model)
    return web.json_response(_wire(result))


async def reconnect_native(request):
    body = await _body(request, ReconnectBody)
    result = await get_runtime(request).reconnect_native(request.match_info["session_id"], body.revision, body.binding_id)
    return web.json_response(_wire(result))


async def collaborations(request):
    runtime = get_runtime(request)
    parent = request.match_info["session_id"]
    if request.method == "GET":
        return web.json_response(await runtime.collaboration.observe(parent))
    body = await _body(request, DelegateBody)
    return web.json_response(await runtime.collaboration.start(parent, body.request_id, body.executor,
        body.goal, body.expected_output, body.readonly, body.model, review_source=body.review_source))


async def executor_settings(request):
    from mona.development.settings import read_settings, update_settings
    runtime = get_runtime(request)
    if request.method == "GET":
        return web.json_response(await asyncio.to_thread(read_settings))
    body = await _body(request, ExecutorSettingsUpdate)
    if body.values:
        async with runtime.native.configuration_change():
            result = await asyncio.to_thread(update_settings, body.revision, body.values, enabled_engines=body.enabled_engines)
    else:
        result = await asyncio.to_thread(update_settings, body.revision, body.values, enabled_engines=body.enabled_engines)
    return web.json_response(result)


async def native_probe(request):
    runtime = get_runtime(request)
    executor = ExecutorId(request.match_info["executor"])
    project_id = request.match_info.get("project_id")
    action = request.match_info["action"]
    result = await (runtime.native.login(project_id, executor) if action == "login"
                    else runtime.native.logout(executor) if action == "logout"
                    else runtime.native.probe(project_id, executor))
    return web.json_response(result)


async def engine_resources(request):
    from mona.development.resources import resource_status
    return web.json_response(await resource_status(get_runtime(request).config_loader().development,
        request.query.get("executor", "codex"), refresh=request.query.get("refresh") == "true"))


async def prepare_executor_resource(request):
    from mona.development.resources import prepare_resource
    body = await _body(request, PrepareResourceBody)
    return web.json_response(await prepare_resource(request.match_info["executor"], body.pack_ref,
        get_runtime(request).config_loader().development, repair=body.repair), status=202)


async def executor_resource_job(request):
    from mona.development.resources import resource_job
    return web.json_response(await resource_job(request.match_info["executor"], request.match_info["job_id"],
        cancel=request.method == "DELETE"))


async def remove_managed_executor(request):
    from mona.development.resources import remove_managed_resource
    runtime = get_runtime(request)
    executor = request.match_info["executor"]
    body = await _body(request, RemoveManagedProgramBody)
    return web.json_response(await remove_managed_resource(executor, runtime.native, expected_version=body.version))


async def decision(request):
    body = await _body(request, DecisionBody)
    get_runtime(request).native.decisions.resolve(request.match_info["session_id"], request.match_info["decision_id"], body.value)
    return web.json_response({"ok": True})


async def recover_native(request):
    result = await get_runtime(request).recover_native(request.match_info["session_id"], request.match_info["run_id"])
    return web.json_response(_wire(result))


async def read_message(request):
    result = get_runtime(request).read_message(request.match_info["session_id"], request.match_info["message_id"],
        int(request.query.get("offset", "0")), request.query.get("sha256"))
    return web.json_response(result)


async def background_command(request):
    runtime = get_runtime(request)
    session = runtime.store.get_session(request.match_info["session_id"])
    stopping = request.method == "POST"
    if stopping and session.readonly:
        raise DevelopmentError("readonly_session", "只读会话不能停止命令。")
    tools = runtime.tools.get(session.id)
    if tools is None or tools.session_key != session.transcript_key:
        raise NotFoundError()
    try:
        manager = tools.exec_sessions
        command_id = request.match_info["command_id"]
        result = await manager.stop(command_id) if stopping else await manager.inspect(command_id)
    except KeyError:
        raise NotFoundError() from None
    except RuntimeError:
        if not stopping:
            raise
        raise ConflictError("未确认命令已停止，请核对当前运行状态。") from None
    return web.json_response(result)


async def snapshot(request):
    before = request.query.get("before")
    limit, after = int(request.query.get("limit", "100")), int(request.query.get("after", "0"))
    if not 1 <= limit <= 200 or after < 0 or (before is not None and int(before) < 0):
        raise ValueError("Invalid page")
    runtime = get_runtime(request)
    session_id = request.match_info["session_id"]
    runtime.store.get_session(session_id)
    runtime.native.service.restore_generated_images(session_id)
    runtime.schedule_recovery(session_id)
    watch = request.query.get("watch")
    if watch is not None:
        if before is not None or len(watch) > 100:
            raise ValueError("Invalid watch cursor")
        await runtime.updates.wait(watch)
        if runtime._closed:
            raise web.HTTPServiceUnavailable()
    return web.json_response(runtime.snapshot(session_id,
        before=int(before) if before is not None else None, limit=limit, after=after))


async def send(request):
    body = await _body(request, SendBody)
    return web.json_response(await get_runtime(request).submit(
        request.match_info["session_id"], body.request_id, body.content, intent=body.intent,
        doc_paths=body.doc_paths, document_names=body.document_names, target_run_id=body.target_run_id,
    ))


async def interrupt(request):
    return web.json_response(_wire(await get_runtime(request).interrupt(request.match_info["session_id"], request.match_info["run_id"])))


async def close_unknown(request):
    body = await _body(request, CloseUnknownBody)
    if not body.confirmed:
        raise ConflictError("请先确认已核对项目文件和执行程序。")
    return web.json_response(_wire(await get_runtime(request).close_unknown(
        request.match_info["session_id"], request.match_info["run_id"], body.revision, body.binding_id)))


async def cancel_input(request):
    await get_runtime(request).cancel_input(request.match_info["session_id"], request.match_info["input_id"])
    return web.json_response({"ok": True})


async def guide_input(request):
    body = await _body(request, GuideInputBody)
    return web.json_response(await get_runtime(request).guide_input(
        request.match_info["session_id"], request.match_info["input_id"], body.revision, body.target_run_id))


async def view(request):
    store = get_runtime(request).store
    if request.method == "PUT":
        body = await _body(request, ViewBody)
        if body.view.id != request.match_info["view_id"]:
            raise ConflictError("视图标识不匹配。")
        return web.json_response(_wire(store.save_view(body.view, body.expected_revision)))
    return web.json_response(_wire(store.get_view(request.match_info["view_id"])))


async def workspace(request):
    runtime = get_runtime(request)
    project = runtime.store.get_project(request.match_info["project_id"])
    section = request.match_info["section"]
    path = request.query.get("path", "")
    if section == "directory" and request.method == "GET":
        result = await asyncio.to_thread(directory_entries, project, path, int(request.query.get("offset", "0")))
    elif section == "file":
        if request.method == "PUT":
            body = await _body(request, SaveBody)
            result = await asyncio.to_thread(save_project_file, project, body.path, body.content, body.expected_sha256)
        else:
            result = await asyncio.to_thread(read_project_file, project, path)
        try:
            result["fileActivity"] = runtime.store.file_activity(project.id, result["path"])
        except Exception:
            # Advisory metadata cannot turn an already-saved file into a failed
            # acknowledgement. Unavailable is not proof that no other task exists.
            result["fileActivity"] = {"available": False, "tasks": [], "checkedAt": None, "partial": True}
    elif section == "git" and request.method == "GET":
        result = await git_summary(project, refresh=request.query.get("refresh") == "true")
    elif section == "diff" and request.method == "GET":
        result = await git_diff(project, path)
    elif section == "context" and request.method == "GET":
        context = load_project_context(project, runtime.config_loader().development)
        result = {"rules": [{"path": r.path, "sha256": r.sha256} for r in context.rules],
            "skills": [{"name": s.name, "description": s.description, "path": s.path} for s in context.skills],
            "issues": context.issues}
    else:
        raise web.HTTPNotFound()
    return web.json_response(result)


async def _cleanup(app):
    if RUNTIME_KEY in app:
        await app[RUNTIME_KEY].close()


def register_development_routes(app: web.Application) -> None:
    from mona.development.workbench_api import register_workbench_routes
    register_workbench_routes(app)
    app.middlewares.append(development_auth)
    app.on_cleanup.append(_cleanup)
    app.router.add_get(PREFIX + "/projects/{project_id}/executors/{executor}/login", native_login_status)
    app.router.add_delete(PREFIX + "/projects/{project_id}/executors/{executor}/login/{login_id}", native_login_status)
    app.router.add_get(PREFIX + "/capabilities", capabilities)
    app.router.add_put(PREFIX + "/sessions/{session_id}/model-source", select_model_source)
    app.router.add_put(PREFIX + "/sessions/{session_id}/permissions", update_permissions)
    app.router.add_get(PREFIX + "/provider-executors", provider_executors)
    app.router.add_put(PREFIX + "/work-model-source", select_work_model_source)
    app.router.add_get(PREFIX + "/provider-executors/{executor}/usage", native_account_usage)
    app.router.add_get(PREFIX + "/provider-executors/{executor}/usage/changes", native_account_usage_changes)
    app.router.add_post(PREFIX + "/provider-executors/{executor}/{action:probe|login|logout}", native_probe)
    app.router.add_get(PREFIX + "/provider-executors/{executor}/login", native_login_status)
    app.router.add_delete(PREFIX + "/provider-executors/{executor}/login/{login_id}", native_login_status)
    app.router.add_get(PREFIX + "/sessions/{session_id}/collaborations", collaborations)
    app.router.add_post(PREFIX + "/sessions/{session_id}/collaborations", collaborations)
    app.router.add_get(PREFIX + "/executor-settings", executor_settings)
    app.router.add_put(PREFIX + "/executor-settings", executor_settings)
    app.router.add_get(PREFIX + "/engine-resources", engine_resources)
    app.router.add_post(PREFIX + "/executors/{executor}/prepare", prepare_executor_resource)
    app.router.add_get(PREFIX + "/executors/{executor}/install/{job_id}", executor_resource_job)
    app.router.add_delete(PREFIX + "/executors/{executor}/install/{job_id}", executor_resource_job)
    app.router.add_delete(PREFIX + "/executors/{executor}/managed-program", remove_managed_executor)
    app.router.add_post(PREFIX + "/projects/{project_id}/executors/{executor}/{action:probe|login}", native_probe)
    app.router.add_put(PREFIX + "/sessions/{session_id}/executor", switch_executor)
    app.router.add_post(PREFIX + "/sessions/{session_id}/reconnect", reconnect_native)
    app.router.add_post(PREFIX + "/sessions/{session_id}/decisions/{decision_id}", decision)
    app.router.add_post(PREFIX + "/sessions/{session_id}/runs/{run_id}/recover", recover_native)
    app.router.add_post(PREFIX + "/sessions/{session_id}/runs/{run_id}/close-unknown", close_unknown)
    app.router.add_get(PREFIX + "/sessions/{session_id}/messages/{message_id}", read_message)
    app.router.add_get(PREFIX + "/sessions/{session_id}/commands/{command_id}", background_command)
    app.router.add_post(PREFIX + "/sessions/{session_id}/commands/{command_id}/stop", background_command)
    for method in ("GET", "POST"):
        app.router.add_route(method, PREFIX + "/projects", projects)
        app.router.add_route(method, PREFIX + "/projects/{project_id}/sessions", sessions)
    app.router.add_patch(PREFIX + "/sessions/{session_id}", update_session)
    app.router.add_post(PREFIX + "/sessions/{session_id}/fork", fork_session)
    app.router.add_put(PREFIX + "/sessions/{session_id}/model", update_model)
    app.router.add_get(PREFIX + "/sessions/{session_id}/snapshot", snapshot)
    app.router.add_post(PREFIX + "/sessions/{session_id}/send", send)
    app.router.add_post(PREFIX + "/sessions/{session_id}/runs/{run_id}/interrupt", interrupt)
    app.router.add_delete(PREFIX + "/sessions/{session_id}/inputs/{input_id}", cancel_input)
    app.router.add_post(PREFIX + "/sessions/{session_id}/inputs/{input_id}/guide", guide_input)
    app.router.add_get(PREFIX + "/views/{view_id}", view)
    app.router.add_put(PREFIX + "/views/{view_id}", view)
    app.router.add_get(PREFIX + "/projects/{project_id}/{section:directory|file|git|diff|context}", workspace)
    app.router.add_put(PREFIX + "/projects/{project_id}/{section:file}", workspace)
