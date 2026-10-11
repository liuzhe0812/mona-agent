"""Session-scoped loopback model access for native development engines."""
from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx
from aiohttp import web
from loguru import logger

from mona.config.schema import Config, ModelPresetConfig
from mona.development.contracts import DevelopmentSession
from mona.development.model_protocol import (
    ModelOutput,
    ModelProtocolError,
    messages_input,
    responses_input,
)
from mona.development.model_selection import resolve_coding_model
from mona.development.store import DevelopmentError
from mona.providers.factory import make_provider
from mona.providers.registry import find_by_name
from mona.security.network import validate_url_target


@dataclass(frozen=True)
class ModelRoute:
    session_id: str
    executor: str
    provider: str
    model: str
    effort: str | None
    config: Config = field(repr=False)
    preset: ModelPresetConfig = field(repr=False)


class NativeModelBridge:
    def __init__(self, config_loader: Callable[[], Config], session_reader: Callable[[str], DevelopmentSession]):
        self.config_loader, self.session_reader = config_loader, session_reader
        self._routes: dict[str, ModelRoute] = {}
        self._tokens: dict[tuple[str, str], str] = {}
        self._runner: web.AppRunner | None = None
        self._base = ""
        self._lock = asyncio.Lock()

    async def bind(self, session: DevelopmentSession, *, refresh: bool = True) -> tuple[str, str]:
        if not session.model_provider or not session.model or session.executor.value not in {"codex", "claude"}:
            raise DevelopmentError("unsupported_model_route", "此引擎暂不支持配置的模型来源。")
        async with self._lock:
            key = (session.id, session.executor.value)
            if not refresh and key in self._tokens:
                self._check_session(session)
                return self._base, self._tokens[key]
            config = self.config_loader().model_copy(deep=True)
            preset = resolve_coding_model(config, session.model, session.model_provider, session.model_reasoning_effort)
            if self._runner is None:
                app = web.Application(client_max_size=32 * 1024 * 1024)
                app.router.add_post("/v1/responses", self._handle)
                app.router.add_post("/v1/messages", self._handle)
                runner = web.AppRunner(app, access_log=None, handler_cancellation=True)
                await runner.setup()
                try:
                    site = web.TCPSite(runner, "127.0.0.1", 0)
                    await site.start()
                    port = runner.addresses[0][1]
                except BaseException:
                    await runner.cleanup()
                    raise
                self._runner, self._base = runner, f"http://127.0.0.1:{port}"
            self._check_session(session)
            token = self._tokens.setdefault(key, secrets.token_urlsafe(32))
            if refresh or token not in self._routes:
                self._routes[token] = ModelRoute(session.id, session.executor.value, session.model_provider,
                                                  session.model, session.model_reasoning_effort, config, preset)
            return self._base, token

    def _check_session(self, session: DevelopmentSession) -> None:
        current = self.session_reader(session.id)
        if current.archived or current.revision != session.revision:
            raise DevelopmentError("session_changed", "任务状态已变化，请重新选择模型。")

    def _authorize(self, request: web.Request) -> ModelRoute:
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else request.headers.get("x-api-key", "")
        route = self._routes.get(token)
        if route is None or request.headers.get("Origin"):
            raise web.HTTPUnauthorized()
        try:
            session = self.session_reader(route.session_id)
        except DevelopmentError:
            raise web.HTTPForbidden() from None
        if session.archived or (session.executor.value, session.model_provider, session.model, session.model_reasoning_effort) != (route.executor, route.provider, route.model, route.effort):
            raise web.HTTPForbidden()
        if request.path.endswith("responses") != (route.executor == "codex"):
            raise web.HTTPForbidden()
        return route

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        stream = None
        provider = None
        protocol = "responses" if request.path.endswith("responses") else "messages"
        try:
            route = self._authorize(request)
            body = await request.json()
            if not isinstance(body, dict):
                raise ModelProtocolError("模型请求格式无效")
            parsed = responses_input(body) if protocol == "responses" else messages_input(body)
            config = route.config
            preset = route.preset
            spec = find_by_name(route.provider)
            if not spec or spec.backend not in {"openai_compat", "anthropic", "mona_managed"}:
                raise ModelProtocolError("此模型来源暂不支持所选引擎")
            source = config.providers.get_provider_config(route.provider)
            allow_private = bool(source and source.api_base) or spec.is_local

            async def check_target(outbound: httpx.Request) -> None:
                ok, _reason = await asyncio.to_thread(validate_url_target, str(outbound.url), allow_private=allow_private)
                if not ok:
                    raise ModelProtocolError("模型服务地址无法安全访问，请检查供应商配置。")

            # Provider credentials never enter the native process. Redirects cannot
            # move them to another endpoint; the current source owns the request.
            def client() -> httpx.AsyncClient:
                return httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30), follow_redirects=False,
                                         event_hooks={"request": [check_target]})

            config = config.model_copy(update={"agents": config.agents.model_copy(update={
                "defaults": config.agents.defaults.model_copy(update={"fallback_models": []})})})
            provider = make_provider(config, preset=preset, http_client_factory=client)
            if body.get("stream") is True:
                stream = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
                await stream.prepare(request)

            async def emit(kind: str, data: dict) -> None:
                if stream is not None:
                    await stream.write(f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())

            output = ModelOutput(protocol, route.model, parsed.tool_names, emit)
            await output.start()
            requested_limit = body.get("max_output_tokens" if protocol == "responses" else "max_tokens")
            limit = min(preset.max_tokens, requested_limit) if type(requested_limit) is int and requested_limit > 0 else preset.max_tokens
            # Native helper requests stay on the same user-selected source/model.
            response = await provider.chat_stream(messages=parsed.messages, tools=parsed.tools or None,
                model=route.model, max_tokens=limit, temperature=preset.temperature,
                reasoning_effort=preset.reasoning_effort, tool_choice=parsed.tool_choice,
                on_content_delta=output.delta, on_thinking_delta=output.thinking_delta)
            try:
                await provider.aclose()
            finally:
                provider = None
            if response.finish_reason == "error":
                logger.warning("Native model request failed (provider={}, status={}, kind={})",
                               route.provider, response.error_status_code, response.error_kind)
                status = response.error_status_code or 502
                message = {401: "模型服务拒绝了凭据，请在模型供应商设置中更新 API Key。",
                           403: "当前凭据无权使用此模型，请检查供应商权限。",
                           402: "模型余额不足，请充值后重试。",
                           429: "模型服务请求过于频繁，请稍后重试。"}.get(status,
                           "所选模型调用失败，请检查供应商配置或稍后重试。")
                code = "context_length_exceeded" if response.error_code == "context_length_exceeded" else "model_request_failed"
                if code == "context_length_exceeded":
                    message = "内容超出模型的上下文限制，请整理任务内容后重试。"
                raise ModelProtocolError(message, code=code, status=status if 400 <= status < 600 else 502)
            result = await output.finish(response)
            if stream is None:
                return web.json_response(result)
            await stream.write_eof()
            return stream
        except web.HTTPException:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Native model bridge failed ({})", type(exc).__name__)
            message = str(exc) if isinstance(exc, ModelProtocolError) else "模型调用未完成，请检查模型设置后重试。"
            code = exc.code if isinstance(exc, ModelProtocolError) else "model_request_failed"
            status = exc.status if isinstance(exc, ModelProtocolError) else 502
            error = {"type": "api_error", "code": code, "message": message}
            if stream is None:
                return web.json_response({"error": error}, status=status)
            try:
                data = {"type": "error", "error": error} if protocol == "messages" else {"type": "error", "code": error["code"], "message": message}
                await stream.write(f"event: error\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                await stream.write_eof()
            except (ConnectionError, RuntimeError):
                pass  # The native request was already closed; no inference is replayed.
            return stream
        finally:
            if provider is not None:
                await provider.aclose()

    async def close(self) -> None:
        if self._runner:
            await self._runner.cleanup()
        self._runner = None
        self._routes.clear()
        self._tokens.clear()

    def revoke(self, session_ids: set[str]) -> None:
        for key in list(self._tokens):
            if key[0] in session_ids:
                self._routes.pop(self._tokens.pop(key), None)
