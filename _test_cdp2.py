import asyncio
import json
import urllib.request
from pathlib import Path

# Simulate what browser.py does

_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"


def _read_ipc_port():
    try:
        text = _IPC_PORT_FILE.read_text().strip()
        port = int(text)
        if 1 <= port <= 65535:
            return port
    except (FileNotFoundError, ValueError, PermissionError):
        pass
    return 17860


def _tauri_invoke(cmd, args=None):
    port = _read_ipc_port()
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    url = f"http://127.0.0.1:{port}"
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])
        return result.get("result", result)


def _is_main_window_url(url):
    return (
        url.startswith("tauri://")
        or url.startswith("http://localhost:1")
        or url == "about:blank"
    )


async def test_find_page():
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")

    tab_id = "ai-bc2992a8"

    # Get tab info from Tauri
    tabs = _tauri_invoke("browser_list_tabs")
    tab_info = next((t for t in tabs if t.get("id") == tab_id), None)
    if not tab_info:
        print(f"Tab {tab_id} not found in Tauri state")
        return

    tab_url = tab_info.get("url", "")
    print(f"Tauri tab_url: {tab_url}")

    # Strategy 1: __mona_tab_id
    for ctx in browser.contexts:
        for page in ctx.pages:
            try:
                marker = await page.evaluate("window.__mona_tab_id || ''")
                print(f"  Page {page.url}: __mona_tab_id = {marker!r}")
                if marker == tab_id:
                    print(f"  >>> MATCHED by __mona_tab_id!")
            except Exception as e:
                print(f"  Page {page.url}: evaluate error: {e}")

    # Strategy 2: URL match
    for ctx in browser.contexts:
        for page in ctx.pages:
            if page.url == tab_url and not _is_main_window_url(page.url):
                print(f"  >>> MATCHED by URL: {page.url}")

    # Show the mismatch
    print(f"\nTauri URL: {tab_url}")
    for ctx in browser.contexts:
        for page in ctx.pages:
            if not _is_main_window_url(page.url):
                print(f"CDP  URL:  {page.url}")

    await browser.close()
    await pw.stop()


asyncio.run(test_find_page())
