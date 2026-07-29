"""Browser automation tools: AI-controlled WebView2 via Playwright CDP + Tauri IPC.

Architecture:
- Tauri creates child WebViews via ``add_child()`` with labels like ``browser-{id}``
- Each WebView's ``initialization_script`` injects ``window.__mona_tab_id = '{id}'``
  so Playwright can identify which CDP Page corresponds to which tab
- All WebView2 instances share a single CDP port (set via
  ``WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`` before the browser process starts)
- Playwright connects to the CDP port and finds the correct page by evaluating
  the ``__mona_tab_id`` marker
"""

from __future__ import annotations

import base64
import json
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from mona.agent.tools.tauri_ipc import tauri_invoke as _tauri_invoke
from mona.config.schema import Base

# Opener that bypasses all proxy settings. The CDP HTTP endpoint is a
# localhost server; system proxies (V2Ray/Clash on 127.0.0.1:10809) intercept
# the request and fail to route it back, causing spurious connection errors.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------------------
# Playwright availability check
# ---------------------------------------------------------------------------


_playwright_checked = False
_playwright_ok = False


def _playwright_available() -> bool:
    global _playwright_checked, _playwright_ok
    if _playwright_checked:
        return _playwright_ok
    _playwright_checked = True
    try:
        import playwright  # noqa: F401

        _playwright_ok = True
    except ImportError as e:
        _playwright_ok = False
        logger.warning("playwright not available, browser tools will be disabled: {}", e)
    return _playwright_ok


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class BrowserToolsConfig(Base):
    """Browser tools configuration."""

    enable: bool = True
    cdp_host: str = "127.0.0.1"
    cdp_port: int = 9300
    default_timeout: int = 30


# ---------------------------------------------------------------------------
# Connection Manager — singleton managing Playwright CDP connections
# ---------------------------------------------------------------------------

_connection_manager: BrowserConnectionManager | None = None


async def _get_connection_manager() -> BrowserConnectionManager:
    global _connection_manager
    if _connection_manager is None:
        _connection_manager = BrowserConnectionManager()
    return _connection_manager


