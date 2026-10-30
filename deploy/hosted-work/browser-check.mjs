// Node 22+ and an installed Edge/Chromium. Uses an isolated, disposable profile.
// --exercise-ui intercepts API calls IN THE TEST BROWSER only; it never enables
// fixture authentication or model execution on the deployed server.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const option = name => argv[argv.indexOf(name) + 1];
if (!argv.includes('--url') || !argv.includes('--output')) throw new Error('--url and --output are required');
const url = new URL(option('--url'));
const output = path.resolve(option('--output'));
const executable = argv.includes('--browser') ? option('--browser') : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!existsSync(executable)) throw new Error('Installed browser not found');
const exercise = argv.includes('--exercise-ui');
const profile = await mkdtemp(path.join(tmpdir(), 'mona-work-browser-'));
await mkdir(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws;
let sequence = 0;
let session;
const pending = new Map();
const failures = [];
const responses = [];
const fixtureErrors = [];
let fixture = false;
let sessionData = null;
let runs = [];
let files = [];
let runCount = 0;
const sha = createHash('sha256').update('abc').digest('hex');
const report = { target: url.href, realPage: null, uiFixtureFlow: null, realAuthOrModelValidated: false };

function send(method, params = {}, targetSession = session) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression, label) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Browser condition not met: ${label}`);
}
async function input(selector, value) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('input missing');
    const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function click(text) {
  await evaluate(`(() => {const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});
    if(!el || el.disabled) throw new Error('button unavailable: '+${JSON.stringify(text)});el.click();})()`);
}
async function fulfill(event) {
  const request = event.request;
  const endpoint = new URL(request.url);
  let status = 200;
  let data;
  let binary = false;
  const body = () => JSON.parse(request.postData || '{}');
  if (endpoint.pathname === '/api/work/auth/login') data = { access_token: 'isolated-browser-fixture-token' };
  else if (endpoint.pathname === '/api/work/models') data = { models: [{ id: 'fixture', label: '浏览器测试模型', source: 'mona' }], max_file_bytes: 1024 };
  else if (endpoint.pathname === '/api/work/sessions') {
    if (request.method === 'POST') {
      const value = body();
      if (!/^[a-f0-9]{32}$/.test(value.request_id)) throw new Error('invalid browser request ID');
      sessionData = { id: value.request_id, title: '浏览器验收', created: 1, updated: 1 };
      data = sessionData; status = 201;
    } else data = { sessions: sessionData ? [sessionData] : [] };
  } else if (endpoint.pathname.endsWith('/runs')) {
    const value = body();
    if (!/^[a-f0-9]{32}$/.test(value.request_id)) throw new Error('invalid run request ID');
    runCount++;
    const run = { id: value.request_id, session_id: sessionData.id, status: 'running', input: value, result: {} };
    runs.push(run); data = run; status = 202;
  } else if (endpoint.pathname.endsWith('/events')) {
    const run = runs.at(-1);
    if (runCount === 1) {
      run.status = 'completed'; run.result = { content: '浏览器流程验收完成（模拟接口）', workspace_saved: true };
      if (!files.some(f => f.name === 'result.txt')) files.push({ id: 'e'.repeat(32), name: 'result.txt', size: 3, sha256: sha });
    }
    data = { run, events: Number(endpoint.searchParams.get('after') || 0) === 0
      ? [{ seq: 1, kind: 'progress', data: { message: '正在处理任务' } }] : [], has_more: false };
  } else if (endpoint.pathname.endsWith('/stop')) {
    if (body().confirmed !== true) throw new Error('stop must be explicit');
    runs.at(-1).status = 'cancelled'; runs.at(-1).result = { message: '已停止' }; data = runs.at(-1);
  } else if (endpoint.pathname.includes('/files/')) {
    if (request.method === 'PUT') {
      data = { id: endpoint.pathname.split('/').at(-1), name: endpoint.searchParams.get('name'), size: 3, sha256: sha };
      files.push(data); status = 201;
    } else { data = Buffer.from('abc'); binary = true; }
  } else if (endpoint.pathname === `/api/work/sessions/${sessionData?.id}`) data = { ...sessionData, runs, files };
  else { status = 404; data = { error: 'fixture_route_missing' }; fixtureErrors.push(endpoint.pathname); }
  await send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: binary ? 'application/octet-stream' : 'application/json' }],
    body: (binary ? data : Buffer.from(JSON.stringify(data))).toString('base64') });
}

try {
  let connection;
  for (let i = 0; i < 150; i++) {
    try { connection = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); break; }
    catch { if (browser.exitCode !== null) throw new Error('Browser exited before debugging was ready'); await wait(100); }
  }
  if (!connection) throw new Error('Browser debugging did not start');
  ws = new WebSocket(`ws://127.0.0.1:${connection[0]}${connection[1]}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', message => {
    const event = JSON.parse(String(message.data));
    if (event.id) {
      const item = pending.get(event.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(event.id);
      if (event.error) item.reject(new Error(event.error.message)); else item.resolve(event.result);
      return;
    }
    if (event.sessionId !== session) return;
    if (event.method === 'Runtime.exceptionThrown') failures.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (event.method === 'Network.responseReceived') {
      const r = event.params.response;
      if (new URL(r.url).origin === url.origin) responses.push({ url: new URL(r.url).pathname, status: r.status, type: r.mimeType, phase: fixture ? 'fixture' : 'real' });
    }
    if (event.method === 'Network.loadingFailed') failures.push(event.params.errorText);
    if (event.method === 'Fetch.requestPaused') void fulfill(event.params).catch(error => {
      fixtureErrors.push(error.message);
      void send('Fetch.failRequest', { requestId: event.params.requestId, errorReason: 'Failed' }).catch(() => {});
    });
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: url.href });
  await until(`document.querySelector('input[autocomplete="username"]') !== null`, 'real login page');
  await wait(500);
  report.realPage = await evaluate(`({title:document.title,text:document.body.innerText,secureContext:window.isSecureContext,
    styles:[...document.styleSheets].length,inputWidth:document.querySelector('input').getBoundingClientRect().width,
    scrollWidth:document.documentElement.scrollWidth,viewportWidth:window.innerWidth})`);
  const pageErrors = failures.slice();
  const resources = responses.filter(r => r.phase === 'real');
  if (pageErrors.length || resources.some(r => r.status >= 400) || !resources.some(r => /css/.test(r.type))
      || !resources.some(r => /javascript/.test(r.type)) || report.realPage.inputWidth < 100) {
    throw new Error('Real browser page/assets failed: ' + JSON.stringify({ pageErrors, resources }));
  }
  const capture = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'real-login.png'), Buffer.from(capture.data, 'base64'));
  if (exercise) {
    fixture = true;
    await send('Fetch.enable', { patterns: [{ urlPattern: `${url.origin}/api/work/*`, requestStage: 'Request' }] });
    const downloads = path.join(output, 'fixture-downloads'); await mkdir(downloads, { recursive: true });
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }, null);
    await input('input[autocomplete="username"]', 'browser-fixture');
    await input('input[autocomplete="current-password"]', 'fixture-only-not-a-real-password');
    await click('登录并开始');
    await until(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='新任务' && !e.disabled)`, 'workspace');
    await click('新任务');
    await until(`document.querySelector('textarea') && !document.querySelector('textarea').disabled`, 'created session');
    const attachment = path.join(profile, 'input.txt'); await writeFile(attachment, 'abc');
    const doc = await send('DOM.getDocument');
    const fileInput = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [attachment] });
    await until(`document.body.innerText.includes('input.txt')`, 'attachment upload');
    await input('textarea', '浏览器验收：处理附件'); await click('发送');
    await until(`document.body.innerText.includes('result.txt')`, 'completed task');
    await click('result.txt');
    for (let i = 0; i < 50 && !(await readdir(downloads)).includes('result.txt'); i++) await wait(100);
    if ((await readFile(path.join(downloads, 'result.txt'), 'utf8')) !== 'abc') throw new Error('Download bytes changed');
    await input('textarea', '浏览器验收：停止任务'); await click('发送');
    await until(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='停止' && !e.disabled)`, 'stop button');
    await click('停止'); await until(`document.body.innerText.includes('已停止')`, 'cancelled task');
    if (fixtureErrors.length || failures.length) throw new Error('Browser flow errors: ' + JSON.stringify({ fixtureErrors, failures }));
    report.uiFixtureFlow = { login: true, createSession: true, upload: true, send: true, downloadChecksum: true, stop: true,
      requestCount: runs.length, note: 'Real browser and production UI; API responses intercepted only in this test tab.' };
  }
  report.success = true;
} catch (error) {
  report.success = false; report.error = error.message; process.exitCode = 1;
} finally {
  report.resources = responses; report.browserErrors = failures; report.fixtureErrors = fixtureErrors;
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (ws?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close', {}, null); } catch { /* Browser can close before acknowledging. */ }
    ws.close();
  }
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
  if (browser.exitCode === null) { browser.kill(); await wait(500); }
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
}
