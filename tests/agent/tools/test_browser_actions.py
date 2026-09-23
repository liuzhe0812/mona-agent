import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.tools import browser as browser_module
from mona.agent.tools.browser import (
    _UNTRUSTED_BROWSER_BANNER,
    BrowserActTool,
    BrowserListTabsTool,
    BrowserObserveTool,
    BrowserOpenTool,
    BrowserScreenshotTool,
    _resolve_query_locator,
    _validate_navigation_url,
)
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import JevConfig


def _patch_page(monkeypatch: pytest.MonkeyPatch, page: MagicMock) -> MagicMock:
    manager = MagicMock()
    manager.get_page = AsyncMock(return_value=page)
    monkeypatch.setattr(
        browser_module,
        "_get_connection_manager",
        AsyncMock(return_value=manager),
    )
    return manager


def test_browser_model_surface_contains_only_facades() -> None:
    registry = ToolRegistry()
    registry.register(BrowserOpenTool())
    registry.register(BrowserObserveTool())
    registry.register(BrowserActTool())

    names = [item["function"]["name"] for item in registry.get_definitions()]

    assert names == ["browser_act", "browser_observe"]


@pytest.mark.asyncio
async def test_browser_observe_dispatches_tab_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        browser_module,
        "_tauri_invoke_async",
        AsyncMock(return_value=[{"id": "tab-1", "url": "https://example.com"}]),
    )

    result = await BrowserObserveTool().execute(action="list_tabs")

    assert "tabId: tab-1" in result


@pytest.mark.asyncio
async def test_browser_act_opens_without_existing_tab(monkeypatch: pytest.MonkeyPatch) -> None:
    execute = AsyncMock(return_value='{"tab_id":"tab-2"}')
    monkeypatch.setattr(BrowserOpenTool, "execute", execute)

    result = await BrowserActTool().execute(kind="open", url="https://example.com")

    assert result == '{"tab_id":"tab-2"}'
    execute.assert_awaited_once_with(url="https://example.com")


@pytest.mark.asyncio
async def test_browser_act_run_keeps_legacy_mode_when_jev_is_disabled() -> None:
    tool = BrowserActTool(jev_config=JevConfig(api_key="secret"))

    result = await tool.execute(kind="run", tabId="tab-1", goal="Search")

    assert result == "Error performing browser action 'run': 浏览器未开启 Jev 加速"


@pytest.mark.asyncio
@pytest.mark.parametrize("tabs", [[], [
    {"id": "tab-1", "url": "https://example.com", "title": "Game"},
]])
async def test_browser_tab_discovery_identifies_its_scope(monkeypatch, tabs) -> None:
    monkeypatch.setattr(
        browser_module, "_tauri_invoke_async", AsyncMock(return_value=tabs),
    )

    result = await BrowserListTabsTool().execute()

    assert "Mona's built-in browser" in result
    assert "Chrome/Edge" in result
    if tabs:
        assert "tabId: tab-1" in result
        assert "https://example.com" in result
    else:
        assert "computer_*" in result
        assert "do not open a replacement" in result


def test_browser_target_scope_reaches_model_context(tmp_path) -> None:
    from mona.agent.context import ContextBuilder

    messages = ContextBuilder(workspace=tmp_path).build_messages(
        history=[],
        current_message="Continue this game",
        message_metadata={"browser_tab_id": "tab-1", "browser_page_title": "Game"},
    )

    assert "Mona Built-in Browser Page: Game [Tab ID: tab-1]" in messages[-1]["content"]
    prompt = messages[0]["content"]
    assert "`browser_observe` and `browser_act` operate only" in prompt
    assert "use `computer_observe` and `computer_act` automatically" in prompt
    assert "do not require the user to name Computer Use" in prompt
    assert "Keep its tab/window identity throughout the task" in prompt
    assert "Mona Built-in Browser Page: Game" not in prompt


