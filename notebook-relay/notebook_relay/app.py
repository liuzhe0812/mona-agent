import asyncio
import hmac
import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect

from notebook_relay.config import Settings
from notebook_relay.opencode_bridge import (
    NativeError,
    OpenCodeBridge,
    install_native_routes,
)

logger = logging.getLogger(__name__)


class RelayError(HTTPException):
    def __init__(self, status: int, code: str, message: str, headers=None):
        super().__init__(status, detail={"code": code, "message": message}, headers=headers)


class Relay:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client
        self.active_requests = 0

    def acquire(self) -> None:
        # Admission has no await: one worker's event loop owns the counter.
        if self.active_requests >= self.settings.max_concurrency:
            raise RelayError(429, "concurrency_limit", "同时进行的请求已达上限，请稍后重试")
        self.active_requests += 1

    def require_upstream(self) -> str:
        url = self.settings.resolved_upstream_base_url
        if not url or not self.settings.models:
            raise RelayError(503, "upstream_not_configured", "尚未配置兼容上游和模型白名单")
        key = self.settings.upstream_api_key
        if self.settings.upstream_provider != "local" and (not key or not key.get_secret_value().strip()):
            raise RelayError(503, "upstream_key_missing", "尚未配置此官方上游的 API Key")
        return url

    def validate_provider_payload(self, payload: dict) -> None:
        if self.settings.upstream_provider != "openrouter_free":
            return
        overrides = {"models", "route", "plugins", "web_search_options"}
        tools = payload.get("tools", [])
        if tools is None:
            tools = []
        if overrides.intersection(payload) or not isinstance(tools, list) or any(
            not isinstance(tool, dict) or tool.get("type") != "function" for tool in tools
        ):
            raise RelayError(
                400, "unsupported_free_tier_option",
                "免费预设不接受模型回退、附加服务或服务端工具选项",
            )

    def upstream_request(self, method: str, path: str, **kwargs) -> httpx.Request:
        url = self.require_upstream() + path
        headers = {"Accept-Encoding": "identity"}
        if method == "POST":
            headers["Content-Type"] = "application/json"
        key = self.settings.upstream_api_key
        if key and key.get_secret_value():
            headers["Authorization"] = "Bearer " + key.get_secret_value()
        request = self.client.build_request(method, url, headers=headers, **kwargs)
        request.headers.pop("cookie", None)
        return request


def upstream_error(response: httpx.Response) -> RelayError | None:
    status = response.status_code
    if 300 <= status < 400:
        return RelayError(502, "upstream_redirect", "上游返回重定向，请核对上游配置")
    if status >= 400:
        headers = {}
        retry_after = response.headers.get("retry-after", "")
        if status == 429 and retry_after.isdecimal():
            headers["Retry-After"] = retry_after
        return RelayError(
            status if status not in {401, 403} else 502,
            "upstream_error",
            f"上游请求失败（HTTP {status}），请核对上游状态或配置",
            headers=headers,
        )
    return None