class BrowserConnectionManager:
    """Manages Playwright CDP connections to WebView2 instances.

    Architecture:
    - Tauri creates child WebViews via ``add_child()`` with labels like ``browser-{id}``
    - All WebView2 instances share a single CDP port configured via
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS at startup.
    - Each WebView's initialization_script injects ``window.__mona_tab_id = '{id}'``
      so we can reliably match CDP Pages to tabs.
    - Playwright connects to the CDP port and finds the correct page by evaluating
      the ``__mona_tab_id`` marker.
    """

    def __init__(self) -> None:
        self._playwright: Any = None
        self._browser: Any = None  # CDP browser connection (shared across all tabs)
        self._pages: dict[str, Any] = {}  # tab_id -> Playwright Page

    # -- Playwright lifecycle ------------------------------------------------

    async def _ensure_playwright(self) -> None:
        if self._playwright is None:
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()

    # -- CDP health & reconnection -------------------------------------------

    async def _cdp_healthy(self) -> bool:
        """Check if the CDP connection is still alive and can see pages.

        A connection to a stale browser process (e.g. from a previous
        ``data_directory`` config) may still respond to ``contexts`` but
        not contain the expected child WebView pages. We verify by checking
        that the /json HTTP endpoint is reachable and returns at least one
        page target — this confirms we're connected to the correct browser
        process.
        """
        if self._browser is None:
            return False
        try:
            _ = self._browser.contexts
        except Exception:
            return False
        # Also verify the CDP HTTP endpoint is responsive. If the browser
        # process has been replaced (e.g. app restart), the old Playwright
        # connection may still appear alive but point to a dead process.
        config = BrowserToolsConfig()
        url = f"http://{config.cdp_host}:{config.cdp_port}/json"
        try:
            with _NO_PROXY_OPENER.open(url, timeout=3) as resp:
                targets = json.loads(resp.read().decode())
                if not isinstance(targets, list) or len(targets) == 0:
                    return False
        except Exception:
            return False
        return True

    async def _ensure_cdp_connection(self) -> None:
        """Connect to the shared CDP endpoint, with reconnection on failure.

        All WebView2 instances share a single CDP port configured via
        ``WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`` at startup.
        Ref: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
        """
        if await self._cdp_healthy():
            return

        # Reset stale state
        await self._reset_cdp()

        await self._ensure_playwright()
        config = BrowserToolsConfig()
        cdp_url = f"http://{config.cdp_host}:{config.cdp_port}"
        try:
            self._browser = await self._playwright.chromium.connect_over_cdp(cdp_url)
            logger.info("CDP connected to {}", cdp_url)
        except Exception as e:
            self._browser = None
            raise RuntimeError(
                f"Cannot connect to WebView2 CDP at {cdp_url}: {e}. "
                "Ensure the Mona app is running with CDP enabled."
            ) from e

    # -- CDP target discovery ------------------------------------------------

    def _get_cdp_targets(self) -> list[dict]:
        """Fetch CDP targets from the /json endpoint.

        The /json endpoint returns all browser targets including their URLs,
        titles, and types. This is useful for debugging and as a fallback
        when Playwright page matching fails.

        Ref: https://chromedevtools.github.io/devtools-protocol/
        """
        config = BrowserToolsConfig()
        url = f"http://{config.cdp_host}:{config.cdp_port}/json"
        try:
            with _NO_PROXY_OPENER.open(url, timeout=5) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            logger.debug("Failed to fetch CDP /json targets: {}", e)
            return []

    def _log_cdp_state(self, tab_id: str) -> None:
        """Log current CDP state for debugging page matching failures."""
        if not self._browser:
            logger.warning("[CDP debug] tab={}: no browser connection", tab_id)
            return
        pages_info = []
        for ctx in self._browser.contexts:
            for page in ctx.pages:
                pages_info.append(f"  url={page.url}")
        targets = self._get_cdp_targets()
        target_info = [f"  url={t.get('url')} type={t.get('type')}" for t in targets]
        logger.warning(
            "[CDP debug] tab={}, Playwright pages ({}):\n{}\n/json targets ({}):\n{}",
            tab_id, len(pages_info), "\n".join(pages_info) or "  (none)",
            len(target_info), "\n".join(target_info) or "  (none)",
        )

    # -- Page matching -------------------------------------------------------

    async def _find_page_for_tab(self, tab_id: str) -> Any | None:
        """Find the Playwright Page corresponding to a browser tab.

        Matching strategies (in order of reliability):
        1. ``__mona_tab_id`` marker — injected by initialization_script, most reliable
        2. Exact URL match — works when no redirects have occurred
        3. /json endpoint — fallback when Playwright contexts are stale
        4. Single non-main page heuristic — last resort for single-tab scenarios
        """
        await self._ensure_cdp_connection()
        if not self._browser or not self._browser.contexts:
            logger.warning("[CDP] No contexts available for tab={}", tab_id)
            return None

        # Get tab info from Tauri
        try:
            tabs = _tauri_invoke("browser_list_tabs")
        except RuntimeError:
            logger.warning("[CDP] IPC browser_list_tabs failed for tab={}", tab_id)
            return None
        if not isinstance(tabs, list):
            logger.warning("[CDP] browser_list_tabs returned non-list for tab={}", tab_id)
            return None
        tab_info = next((t for t in tabs if t.get("id") == tab_id), None)
        if not tab_info:
            logger.warning("[CDP] Tab {} not found in Tauri state, tabs={}", tab_id,
                           [t.get("id") for t in tabs])
            return None

        tab_url = tab_info.get("url", "")
        logger.debug("[CDP] Looking for tab={} url={}", tab_id, tab_url)

        # Strategy 1: Match by __mona_tab_id marker (most reliable)
        # The initialization_script injects window.__mona_tab_id = '{id}' on every
        # navigation, so this survives redirects and page reloads.
        for ctx in self._browser.contexts:
            for page in ctx.pages:
                try:
                    marker = await page.evaluate("window.__mona_tab_id || ''")
                    if marker == tab_id:
                        logger.debug("[CDP] Matched tab={} by __mona_tab_id", tab_id)
                        return page
                except Exception as e:
                    logger.debug("[CDP] evaluate failed on page url={}: {}", page.url, e)
                    continue

        # Strategy 2: Exact URL match (skip main window URLs)
        for ctx in self._browser.contexts:
            for page in ctx.pages:
                if page.url == tab_url and not _is_main_window_url(page.url):
                    logger.debug("[CDP] Matched tab={} by URL: {}", tab_id, tab_url)
                    return page

        # Strategy 3: Use /json endpoint for target discovery
        targets = self._get_cdp_targets()
        page_targets = [
            t
            for t in targets
            if t.get("type") == "page" and not _is_main_window_url(t.get("url", ""))
        ]
        for target in page_targets:
            if target.get("url") == tab_url:
                target_url = target["url"]
                for ctx in self._browser.contexts:
                    for page in ctx.pages:
                        if page.url == target_url:
                            logger.debug("[CDP] Matched tab={} by /json target URL", tab_id)
                            return page

        # Strategy 4: Single non-main page heuristic
        non_main_pages = []
        for ctx in self._browser.contexts:
            for page in ctx.pages:
                if not _is_main_window_url(page.url):
                    non_main_pages.append(page)
        if len(non_main_pages) == 1:
            logger.debug("[CDP] Matched tab={} by single non-main page heuristic", tab_id)
            return non_main_pages[0]

        # All strategies failed — log diagnostic info
        self._log_cdp_state(tab_id)
        return None

    async def _is_page_valid(self, page: Any) -> bool:
        """Check if a cached Playwright Page is still usable."""
        try:
            _ = page.url
            return True
        except Exception:
            return False

    async def _reset_cdp(self) -> None:
        """Reset CDP connection state, closing the old browser if needed."""
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:
                pass
        self._browser = None
        self._pages.clear()

    async def get_page(self, tab_id: str) -> Any:
        """Get or create a Playwright Page for the given tab.

        Includes retry with CDP reconnection for robustness.
        """
        # Check cache
        if tab_id in self._pages:
            page = self._pages[tab_id]
            if await self._cdp_healthy() and await self._is_page_valid(page):
                return page
            # Cached page is stale, remove it
            del self._pages[tab_id]

        # Try finding the page, with one CDP reconnection retry
        page = await self._find_page_for_tab(tab_id)
        if page is None:
            # Force CDP reconnection and retry once
            logger.info("[CDP] Page not found for tab={}, forcing reconnection", tab_id)
            await self._reset_cdp()
            try:
                page = await self._find_page_for_tab(tab_id)
            except RuntimeError:
                pass

        if page is None:
            raise ValueError(
                f"Could not find CDP page for tab '{tab_id}'. "
                "The tab may not have loaded yet. Try browser_open first."
            )
        self._pages[tab_id] = page
        return page

    async def create_tab(self, url: str) -> tuple[str, int]:
        """Create a browser tab via Tauri IPC and return (tab_id, cdp_port)."""
        import asyncio
        import uuid

        tab_id = f"ai-{uuid.uuid4().hex[:8]}"
        result = _tauri_invoke("browser_create_tab", {"id": tab_id, "url": url})
        if isinstance(result, str) and "Error" in result:
            raise RuntimeError(f"Failed to create browser tab: {result}")

        config = BrowserToolsConfig()
        cdp_port = result.get("cdp_port", config.cdp_port) if isinstance(result, dict) else config.cdp_port

        # WebView2 does not reliably publish a newly-created child target to an
        # existing Playwright-over-CDP connection. Reconnect once after creation.
        if self._browser is not None:
            await self._reset_cdp()

        # Ensure CDP connection, then poll for the page to appear
        try:
            await self._ensure_cdp_connection()
        except RuntimeError as e:
            logger.warning("CDP not available for new tab {}: {}", tab_id, e)
            return tab_id, cdp_port

        # Poll for the page to appear (max 5 seconds, 500ms interval)
        for attempt in range(10):
            await asyncio.sleep(0.5)
            try:
                page = await self._find_page_for_tab(tab_id)
                if page is not None:
                    self._pages[tab_id] = page
                    logger.debug("[CDP] Tab {} page found after {:.1f}s", tab_id, (attempt + 1) * 0.5)
                    return tab_id, cdp_port
            except Exception as e:
                logger.debug("[CDP] Poll attempt {} for tab={} failed: {}", attempt + 1, tab_id, e)
                continue

        logger.warning("Could not find CDP page for tab {} after 5s polling", tab_id)
        return tab_id, cdp_port

    async def close_tab(self, tab_id: str) -> None:
        """Close a browser tab via Tauri IPC."""
        self._pages.pop(tab_id, None)
        _tauri_invoke("browser_close_tab", {"id": tab_id})


