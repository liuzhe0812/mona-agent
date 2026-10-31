"""Create workbench sessions through the same validation for all callers."""

from __future__ import annotations

from typing import TYPE_CHECKING

from mona.development.contracts import DevelopmentSession, ExecutorId, PermissionMode
from mona.development.model_selection import resolve_coding_model
from mona.development.store import DevelopmentError

if TYPE_CHECKING:
    from mona.development.runtime import DevelopmentRuntime


def create_session(
    runtime: DevelopmentRuntime,
    project_id: str,
    *,
    request_id: str | None = None,
    executor: ExecutorId = ExecutorId.MONA,
    title: str = "新开发任务",
    model: str | None = None,
    model_provider: str | None = None,
    model_reasoning_effort: str | None = None,
    readonly: bool = False,
    parent_session_id: str | None = None,
) -> DevelopmentSession:
    fields = {
        "executor": executor,
        "title": title,
        "model": model,
        "model_provider": model_provider,
        "model_reasoning_effort": model_reasoning_effort,
        "readonly": readonly,
        "parent_session_id": parent_session_id,
    }
    if request_id is not None:
        existing = runtime.store.find_session_creation(project_id, request_id, fields)
        if existing is not None:
            return existing
    if executor == ExecutorId.MONA:
        if model_provider is not None:
            resolve_coding_model(runtime.config_loader(), model, model_provider,
                                 model_reasoning_effort, require_visible=True)
        elif model_reasoning_effort is not None:
            raise DevelopmentError("invalid_model_source", "请通过模型来源选择推理强度。")
        elif model:
            try:
                runtime.config_loader().resolve_preset(model)
            except KeyError as exc:
                raise DevelopmentError("model_preset_not_found", "模型预设不存在，请选择已有的开发模型来源。") from exc
    elif model_provider is not None:
        raise DevelopmentError("unsupported_model_route", "原生引擎使用自己的模型来源，请选择对应来源的模型。")
    else:
        if executor.value not in runtime.config_loader().development.enabled_engines:
            raise DevelopmentError("engine_disabled", "此模型来源已停用，请在模型设置中启用后再调用。")
        runtime.native.validate_effort(project_id, executor, model, model_reasoning_effort)
    return runtime.store.create_session(
        project_id, executor, title, model,
        readonly=readonly, parent_session_id=parent_session_id,
        model_provider=model_provider, model_reasoning_effort=model_reasoning_effort,
        permission_mode=PermissionMode(runtime.config_loader().development.permissions.default_mode),
        request_id=request_id,
    )
