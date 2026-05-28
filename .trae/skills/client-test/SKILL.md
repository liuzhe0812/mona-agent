---
name: "client-test"
description: "Web and Tauri desktop UI automation testing. Invoke when user asks to test UI, verify layout, check scrollbars, screenshot pages, or automate browser/Tauri client interactions."
---

# Client UI Automation Testing

| Mode | How | Coverage |
|------|-----|----------|
| Browser | Playwright → Vite dev server | Layout, CSS, interactions |
| Tauri CDP | Playwright → CDP → Tauri WebView | All browser + Tauri IPC |

## Mode 1: Browser (Playwright)

### Setup

```bash
cd webui && npm install playwright --no-save && npx playwright install chromium
```

Dev server or Gateway must be running.

### Template

```javascript
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);
  // --- test logic ---
  await browser.close();
})();
```

Run: `node <script>.cjs` from `webui/`.

## Mode 2: Tauri CDP (Playwright + Chrome DevTools Protocol)

Connect Playwright to the running Tauri app via CDP. No release build, no tauri-driver needed. Full IPC access.

### Setup

1. Start Gateway: `mona gateway`
2. Start Tauri dev with CDP port:
```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
cargo tauri dev
```
3. Wait for app window to appear.

### Template

```javascript
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  // Page 0 = DevTools, Page 1 = app. Always find by URL:
  const page = browser.contexts()[0].pages().find(p => p.url().includes("127.0.0.1:5173"));
  if (!page) { console.error("App page not found"); process.exit(1); }
  // --- test logic ---
  await browser.close();
})();
```

### Tauri IPC Calls

Call any registered Tauri command directly from `page.evaluate`:

```javascript
const result = await page.evaluate(async () => {
  try {
    return await window.__TAURI_INTERNALS__.invoke("command_name", { arg1: "value" });
  } catch (err) {
    return { error: err.message };
  }
});
```

**Key rules for IPC in `page.evaluate`**:
- Use `window.__TAURI_INTERNALS__.invoke`, NOT `import("@tauri-apps/api/core")` (dynamic import doesn't work in evaluate context)
- Use camelCase param names (e.g. `connectionId` not `connection_id`) — Tauri v2 auto-converts
- For MySQL queries, use qualified table names: `` `database`.`table` `` to avoid schema ambiguity
- For SQLite, `host` field holds the path (e.g. `:memory:`), not `database`

### UI + IPC coordination

When testing features that use both UI state (Zustand store) and IPC:

1. **Let the UI manage connections** — click connection items in tree to trigger store's `connect()`, which also calls `refreshTree()`
2. **Don't mix IPC direct calls with UI state** — if you `db_connect` via IPC directly, the store won't know about it, causing `isConnected()` to return false and UI tree to not render
3. **After UI connection, use IPC for verification** — `db_list_connections` returns active connections, then use the `id` for further IPC calls

### CDP vs Browser Mode

| Feature | Browser | Tauri CDP |
|---------|---------|-----------|
| Layout/CSS | ✅ | ✅ |
| Click/drag | ✅ | ✅ |
| Tauri IPC (`invoke`) | ❌ | ✅ |
| File dialogs | ❌ | ✅ (via IPC) |
| Custom title bar drag | ❌ | ✅ |
| Window controls | ❌ | ❌ (CDP controls WebView, not native chrome) |
| Native menus | ❌ | ❌ |
| Setup complexity | Low | Medium (need `cargo tauri dev`) |

## Common Snippets

**Screenshot**: `await page.screenshot({ path: "test.png" });`

**Scrollbar detection**:
```javascript
const scrollInfo = await page.evaluate(() =>
  Array.from(document.querySelectorAll("*")).filter(el => {
    const s = getComputedStyle(el);
    return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
  }).map(el => ({
    tag: el.tagName, id: el.id,
    cls: el.className?.substring?.(0, 120),
    diff: el.scrollHeight - el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
    parent: el.parentElement?.className?.substring?.(0, 80),
  }))
);
```

**Root overflow check**:
```javascript
const rootInfo = await page.evaluate(() => {
  const check = el => ({ scrollH: el.scrollHeight, clientH: el.clientHeight, hasOverflow: el.scrollHeight > el.clientHeight });
  return { html: check(document.documentElement), body: check(document.body), root: check(document.getElementById("root")) };
});
```

**Click tree item by label** (precise — avoids parent element matching):
```javascript
await page.evaluate((targetLabel) => {
  const items = document.querySelectorAll('[class*="cursor-pointer"]');
  for (const el of items) {
    const label = el.querySelector('.truncate');
    if (label?.textContent?.trim() === targetLabel) { el.click(); break; }
  }
}, 'vpc');
```

**Click table by blue icon**:
```javascript
const clickedTable = await page.evaluate(() => {
  const blues = document.querySelectorAll('.text-blue-400');
  for (const el of blues) {
    const p = el.closest('[class*="cursor-pointer"]');
    if (p) { p.click(); return p.textContent?.trim(); }
  }
  return null;
});
```

**Console error capture**:
```javascript
const errors = [];
page.on('pageerror', err => errors.push(err.message));
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module 'playwright'` | `npm install playwright --no-save` in `webui/` |
| Playwright browser launch fails | `npx playwright install chromium` |
| Page shows error | Ensure Gateway is running |
| `networkidle` timeout | Use `waitUntil: "domcontentloaded"` + manual wait |
| CDP connection refused | Ensure `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is set before `cargo tauri dev` |
| App page not found in CDP | Page 0 is DevTools — find app by URL: `.find(p => p.url().includes("127.0.0.1:5173"))` |
| IPC `missing field` error | Check Rust struct field names (e.g. `db_type` not `type`, `host` for SQLite path) |
| IPC `not a function` | Use `window.__TAURI_INTERNALS__.invoke`, not `import()` in evaluate |
| UI tree empty after IPC connect | Store doesn't know about IPC connections — click connection in tree instead |
| MySQL query `table not found` | Use qualified names: `` `database`.`table` `` instead of bare `table` |
| `has-text()` matches parent | Use `.querySelector('.truncate')` to match exact label text |
