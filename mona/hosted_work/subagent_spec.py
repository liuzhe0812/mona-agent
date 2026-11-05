"""Construct fresh hosted inputs for the application's shared subagent runner."""
from __future__ import annotations

import json

from mona.agent.context import ContextBuilder
from mona.agent.hook import AgentHook, CompositeHook
from mona.agent.runner import AgentRunSpec
from mona.config.schema import AgentDefaults
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.editor_tools import _HostedOfficeTool, build_editor_tools
from mona.hosted_work.tools import HostedTools
from mona.utils.prompt_templates import render_template


class _AuthorizationHook(AgentHook):
    def __init__(self, authorize):
        super().__init__(reraise=True)
        self.authorize = authorize

    async def before_iteration(self, context):
        if self.authorize is not None:
            await self.authorize()

    async def before_execute_tools(self, context):
        if self.authorize is not None:
            await self.authorize()


def build_subagent_factory(ctx, payload, sandbox, provider, emit, authorize, editor_tools=(),
                           *, progress_callback=None):
    """Return a shared-manager spec factory and the tools to flush after exit.

    Construction itself binds no capability context. The shared manager calls
    the async factory inside each child's task, where HostedTools creates a
    fresh capability set, Skill loader, file reader and pending-delivery list.
    No child session store or parent model-input snapshot is constructed.
    """
    session_id = ctx.session_id
    if (payload.get("session_id", session_id) != session_id
            or ctx.session.key != "websocket:" + session_id
            or payload.get("owner") != getattr(ctx, "owner", payload.get("owner"))
            or getattr(ctx, "provider", provider) is not provider):
        raise WorkError("session_scope", "子任务运行配置不属于当前会话。", 403)
    metadata = {key: value for key, value in (payload.get("metadata") or {}).items() if key in {
        "ui_theme", "office_session_id", "office_document_type", "office_display_name", "canvas_id", "canvas_path",
    }}
    attachments = tuple(dict(item) for item in payload.get("attachments", ()) if isinstance(item, dict))
    editor_payload = {key: payload.get(key) for key in ("owner", "session_id", "run_id", "account_token")}
    editor_payload["metadata"] = metadata
    parent_editors = tuple(tool for tool in editor_tools if tool.name in {"office", "canvas"})
    parent_office = next((tool for tool in parent_editors if isinstance(tool, _HostedOfficeTool)), None)
    child_tools = []

    async def factory(task_id, task, origin, hook, checkpoint):
        if (origin.get("channel") != "websocket" or origin.get("chat_id") != session_id
                or origin.get("session_key") != ctx.session.key):
            raise WorkError("session_scope", "子任务不属于当前会话。", 403)
        editors = parent_editors
        if payload.get("owner") is not None:
            editors = ()
            if payload.get("desktop_ui"):
                if parent_office is None or any(
                    getattr(parent_office.scope, name) != editor_payload[name]
                    for name in ("owner", "session_id", "run_id")
                ):
                    raise WorkError("session_scope", "子任务文档服务不属于当前会话。", 403)
                editors = build_editor_tools(ctx.config, editor_payload, emit)
                child_office = next(tool for tool in editors if isinstance(tool, _HostedOfficeTool))
                # Share only this run's verified document identities. Office
                # sessions, working copies and expected_delivery stay local so
                # the parent can deliver child exports without racing that state.
                child_office._delivery_bus.delivered = parent_office._delivery_bus.delivered
        tools = HostedTools(sandbox, emit, editors, session_id=session_id, history=(), config=ctx.config,
                            metadata=metadata, attachments=attachments)
        if getattr(ctx, "_runtime", None) is not None:
            from mona.hosted_work.owner_memory import build_memory_tools

            for tool in build_memory_tools(ctx):
                tools.registry.register(tool)
                tools.skills.allowed_names.add(tool.name)
                tools.skills.initial_names.add(tool.name)
                allowed = tools.registry.get_allowed_tool_names()
                if allowed is not None:
                    tools.registry.set_allowed_tool_names(allowed | {tool.name})
        child_tools.append(tools)
        system = render_template(
            "agent/subagent_system.md", time_ctx="", workspace="/workspace",
            skills_summary=json.dumps(tools.skills.catalog(), ensure_ascii=False),
        )
        supplemental = ContextBuilder._attachment_runtime_lines({"_attachment_paths": [
            item["path"] for item in attachments if isinstance(item.get("path"), str)
        ]})
        if metadata.get("ui_theme") in {"light", "dark"}:
            supplemental.append("Current UI Theme: " + metadata["ui_theme"])
        runtime = ContextBuilder._build_runtime_context(
            "websocket", session_id, getattr(ctx.builder, "timezone", None),
            supplemental_lines=supplemental,
            office_session_id=metadata.get("office_session_id"),
            office_document_type=metadata.get("office_document_type"),
            office_display_name=metadata.get("office_display_name"),
        )
        selection, window = ctx.selection, ctx.window
        return AgentRunSpec(
            initial_messages=[{"role": "system", "content": system},
                              {"role": "user", "content": task + "\n\n" + runtime}],
            tools=tools.registry, model=selection.model,
            max_iterations=ctx.config.max_iterations, max_tool_result_chars=100_000,
            max_tokens=selection.max_output_tokens, reasoning_effort=selection.reasoning_effort,
            hook=CompositeHook([_AuthorizationHook(authorize), hook]), checkpoint_callback=checkpoint,
            progress_callback=progress_callback,
            context_provider="mona_managed", context_window_tokens=window.tokens,
            context_window_verified=window.source != "default", context_block_limit=selection.context_window_tokens,
            provider_retry_mode="standard", concurrent_tools=True, max_parallel_tool_calls=AgentDefaults().max_parallel_tool_calls,
            fail_on_tool_error=False, llm_timeout_s=ctx.config.run_timeout_seconds,
            enforce_llm_timeout_for_streaming=True, session_key=ctx.session.key,
            error_message=None, max_iterations_message="本轮达到执行步数上限，已有进度已保留。",
        )

    return factory, child_tools