def _is_main_window_url(url: str) -> bool:
    """Check if a URL belongs to the main Tauri window (not a browser tab)."""
    parsed = urlparse(url)
    if parsed.scheme == "tauri" or parsed.hostname == "tauri.localhost":
        return True
    if parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 9527:
        return True
    return url == "about:blank"


def _resolve_locator(page: Any, target: str) -> Any:
    """Resolve a target reference to a Playwright Locator.

    Following the Playwright MCP convention (microsoft/playwright-mcp):

    - ``ref=e12``  → page.locator('aria-ref=e12') — ARIA snapshot reference,
      the primary and most reliable way to locate elements. Each browser_snapshot
      call assigns unique refs to all interactive elements.
    - ``text=登录`` → page.get_by_text("登录") — by visible text
    - ``role=button/name=确定`` → page.get_by_role("button", name="确定")
    - ``placeholder=请输入`` → page.get_by_placeholder("请输入")
    - ``label=密码`` → page.get_by_label("密码")
    - CSS selector fallback → page.locator(selector)

    Ref: https://github.com/microsoft/playwright-mcp/blob/main/packages/playwright-core/src/tools/backend/tab.ts
    """
    if target.startswith("ref="):
        # ARIA snapshot reference — the primary mechanism from Playwright MCP
        return page.locator(f"aria-ref={target[4:]}")
    if target.startswith("text="):
        return page.get_by_text(target[5:], exact=False)
    if target.startswith("role="):
        parts = target[5:]
        name = None
        if "/name=" in parts:
            role, name = parts.split("/name=", 1)
        else:
            role = parts
        return page.get_by_role(role, name=name) if name else page.get_by_role(role)
    if target.startswith("placeholder="):
        return page.get_by_placeholder(target[12:], exact=False)
    if target.startswith("label="):
        return page.get_by_label(target[6:], exact=False)
    # Fallback: CSS selector
    return page.locator(target)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------


