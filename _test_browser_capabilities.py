"""Systematic test of browser capabilities via Playwright CDP."""
import asyncio
import json
import urllib.request
from pathlib import Path

_GATEWAY_BASE = "http://127.0.0.1"
_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"


def _read_ipc_port():
    try:
        text = _IPC_PORT_FILE.read_text().strip()
        return int(text)
    except Exception:
        return 17860


def _tauri_invoke(cmd, args=None):
    port = _read_ipc_port()
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    url = f"{_GATEWAY_BASE}:{port}"
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])
        return result.get("result", result)


def _is_main_window_url(url):
    return url.startswith("tauri://") or url.startswith("http://localhost:1") or url == "about:blank"


async def find_page(tab_id):
    from playwright.async_api import async_playwright
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")
    for ctx in browser.contexts:
        for page in ctx.pages:
            try:
                marker = await page.evaluate("window.__mona_tab_id || ''")
                if marker == tab_id:
                    return pw, browser, page
            except Exception:
                continue
    return pw, browser, None


async def test_capability(name, test_fn):
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    try:
        result = await test_fn()
        status = "PASS" if result else "FAIL"
        print(f"RESULT: {status}")
        return status == "PASS"
    except Exception as e:
        print(f"RESULT: FAIL - {e}")
        return False


