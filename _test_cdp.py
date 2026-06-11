import asyncio
from playwright.async_api import async_playwright


async def test():
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")
    print(f"Contexts: {len(browser.contexts)}")
    for i, ctx in enumerate(browser.contexts):
        print(f"  Context {i}: {len(ctx.pages)} pages")
        for j, page in enumerate(ctx.pages):
            print(f"    Page {j}: url={page.url}")
            try:
                marker = await page.evaluate("window.__mona_tab_id || ''")
                print(f"    __mona_tab_id = {marker!r}")
            except Exception as e:
                print(f"    evaluate error: {e}")
    await browser.close()
    await pw.stop()


asyncio.run(test())
