from unittest.mock import AsyncMock

import pytest

from mona.agent.tools import browser as browser_module
from mona.agent.tools.browser import BrowserConnectionManager, _is_main_window_url


def test_main_window_urls_are_not_mistaken_for_browser_tabs() -> None:
    assert _is_main_window_url("tauri://localhost/")
    assert _is_main_window_url("https://tauri.localhost/")
    assert _is_main_window_url("http://127.0.0.1:9527/")
    assert _is_main_window_url("http://localhost:9527/")
    assert not _is_main_window_url("http://127.0.0.1:8000/")
    assert not _is_main_window_url("https://example.com/")


@pytest.mark.asyncio
async def test_new_tab_reconnects_cdp_so_the_new_webview_is_discoverable(monkeypatch) -> None:
    manager = BrowserConnectionManager()
    manager._browser = object()
    page = object()
    manager._reset_cdp = AsyncMock()
    manager._ensure_cdp_connection = AsyncMock()
    manager._find_page_for_tab = AsyncMock(return_value=page)

    monkeypatch.setattr(
        browser_module,
        "_tauri_invoke",
        lambda *_args, **_kwargs: {"cdp_port": 9300},
    )
    monkeypatch.setattr("asyncio.sleep", AsyncMock())

    tab_id, cdp_port = await manager.create_tab("https://example.com")

    assert tab_id.startswith("ai-")
    assert cdp_port == 9300
    manager._reset_cdp.assert_awaited_once()
    manager._ensure_cdp_connection.assert_awaited_once()
    assert manager._pages[tab_id] is page
