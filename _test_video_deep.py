"""Deep test: video playback in WebView2."""
import asyncio
import json
import urllib.request
from pathlib import Path

_GATEWAY_BASE = "http://127.0.0.1"
_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"


def _read_ipc_port():
    try:
        return int(_IPC_PORT_FILE.read_text().strip())
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


async def main():
    import uuid
    tab_id = f"test-{uuid.uuid4().hex[:8]}"

    # Test 1: Bilibili video (popular Chinese video site)
    print("=== Test 1: Bilibili Video ===")
    result = _tauri_invoke("browser_create_tab", {"id": tab_id, "url": "https://www.bilibili.com/video/BV1GJ411x7h7/"})
    print(f"Create tab: {result}")
    await asyncio.sleep(5)

    pw, browser, page = await find_page(tab_id)
    if not page:
        print("Page not found!")
        return

    print(f"Page URL: {page.url}")
    print(f"Page title: {await page.title()}")

    # Check video elements
    media_info = await page.evaluate("""
        () => {
            const videos = document.querySelectorAll('video');
            const iframes = document.querySelectorAll('iframe');
            return {
                videoCount: videos.length,
                iframeCount: iframes.length,
                videoDetails: Array.from(videos).map(v => ({
                    src: v.src || v.querySelector('source')?.src || 'no src',
                    currentSrc: v.currentSrc || 'none',
                    paused: v.paused,
                    readyState: v.readyState,
                    networkState: v.networkState,
                    error: v.error ? v.error.message : null,
                    videoWidth: v.videoWidth,
                    videoHeight: v.videoHeight,
                })),
                iframeDetails: Array.from(iframes).slice(0, 3).map(f => ({
                    src: f.src || 'no src',
                })),
            };
        }
    """)
    print(f"Media: {json.dumps(media_info, indent=2, ensure_ascii=False)}")

    # Check codec support
    codec_info = await page.evaluate("""
        () => {
            const video = document.createElement('video');
            return {
                h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
                h264_high: video.canPlayType('video/mp4; codecs="avc1.640028"'),
                vp8: video.canPlayType('video/webm; codecs="vp8"'),
                vp9: video.canPlayType('video/webm; codecs="vp9"'),
                av1: video.canPlayType('video/mp4; codecs="av01.0.01M.08"'),
                hevc: video.canPlayType('video/mp4; codecs="hvc1"'),
                mse: typeof MediaSource !== 'undefined',
                eme: typeof navigator.requestMediaKeySystemAccess !== 'undefined',
            };
        }
    """)
    print(f"Codecs: {json.dumps(codec_info, indent=2, ensure_ascii=False)}")

    # Test 2: Simple HTML5 video test
    print("\n=== Test 2: Direct HTML5 Video Test ===")
    _tauri_invoke("browser_navigate_tab", {"id": tab_id, "url": "https://www.w3schools.com/html/html5_video.asp"})
    await asyncio.sleep(4)

    # Re-find page
    pw2, browser2, page2 = await find_page(tab_id)
    if page2:
        print(f"Page URL: {page2.url}")
        w3_media = await page2.evaluate("""
            () => {
                const videos = document.querySelectorAll('video');
                return {
                    videoCount: videos.length,
                    videoDetails: Array.from(videos).map(v => ({
                        src: v.src || v.querySelector('source')?.src || 'no src',
                        currentSrc: v.currentSrc || 'none',
                        paused: v.paused,
                        readyState: v.readyState,
                        videoWidth: v.videoWidth,
                        videoHeight: v.videoHeight,
                    })),
                };
            }
        """)
        print(f"W3Schools media: {json.dumps(w3_media, indent=2, ensure_ascii=False)}")
        await browser2.close()
        await pw2.stop()

    await browser.close()
    await pw.stop()

    # Cleanup
    try:
        _tauri_invoke("browser_close_tab", {"id": tab_id})
    except Exception:
        pass


asyncio.run(main())
