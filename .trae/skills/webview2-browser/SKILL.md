---
name: "webview2-browser"
description: "WebView2 browser development in Tauri 2. Invoke when developing embedded browser, multi-tab webview, CDP automation, or WebView2-related features."
---

# WebView2 Browser Development (Tauri 2)

## 红线规则

1. **不要设置 `data_directory`** — 不同 data_directory 会启动独立的 WebView2 浏览器进程，不共享 CDP 端口，Playwright 无法连接子 WebView。所有 WebView 共享默认的 EBWebView 目录即可实现缓存持久化。
2. **`on_new_window` 不可用** — 必须用 `initialization_script` 拦截 `target="_blank"` 链接
3. **JS API 没有 `navigate` 方法** — 导航必须通过 Rust IPC 命令
4. **`add_child` 可能阻塞 IPC** — 使用 `app.state::<BrowserState>()` 获取状态
5. **CDP 端口必须在 `run()` 之前设置** — 运行时修改无效，所有 WebView 共享同一端口

## CDP + Playwright 自动化

### 连接与 Page 匹配

```python
from playwright.async_api import async_playwright

pw = await async_playwright().start()
browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9300")

# 匹配子 WebView Page：通过 initialization_script 注入的 __mona_tab_id 标记
for ctx in browser.contexts:
    for page in ctx.pages:
        marker = await page.evaluate("window.__mona_tab_id || ''")
        if marker == tab_id:
            return page  # 找到对应的 Page
```

- 子 WebView 的 `initialization_script` 注入 `window.__mona_tab_id = '{id}'`
- CDP 连接断开后必须重连，`browser.contexts` 不抛异常不代表连接有效
- 验证 CDP 可用：`http://127.0.0.1:9300/json` 应返回至少一个 page target

### AI 浏览器交互（Playwright MCP 方案）

```python
# 1. 获取 ARIA 快照（与微软 Playwright MCP 一致）
snapshot = await page.aria_snapshot(mode="ai")
# 返回示例：
# - textbox "用户名" [ref=e3]
# - textbox "密码" [ref=e5]
# - button "登录" [ref=e7]

# 2. 通过 ref 定位并操作元素
locator = page.locator("aria-ref=e3")
await locator.fill("admin", force=True)  # force=True: WebView2 可见性检测不可靠

# 3. 点击按钮
locator = page.locator("aria-ref=e7")
await locator.click(force=True)
```

- **`page.aria_snapshot(mode='ai')`** 是 Playwright 内置的可访问性树，比自定义 JS 遍历 DOM 可靠
- **`aria-ref` 定位器** 是 Playwright MCP 的标准元素引用机制
- **`force=True`** 必须设置，WebView2 子 WebView 的可见性状态与 Playwright 预期不同

## 官方参考

- Playwright MCP (微软官方): https://github.com/microsoft/playwright-mcp
- Playwright `aria_snapshot`: https://playwright.dev/python/docs/api/class-page#page-aria-snapshot
- WebView2 CDP 协议: https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol
- WebView2 环境变量: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/environment-variables
- Tauri multiwebview 示例: https://github.com/tauri-apps/tauri/tree/dev/examples/multiwebview