@tool_parameters(
    tool_parameters_schema(
        url=StringSchema("URL to navigate to"),
        required=["url"],
    )
)
class BrowserOpenTool(Tool):
    """Open a new browser tab and navigate to a URL."""

    _scopes = {"core", "subagent"}

    name = "browser_open"
    description = (
        "Open a new browser tab and navigate to the specified URL. "
        "Returns the tab ID for subsequent operations."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, url: str, **kwargs: Any) -> str:
        mgr = await _get_connection_manager()
        try:
            tab_id, cdp_port = await mgr.create_tab(url)
            return json.dumps({"tab_id": tab_id, "cdp_port": cdp_port, "url": url})
        except Exception as e:
            return f"Error opening browser tab: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        url=StringSchema("URL to navigate to"),
        required=["tabId", "url"],
    )
)
class BrowserNavigateTool(Tool):
    """Navigate to a URL in an existing browser tab."""

    _scopes = {"core", "subagent"}

    name = "browser_navigate"
    description = "Navigate to a new URL in the specified browser tab."
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, url: str, **kwargs: Any) -> str:
        try:
            _tauri_invoke("browser_navigate_tab", {"id": tabId, "url": url})
            import asyncio

            await asyncio.sleep(1)  # Wait for navigation to start
            return f"Navigated to {url}"
        except Exception as e:
            return f"Error navigating: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        target=StringSchema(
            "Element reference from the page snapshot. Use ref=e12 (from browser_snapshot), "
            "text=登录, role=button/name=确定, placeholder=请输入, label=密码, or CSS selector"
        ),
        nth=IntegerSchema(
            description=(
                "Optional 0-based index to disambiguate when target matches multiple elements. "
                "Use this to avoid 'strict mode violation' errors when several elements share "
                "the same text/role/label (e.g. multiple '创建新的密钥' buttons). "
                "Prefer ref= from browser_snapshot when possible."
            ),
            minimum=0,
        ),
        required=["tabId", "target"],
    )
)
class BrowserClickTool(Tool):
    """Click an element on the page."""

    _scopes = {"core", "subagent"}

    name = "browser_click"
    description = (
        "Click an element on the page. Use ref= from browser_snapshot for the most "
        "reliable targeting. Also supports text=, role=, placeholder=, label=, "
        "or CSS selectors as fallback. When the selector matches multiple elements "
        "and you cannot get a unique ref, pass nth (0-based) to pick one — this "
        "avoids 'strict mode violation' errors."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, target: str, **kwargs: Any) -> str:
        nth = kwargs.get("nth")
        mgr = await _get_connection_manager()
        try:
            # Record tabs before click to detect new tabs opened by target="_blank"
            tabs_before = set()
            try:
                tabs_before = {t["id"] for t in _tauri_invoke("browser_list_tabs") or []}
            except Exception:
                pass

            page = await mgr.get_page(tabId)
            locator = _resolve_locator(page, target)
            if nth is not None:
                locator = locator.nth(int(nth))
            await locator.click(timeout=10000, force=True)

            # Wait briefly for new tab to appear
            import asyncio
            await asyncio.sleep(0.5)

            # Check if new tabs were opened
            new_tabs_info = ""
            try:
                tabs_after = _tauri_invoke("browser_list_tabs") or []
                new_tabs = [t for t in tabs_after if t["id"] not in tabs_before]
                if new_tabs:
                    new_tabs_info = (
                        "\n\n⚠️ New tab(s) opened by this click:\n"
                        + "\n".join(
                            f"  - tabId: {t['id']}, url: {t.get('url', '')}, "
                            f"title: {t.get('title', '')}"
                            for t in new_tabs
                        )
                        + "\nUse browser_list_tabs to see all tabs, and use the new tabId "
                        "for subsequent operations on the new page."
                    )
            except Exception:
                pass

            return f"Clicked: {target}{new_tabs_info}"
        except Exception as e:
            return f"Error clicking '{target}': {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        target=StringSchema(
            "Element reference from the page snapshot. Use ref=e12 (from browser_snapshot), "
            "placeholder=请输入, label=密码, role=textbox/name=邮箱, or CSS selector"
        ),
        text=StringSchema("Text to type"),
        nth=IntegerSchema(
            description=(
                "Optional 0-based index to disambiguate when target matches multiple elements. "
                "Use this to avoid 'strict mode violation' errors when several inputs share "
                "the same placeholder/label. Prefer ref= from browser_snapshot when possible."
            ),
            minimum=0,
        ),
        required=["tabId", "target", "text"],
    )
)
class BrowserTypeTool(Tool):
    """Type text into an input field."""

    _scopes = {"core", "subagent"}

    name = "browser_type"
    description = (
        "Type text into an input field. Use ref= from browser_snapshot for the most "
        "reliable targeting. Also supports placeholder=, label=, role=, or CSS selectors. "
        "When the selector matches multiple inputs, pass nth (0-based) to pick one — "
        "this avoids 'strict mode violation' errors."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, target: str, text: str, **kwargs: Any) -> str:
        nth = kwargs.get("nth")
        mgr = await _get_connection_manager()
        try:
            page = await mgr.get_page(tabId)
            locator = _resolve_locator(page, target)
            if nth is not None:
                locator = locator.nth(int(nth))
            await locator.fill(text, timeout=10000, force=True)
            return f"Typed '{text}' into: {target}"
        except Exception as e:
            return f"Error typing into '{target}': {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        target=StringSchema(
            "Optional element reference to capture only that region/element. "
            "Use ref=e12 (from browser_snapshot), text=..., role=..., placeholder=..., label=..., "
            "or CSS selector. If omitted, captures the full visible page."
        ),
        nth=IntegerSchema(
            description=(
                "Optional 0-based index to disambiguate when target matches multiple elements. "
                "Use this to avoid 'strict mode violation' errors. "
                "Prefer ref= from browser_snapshot when possible."
            ),
            minimum=0,
        ),
        required=["tabId"],
    )
)
class BrowserScreenshotTool(Tool):
    """Take a screenshot of the current page or a specific element/region."""

    _scopes = {"core", "subagent"}

    name = "browser_screenshot"
    description = (
        "Take a screenshot of the current page or a specific element/region and save to a temp file. "
        "To capture a region/element, use ref= from browser_snapshot (e.g. ref=e12). "
        "Also supports text=, role=, placeholder=, label=, or CSS selectors. "
        "If no target is provided, captures the full visible page. "
        "When the selector matches multiple elements, pass nth (0-based) to pick one."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, tabId: str, target: str | None = None, **kwargs: Any) -> str:
        nth = kwargs.get("nth")
        mgr = await _get_connection_manager()
        try:
            page = await mgr.get_page(tabId)
            import base64
            import tempfile
            import time

            if target:
                # For region screenshots we still need Playwright's locator API,
                # which waits for fonts. Use a short timeout and fall back to
                # full-page CDP screenshot on failure.
                try:
                    locator = _resolve_locator(page, target)
                    if nth is not None:
                        locator = locator.nth(int(nth))
                    screenshot_bytes = await locator.screenshot(timeout=8000)
                    region_label = f"region: {target}"
                    if nth is not None:
                        region_label += f" [nth={nth}]"
                except Exception as loc_err:
                    logger.warning(
                        "Locator screenshot failed ({}), falling back to full page CDP",
                        loc_err,
                    )
                    screenshot_bytes = await _cdp_screenshot(page)
                    region_label = f"full visible page (region {target} unavailable)"
            else:
                # Full-page screenshot via raw CDP — bypasses Playwright's
                # internal `document.fonts.ready` wait that hangs on sites
                # with slow/unreachable @font-face CDNs (e.g. Google Fonts in CN).
                screenshot_bytes = await _cdp_screenshot(page)
                region_label = "full visible page"

            screenshots_dir = Path(tempfile.gettempdir()) / "mona-browser-screenshots"
            screenshots_dir.mkdir(parents=True, exist_ok=True)

            filename = f"screenshot_{tabId}_{int(time.time())}.png"
            filepath = screenshots_dir / filename
            filepath.write_bytes(screenshot_bytes)

            return (
                f"Screenshot saved to: {filepath}\n"
                f"Region: {region_label}\n"
                f"File size: {len(screenshot_bytes)} bytes\n"
                f"Tab: {tabId}"
            )
        except Exception as e:
            return f"Error taking screenshot: {e}"


