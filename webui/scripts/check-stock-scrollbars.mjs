import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Run against an isolated Vite stock-vibe-dev.html preview with an existing
// Playwright module and browser; this check never installs a browser or uses a backend.
const { values } = parseArgs({ options: { url: { type: 'string' }, playwright: { type: 'string' }, browser: { type: 'string' } } });
assert(values.url, 'Pass --url for the isolated stock-vibe-dev.html preview');
const target = new URL(values.url);
assert(target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.pathname === '/stock-vibe-dev.html', 'Use the loopback stock development entry');
const { chromium } = await import(values.playwright ? pathToFileURL(path.resolve(values.playwright)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: path.resolve(values.browser) } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const errors = [], writes = [];
page.on('pageerror', (error) => errors.push(error.message));
const historyRows = Array.from({ length: 20 }, (_, index) => ({ operation_id: `layout_history_${index}`, operation: 'strategy_scan', status: 'completed', references: { strategy_name: `布局测试记录 ${index + 1}` } }));
await page.route('**/api/**', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
  let body = { source: null, native: {} };
  if (url.pathname === '/api/stock-vibe') body = { execution_allowed: true, model_preset: null, model_binding: null };
  else if (url.pathname.endsWith('/strategy-library')) body.native = { items: [], total: 0, limit: 20, offset: Number(url.searchParams.get('offset') ?? 0) };
  else if (url.pathname.endsWith('/strategy-library/history')) body.native = { items: historyRows, total: 20, limit: 20, offset: 0 };
  else if (url.pathname.endsWith('/attention')) body = { preferences: { proactive_mode: 'manual', watched_symbols: [], notification_start: '09:30', notification_end: '15:00', attention_interval_sec: 900, data_sources: ['tencent'] }, execution_allowed: true, runtime: null };
  else if (url.pathname.endsWith('/uploads')) body.uploads = [];
  else if (url.pathname.endsWith('/operations')) body.native = { operations: [] };
  else if (url.pathname.endsWith('/portfolio/status')) body.native = { status: 'idle' };
  else if (url.pathname.endsWith('/portfolio')) body.native = { status: 'empty', snapshot: null };
  else if (url.pathname.endsWith('/shadow/profiles')) body.native = { profiles: [] };
  else if (url.pathname.endsWith('/attention/events')) body.native = { events: [] };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
const metrics = (locator) => locator.evaluate((element) => ({ height: element.clientHeight, contentHeight: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth, scrollbar: getComputedStyle(element).scrollbarWidth, color: getComputedStyle(element).scrollbarColor }));
const fits = (value, label) => assert(value.contentHeight <= value.height + 1 && value.contentWidth <= value.width + 1, `${label} overflow: ${JSON.stringify(value)}`);
try {
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '机会选股', exact: true }).click();
  await page.locator('.stock-vibe-opportunity-empty').waitFor();
  for (const viewport of [{width:2048,height:1190},{width:1440,height:900},{width:1280,height:800},{width:1024,height:768}]) {
    await page.setViewportSize(viewport);
    fits(await metrics(page.locator('.stock-vibe-strategy-workspace')), `Initial strategy workspace at ${viewport.width}x${viewport.height}`);
    fits(await metrics(page.locator('.stock-vibe-page')), 'Page');
  }
  const rows = page.locator('.stock-vibe-strategy-rows');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const hidden = await metrics(rows);
  assert(hidden.contentHeight > hidden.height, 'The full built-in list should scroll');
  assert.equal(hidden.scrollbar, 'thin');
  assert.equal(hidden.color, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  await rows.hover();
  await page.waitForTimeout(250);
  assert.notEqual((await metrics(rows)).color, hidden.color, 'Hover should reveal the thumb');
  await page.mouse.wheel(0, 350);
  await page.waitForFunction(() => document.querySelector('.stock-vibe-strategy-rows').scrollTop > 0);
  await page.getByRole('textbox', { name: '搜索策略' }).fill('多因子排名');
  await page.waitForFunction(() => document.querySelectorAll('.stock-vibe-strategy-row').length === 1);
  fits(await metrics(rows), 'Filtered single strategy');
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '策略历史记录' });
  await dialog.getByText('布局测试记录 20', { exact: true }).waitFor();
  const history = dialog.locator('div.overflow-y-auto');
  const historySize = await metrics(history);
  assert(historySize.contentHeight > historySize.height, 'Long portaled history should scroll');
  assert.equal(historySize.scrollbar, 'thin');
  await history.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('[role="dialog"] div.overflow-y-auto').scrollTop > 0);
  await dialog.getByRole('button', { name: '关闭信息' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '账户与复盘', exact: true }).click();
  await page.getByText('看看自己的交易表现', { exact: true }).waitFor();
  fits(await metrics(page.locator('.stock-vibe-account-workspace')), 'Initial account workspace');
  fits(await metrics(page.locator('.stock-vibe-account-sidebar')), 'Initial account sidebar');
  await page.getByRole('button', { name: '投资工作台', exact: true }).click();
  await page.locator('.stock-vibe-workbench-layout').waitFor();
  fits(await metrics(page.locator('.stock-vibe-page')), 'Initial workbench page');
  assert.deepEqual(writes, [], 'Layout inspection must not dispatch writes');
  assert.deepEqual(errors, [], 'No browser errors');
  console.log('Stock scrollbars: initial layouts, long/short lists, hover reveal and portaled history passed');
} finally { await context.close(); await browser.close(); }
