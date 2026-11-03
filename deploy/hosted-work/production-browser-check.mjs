// Real production acceptance, using a disposable off-the-record Edge context.
// Supply short-lived website sessions as JSON on stdin; no API calls are mocked.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ORIGIN = 'https://mona-ai.cn';
const TARGET = `${ORIGIN}/work/`;
const inputBytes = Buffer.from('MONA_WORK_INPUT_20261103', 'utf8');
const expectedBytes = Buffer.concat([inputBytes, Buffer.from('\nONLINE_WORK_ACCEPTED', 'utf8')]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const runFile = promisify(execFile);
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validToken = token => typeof token === 'string' && token.length <= 8192 && /^[\x21-\x7e]+$/.test(token);
const terminal = status => ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status);
const safeErrorCodes = new Set(['auth_unavailable', 'capacity', 'file_changed', 'host_denied', 'invalid_model',
  'invalid_request', 'login_required', 'model_busy', 'model_pending', 'not_found', 'origin_denied',
  'request_capacity', 'request_conflict', 'service_error', 'upload_failed', 'user_busy', 'workspace_pending']);

class CheckFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCheck(condition, code) { if (!condition) throw new CheckFailure(code); }

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    requireCheck(['--url', '--output'].includes(key) && argv[index + 1] && !values[key], 'invalid_arguments');
    values[key] = argv[index + 1];
  }
  requireCheck(values['--url'] && values['--output'], 'missing_arguments');
  const url = new URL(values['--url']);
  requireCheck(url.href === TARGET && !url.username && !url.password, 'invalid_target');
  return { output: path.resolve(values['--output']), browser: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
}

async function readCredentials() {
  requireCheck(!process.stdin.isTTY, 'credentials_required_on_stdin');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireCheck(size <= 64 * 1024, 'credentials_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CheckFailure('credentials_invalid_json'); }
  return { token: value?.token, otherToken: value?.other_token };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function createOutput(candidate) {
  const repo = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const requestedRoot = path.join(repo, 'output', 'hosted-work');
  const root = await realpath(requestedRoot);
  requireCheck(inside(repo, root) && inside(requestedRoot, candidate), 'output_outside_workspace');
  const parts = path.relative(requestedRoot, candidate).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]);
    if (index === parts.length - 1) {
      try { await mkdir(next, { mode: 0o700 }); }
      catch { throw new CheckFailure('output_exists_or_unavailable'); }
    } else {
      try { await mkdir(next, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw new CheckFailure('output_parent_unavailable'); }
    }
    current = await realpath(next);
    requireCheck(inside(root, current), 'output_outside_workspace');
  }
  return current;
}