async def _cdp_screenshot(page: Any) -> bytes:
    """Take a full-page screenshot via raw CDP, bypassing Playwright's font wait.

    Playwright's `page.screenshot()` internally waits for `document.fonts.ready`,
    which hangs for ~30s on sites with @font-face pointing to unreachable CDNs.
    Going straight to the CDP `Page.captureScreenshot` command skips that wait
    and captures the page as currently rendered (with fallback fonts).
    """
    client = await page.context.new_cdp_session(page)
    try:
        result = await client.send(
            "Page.captureScreenshot",
            {"format": "png", "captureBeyondViewport": False},
        )
        data_b64 = result.get("data") if isinstance(result, dict) else None
        if not data_b64:
            raise RuntimeError("CDP captureScreenshot returned no data")
        return base64.b64decode(data_b64)
    finally:
        await client.detach()


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        required=["tabId"],
    )
)
class BrowserReadTool(Tool):
    """Read the text content of the current page.

    Note: ``inner_text`` cannot read input/textarea values (they are IDL
    attributes, not text nodes). We append a "Form field values" section
    so disabled/readonly fields (e.g. a generated API key in a disabled
    textbox) are visible to the agent. Password fields are skipped for
    security.
    """

    _scopes = {"core", "subagent"}

    name = "browser_read"
    description = (
        "Read and return the visible text content of the current page. "
        "Also appends input/textarea values (except password fields) so that "
        "disabled/readonly fields like a generated API key are readable — "
        "inner_text alone cannot capture input values."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, tabId: str, **kwargs: Any) -> str:
        mgr = await _get_connection_manager()
        try:
            page = await mgr.get_page(tabId)
            text = await page.inner_text("body", timeout=10000)

            # inner_text cannot read input/textarea values (they are IDL
            # attributes, not text nodes). Append form control values so the
            # agent can see disabled/readonly fields like generated API keys.
            # Skip password fields for security. Cap each value at 500 chars.
            try:
                form_values = await page.eval_on_selector_all(
                    "input, textarea",
                    """els => els
                      .filter(e => e.type !== 'password' && e.value)
                      .map(e => ({
                        id: e.id || '',
                        name: e.name || '',
                        type: e.type || '',
                        placeholder: e.placeholder || '',
                        disabled: e.disabled,
                        readOnly: e.readOnly,
                        value: String(e.value).slice(0, 500)
                      }))""",
                )
                if form_values:
                    lines = ["\n\n--- Form field values ---"]
                    for fv in form_values:
                        label = (
                            fv.get("id")
                            or fv.get("name")
                            or fv.get("placeholder")
                            or fv.get("type")
                            or "field"
                        )
                        state_parts = []
                        if fv.get("disabled"):
                            state_parts.append("disabled")
                        if fv.get("readOnly"):
                            state_parts.append("readonly")
                        state = (
                            f" [{', '.join(state_parts)}]" if state_parts else ""
                        )
                        lines.append(f"{label}{state}: {fv['value']}")
                    text = text + "\n".join(lines)
            except Exception as form_err:
                logger.debug("Failed to read form field values: {}", form_err)

            return text[:50000] if len(text) > 50000 else text
        except Exception as e:
            return f"Error reading page: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        required=["tabId"],
    )
)
class BrowserSnapshotTool(Tool):
    """Capture accessibility snapshot of the current page.

    Uses Playwright's aria_snapshot(mode='ai') to generate a compact
    accessibility tree — the same approach as Microsoft's Playwright MCP.

    Each interactive element gets a unique ref (e.g. ``e12``) that can be
    used with browser_click/browser_type via ``ref=e12``.

    Ref: https://github.com/microsoft/playwright-mcp
    """

    _scopes = {"core", "subagent"}

    name = "browser_snapshot"
    description = (
        "Capture accessibility snapshot of the current page. This is better than "
        "screenshot for understanding page structure. Returns a compact tree of "
        "all interactive elements with unique refs (e.g. ref=e12). Use these refs "
        "with browser_click(tabId, 'ref=e12') and browser_type(tabId, 'ref=e12', text). "
        "Always call this before interacting with a page."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, tabId: str, **kwargs: Any) -> str:
        mgr = await _get_connection_manager()
        try:
            page = await mgr.get_page(tabId)
            # Use Playwright's built-in ARIA snapshot — same as Playwright MCP
            # Ref: https://playwright.dev/python/docs/api/class-page#page-aria-snapshot
            snapshot = await page.aria_snapshot(mode="ai")
            if not snapshot or not snapshot.strip():
                return f"Page URL: {page.url}\nNo interactive elements found."
            return f"Page URL: {page.url}\n{snapshot}"
        except Exception as e:
            return f"Error taking snapshot: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID to close"),
        required=["tabId"],
    )
)
class BrowserCloseTool(Tool):
    """Close a browser tab."""

    _scopes = {"core", "subagent"}

    name = "browser_close"
    description = "Close the specified browser tab."
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, **kwargs: Any) -> str:
        mgr = await _get_connection_manager()
        try:
            await mgr.close_tab(tabId)
            return f"Closed tab: {tabId}"
        except Exception as e:
            return f"Error closing tab: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        required=["tabId"],
    )
)
class BrowserGoBackTool(Tool):
    """Go back in browser history."""

    _scopes = {"core", "subagent"}

    name = "browser_go_back"
    description = "Navigate back in the browser history for the specified tab."
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, **kwargs: Any) -> str:
        try:
            _tauri_invoke("browser_go_back", {"id": tabId})
            import asyncio

            await asyncio.sleep(1)
            return "Navigated back"
        except Exception as e:
            return f"Error going back: {e}"