def test_validate_navigation_url_accepts_only_absolute_http_urls() -> None:
    assert _validate_navigation_url("  https://example.com/path  ") == "https://example.com/path"
    assert _validate_navigation_url("http://localhost:9527") == "http://localhost:9527"

    for value in (
        "",
        "example.com",
        "//example.com/path",
        "file:///tmp/report.html",
        "ftp://example.com/file",
        "javascript:alert(1)",
        "https://",
    ):
        with pytest.raises(ValueError, match=r"absolute http\(s\) URLs"):
            _validate_navigation_url(value)


def test_resolve_query_locator_uses_semantic_lookup_and_match_index() -> None:
    page = MagicMock()
    locator = MagicMock()
    indexed_locator = MagicMock()
    page.get_by_role.return_value = locator
    locator.nth.return_value = indexed_locator

    result = _resolve_query_locator(
        page,
        {"role": "button", "name": "Save", "exact": True, "index": 2},
    )

    assert result is indexed_locator
    page.get_by_role.assert_called_once_with("button", name="Save", exact=True)
    locator.nth.assert_called_once_with(2)


@pytest.mark.asyncio
async def test_browser_act_fill_does_not_echo_input_text(monkeypatch: pytest.MonkeyPatch) -> None:
    page = MagicMock()
    locator = MagicMock()
    locator.fill = AsyncMock()
    page.locator.return_value = locator
    _patch_page(monkeypatch, page)

    result = await BrowserActTool().execute(
        tabId="tab-1",
        kind="fill",
        target="#password",
        text="super-secret-value",
    )

    assert result == "fill completed"
    assert "super-secret-value" not in result
    locator.fill.assert_awaited_once_with("super-secret-value", timeout=10000)


@pytest.mark.asyncio
async def test_browser_act_press_passes_key_chord_and_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    locator = MagicMock()
    locator.press = AsyncMock()
    page.locator.return_value = locator
    _patch_page(monkeypatch, page)

    result = await BrowserActTool().execute(
        tabId="tab-1",
        kind="press",
        target="#search",
        key="Control+A",
        timeoutMs=2500,
    )

    assert result == "Pressed Control+A"
    locator.press.assert_awaited_once_with("Control+A", timeout=2500)


@pytest.mark.asyncio
async def test_browser_act_supports_page_keyboard_and_scroll_without_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    page.keyboard.press = AsyncMock()
    page.mouse.wheel = AsyncMock()
    _patch_page(monkeypatch, page)
    tool = BrowserActTool()

    assert await tool.execute(tabId="tab-1", kind="press", key="Escape") == "Pressed Escape"
    assert await tool.execute(tabId="tab-1", kind="scroll", deltaY=800) == "Scrolled page"

    page.keyboard.press.assert_awaited_once_with("Escape")
    page.mouse.wheel.assert_awaited_once_with(0.0, 800.0)