async def main():
    results = {}

    # ===== 1. IPC Bridge =====
    async def test_ipc():
        tabs = _tauri_invoke("browser_list_tabs")
        print(f"  IPC bridge OK, tabs: {json.dumps(tabs, indent=2, ensure_ascii=False)[:200]}")
        return isinstance(tabs, list)
    results["IPC Bridge"] = await test_capability("IPC Bridge 连通性", test_ipc)

    # ===== 2. CDP Connection =====
    async def test_cdp():
        from playwright.async_api import async_playwright
        pw = await async_playwright().start()
        browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")
        ctx_count = len(browser.contexts)
        page_count = sum(len(c.pages) for c in browser.contexts)
        print(f"  CDP connected, {ctx_count} contexts, {page_count} pages")
        for ctx in browser.contexts:
            for p in ctx.pages:
                print(f"    - {p.url[:80]}")
        await browser.close()
        await pw.stop()
        return ctx_count > 0
    results["CDP Connection"] = await test_capability("CDP 连接", test_cdp)

    # ===== 3. Create Tab + Page Matching =====
    import uuid
    test_tab_id = f"test-{uuid.uuid4().hex[:8]}"

    async def test_create_tab():
        result = _tauri_invoke("browser_create_tab", {"id": test_tab_id, "url": "https://www.bing.com"})
        print(f"  Create tab result: {result}")
        await asyncio.sleep(3)
        pw, browser, page = await find_page(test_tab_id)
        if page:
            print(f"  Page found: url={page.url}")
            print(f"  __mona_tab_id check: {await page.evaluate('window.__mona_tab_id || \"\"')}")
            await browser.close()
            await pw.stop()
            return True
        else:
            print("  Page NOT found via __mona_tab_id")
            # Fallback: check CDP targets
            targets = json.loads(urllib.request.urlopen("http://127.0.0.1:9300/json", timeout=5).read().decode())
            bing_targets = [t for t in targets if "bing" in t.get("url", "")]
            print(f"  CDP /json bing targets: {bing_targets}")
            await browser.close()
            await pw.stop()
            return False
    results["Create Tab + Page Match"] = await test_capability("创建标签 + Page 匹配", test_create_tab)

    # ===== 4. ARIA Snapshot =====
    async def test_aria_snapshot():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        snapshot = await page.aria_snapshot(mode="ai")
        lines = snapshot.split("\n")
        print(f"  ARIA snapshot ({len(lines)} lines):")
        for line in lines[:15]:
            print(f"    {line}")
        if len(lines) > 15:
            print(f"    ... ({len(lines) - 15} more lines)")
        await browser.close()
        await pw.stop()
        return len(snapshot) > 0
    results["ARIA Snapshot"] = await test_capability("ARIA 快照 (aria_snapshot)", test_aria_snapshot)

    # ===== 5. aria-ref Locator =====
    async def test_aria_ref():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        snapshot = await page.aria_snapshot(mode="ai")
        # Find a ref in the snapshot
        import re
        refs = re.findall(r'\[ref=(e\d+)\]', snapshot)
        if not refs:
            print("  No refs found in snapshot")
            await browser.close()
            await pw.stop()
            return False
        test_ref = refs[0]
        print(f"  Testing ref={test_ref}")
        locator = page.locator(f"aria-ref={test_ref}")
        count = await locator.count()
        print(f"  Locator count: {count}")
        await browser.close()
        await pw.stop()
        return count > 0
    results["aria-ref Locator"] = await test_capability("aria-ref 定位器", test_aria_ref)

    # ===== 6. Online Video (腾讯视频) =====
    async def test_video():
        # Use existing tab with QQ video
        from playwright.async_api import async_playwright
        pw = await async_playwright().start()
        browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")
        video_page = None
        for ctx in browser.contexts:
            for page in ctx.pages:
                if "v.qq.com" in page.url:
                    video_page = page
                    break
        if not video_page:
            print("  No QQ video tab found")
            await browser.close()
            await pw.stop()
            return False
        print(f"  Video page: {video_page.url}")
        # Check if video element exists
        has_video = await video_page.evaluate("""
            () => {
                const video = document.querySelector('video');
                return {
                    exists: !!video,
                    src: video ? (video.src || video.querySelector('source')?.src || 'no src') : 'no video',
                    paused: video ? video.paused : null,
                    currentTime: video ? video.currentTime : null,
                    readyState: video ? video.readyState : null,
                };
            }
        """)
        print(f"  Video element: {json.dumps(has_video, ensure_ascii=False)}")
        await browser.close()
        await pw.stop()
        return has_video.get("exists", False)
    results["Online Video"] = await test_capability("在线视频 (腾讯视频)", test_video)

    # ===== 7. Audio Support =====
    async def test_audio():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        # Navigate to a page and test Audio API
        _tauri_invoke("browser_navigate_tab", {"id": test_tab_id, "url": "https://www.bing.com"})
        await asyncio.sleep(2)
        # Re-find page after navigation
        pw2, browser2, page2 = await find_page(test_tab_id)
        if not page2:
            await browser.close()
            await pw.stop()
            if browser2:
                await browser2.close()
            await pw2.stop()
            return False
        audio_support = await page2.evaluate("""
            () => {
                const audio = document.createElement('audio');
                return {
                    canPlayType_mp3: audio.canPlayType('audio/mpeg'),
                    canPlayType_wav: audio.canPlayType('audio/wav'),
                    canPlayType_ogg: audio.canPlayType('audio/ogg'),
                    webAudioAPI: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined',
                };
            }
        """)
        print(f"  Audio support: {json.dumps(audio_support, ensure_ascii=False)}")
        await browser.close()
        await pw.stop()
        await browser2.close()
        await pw2.stop()
        return audio_support.get("canPlayType_mp3", "") != ""
    results["Audio Support"] = await test_capability("音频支持 (Audio API)", test_audio)

    # ===== 8. target="_blank" Interception =====
    async def test_blank_link():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        # Check if __mona_tab_id is set (proves initialization_script ran)
        marker = await page.evaluate("window.__mona_tab_id || ''")
        print(f"  __mona_tab_id = {marker!r}")
        # Check if blank link interceptor is present
        has_interceptor = await page.evaluate("""
            () => {
                // The interceptor adds a click event listener on window
                // We can't directly check, but we can verify the script ran by checking __mona_tab_id
                return !!window.__mona_tab_id;
            }
        """)
        print(f"  Initialization script ran: {has_interceptor}")
        await browser.close()
        await pw.stop()
        return bool(marker)
    results["target=_blank Interception"] = await test_capability("target=_blank 拦截", test_blank_link)

    # ===== 9. Navigation (on_navigation callback) =====
    async def test_navigation():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        old_url = page.url
        _tauri_invoke("browser_navigate_tab", {"id": test_tab_id, "url": "https://www.baidu.com"})
        await asyncio.sleep(3)
        # Re-find page
        pw2, browser2, page2 = await find_page(test_tab_id)
        new_url = page2.url if page2 else "NOT FOUND"
        print(f"  Navigate: {old_url} -> {new_url}")
        # Check Tauri state
        tabs = _tauri_invoke("browser_list_tabs")
        tab_info = next((t for t in tabs if t.get("id") == test_tab_id), None)
        tauri_url = tab_info.get("url", "") if tab_info else ""
        print(f"  Tauri state URL: {tauri_url}")
        ok = "baidu" in new_url.lower()
        if browser2:
            await browser2.close()
        await pw2.stop()
        await browser.close()
        await pw.stop()
        return ok
    results["Navigation"] = await test_capability("导航 (on_navigation)", test_navigation)

    # ===== 10. Screenshot =====
    async def test_screenshot():
        pw, browser, page = await find_page(test_tab_id)
        if not page:
            await browser.close()
            await pw.stop()
            return False
        import tempfile, time
        screenshots_dir = Path(tempfile.gettempdir()) / "mona-browser-screenshots"
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        filepath = screenshots_dir / f"capability_test_{int(time.time())}.png"
        screenshot_bytes = await page.screenshot(timeout=15000)
        filepath.write_bytes(screenshot_bytes)
        print(f"  Screenshot saved: {filepath} ({len(screenshot_bytes)} bytes)")
        await browser.close()
        await pw.stop()
        return len(screenshot_bytes) > 1000
    results["Screenshot"] = await test_capability("截图 (screenshot)", test_screenshot)

    # ===== Cleanup =====
    try:
        _tauri_invoke("browser_close_tab", {"id": test_tab_id})
        print(f"\n  Cleaned up test tab: {test_tab_id}")
    except Exception:
        pass

    # ===== Summary =====
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    print(f"\n  Total: {passed}/{total}")


asyncio.run(main())