@tool_parameters(
    tool_parameters_schema(
        tabId=StringSchema("Browser tab ID"),
        required=["tabId"],
    )
)
class BrowserGoForwardTool(Tool):
    """Go forward in browser history."""

    _scopes = {"core", "subagent"}

    name = "browser_go_forward"
    description = "Navigate forward in the browser history for the specified tab."
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, tabId: str, **kwargs: Any) -> str:
        try:
            _tauri_invoke("browser_go_forward", {"id": tabId})
            import asyncio

            await asyncio.sleep(1)
            return "Navigated forward"
        except Exception as e:
            return f"Error going forward: {e}"


@tool_parameters(
    tool_parameters_schema()
)
class BrowserListTabsTool(Tool):
    """List all open browser tabs."""

    _scopes = {"core", "subagent"}

    name = "browser_list_tabs"
    description = (
        "List all open browser tabs with their IDs, URLs, and titles. "
        "Use this to discover new tabs that may have been opened by clicking links, "
        "or to find the correct tabId for subsequent operations."
    )
    config_key = "browser"

    @classmethod
    def config_cls(cls):
        return BrowserToolsConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _playwright_available()

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        try:
            tabs = _tauri_invoke("browser_list_tabs") or []
            if not tabs:
                return "No browser tabs open."
            lines = ["Open browser tabs:"]
            for t in tabs:
                lines.append(
                    f"  - tabId: {t['id']}, url: {t.get('url', '')}, "
                    f"title: {t.get('title', '')}, "
                    f"aiControlled: {t.get('is_ai_controlled', False)}"
                )
            return "\n".join(lines)
        except Exception as e:
            return f"Error listing tabs: {e}"