@pytest.mark.asyncio
async def test_browser_act_drag_uses_source_and_destination_locators(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    source = MagicMock()
    destination = MagicMock()
    source.drag_to = AsyncMock()
    page.locator.side_effect = {"#source": source, "#destination": destination}.get
    _patch_page(monkeypatch, page)

    result = await BrowserActTool().execute(
        tabId="tab-1",
        kind="drag",
        target="#source",
        endTarget="#destination",
        timeoutMs=1800,
    )

    assert result == "Dragged element"
    source.drag_to.assert_awaited_once_with(destination, timeout=1800)


@pytest.mark.asyncio
async def test_browser_act_select_returns_selected_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    locator = MagicMock()
    locator.select_option = AsyncMock(return_value=["pro", "team"])
    page.locator.return_value = locator
    _patch_page(monkeypatch, page)

    result = await BrowserActTool().execute(
        tabId="tab-1",
        kind="select",
        target="#plan",
        values=["pro", "team"],
        timeoutMs=3200,
    )

    assert json.loads(result) == {"selected": ["pro", "team"]}
    locator.select_option.assert_awaited_once_with(
        value=["pro", "team"],
        timeout=3200,
    )


@pytest.mark.asyncio
async def test_browser_act_wait_supports_time_url_text_and_load_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    page.wait_for_timeout = AsyncMock()
    page.wait_for_url = AsyncMock()
    page.wait_for_load_state = AsyncMock()
    text_locator = MagicMock()
    text_locator.wait_for = AsyncMock()
    page.get_by_text.return_value = text_locator
    _patch_page(monkeypatch, page)
    tool = BrowserActTool()

    assert await tool.execute(tabId="tab-1", kind="wait", timeMs=25) == "Wait condition satisfied"
    assert (
        await tool.execute(
            tabId="tab-1",
            kind="wait",
            url="https://example.com/done",
            timeoutMs=321,
        )
        == "Wait condition satisfied"
    )
    assert (
        await tool.execute(
            tabId="tab-1",
            kind="wait",
            textGone="Loading...",
            timeoutMs=654,
        )
        == "Wait condition satisfied"
    )
    assert (
        await tool.execute(
            tabId="tab-1",
            kind="wait",
            loadState="networkidle",
            timeoutMs=987,
        )
        == "Wait condition satisfied"
    )

    page.wait_for_timeout.assert_awaited_once_with(25)
    page.wait_for_url.assert_awaited_once_with("https://example.com/done", timeout=321)
    page.get_by_text.assert_called_once_with("Loading...", exact=False)
    text_locator.wait_for.assert_awaited_once_with(state="hidden", timeout=654)
    page.wait_for_load_state.assert_awaited_once_with("networkidle", timeout=987)


@pytest.mark.asyncio
async def test_browser_act_upload_enforces_workspace_boundary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    inside = workspace / "inside.txt"
    inside.write_text("inside", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")

    page = MagicMock()
    locator = MagicMock()
    locator.set_input_files = AsyncMock()
    page.locator.return_value = locator
    _patch_page(monkeypatch, page)
    tool = BrowserActTool(workspace=str(workspace), restrict_to_workspace=True)

    result = await tool.execute(
        tabId="tab-1",
        kind="upload",
        target="input[type=file]",
        paths=["inside.txt"],
    )
    assert result == "Uploaded 1 file(s)"
    locator.set_input_files.assert_awaited_once_with([str(inside.resolve())], timeout=10000)

    rejected = await tool.execute(
        tabId="tab-1",
        kind="upload",
        target="input[type=file]",
        paths=[str(outside)],
    )
    assert "outside the workspace" in rejected
    assert locator.set_input_files.await_count == 1


@pytest.mark.asyncio
async def test_browser_act_evaluate_truncates_large_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = MagicMock()
    page.evaluate = AsyncMock(return_value={"payload": "x" * 60_000})
    _patch_page(monkeypatch, page)

    result = await BrowserActTool().execute(
        tabId="tab-1",
        kind="evaluate",
        fn="() => document.title",
    )

    banner, payload = result.split("\n", 1)
    bounded = json.loads(payload)
    assert banner == _UNTRUSTED_BROWSER_BANNER
    assert bounded["truncated"] is True
    assert bounded["length"] > 50_000
    assert len(result) < 50_000
    page.evaluate.assert_awaited_once_with("() => document.title")


@pytest.mark.asyncio
async def test_browser_screenshot_returns_native_image_content_blocks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    page = MagicMock()
    _patch_page(monkeypatch, page)
    screenshot_bytes = b"\x89PNG\r\n\x1a\nmock-image"
    monkeypatch.setattr(
        browser_module,
        "_cdp_screenshot",
        AsyncMock(return_value=screenshot_bytes),
    )
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))

    result = await BrowserScreenshotTool().execute(tabId="tab-1")

    assert isinstance(result, list)
    assert result[0]["type"] == "image_url"
    assert result[0]["image_url"]["url"] == (
        "data:image/png;base64," + base64.b64encode(screenshot_bytes).decode()
    )
    assert result[1]["type"] == "text"
    saved_path = Path(result[0]["_meta"]["path"])
    assert saved_path.parent == tmp_path / "mona-browser-screenshots"
    assert saved_path.read_bytes() == screenshot_bytes
