"""Test browser tools by opening a page and logging in."""
import asyncio
import json
import urllib.request
from pathlib import Path
from typing import Any


# ---- Inline minimal IPC + CDP logic (avoid importing mona package) ----

_GATEWAY_BASE = "http://127.0.0.1"
_FALLBACK_IPC_PORT = 17860
_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"


def _read_ipc_port() -> int:
    try:
        text = _IPC_PORT_FILE.read_text().strip()
        port = int(text)
        if 1 <= port <= 65535:
            return port
    except (FileNotFoundError, ValueError, PermissionError):
        pass
    return _FALLBACK_IPC_PORT


def _tauri_invoke(cmd: str, args: dict | None = None) -> Any:
    port = _read_ipc_port()
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    url = f"{_GATEWAY_BASE}:{port}"
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])
        return result.get("result", result)


def _is_main_window_url(url: str) -> bool:
    return (
        url.startswith("tauri://")
        or url.startswith("http://localhost:1")
        or url == "about:blank"
    )


async def find_page(tab_id: str):
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")

    # Strategy 1: __mona_tab_id
    for ctx in browser.contexts:
        for page in ctx.pages:
            try:
                marker = await page.evaluate("window.__mona_tab_id || ''")
                if marker == tab_id:
                    return pw, browser, page
            except Exception:
                continue

    # Strategy 2: URL match
    tabs = _tauri_invoke("browser_list_tabs")
    tab_info = next((t for t in tabs if t.get("id") == tab_id), None)
    if tab_info:
        tab_url = tab_info.get("url", "")
        for ctx in browser.contexts:
            for page in ctx.pages:
                if page.url == tab_url and not _is_main_window_url(page.url):
                    return pw, browser, page

    # Strategy 3: single non-main page
    non_main = [p for c in browser.contexts for p in c.pages if not _is_main_window_url(p.url)]
    if len(non_main) == 1:
        return pw, browser, non_main[0]

    return pw, browser, None


async def test():
    # Step 1: Create tab via IPC
    print("=== Step 1: browser_open ===")
    import uuid
    tab_id = f"test-{uuid.uuid4().hex[:8]}"
    result = _tauri_invoke("browser_create_tab", {"id": tab_id, "url": "http://58.48.71.131:8083/"})
    print(f"IPC result: {result}")
    print(f"tab_id: {tab_id}")

    # Wait for page to load
    await asyncio.sleep(3)

    # Step 2: Find page via CDP
    print("\n=== Step 2: Find CDP page ===")
    pw, browser, page = await find_page(tab_id)
    if page is None:
        print("ERROR: Could not find CDP page!")
        # Dump debug info
        for ctx in browser.contexts:
            for p in ctx.pages:
                print(f"  Page: url={p.url}")
        await browser.close()
        await pw.stop()
        return
    print(f"Found page: url={page.url}")

    # Step 3: Read page content
    print("\n=== Step 3: Read page ===")
    try:
        text = await page.inner_text("body", timeout=10000)
        print(f"Page text (first 300): {text[:300]}")
    except Exception as e:
        print(f"Read error: {e}")

    # Step 4: Screenshot
    print("\n=== Step 4: Screenshot ===")
    try:
        import tempfile, time
        screenshots_dir = Path(tempfile.gettempdir()) / "mona-browser-screenshots"
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        filepath = screenshots_dir / f"test_{int(time.time())}.png"
        screenshot_bytes = await page.screenshot(timeout=15000)
        filepath.write_bytes(screenshot_bytes)
        print(f"Screenshot saved: {filepath} ({len(screenshot_bytes)} bytes)")
    except Exception as e:
        print(f"Screenshot error: {e}")

    # Step 5: Type username
    print("\n=== Step 5: Type username ===")
    for selector in ["input[type='text']", "input[name='username']", "input[placeholder*='用户']", "input[placeholder*='账号']", "#username", ".el-input input[type='text']"]:
        try:
            await page.fill(selector, "admin", timeout=3000, force=True)
            print(f"  Filled username with selector: {selector}")
            break
        except Exception as e:
            print(f"  selector={selector}: {e}")

    # Step 6: Type password
    print("\n=== Step 6: Type password ===")
    for selector in ["input[type='password']", "input[name='password']", "input[placeholder*='密码']", "#password", ".el-input input[type='password']"]:
        try:
            await page.fill(selector, "admin123", timeout=3000, force=True)
            print(f"  Filled password with selector: {selector}")
            break
        except Exception as e:
            print(f"  selector={selector}: {e}")

    # Step 7: Click login
    print("\n=== Step 7: Click login ===")
    for selector in ["button[type='submit']", "button:has-text('登录')", "button:has-text('Login')", ".login-btn", "input[type='submit']", ".el-button--primary"]:
        try:
            await page.click(selector, timeout=3000, force=True)
            print(f"  Clicked login with selector: {selector}")
            break
        except Exception as e:
            print(f"  selector={selector}: {e}")

    # Step 8: Wait and check result
    print("\n=== Step 8: Check result after login ===")
    await asyncio.sleep(3)
    print(f"Current URL: {page.url}")
    try:
        text = await page.inner_text("body", timeout=10000)
        print(f"Page text (first 300): {text[:300]}")
    except Exception as e:
        print(f"Read error: {e}")

    # Final screenshot
    try:
        filepath = screenshots_dir / f"test_after_login_{int(time.time())}.png"
        screenshot_bytes = await page.screenshot(timeout=15000)
        filepath.write_bytes(screenshot_bytes)
        print(f"Final screenshot saved: {filepath} ({len(screenshot_bytes)} bytes)")
    except Exception as e:
        print(f"Screenshot error: {e}")

    await browser.close()
    await pw.stop()
    print("\n=== Test complete ===")


asyncio.run(test())
