from __future__ import annotations

import os
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.materials.auth import get_services_token, materials_auth_middleware
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime
from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PREFIX = "/api/stock-vibe/symbol-search"
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"


async def _host_client(tmp_path: Path, monkeypatch, upstream):
    _resolve_tool_config_refs()
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "mona"))
    monkeypatch.delenv("MONA_SERVICES_TOKEN", raising=False)
    runtime = StockVibeRuntime(runtime_root=tmp_path / "components", data_root=tmp_path / "native",
                               config_loader=Config)

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(upstream)) as native:
            yield native

    monkeypatch.setattr(runtime, "lease", lease)
    app = web.Application(middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(app, runtime=runtime)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, {"X-Mona-Token": get_services_token()}


async def test_host_search_is_authenticated_bounded_and_keeps_native_envelope(tmp_path, monkeypatch):
    calls = []
    payload = {"query": "赣锋", "candidates": [{"symbol": "002460.SZ", "name": "赣锋锂业"}], "source": "eastmoney"}

    def upstream(request):
        calls.append(request)
        return httpx.Response(200, json=payload)

    client, auth = await _host_client(tmp_path, monkeypatch, upstream)
    async with client:
        assert (await client.get(PREFIX + "?q=%E8%B5%A3%E9%94%8B")).status == 401
        assert calls == []

        response = await client.get(PREFIX, params={"q": "赣锋"}, headers=auth)
        body = await response.json()
        assert response.status == 200
        assert body["native"] == payload
        assert body["source"] is None
        assert calls[0].url.path == "/mona/symbol-search"
        assert dict(calls[0].url.params) == {"q": "赣锋"}

        for query in (
            "?q=", "?q=" + "x" * 41, "?q=%20%20", "?q=a&q=b", "?q=a&limit=5", "?q=%01",
        ):
            invalid = await client.get(PREFIX + query, headers=auth)
            assert invalid.status == 400, query
        assert len(calls) == 1


@pytest.mark.parametrize("upstream_response", [
    httpx.Response(502, json={"detail": "private upstream diagnostic sentinel"}),
    httpx.Response(200, json={"query": "赣锋", "candidates": [{"symbol": "002460.XS", "name": "赣锋锂业"}],
                              "source": "eastmoney"}),
])
async def test_host_search_hides_upstream_errors_and_rejects_invalid_candidates(
    tmp_path, monkeypatch, upstream_response,
):
    def upstream(_request):
        return upstream_response

    client, auth = await _host_client(tmp_path, monkeypatch, upstream)
    async with client:
        response = await client.get(PREFIX, params={"q": "赣锋"}, headers=auth)
        assert response.status == 502
        body = await response.text()
        assert "private upstream diagnostic sentinel" not in body
        assert "002460.XS" not in body
        assert "symbol_search_unavailable" in body


_NATIVE_PROBE = r'''
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api import mona_symbol_search as search
from src.tools import symbol_search_tool as native_search

with patch.object(native_search.eastmoney_client, "get_json", return_value={"result": {"not_securities": []}}):
    rows, status = native_search._search_eastmoney("赣锋")
    assert rows == [] and status != "ok"

app = FastAPI()
search.register_mona_symbol_search(app)
headers = {"Authorization": "Bearer symbol-search-test-key"}
eastmoney_rows = [
    {"symbol": "002460.SZ", "name": " 赣锋锂业 ", "type": "A股"},
    {"symbol": "002460.SZ", "name": "duplicate", "type": "A股"},
    {"symbol": "600000.SH", "name": "浦发银行", "type": "A股"},
    {"symbol": "430047.SZ", "name": "北交样例", "type": "北A"},
    {"symbol": "920001.SZ", "name": "京A样例", "type": "京A"},
    {"symbol": "430048.SZ", "name": "未标记北交", "type": "A股"},
    {"symbol": "920002.SH", "name": "错误交易所", "type": "北A"},
]

with TestClient(app) as client:
    with patch.object(search, "_search_eastmoney", return_value=(eastmoney_rows, "ok")) as upstream:
        assert client.get("/mona/symbol-search", params={"q": "赣锋"}).status_code == 401
        assert upstream.call_count == 0

        result = client.get("/mona/symbol-search", params={"q": " 赣锋 "}, headers=headers)
        assert result.status_code == 200, result.text
        assert result.json() == {
            "query": "赣锋",
            "source": "eastmoney",
            "candidates": [
                {"symbol": "002460.SZ", "name": "赣锋锂业"},
                {"symbol": "600000.SH", "name": "浦发银行"},
                {"symbol": "430047.BJ", "name": "北交样例"},
                {"symbol": "920001.BJ", "name": "京A样例"},
            ],
        }
        upstream.assert_called_once_with("赣锋")

        for query in (
            "?q=", "?q=" + "x" * 41, "?q=%20%20", "?q=a&q=b", "?q=a&limit=5", "?q=%01",
        ):
            invalid = client.get("/mona/symbol-search" + query, headers=headers)
            assert invalid.status_code == 422, query
        assert upstream.call_count == 1

    class Response:
        def __init__(self, content):
            self.content = content

        def raise_for_status(self):
            return None

    valid_tencent = b'v_hint="sz~002460~\\u8d63\\u950b\\u9502\\u4e1a~gfly~GP-A"'
    with patch.object(search, "_search_eastmoney", return_value=([], "eastmoney unavailable")), \
         patch.object(search, "throttled_get", return_value=Response(valid_tencent)) as request:
        supplemented = search.search_symbols("赣锋")
        assert supplemented == {"query": "赣锋", "candidates": [{"symbol": "002460.SZ", "name": "赣锋锂业"}],
                               "source": "tencent"}
        assert request.call_args.args == ("https://smartbox.gtimg.cn/s3/",)
        assert request.call_args.kwargs["allow_redirects"] is False

    with patch.object(search, "_search_eastmoney", return_value=([], "eastmoney unavailable")), \
         patch.object(search, "throttled_get", return_value=Response(b'v_hint=""')) as request:
        empty = search.search_symbols("不存在")
        assert empty == {"query": "不存在", "candidates": [], "source": "tencent"}
        assert request.call_args.kwargs["allow_redirects"] is False

    with patch.object(search, "_search_eastmoney", return_value=([], "eastmoney unavailable")), \
         patch.object(search, "throttled_get", return_value=Response(b'v_hint="invalid\\q"')) as request:
        malformed = client.get("/mona/symbol-search", params={"q": "赣锋"}, headers=headers)
        assert malformed.status_code == 502
        assert "invalid\\q" not in malformed.text
        assert request.call_args.kwargs["allow_redirects"] is False

    with patch.object(search, "_search_eastmoney", return_value=([], "eastmoney unavailable")), \
         patch.object(search, "throttled_get", side_effect=RuntimeError("private Tencent failure sentinel")):
        failed = client.get("/mona/symbol-search", params={"q": "赣锋"}, headers=headers)
        assert failed.status_code == 502
        assert "private Tencent failure sentinel" not in failed.text
print("SYMBOL_SEARCH_NATIVE_OK")
'''


def test_native_symbol_search_normalization_fallback_and_auth(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0032-forecast-abstention.json" for patch in receipt["patches"])

    home = tmp_path / "native-home"
    home.mkdir()
    safe_names = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}
    environment = {key: value for key, value in os.environ.items() if key.upper() in safe_names}
    environment.update(
        PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHON_DOTENV_DISABLED="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        API_AUTH_KEY="symbol-search-test-key",
    )
    result = subprocess.run([str(PYTHON), "-c", _NATIVE_PROBE], cwd=source / "agent", env=environment,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                            timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "SYMBOL_SEARCH_NATIVE_OK" in result.stdout
