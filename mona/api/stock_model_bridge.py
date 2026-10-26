"""Instance-scoped OpenAI model transport; Vibe owns every research/tool loop."""

from __future__ import annotations

import asyncio
import hmac
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from aiohttp import web

from mona.config.loader import load_config
from mona.config.schema import Config
from mona.development.input_content import validate_content
from mona.development.store import DevelopmentError
from mona.materials.auth import SERVICES_TOKEN_HEADER, is_valid_services_token
from mona.providers.base import ToolCallRequest
from mona.providers.factory import ProviderSnapshot, build_provider_snapshot
from mona.providers.native_work_provider import NativeWorkProvider, _native_history_blocks
from mona.providers.registry import find_by_name


@dataclass
class _NativeTurn:
    provider: NativeWorkProvider
    workspace: TemporaryDirectory
    pending: set[str] = field(default_factory=set)
    busy: bool = True


class StockModelBridge:
    def __init__(self, snapshot: ProviderSnapshot) -> None:
        self.snapshot = snapshot
        self.token = secrets.token_urlsafe(32)
        self.active = 0
        self.selection: str | None = None
        self.binding: dict | None = None
        self._native_turns: dict[str, _NativeTurn] = {}
        self._native_pending: dict[str, str] = {}

    @classmethod
    def from_config(cls, config: Config) -> StockModelBridge:
        config = config.model_copy(deep=True)
        binding = config.stock_vibe.model_binding
        config.agents.defaults.fallback_models = []
        if binding is not None:
            if binding.executor not in config.development.enabled_engines:
                raise ValueError("所选模型引擎已停用")
            defaults = config.agents.defaults
            if (defaults.executor, defaults.native_model) != (binding.executor, binding.model):
                defaults.native_context_window_tokens = None
            defaults.model_preset = None
            defaults.executor = binding.executor
            defaults.native_model = binding.model
            defaults.native_reasoning_effort = binding.effort
            bridge = cls(build_provider_snapshot(config))
            bridge.binding = binding.model_dump(mode="json")
            return bridge
        preset_name = config.stock_vibe.model_preset
        if not preset_name or preset_name != "default" and preset_name not in config.model_presets:
            raise ValueError("股票研究尚未选择模型预设")
        preset = config.resolve_preset(preset_name)
        provider_name = config.get_provider_name(preset.model, preset=preset)
        spec = find_by_name(provider_name) if provider_name else None
        # API presets retain their independently verified protocol contract.
        if spec is None or spec.backend != "openai_compat":
            raise ValueError("所选模型来源尚未通过股票模型桥接验证")
        bridge = cls(build_provider_snapshot(config, preset_name=preset_name))
        bridge.selection = preset_name
        return bridge

    def metadata(self) -> dict[str, Any]:
        generation = self.snapshot.provider.generation
        return {"selection": self.selection, "binding": self.binding,
                "model": self.snapshot.model, "max_tokens": generation.max_tokens,
                "temperature": generation.temperature, "reasoning_effort": generation.reasoning_effort,
                "context_window_tokens": self.snapshot.context_window_tokens,
                "context_window_verified": self.snapshot.context_window_verified}

    def _native_turn(self, messages: list[dict]) -> tuple[str, _NativeTurn] | None:
        if self.binding is None:
            return None
        results = [item.get("tool_call_id") for item in messages if item.get("role") == "tool"]
        if any(not isinstance(value, str) or not value for value in results):
            raise web.HTTPBadRequest(reason="invalid tool result identifier")
        keys = {self._native_pending[value] for value in results if value in self._native_pending}
        if len(keys) > 1:
            raise web.HTTPConflict(reason="tool results belong to different model turns")
        if keys:
            key = keys.pop()
            turn = self._native_turns[key]
            if turn.busy or any(results.count(value) != 1 for value in turn.pending):
                raise web.HTTPConflict(reason="model turn is busy or tool results are incomplete")
            turn.busy = True
            return key, turn
        if messages[-1].get("role") == "tool":
            raise web.HTTPConflict(reason="model turn expired; tool results cannot be replayed")
        try:
            # Never silently omit Vibe's financial evidence to fit native transport.
            validate_content(_native_history_blocks(messages))
        except DevelopmentError as exc:
            raise web.HTTPBadRequest(reason="model input exceeds native transport limits") from exc
        workspace = TemporaryDirectory(prefix="mona-stock-model-")
        turn = _NativeTurn(self.snapshot.provider.for_turn(Path(workspace.name)), workspace)
        key = secrets.token_hex(16)
        self._native_turns[key] = turn
        return key, turn

    def _retain_native_turn(self, key: str, calls: list[ToolCallRequest]) -> None:
        turn = self._native_turns[key]
        for value in turn.pending:
            self._native_pending.pop(value, None)
        turn.pending = {call.id for call in calls}
        self._native_pending.update((value, key) for value in turn.pending)
        turn.busy = False

    async def _close_native_turn(self, key: str) -> None:
        turn = self._native_turns.pop(key)
        for value in turn.pending:
            self._native_pending.pop(value, None)
        try:
            await turn.provider.aclose()
        finally:
            turn.workspace.cleanup()

    async def aclose(self) -> None:
        for key in list(self._native_turns):
            await self._close_native_turn(key)
        await self.snapshot.provider.aclose()

    async def complete(self, request: web.Request) -> web.StreamResponse:
        authorization = request.headers.get("Authorization", "")
        if not hmac.compare_digest(authorization, f"Bearer {self.token}"):
            raise web.HTTPUnauthorized()
        self.active += 1
        try:
            return await self._complete(request)
        finally:
            self.active -= 1

    async def _complete(self, request: web.Request) -> web.StreamResponse:
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError) as exc:
            raise web.HTTPBadRequest(reason="invalid JSON") from exc
        if not isinstance(body, dict) or body.get("model") != self.snapshot.model:
            raise web.HTTPBadRequest(reason="model does not match the bound snapshot")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages or any(
            not isinstance(item, dict) or item.get("role") not in {"system", "developer", "user", "assistant", "tool"}
            for item in messages
        ):
            raise web.HTTPBadRequest(reason="invalid messages")
        tools = body.get("tools")
        if tools is not None and not isinstance(tools, list):
            raise web.HTTPBadRequest(reason="invalid tools")
        generation = self.snapshot.provider.generation
        maximum = body.get("max_tokens", body.get("max_completion_tokens", generation.max_tokens))
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
            raise web.HTTPBadRequest(reason="invalid token limit")
        arguments = dict(messages=messages, tools=tools, model=self.snapshot.model,
                         max_tokens=min(maximum, generation.max_tokens), temperature=generation.temperature,
                         reasoning_effort=generation.reasoning_effort, tool_choice=body.get("tool_choice"))
        stream = body.get("stream", False)
        if not isinstance(stream, bool):
            raise web.HTTPBadRequest(reason="invalid stream option")
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-store"})
        completion_id = "chatcmpl_" + secrets.token_hex(16)
        created = int(time.time())
        text_sent = False
        reasoning_sent = False
        tools_sent: set[int] = set()
        tool_ids_sent: set[int] = set()

        async def chunk(delta: dict, *, finish=None, usage=None) -> None:
            payload = {"id": completion_id, "object": "chat.completion.chunk", "created": created,
                       "model": self.snapshot.model, "choices": [
                           {"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage is not None:
                payload["usage"] = usage
            await response.write(("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode())

        async def content_delta(content: str) -> None:
            nonlocal text_sent
            text_sent = True
            await chunk({"content": content})

        async def reasoning_delta(content: str) -> None:
            nonlocal reasoning_sent
            reasoning_sent = True
            await chunk({"reasoning_content": content})

        async def tool_delta(delta: dict) -> None:
            index = delta.get("index", 0)
            tools_sent.add(index)
            wire: dict = {"index": index, "function": {}}
            if delta.get("call_id"):
                wire.update(id=delta["call_id"], type="function")
                tool_ids_sent.add(index)
            if delta.get("name"):
                wire["function"]["name"] = delta["name"]
            if "arguments_delta" in delta:
                wire["function"]["arguments"] = delta["arguments_delta"]
            await chunk({"tool_calls": [wire]})

        async def cancel_on_disconnect(task: asyncio.Task) -> None:
            while not task.done():
                if request.transport is None or request.transport.is_closing():
                    task.cancel()
                    return
                await asyncio.sleep(0.1)

        lease = self._native_turn(messages)
        provider = lease[1].provider if lease else self.snapshot.provider
        retained = False
        task = monitor = None
        try:
            if stream:
                await response.prepare(request)
                await chunk({"role": "assistant"})
                task = asyncio.create_task(provider.chat_stream(
                    **arguments, on_content_delta=content_delta, on_thinking_delta=reasoning_delta,
                    on_tool_call_delta=tool_delta,
                ))
            else:
                task = asyncio.create_task(provider.chat(**arguments))
            monitor = asyncio.create_task(cancel_on_disconnect(task))
            result = await task
            if result.finish_reason == "error":
                error = {"error": {"code": "model_error", "message": "模型请求失败，请检查所选模型设置。"}}
                if not stream:
                    return web.json_response(error, status=502)
                await response.write(("data: " + json.dumps(error, ensure_ascii=False) + "\n\n").encode())
            elif stream:
                if result.content and not text_sent:
                    await content_delta(result.content)
                if result.reasoning_content and not reasoning_sent:
                    await reasoning_delta(result.reasoning_content)
                for index, tool in enumerate(result.tool_calls):
                    wire = tool.to_openai_tool_call()
                    if index in tools_sent:
                        # Keep final provider metadata without replaying argument deltas.
                        wire["function"].pop("name", None)
                        wire["function"].pop("arguments", None)
                        if index in tool_ids_sent:
                            wire.pop("id", None)
                            wire.pop("type", None)
                        if not wire["function"]:
                            del wire["function"]
                    if wire:
                        await chunk({"tool_calls": [{"index": index, **wire}]})
                await chunk({}, finish=result.finish_reason, usage=result.usage)
            else:
                message: dict = {"role": "assistant", "content": result.content}
                if result.tool_calls:
                    message["tool_calls"] = [tool.to_openai_tool_call() for tool in result.tool_calls]
                if result.reasoning_content:
                    message["reasoning_content"] = result.reasoning_content
                if lease and result.tool_calls:
                    self._retain_native_turn(lease[0], result.tool_calls)
                    retained = True
                return web.json_response({"id": completion_id, "object": "chat.completion", "created": created,
                                          "model": self.snapshot.model, "choices": [
                                              {"index": 0, "message": message, "finish_reason": result.finish_reason}],
                                          "usage": result.usage})
            await response.write(b"data: [DONE]\n\n")
            if lease and result.finish_reason != "error" and result.tool_calls:
                self._retain_native_turn(lease[0], result.tool_calls)
                retained = True
            return response
        except (ConnectionError, asyncio.CancelledError):
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            raise
        except Exception:
            error = {"error": {"code": "model_error", "message": "模型请求失败，请检查所选模型设置。"}}
            if stream:
                await response.write(("data: " + json.dumps(error, ensure_ascii=False) + "\n\ndata: [DONE]\n\n").encode())
                return response
            return web.json_response(error, status=502)
        finally:
            if monitor is not None:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            if lease and not retained:
                await self._close_native_turn(lease[0])


def register_routes(app: web.Application, config_loader: Callable[[], Config] = load_config) -> None:
    bridges: dict[str, StockModelBridge] = {}

    def require_host(request: web.Request) -> None:
        if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
            raise web.HTTPUnauthorized()

    async def bind(request: web.Request) -> web.Response:
        require_host(request)
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError) as exc:
            raise web.HTTPBadRequest(reason="invalid JSON") from exc
        instance_id = body.get("instance_id", "") if isinstance(body, dict) else ""
        if not isinstance(instance_id, str) or not re.fullmatch(r"[a-f0-9]{32}", instance_id):
            raise web.HTTPBadRequest(reason="invalid engine instance")
        if instance_id not in bridges:
            try:
                bridges[instance_id] = StockModelBridge.from_config(config_loader())
            except ValueError:
                return web.json_response({"error": "股票研究模型尚未配置或此来源暂不支持"}, status=409)
        bridge = bridges[instance_id]
        return web.json_response({"instance_id": instance_id, "api_key": bridge.token,
                                  "base_path": f"/internal/stock-vibe/models/{instance_id}/v1",
                                  **bridge.metadata()}, headers={"Cache-Control": "no-store"})

    async def complete(request: web.Request) -> web.StreamResponse:
        bridge = bridges.get(request.match_info["instance_id"])
        if bridge is None:
            raise web.HTTPNotFound()
        return await bridge.complete(request)

    async def release(request: web.Request) -> web.Response:
        require_host(request)
        instance_id = request.match_info["instance_id"]
        bridge = bridges.get(instance_id)
        if bridge is not None:
            if bridge.active:
                raise web.HTTPConflict(reason="model requests are still active")
            await bridge.aclose()
            del bridges[instance_id]
        return web.json_response({"released": True})

    async def cleanup(_: web.Application) -> None:
        for bridge in bridges.values():
            await bridge.aclose()
        bridges.clear()

    app.router.add_post("/internal/stock-vibe/models", bind)
    app.router.add_post("/internal/stock-vibe/models/{instance_id}/v1/chat/completions", complete)
    app.router.add_delete("/internal/stock-vibe/models/{instance_id}", release)
    app.on_cleanup.append(cleanup)