async def read_payload(request: Request, limit: int) -> tuple[dict, bytes]:
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise RelayError(415, "unsupported_content_type", "请使用 application/json")
    length = request.headers.get("content-length")
    if length is not None:
        if not length.isdecimal():
            raise RelayError(400, "invalid_content_length", "请求长度无效")
        if int(length) > limit:
            raise RelayError(413, "request_too_large", "请求正文超过大小限制")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise RelayError(413, "request_too_large", "请求正文超过大小限制")
        body.extend(chunk)
    try:
        def reject_constant(value):
            raise ValueError("non-finite JSON number")

        payload = json.loads(body, parse_constant=reject_constant)
    except (ValueError, UnicodeDecodeError):
        raise RelayError(400, "invalid_json", "请求正文不是有效的 JSON") from None
    if not isinstance(payload, dict):
        raise RelayError(400, "invalid_request", "请求正文必须是 JSON 对象")
    return payload, bytes(body)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()
    native = OpenCodeBridge(settings) if settings.upstream_provider == "opencode_native" else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            if native:
                await native.start()
            async with httpx.AsyncClient(
                trust_env=False,
                follow_redirects=False,
                timeout=httpx.Timeout(settings.request_timeout_seconds, connect=5),
                limits=httpx.Limits(
                    max_connections=settings.max_concurrency + 1,
                    max_keepalive_connections=settings.max_concurrency,
                ),
            ) as client:
                app.state.relay = Relay(settings, client)
                yield
        finally:
            if native:
                await native.stop()

    app = FastAPI(
        title="Notebook Relay", version="0.1.0", lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None,
    )
    install_native_routes(app, native)

    @app.exception_handler(NativeError)
    async def handle_native_error(request: Request, exc: NativeError):
        return JSONResponse(
            {"error": {"type": "opencode_error", "code": exc.code, "message": str(exc)}},
            status_code=exc.status, headers=exc.headers,
        )

    @app.exception_handler(RelayError)
    async def handle_error(request: Request, exc: RelayError):
        return JSONResponse(
            {"error": {"type": "relay_error", **exc.detail}},
            status_code=exc.status_code,
            headers=exc.headers,
        )

    async def authenticate(authorization: str | None = Header(default=None)) -> None:
        scheme, _, supplied = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            supplied.encode(), settings.api_key.get_secret_value().encode()
        ):
            raise RelayError(401, "unauthorized", "访问凭据无效")

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": "notebook-relay", "version": "0.1.0"}

    @app.get("/ready", dependencies=[Depends(authenticate)])
    async def ready(request: Request):
        if native:
            try:
                async with asyncio.timeout(10):
                    return await native.ready()
            except TimeoutError:
                raise NativeError(503, "native_plugin_not_ready", "官方客户端插件尚未就绪") from None
        relay: Relay = request.app.state.relay
        upstream = None
        try:
            async with asyncio.timeout(min(settings.request_timeout_seconds, 5)):
                upstream = await relay.client.send(relay.upstream_request("GET", "/models"))
            if upstream.status_code != 200:
                raise ValueError("upstream catalog unavailable")
            models = upstream.json()["data"]
            if not isinstance(models, list) or not set(settings.models).issubset(
                {item["id"] for item in models if isinstance(item, dict)}
            ):
                raise ValueError("configured models unavailable")
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
            raise RelayError(503, "upstream_not_ready", "上游兼容接口或配置的模型尚未就绪") from None
        finally:
            if upstream is not None:
                await upstream.aclose()
        return {"ready": True}

    @app.get("/v1/models", dependencies=[Depends(authenticate)])
    async def models():
        capabilities = await native.load_model_capabilities() if native else {}
        return {"object": "list", "data": [
            {"id": model, "object": "model", "created": 0, "owned_by": "notebook-relay",
             **capabilities}
            for model in settings.models
        ]}

    @app.post("/v1/chat/completions", dependencies=[Depends(authenticate)])
    async def completions(request: Request):
        relay: Relay = request.app.state.relay
        if not native:
            relay.require_upstream()
        relay.acquire()
        upstream = None
        native_job = None
        transferred = False
        released = False
        deadline = asyncio.get_running_loop().time() + settings.request_timeout_seconds

        async def cleanup():
            nonlocal released
            if released:
                return
            released = True
            relay.active_requests -= 1
            if upstream is not None:
                await upstream.aclose()
            if native_job is not None:
                await native.close_job(native_job)

        try:
            async with asyncio.timeout_at(deadline):
                payload, body = await read_payload(request, settings.max_body_bytes)
                if payload.get("model") not in settings.models:
                    raise RelayError(400, "model_not_allowed", "请求的模型不在白名单中")
                if not isinstance(payload.get("messages"), list) or not payload["messages"]:
                    raise RelayError(400, "invalid_messages", "messages 必须是非空数组")
                streaming = payload.get("stream", False)
                if not isinstance(streaming, bool):
                    raise RelayError(400, "invalid_stream", "stream 必须是布尔值")
                if native:
                    async def native_request():
                        nonlocal native_job
                        native_job = await native.open(payload)
                        return None if streaming else await native.completion(native_job)

                    async def disconnected():
                        while (await request.receive())["type"] != "http.disconnect":
                            pass

                    operation = asyncio.create_task(native_request())
                    disconnect = asyncio.create_task(disconnected())
                    try:
                        done, _ = await asyncio.wait((operation, disconnect), return_when=asyncio.FIRST_COMPLETED)
                        if disconnect in done:
                            raise ClientDisconnect
                        result = await operation
                    finally:
                        operation.cancel()
                        disconnect.cancel()
                        await asyncio.gather(operation, disconnect, return_exceptions=True)
                    if not streaming:
                        return JSONResponse(result)

                    async def native_content():
                        try:
                            async with asyncio.timeout_at(deadline):
                                include_usage = (payload.get("stream_options") or {}).get("include_usage", False)
                                async for data in native.events(native_job, include_usage):
                                    yield ("data: " + data + "\n\n").encode()
                        except (NativeError, TimeoutError, ValueError) as exc:
                            code = (exc.code if isinstance(exc, NativeError) else
                                    "request_timeout" if isinstance(exc, TimeoutError) else "native_protocol_error")
                            error = {"error": {"type": "opencode_error", "code": code,
                                               "message": "官方客户端响应未完成"}}
                            yield ("data: " + json.dumps(error, ensure_ascii=False) + "\n\n").encode()
                        finally:
                            await cleanup()

                    response = StreamingResponse(
                        native_content(), media_type="text/event-stream",
                        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
                        background=BackgroundTask(cleanup),
                    )
                    transferred = True
                    return response
                relay.validate_provider_payload(payload)
                upstream = await relay.client.send(
                    relay.upstream_request("POST", "/chat/completions", content=body),
                    stream=True,
                )
                if error := upstream_error(upstream):
                    raise error
                media = upstream.headers.get("content-type", "").split(";", 1)[0].lower()
                expected = "text/event-stream" if streaming else "application/json"
                if media != expected:
                    raise RelayError(502, "incompatible_upstream", "上游未返回预期的兼容协议")

            async def content():
                try:
                    async with asyncio.timeout_at(deadline):
                        async for chunk in upstream.aiter_bytes():
                            yield chunk
                except (httpx.HTTPError, TimeoutError):
                    logger.warning("upstream_response_interrupted")
                    if not streaming:
                        raise RuntimeError("上游响应中断") from None
                    error = {"error": {"type": "relay_error", "code": "upstream_interrupted",
                                       "message": "上游响应中断，本次请求未完成"}}
                    yield ("data: " + json.dumps(error, ensure_ascii=False) + "\n\n").encode()
                finally:
                    await cleanup()

            response = StreamingResponse(
                content(), status_code=upstream.status_code,
                headers={"Content-Type": upstream.headers["content-type"],
                         "Cache-Control": "no-store", "X-Accel-Buffering": "no"},
                background=BackgroundTask(cleanup),
            )
            transferred = True
            return response
        except TimeoutError:
            raise RelayError(504, "request_timeout", "请求超时，请稍后重试") from None
        except httpx.HTTPError:
            raise RelayError(502, "upstream_unavailable", "无法连接上游兼容接口") from None
        except ClientDisconnect:
            raise RelayError(400, "client_disconnected", "客户端已断开连接") from None
        finally:
            if not transferred:
                await cleanup()

    return app