async function apiJson(route, token) {
  let response;
  try {
    response = await fetch(`${ORIGIN}${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new CheckFailure('api_unreachable'); }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CheckFailure('api_non_json');
  }
  let body;
  try { body = await response.json(); } catch { throw new CheckFailure('api_invalid_json'); }
  if (!response.ok) {
    const code = typeof body?.error === 'string' && safeErrorCodes.has(body.error) ? body.error : 'request_failed';
    throw new CheckFailure(`api_${response.status}_${code}`);
  }
  return body;
}

async function revoke(token) {
  if (!token) return { requested: false, confirmed: true };
  if (!validToken(token)) return { requested: true, status: 'invalid', confirmed: false };
  try {
    const response = await fetch(`${ORIGIN}/api/work/auth/logout`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const json = response.headers.get('content-type')?.toLowerCase().startsWith('application/json') === true;
    return { requested: true, status: response.status, confirmed: json && [200, 401].includes(response.status) };
  } catch { return { requested: true, status: 'unreachable', confirmed: false }; }
}

async function stopOwnedBrowser(profile, root, executable) {
  const target = await realpath(profile);
  requireCheck(target === profile && inside(root, target) && path.dirname(target) === root
    && path.basename(target).startsWith('mona-work-production-check-'), 'temporary_profile_changed');
  const cleanupScript = String.raw`
$profile = $env:MONA_WORK_EDGE_PROFILE
$exe = [IO.Path]::GetFullPath($env:MONA_WORK_EDGE_EXE)
$pattern = '(?i)--user-data-dir="?' + [regex]::Escape($profile) + '(?:"|\s|$)'
function Find-OwnedEdge {
    @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exe -and
        $_.CommandLine -and [regex]::IsMatch($_.CommandLine, $pattern)
    })
}
$owned = @(Find-OwnedEdge)
foreach ($item in $owned) {
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $item.ProcessId) -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $item.CreationDate -and $current.ExecutablePath -and
        [IO.Path]::GetFullPath($current.ExecutablePath) -eq $exe -and $current.CommandLine -and
        [regex]::IsMatch($current.CommandLine, $pattern)) {
        Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Milliseconds 500
$remaining = @(Find-OwnedEdge)
@{ matched = $owned.Count; remaining = $remaining.Count } | ConvertTo-Json -Compress
`;
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cleanupScript], {
    windowsHide: true, timeout: 15000, maxBuffer: 65536,
    env: { ...process.env, MONA_WORK_EDGE_PROFILE: target, MONA_WORK_EDGE_EXE: executable },
  });
  const result = JSON.parse(stdout.trim());
  requireCheck(Number.isInteger(result.matched) && Number.isInteger(result.remaining), 'browser_cleanup_response_invalid');
  return result;
}

async function main() {
  const report = { target: TARGET, auth_mode: 'operator_issued_website_session', password_login_tested: false,
    real_browser: false, mocked_responses: false, success: false, phase: 'input', logout: {} };
  let credentials, output, profile, profileRoot, browser, browserExecutable, ws, contextId, targetSession;
  let sessionId, resultRunId, stopRunId;
  let sequence = 0;
  let browserStartError = false;
  const pending = new Map();
  const responses = [];
  const runPosts = [];
  const fileGets = [];
  let pageExceptions = 0;

  const cdp = (method, params = {}, session = targetSession) => {
    requireCheck(ws?.readyState === WebSocket.OPEN, 'browser_connection_closed');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new CheckFailure('browser_command_timeout')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })); }
      catch { clearTimeout(timer); pending.delete(id); reject(new CheckFailure('browser_connection_closed')); }
    });
  };
  const evaluate = async expression => {
    const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    requireCheck(!value.exceptionDetails, 'page_evaluation_failed');
    return value.result.value;
  };
  const waitFor = async (test, timeout, code) => {
    const deadline = Date.now() + timeout;
    do {
      if (await test()) return;
      await delay(250);
    } while (Date.now() < deadline);
    throw new CheckFailure(code);
  };
  const click = async label => evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('button unavailable'); button.click();
  })()`);
  const buttonReady = label => evaluate(`[...document.querySelectorAll('button')].some(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled)`);
  const inputText = async value => evaluate(`(() => {
    const element = document.querySelector('textarea[aria-label="任务内容"]');
    if (!element || element.disabled) throw new Error('textarea unavailable');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const selectedSession = () => evaluate(`(() => {
    const value = JSON.parse(sessionStorage.getItem('mona-hosted-work-v1') || '{}');
    return typeof value.selected === 'string' ? value.selected : null;
  })()`);
  const sessionDetail = id => apiJson(`/api/work/sessions/${id}`, credentials.token);
  const screenshot = async name => {
    const capture = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'), { flag: 'wx' });
  };
  const browserStatus = async (route, token) => evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(route)}, {
      headers: ${token ? `{ Authorization: 'Bearer ' + ${JSON.stringify(token)} }` : '{}'},
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    return { status: response.status, json: (response.headers.get('content-type') || '').toLowerCase().startsWith('application/json') };
  })()`);
  const pollRun = async (id, wanted, timeout) => {
    let cursor = 0;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await apiJson(`/api/work/runs/${id}/events?after=${cursor}`, credentials.token);
      requireCheck(result?.run?.id === id && Array.isArray(result.events), 'run_response_invalid');
      const run = result.run;
      for (const event of result.events) if (Number.isInteger(event.seq)) cursor = Math.max(cursor, event.seq);
      if (id === resultRunId) report.result_run = { id, status: run.status, workspace_saved: run.result?.workspace_saved === true };
      if (id === stopRunId) report.stop_run = { ...report.stop_run, id, status: run.status, workspace_saved: run.result?.workspace_saved === true };
      if (wanted === 'exec' && result.events.some(event => event.kind === 'progress' && Array.isArray(event.data?.tools) && event.data.tools.includes('exec'))) {
        report.stop_run.exec_progress_seen = true;
        return run;
      }
      if (terminal(run.status)) {
        if (wanted === run.status) return run;
        throw new CheckFailure(`run_terminal_${run.status}`);
      }
      await delay(result.has_more ? 0 : 1000);
    }
    throw new CheckFailure(wanted === 'exec' ? 'exec_progress_timeout' : 'run_terminal_timeout');
  };
  const waitForNewRun = async (expectedCount, expectedPosts) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const detail = await sessionDetail(sessionId);
      requireCheck(Array.isArray(detail.runs) && detail.runs.length <= expectedCount, 'unexpected_run_count');
      if (detail.runs.length === expectedCount && runPosts.length >= expectedPosts) {
        requireCheck(runPosts.length === expectedPosts && identifier(detail.runs.at(-1)?.id), 'unexpected_run_submission_count');
        return detail.runs.at(-1);
      }
      await delay(500);
    }
    throw new CheckFailure('run_submission_unconfirmed');
  };

  try {
    credentials = await readCredentials();
    requireCheck(validToken(credentials.token), 'primary_credential_invalid');
    requireCheck(credentials.otherToken === undefined || validToken(credentials.otherToken), 'other_credential_invalid');
    requireCheck(!credentials.otherToken || credentials.otherToken !== credentials.token, 'credentials_not_distinct');
    report.other_account_provided = Boolean(credentials.otherToken);
    const args = parseArgs(process.argv.slice(2));
    requireCheck(existsSync(args.browser), 'browser_not_found');
    browserExecutable = args.browser;
    output = await createOutput(args.output);
    report.output = output;
    const downloads = path.join(output, 'downloads');
    await mkdir(downloads, { mode: 0o700 });
    profileRoot = await realpath(tmpdir());
    profile = await realpath(await mkdtemp(path.join(profileRoot, 'mona-work-production-check-')));
    requireCheck(inside(profileRoot, profile) && path.dirname(profile) === profileRoot
      && path.basename(profile).startsWith('mona-work-production-check-'), 'temporary_profile_invalid');
    await writeFile(path.join(profile, 'input.txt'), inputBytes, { flag: 'wx' });

    report.phase = 'browser_start';
    browser = spawn(args.browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => { browserStartError = true; });
    let debugInfo;
    await waitFor(async () => {
      if (browserStartError) throw new CheckFailure('browser_start_failed');
      try {
        const portFile = await realpath(path.join(profile, 'DevToolsActivePort'));
        requireCheck(path.dirname(portFile) === profile, 'browser_debug_path_invalid');
        const info = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
        const port = Number(info[0]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535
          && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(info[1] || '')) {
          debugInfo = [String(port), info[1]];
          return true;
        }
      } catch (error) {
        if (error instanceof CheckFailure) throw error;
        if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw new CheckFailure('browser_debug_port_unreadable');
      }
      return false;
    }, 30000, 'browser_start_timeout');
    ws = new WebSocket(`ws://127.0.0.1:${debugInfo[0]}${debugInfo[1]}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CheckFailure('browser_connection_timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new CheckFailure('browser_connection_failed')); }, { once: true });
    });
    ws.addEventListener('message', message => {
      let event;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.id) {
        const entry = pending.get(event.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(event.id);
        if (event.error) entry.reject(new CheckFailure('browser_command_failed')); else entry.resolve(event.result);
        return;
      }
      if (event.sessionId !== targetSession) return;
      if (event.method === 'Runtime.exceptionThrown') pageExceptions++;
      if (event.method === 'Network.responseReceived') {
        const response = event.params.response;
        try {
          const url = new URL(response.url);
          if (url.origin === ORIGIN && responses.length < 300) responses.push({ path: url.pathname, status: response.status, type: response.mimeType });
        } catch { /* Ignore non-HTTP resources. */ }
      }
      if (event.method === 'Network.requestWillBeSent') {
        const request = event.params.request;
        try {
          const url = new URL(request.url);
          if (url.origin !== ORIGIN) return;
          if (request.method === 'POST' && /^\/api\/work\/sessions\/[a-f0-9]{32}\/runs$/.test(url.pathname)) runPosts.push(url.pathname);
          if (request.method === 'GET' && /^\/api\/work\/sessions\/[a-f0-9]{32}\/files\/[a-f0-9]{32}$/.test(url.pathname)) fileGets.push(url.pathname);
        } catch { /* Ignore non-HTTP resources. */ }
      }
    });

    contextId = (await cdp('Target.createBrowserContext', { disposeOnDetach: true }, null)).browserContextId;
    const targetId = (await cdp('Target.createTarget', { url: 'about:blank', browserContextId: contextId }, null)).targetId;
    targetSession = (await cdp('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
    report.real_browser = true;
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId: contextId }, null);

    report.phase = 'real_login_page';
    const navigation = await cdp('Page.navigate', { url: TARGET });
    requireCheck(!navigation.errorText, 'navigation_failed');
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[autocomplete="username"]'))`), 30000, 'login_page_timeout');
    report.page = {
      secure_context: await evaluate('window.isSecureContext'),
      css_loaded: responses.some(item => item.status === 200 && /css/i.test(item.type)),
      javascript_loaded: responses.some(item => item.status === 200 && /javascript/i.test(item.type)),
    };
    requireCheck(report.page.secure_context && report.page.css_loaded && report.page.javascript_loaded, 'page_assets_unconfirmed');
    await screenshot('01-login.png');

    report.phase = 'website_session';
    const websiteProfile = await apiJson('/auth/web/profile', credentials.token);
    requireCheck(typeof websiteProfile.id === 'string', 'website_profile_invalid');
    await evaluate(`sessionStorage.setItem('mona-website-session-v1', ${JSON.stringify(JSON.stringify({ token: credentials.token, user: websiteProfile }))})`);
    await cdp('Page.navigate', { url: `${ORIGIN}/` });
    await waitFor(() => evaluate(`Boolean(document.querySelector('details.account-menu summary'))`), 30000, 'website_account_menu_missing');
    await evaluate(`document.querySelector('details.account-menu').open = true`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('details.account-menu a')].find(item => item.getAttribute('href') === '/work/' && item.textContent.trim() === '进入在线 Work'))`), 30000, 'website_work_entry_unavailable');
    report.website_entry = { available: true, canonical_origin: true };
    await evaluate(`document.querySelector('details.account-menu a[href="/work/"]').click()`);
    await waitFor(async () => await buttonReady('新任务') && await evaluate(`Boolean([...document.querySelectorAll('select[aria-label="平台模型"] option')].find(item => item.value === 'qwen' && item.textContent.trim() === 'Qwen3.7 Plus'))`), 30000, 'workspace_or_model_unavailable');
    report.website_entry.shared_session_verified = true;
    report.model = { id: 'qwen', label: 'Qwen3.7 Plus' };
    await evaluate(`(() => { const element = document.querySelector('select[aria-label="平台模型"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, 'qwen');
      element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await screenshot('02-workspace.png');

    report.phase = 'create_session';
    await click('新任务');
    await waitFor(async () => identifier(await selectedSession()) && await evaluate(`Boolean(document.querySelector('textarea[aria-label="任务内容"]:not(:disabled)'))`), 30000, 'session_creation_unconfirmed');
    sessionId = await selectedSession();
    report.session_id = sessionId;
    let detail = await sessionDetail(sessionId);
    requireCheck(detail.id === sessionId && Array.isArray(detail.runs) && detail.runs.length === 0, 'new_session_invalid');

    report.phase = 'upload';
    report.upload = { status: 'pending_or_unconfirmed' };
    const documentNode = await cdp('DOM.getDocument');
    const fileNode = await cdp('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type="file"][aria-label="上传附件"]' });
    requireCheck(fileNode.nodeId, 'upload_input_missing');
    await cdp('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [path.join(profile, 'input.txt')] });
    await waitFor(() => evaluate(`Boolean(document.querySelector('button[aria-label="取消附加 input.txt"]'))`), 90000, 'upload_unconfirmed');
    detail = await sessionDetail(sessionId);
    const upload = detail.files?.find(file => file.name === 'input.txt');
    requireCheck(identifier(upload?.id) && upload.size === inputBytes.length && upload.sha256 === sha256(inputBytes), 'upload_integrity_failed');
    report.upload = { file_id: upload.id, size: upload.size, sha256: upload.sha256, verified: true };

    report.phase = 'isolation';
    const sessionPath = `/api/work/sessions/${sessionId}`;
    const filePath = `${sessionPath}/files/${upload.id}`;
    const anonymousSession = await browserStatus(sessionPath);
    const anonymousFile = await browserStatus(filePath);
    report.isolation = { anonymous_session: anonymousSession.status, anonymous_file: anonymousFile.status };
    requireCheck(anonymousSession.json && anonymousSession.status === 401 && anonymousFile.json && anonymousFile.status === 401, 'anonymous_access_not_rejected');
    if (credentials.otherToken) {
      const otherSession = await browserStatus(sessionPath, credentials.otherToken);
      const otherFile = await browserStatus(filePath, credentials.otherToken);
      report.isolation.other_session = otherSession.status;
      report.isolation.other_file = otherFile.status;
      requireCheck(otherSession.json && [403, 404].includes(otherSession.status)
        && otherFile.json && [403, 404].includes(otherFile.status), 'cross_account_access_not_rejected');
    }

    report.phase = 'real_model_task';
    report.result_run = { status: 'submission_pending_or_unconfirmed' };
    const resultPath = `/workspace/acceptance-${sessionId}/result.txt`;
    const task = `请先用 read_file 读取本轮上传的 input.txt 附件，附件路径在本轮上传文件信息中。用 write_file 创建 ${resultPath}，文件内容严格为附件原文、一个换行、ONLINE_WORK_ACCEPTED，不要追加其他字符或末尾换行。最后必须调用 deliver_file 交付该文件。`;
    await inputText(task);
    await waitFor(() => buttonReady('发送'), 10000, 'send_button_unavailable');
    await click('发送');
    const started = await waitForNewRun(1, 1);
    resultRunId = started.id;
    report.result_run = { id: resultRunId, status: started.status };
    await waitFor(() => evaluate(`(() => {
      const value = JSON.parse(sessionStorage.getItem('mona-hosted-work-v1') || '{}');
      return value.pending?.input?.request_id === ${JSON.stringify(resultRunId)} || document.body.innerText.includes(${JSON.stringify(task)});
    })()`), 10000, 'send_not_observed_in_browser');
    report.phase = 'refresh_while_running';
    await cdp('Page.reload');
    await waitFor(async () => await selectedSession() === sessionId
      && await evaluate(`Boolean(document.querySelector('textarea[aria-label="任务内容"]'))`), 30000, 'refresh_session_not_restored');
    const resultRun = await pollRun(resultRunId, 'completed', 180000);
    requireCheck(resultRun.result?.workspace_saved === true, 'workspace_save_unconfirmed');
    const usage = resultRun.result?.usage || {};
    report.result_run.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens']
      .filter(key => Number.isInteger(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
    requireCheck(report.result_run.usage.prompt_tokens > 0 && report.result_run.usage.completion_tokens > 0, 'model_usage_missing');
    detail = await sessionDetail(sessionId);
    requireCheck(detail.runs.length === 1 && detail.runs[0].id === resultRunId && runPosts.length === 1, 'refresh_replayed_request');
    report.refresh = { same_session: true, run_count: detail.runs.length, browser_submit_count: runPosts.length, no_replay: true };

    report.phase = 'download';
    const artifact = detail.files?.find(file => file.name === 'result.txt');
    requireCheck(identifier(artifact?.id) && artifact.size === expectedBytes.length && artifact.sha256 === sha256(expectedBytes), 'delivered_file_metadata_invalid');
    await waitFor(() => buttonReady('result.txt'), 30000, 'delivered_file_not_visible');
    await screenshot('03-completed.png');
    const previousFileGets = fileGets.length;
    await click('result.txt');
    const downloaded = path.join(downloads, 'result.txt');
    await waitFor(async () => { try { await access(downloaded); return true; } catch { return false; } }, 30000, 'download_unconfirmed');
    const bytes = await readFile(downloaded);
    requireCheck(bytes.equals(expectedBytes) && sha256(bytes) === artifact.sha256 && fileGets.length > previousFileGets, 'download_integrity_failed');
    report.download = { file_id: artifact.id, size: bytes.length, sha256: sha256(bytes), verified: true };

    report.phase = 'stop_task';
    report.stop_run = { status: 'submission_pending_or_unconfirmed', exec_progress_seen: false };
    await inputText('请调用 exec 在隔离工作区执行 shell 命令 sleep 60，等待命令结束后再回复。这是停止按钮验收，不创建、修改或删除任何文件。');
    await waitFor(() => buttonReady('发送'), 10000, 'stop_test_send_unavailable');
    await click('发送');
    const stopStarted = await waitForNewRun(2, 2);
    stopRunId = stopStarted.id;
    report.stop_run = { id: stopRunId, status: stopStarted.status, exec_progress_seen: false };
    await pollRun(stopRunId, 'exec', 120000);
    await waitFor(() => buttonReady('停止'), 10000, 'stop_button_unavailable');
    await click('停止');
    const stopped = await pollRun(stopRunId, 'cancelled', 60000);
    requireCheck(stopped.result?.workspace_saved === true, 'stop_workspace_save_unconfirmed');
    detail = await sessionDetail(sessionId);
    requireCheck(detail.runs.length === 2 && detail.runs.every(run => run.status !== 'unknown') && runPosts.length === 2, 'stop_or_run_count_unconfirmed');
    report.stop_run.verified = true;

    report.phase = 'next_session';
    await waitFor(() => buttonReady('新任务'), 15000, 'next_session_button_unavailable');
    await click('新任务');
    await waitFor(async () => {
      const id = await selectedSession();
      return identifier(id) && id !== sessionId && await evaluate(`Boolean(document.querySelector('textarea[aria-label="任务内容"]:not(:disabled)'))`);
    }, 30000, 'next_session_unconfirmed');
    const nextId = await selectedSession();
    const next = await sessionDetail(nextId);
    requireCheck(next.id === nextId && Array.isArray(next.runs) && next.runs.length === 0 && runPosts.length === 2, 'next_session_invalid');
    await inputText('验收草稿，未发送。');
    await waitFor(() => buttonReady('发送'), 10000, 'next_session_not_ready');
    await inputText('');
    report.next_session = { id: nextId, created: true, input_ready: true, model_request_sent: false };

    report.phase = 'ui_logout';
    await click('退出登录');
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[autocomplete="username"]'))`), 30000, 'ui_logout_unconfirmed');
    const revokedStatus = await browserStatus('/api/work/models', credentials.token);
    report.logout.primary_ui = true;
    report.logout.primary_after_logout_status = revokedStatus.status;
    requireCheck(revokedStatus.json && revokedStatus.status === 401, 'primary_session_not_revoked');
    requireCheck(pageExceptions === 0, 'browser_runtime_exception');
    report.phase = 'completed';
    report.success = true;
  } catch (error) {
    report.error = error instanceof CheckFailure ? error.code : 'unexpected_error';
    if (/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(error?.name || '')) report.error_kind = error.name;
    if (/^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code || '')) report.error_code = error.code;
  } finally {
    if (credentials?.token && sessionId && !report.logout.primary_ui) {
      try {
        const detail = await sessionDetail(sessionId);
        report.observed_runs = Array.isArray(detail.runs) ? detail.runs.map(run => ({ id: run.id, status: run.status })) : [];
      } catch { report.final_run_observation = 'unavailable'; }
    }
    report.logout.primary_cleanup = await revoke(credentials?.token);
    report.logout.other_cleanup = await revoke(credentials?.otherToken);
    if (!report.logout.primary_cleanup.confirmed || !report.logout.other_cleanup.confirmed) {
      report.success = false;
      report.error ||= 'session_revocation_unconfirmed';
    }
    report.browser_runtime_exceptions = pageExceptions;
    report.browser_run_post_count = runPosts.length;
    if (ws?.readyState === WebSocket.OPEN) {
      if (contextId) { try { await cdp('Target.disposeBrowserContext', { browserContextId: contextId }, null); } catch {} }
      try { await cdp('Browser.close', {}, null); } catch {}
      ws.close();
    }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new CheckFailure('browser_closed')); }
    if (browser && browser.exitCode === null) {
      browser.kill();
      await delay(500);
    }
    let browserCleanupConfirmed = !browser;
    if (browser && profile && profileRoot && browserExecutable) {
      try {
        report.browser_process_cleanup = await stopOwnedBrowser(profile, profileRoot, browserExecutable);
        browserCleanupConfirmed = report.browser_process_cleanup.remaining === 0;
      } catch { browserCleanupConfirmed = false; }
    }
    if (profile && profileRoot && inside(profileRoot, profile) && path.dirname(profile) === profileRoot
      && path.basename(profile).startsWith('mona-work-production-check-')) {
      try {
        requireCheck(browserCleanupConfirmed, 'browser_process_cleanup_unconfirmed');
        const target = await realpath(profile);
        requireCheck(target === profile && inside(profileRoot, target) && path.dirname(target) === profileRoot, 'temporary_profile_changed');
        await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
        report.temporary_profile_removed = true;
      }
      catch { report.temporary_profile_removed = false; }
      if (!report.temporary_profile_removed) {
        report.success = false;
        report.error ||= 'temporary_profile_cleanup_unconfirmed';
      }
    }
    if (output) {
      try { await writeFile(path.join(output, 'production-browser-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); }
      catch { report.success = false; report.error ||= 'report_write_failed'; }
    }
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => { clearTimeout(timeout); resolve(); });
    });
    process.exit(report.success ? 0 : 1);
  }
}

await main();
