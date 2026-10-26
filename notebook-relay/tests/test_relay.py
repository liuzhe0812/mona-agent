import asyncio
import json
import secrets
import threading
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from notebook_relay.app import create_app
from notebook_relay.config import Settings

PAYLOAD = {"model": "example-model", "messages": [{"role": "user", "content": "hello"}]}
SSE = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'.encode()


class Upstream(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.requests = []
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.sent = threading.Event()
        self.mode = "json"
        self.sse = SSE
        self.error_body = secrets.token_urlsafe(32).encode()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server_port}/v1"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        state = self.server
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        with state.lock:
            state.requests.append({
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers),
                "body": body,
            })
        mode = state.mode
        if self.command == "GET":
            response = json.dumps({"data": [{"id": "example-model"}, {"id": "private-model"}]}).encode()
        elif mode == "redirect":
            self.send_response(307)
            self.send_header("Location", state.base_url + "/redirect-target")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        elif mode == "error":
            response = state.error_body
        elif mode in {"sse", "sse_hold"}:
            response = state.sse
        else:
            response = b'{"id":"completion","choices":[]}'
        if mode == "hold":
            state.release.wait(10)
        self.send_response(503 if mode == "error" else 200)
        self.send_header("Content-Type", "text/event-stream" if mode.startswith("sse") else "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        try:
            if mode == "sse_hold":
                self.wfile.write(response[:8])
                self.wfile.flush()
                state.sent.set()
                state.release.wait(10)
                self.wfile.write(response[8:])
            elif mode == "sse":
                for offset in range(0, len(response), 7):
                    self.wfile.write(response[offset:offset + 7])
                    self.wfile.flush()
            else:
                self.wfile.write(response)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


@pytest.fixture
def upstream():
    server = Upstream()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@asynccontextmanager
async def relay_client(upstream=None, **overrides):
    settings = Settings(**{
        "api_key": SecretStr(secrets.token_urlsafe(32)),
        "upstream_base_url": upstream.base_url if upstream else None,
        "upstream_api_key": SecretStr(secrets.token_urlsafe(32)),
        "models": ("example-model",),
        **overrides,
    })
    app = create_app(settings)
    async with app.router.lifespan_context(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://relay",
        headers={"Authorization": "Bearer " + settings.api_key.get_secret_value()},
    ) as client:
        yield client, settings


async def wait_until(predicate):
    async with asyncio.timeout(10):
        while not predicate():
            await asyncio.sleep(0.01)


async def test_health_is_public_and_unconfigured_ready_is_not_ready():
    async with relay_client() as (client, settings):
        health = await client.get("/health", headers={"Authorization": ""})
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert settings.api_key.get_secret_value() not in health.text
        assert settings.upstream_api_key.get_secret_value() not in health.text
        assert (await client.get("/ready", headers={"Authorization": ""})).status_code == 401
        assert (await client.get("/ready")).status_code == 503


async def test_authentication_and_model_whitelist(upstream):
    async with relay_client(upstream) as (client, _):
        for authorization in ("", "Bearer " + secrets.token_urlsafe(32), "Basic " + secrets.token_urlsafe(32)):
            for method, path in (("GET", "/ready"), ("GET", "/v1/models"), ("POST", "/v1/chat/completions")):
                response = await client.request(method, path, headers={"Authorization": authorization}, json=PAYLOAD)
                assert response.status_code == 401
        response = await client.get("/v1/models")
        assert response.status_code == 200
        assert [model["id"] for model in response.json()["data"]] == ["example-model"]
        assert upstream.requests == []


async def test_ready_probes_models_without_a_completion(upstream):
    async with relay_client(upstream) as (client, settings):
        response = await client.get("/ready")
        assert response.status_code == 200
        assert len(upstream.requests) == 1
        request = upstream.requests[0]
        assert (request["method"], request["path"], request["body"]) == ("GET", "/v1/models", b"")
        assert request["headers"]["Authorization"] == "Bearer " + settings.upstream_api_key.get_secret_value()
        assert "private-model" not in response.text


async def test_json_and_tools_are_preserved_with_separate_upstream_credentials(upstream):
    payload = {
        **PAYLOAD,
        "messages": [
            {"role": "system", "content": "Keep this system message unchanged."},
            {"role": "user", "content": "synthetic test"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": '{"q":"你好"}'}}
            ]},
            {"role": "tool", "tool_call_id": "call_1", "content": "synthetic result"},
        ],
        "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}],
        "temperature": 0.125,
        "max_tokens": 123,
        "stream": False,
    }
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode()
    async with relay_client(upstream) as (client, settings):
        response = await client.post(
            "/v1/chat/completions?ignored=1", content=raw,
            headers={"Content-Type": "application/json", "Cookie": "session=" + secrets.token_urlsafe(16)},
        )
        assert response.status_code == 200
        assert response.json() == {"id": "completion", "choices": []}
        assert len(upstream.requests) == 1
        request = upstream.requests[0]
        assert request["path"] == "/v1/chat/completions"
        assert request["body"] == raw
        assert request["headers"]["Authorization"] == "Bearer " + settings.upstream_api_key.get_secret_value()
        assert settings.api_key.get_secret_value() not in str(request["headers"])
        assert "Cookie" not in request["headers"]
    async with relay_client(upstream, upstream_api_key=None) as (client, _):
        assert (await client.post("/v1/chat/completions", json=PAYLOAD)).status_code == 200
        assert "Authorization" not in upstream.requests[-1]["headers"]


