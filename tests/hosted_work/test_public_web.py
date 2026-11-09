"""Hosted web_fetch keeps desktop length controls without weakening isolation."""
import asyncio
import json
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.config.schema import HostedWorkConfig
from mona.hosted_work import public_web
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tools import HostedTools


class Response:
    def __init__(self, body=b"", *, status=200, headers=None, url="https://example.com/page"):
        self.body, self.status, self.url = body, status, url
        self.headers = headers or {"Content-Type": "text/plain; charset=utf-8"}
        self.charset = "utf-8"
        self.content = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def iter_chunked(self, _size):
        yield self.body


def install_responses(monkeypatch, responses):
    requested = []

    class Session:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, url, **_kwargs):
            requested.append(url)
            return responses.pop(0)

    monkeypatch.setattr(public_web.aiohttp, "ClientSession", Session)
    return requested


@pytest.mark.asyncio
async def test_default_and_explicit_max_chars_match_desktop(monkeypatch):
    content = "网页内容" * 7500 + "末尾标记"
    install_responses(monkeypatch, [Response(content.encode()), Response(content.encode())])
    default = await public_web.fetch_public_text("https://example.com/page")
    assert default["content"] == content[:15000] and default["truncated"] is True
    full = await public_web.fetch_public_text("https://example.com/page", max_chars=len(content))
    assert full["content"] == content and full["truncated"] is False
    with pytest.raises(WorkError):
        await public_web.fetch_public_text("https://example.com/page", max_chars=99)


@pytest.mark.asyncio
async def test_large_page_uses_existing_owned_result_reference(monkeypatch, tmp_path):
    content = "正文" * 65000 + "末尾标记"
    install_responses(monkeypatch, [Response(content.encode())])
    config = HostedWorkConfig(state_dir=str(tmp_path))
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    owner, session_id, run_id = owner_key("91"), "a" * 32, "b" * 32
    try:
        store.create_session(owner, NewSession(request_id=session_id))
        store.create_run(owner, session_id, NewTurn(request_id=run_id, model_id="fixture", text="read"))
        sandbox = DockerSandbox(config, owner, run_id, tmp_path / "workspace.zip")
        tools = HostedTools(sandbox, AsyncMock(), result_session_id=session_id)
        fetch = tools.registry.get("web_fetch")
        assert not fetch.validate_params({"url": "https://example.com/page", "maxChars": 200000})
        assert not fetch.validate_params({"url": "https://example.com/page", "extractMode": "text"})
        assert fetch.validate_params({"url": "https://example.com/page", "maxChars": 99})
        unsupported = await fetch.execute(url="https://example.com/page", extractMode="markdown")
        assert unsupported.startswith("Error:") and "Markdown" in unsupported
        raw = await fetch.execute(url="https://example.com/page", maxChars=200000, extractMode="text")
        assert json.loads(raw)["content"] == content
        spec = AgentRunSpec(initial_messages=[], tools=tools.registry, model="fixture", max_iterations=1,
                            max_tool_result_chars=100000)
        normalized = await AgentRunner(None)._normalize_tool_result_async(spec, "call", "web_fetch", raw)
        reference = re.search(r"mona-tool-result://sha256/[a-f0-9]{64}\.txt", normalized).group()
        saved, _, _ = tools.registry.storage.read(reference)
        assert json.loads(saved)["content"] == content
        reader = tools.registry.get("read_file")
        window = await reader.execute(path=reference, char_offset=saved.decode().index("末尾标记"), char_limit=20)
        assert "末尾标记" in window
    finally:
        store.close()


@pytest.mark.asyncio
async def test_output_larger_than_owner_file_quota_is_explicit(monkeypatch):
    install_responses(monkeypatch, [Response(("a" * 3000).encode())])
    config = HostedWorkConfig(max_file_bytes=1024)
    tools = HostedTools(SimpleNamespace(config=config), AsyncMock())
    result = await tools.web_fetch("https://example.com/page", maxChars=3000)
    assert result.startswith("Error:") and "maxChars" in result


@pytest.mark.asyncio
async def test_redirect_and_raw_response_limit_keep_existing_protections(monkeypatch):
    requested = install_responses(monkeypatch, [Response(status=302, headers={"Location": "http://127.0.0.1/"})])
    with pytest.raises(WorkError) as error:
        await public_web.fetch_public_text("https://example.com/page")
    assert error.value.code == "blocked_url" and requested == ["https://example.com/page"]
    install_responses(monkeypatch, [Response(b"a" * (2 * 1024 * 1024 + 1))])
    with pytest.raises(WorkError) as error:
        await public_web.fetch_public_text("https://example.com/page", max_chars=2 * 1024 * 1024)
    assert error.value.code == "web_too_large"


@pytest.mark.asyncio
async def test_fetch_can_be_cancelled_while_reading(monkeypatch):
    entered = asyncio.Event()

    class Waiting(Response):
        async def iter_chunked(self, _size):
            entered.set()
            await asyncio.Event().wait()
            yield b"unreachable"

    install_responses(monkeypatch, [Waiting()])
    task = asyncio.create_task(public_web.fetch_public_text("https://example.com/page"))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