async def test_invalid_completion_requests_never_reach_upstream(upstream):
    async with relay_client(upstream, max_concurrency=1) as (client, _):
        for payload in (
            {**PAYLOAD, "model": "private-model"},
            {**PAYLOAD, "messages": []},
            {**PAYLOAD, "messages": "hello"},
            {**PAYLOAD, "stream": "true"},
            [],
        ):
            response = await client.post("/v1/chat/completions", json=payload)
            assert response.status_code == 400
        assert upstream.requests == []
        assert (await client.post("/v1/chat/completions", json=PAYLOAD)).status_code == 200


async def test_fifteen_requests_then_sixteenth_are_admitted_and_seventeenth_is_rejected(upstream):
    upstream.mode = "hold"
    async with relay_client(upstream) as (client, _):
        tasks = [asyncio.create_task(client.post("/v1/chat/completions", json=PAYLOAD)) for _ in range(15)]
        try:
            await wait_until(lambda: len(upstream.requests) == 15)
            assert all(not task.done() for task in tasks)
            tasks.append(asyncio.create_task(client.post("/v1/chat/completions", json=PAYLOAD)))
            await wait_until(lambda: len(upstream.requests) == 16)
            rejected = await client.post("/v1/chat/completions", json=PAYLOAD)
            assert rejected.status_code == 429
            assert len(upstream.requests) == 16
        finally:
            upstream.release.set()
            responses = await asyncio.gather(*tasks)
        assert all(response.status_code == 200 for response in responses)
        assert (await client.post("/v1/chat/completions", json=PAYLOAD)).status_code == 200


async def test_body_limit_checks_actual_chunks_even_without_or_with_false_content_length(upstream):
    raw = json.dumps({**PAYLOAD, "padding": "x" * 512}).encode()

    async def chunks():
        for offset in range(0, len(raw), 73):
            yield raw[offset:offset + 73]

    async with relay_client(upstream, max_body_bytes=256, max_concurrency=1) as (client, _):
        for length in (None, "1", str(len(raw))):
            headers = {"Content-Type": "application/json"}
            if length is not None:
                headers["Content-Length"] = length
            request = client.build_request("POST", "/v1/chat/completions", content=chunks(), headers=headers)
            assert request.headers.get("content-length") == length
            assert (await client.send(request)).status_code == 413
        assert upstream.requests == []
        assert (await client.post("/v1/chat/completions", json=PAYLOAD)).status_code == 200


async def test_sse_bytes_and_done_are_preserved_without_inventing_a_done(upstream):
    upstream.mode = "sse"
    async with relay_client(upstream) as (client, _):
        for content in (SSE, b': keepalive\r\nid: 7\r\nevent: delta\r\ndata: {"partial":true}\r\n\r\n'):
            upstream.sse = content
            response = await client.post("/v1/chat/completions", json={**PAYLOAD, "stream": True})
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.content == content


async def test_upstream_redirects_and_errors_are_not_retried_and_release_capacity(upstream):
    async with relay_client(upstream, max_concurrency=1) as (client, _):
        for mode, expected in (("redirect", 502), ("error", 503)):
            upstream.mode = mode
            before = len(upstream.requests)
            response = await client.post("/v1/chat/completions", json=PAYLOAD)
            assert response.status_code == expected
            assert len(upstream.requests) == before + 1
            assert upstream.error_body.decode() not in response.text
            upstream.mode = "json"
            assert (await client.post("/v1/chat/completions", json=PAYLOAD)).status_code == 200
        assert all(request["method"] == "POST" and request["path"] == "/v1/chat/completions" for request in upstream.requests)


async def test_cancelled_stream_releases_capacity_for_the_next_request(upstream):
    upstream.mode = "sse_hold"
    async with relay_client(upstream, max_concurrency=1) as (client, _):
        task = asyncio.create_task(client.post("/v1/chat/completions", json={**PAYLOAD, "stream": True}))
        try:
            await wait_until(upstream.sent.is_set)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            upstream.mode = "json"
            response = await client.post("/v1/chat/completions", json=PAYLOAD)
            assert response.status_code == 200
        finally:
            upstream.release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("url, allowed", [
    ("http://127.0.0.1:8801/v1", True),
    ("http://[::1]:8801/v1", True),
    ("http://192.0.2.1:8801/v1", False),
    ("http://localhost:8801/v1", False),
    ("http://127.0.0.1:8801/v1?target=elsewhere", False),
    ("http://127.0.0.1:8801/v1#fragment", False),
    (None, False),
])
def test_upstream_settings_only_allow_fixed_numeric_loopback_urls(url, allowed):
    if url is None:
        url = "http://" + secrets.token_urlsafe(16) + "@127.0.0.1:8801/v1"
    values = {"api_key": SecretStr(secrets.token_urlsafe(32)), "upstream_base_url": url}
    if allowed:
        assert Settings(**values).upstream_base_url == url
    else:
        with pytest.raises(ValidationError):
            Settings(**values)
