import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const task = fileURLToPath(new URL('./', import.meta.url));
const candidateInput = process.env.MONA_ADMIN_CANDIDATE_HTML;
if (!candidateInput) throw new Error('Set MONA_ADMIN_CANDIDATE_HTML to the isolated candidate HTML file.');
const candidate = await realpath(resolve(root, candidateInput));
const candidateRelative = relative(root, candidate);
if (!candidateRelative || isAbsolute(candidateRelative) || candidateRelative === '..' || candidateRelative.startsWith('..' + sep)
    || candidateRelative.split(sep)[0].toLowerCase() === 'mona-auth') {
    throw new Error('MONA_ADMIN_CANDIDATE_HTML must name a candidate inside the workspace, outside the local Auth checkout.');
}
const edge = process.env.CHROMIUM_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
    constructor(socket) {
        this.socket = socket; this.id = 0; this.pending = new Map(); this.events = new Map(); this.errors = [];
        socket.addEventListener('message', ({ data }) => {
            const value = JSON.parse(data);
            if (value.method === 'Runtime.exceptionThrown') this.errors.push(value.params.exceptionDetails.text);
            if (value.id) {
                const task = this.pending.get(value.id); if (!task) return;
                this.pending.delete(value.id); clearTimeout(task.timer);
                value.error ? task.reject(new Error(value.error.message)) : task.resolve(value.result);
            } else this.events.get(value.method)?.(value.params);
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000);
            this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    async wait(expression) {
        for (let i = 0; i < 120; i++) { if (await this.eval(expression)) return; await delay(80); }
        throw new Error('Browser condition not met: ' + expression);
    }
}

test('admin suggestion management with synthetic service boundaries', { timeout: 90000 }, async t => {
    const records = [1, 2, 3, 4].map(id => ({ id: String(id), account_id: String(800 + id), display_name: '测试用户 ' + id,
        body: id === 4 ? '纯文字 <img src=x onerror=alert(1)> 😊\n第二行' : '建议 ' + id,
        created_at: '2026-10-31T00:00:00.000000Z', state: id === 2 ? 'hidden' : 'public', moderated_at: null, moderated_by: null }));
    let forbid = false, failWrite = false, delayPublic = false, confirms = 0, confirmNext = true;
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
        try {
            if (url.pathname === '/auth/login') return json({ access_token: 'synthetic-admin-session' });
            if (url.pathname === '/admin/stats') return json({ total_users: 0, active_subscriptions: 0, active_trials: 0, expired_trials: 0 });
            if (url.pathname === '/admin/metrics/dashboard') return json({
                revenue: { today: 0, week: 0, month: 0, year: 0, mrr: 0, arr: 0, avg_revenue_per_user: 0, monthly_series: [] },
                users: { total: 0, paying: 0, active_trials: 0, churned: 0, conversion_rate: 0, new_users_series: [] },
                subscriptions: { active: 0, auto_renew_count: 0, auto_renew_rate: 0,
                    expiry_distribution: { '7d': 0, '30d': 0, '60d': 0, '90d': 0 }, renewals: { total: 0, success: 0, failed: 0, retrying: 0, success_rate: 0 } },
            });
            if (url.pathname === '/api/suggestions/admin' && request.method === 'GET') {
                if (forbid) return json({ error: 'forbidden' }, 403);
                const state = url.searchParams.get('state');
                if (delayPublic && state === 'public') { delayPublic = false; await delay(700); }
                const before = Number(url.searchParams.get('before') || 1000);
                const items = records.filter(item => item.state !== 'deleted' && (state === 'all' || item.state === state) && Number(item.id) < before)
                    .sort((a, b) => Number(b.id) - Number(a.id));
                return json({ items: items.slice(0, 2), next_before: items.length > 2 ? items[1].id : null });
            }
            const match = /^\/api\/suggestions\/admin\/(\d+)$/.exec(url.pathname);
            if (match && ['PATCH', 'DELETE'].includes(request.method)) {
                if (forbid) return json({ error: 'forbidden' }, 403);
                if (failWrite) return json({ error: 'unavailable' }, 503);
                const item = records.find(record => record.id === match[1]);
                if (!item || item.state === 'deleted') return json({ error: 'not_found' }, 404);
                if (request.method === 'DELETE') { item.state = 'deleted'; return json({ id: item.id, state: 'deleted' }); }
                let raw = ''; for await (const chunk of request) raw += chunk;
                item.state = JSON.parse(raw).hidden ? 'hidden' : 'public';
                return json(item);
            }
            if (url.pathname === '/admin/' || url.pathname === '/admin') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return response.end(await readFile(candidate));
            }
            if (url.pathname === '/admin/assets/suggestions.js' || url.pathname === '/admin/assets/suggestions.css') {
                const name = url.pathname.split('/').at(-1);
                response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css' });
                return response.end(await readFile(join(task, name)));
            }
            if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
            return json({ error: 'not_found' }, 404);
        } catch { if (!response.headersSent) json({ error: 'fixture_error' }, 500); else response.end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const temporaryRoot = await realpath(tmpdir());
    const profile = await realpath(await mkdtemp(join(temporaryRoot, 'mona-admin-suggestions-')));
    assert.equal(dirname(profile), temporaryRoot); assert.ok(basename(profile).startsWith('mona-admin-suggestions-'));
    const browser = spawn(edge, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let cdp;
    try {
        let port;
        for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
        assert.ok(port, 'browser did not start');
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const socket = new WebSocket(pages.find(item => item.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        cdp = new CDP(socket);
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
        cdp.events.set('Page.javascriptDialogOpening', () => { confirms++; void cdp.send('Page.handleJavaScriptDialog', { accept: confirmNext }); });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: origin + '/admin/' });
        await cdp.wait("document.readyState === 'complete' && document.getElementById('tab-suggestions') !== null && typeof window.loadSuggestions === 'function'");
        await cdp.eval("document.getElementById('loginEmail').value='test-admin';document.getElementById('loginPassword').value='synthetic';document.querySelector('#login button').click()");
        await cdp.wait("document.getElementById('app').style.display === 'block'");
        const clickTab = () => cdp.eval("document.getElementById('tab-suggestions').click()");
        const select = value => cdp.eval(`(()=>{const e=document.getElementById('suggestionFilter');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        const click = text => cdp.eval(`(()=>{const e=[...document.querySelectorAll('#section-suggestions button')].find(x=>x.textContent.trim()===${JSON.stringify(text)} && !x.hidden);if(!e||e.disabled)throw new Error('button unavailable');e.click()})()`);
        await t.test('menu, public text and pagination', async () => {
            await clickTab();
            await cdp.wait("document.querySelectorAll('#suggestionTable tr').length === 2");
            assert.equal(await cdp.eval("document.getElementById('adminPageName').textContent"), '建议管理');
            assert.equal(await cdp.eval("document.querySelector('#suggestionTable tr td:nth-child(4)').textContent"), records[3].body);
            assert.equal(await cdp.eval("document.querySelectorAll('#suggestionTable img, #suggestionTable script').length"), 0);
            await click('查看更多'); await cdp.wait("document.querySelectorAll('#suggestionTable tr').length === 4");
            assert.equal(await cdp.eval("document.getElementById('suggestionMore').hidden"), true);
        });
        await t.test('hide and restore respect the active filter', async () => {
            await select('public'); await cdp.wait("document.querySelectorAll('#suggestionTable tr').length === 2 && document.querySelector('#suggestionTable tr td').textContent === '4'");
            await click('隐藏'); await cdp.wait("[...document.querySelectorAll('#suggestionTable tr')].every(r=>r.cells[0].textContent !== '4')");
            assert.equal(records[3].state, 'hidden');
            await select('hidden'); await cdp.wait("document.querySelector('#suggestionTable tr td')?.textContent === '4'");
            await click('恢复'); await cdp.wait("[...document.querySelectorAll('#suggestionTable tr')].every(r=>r.cells[0].textContent !== '4')");
            assert.equal(records[3].state, 'public');
        });
        await t.test('delete requires confirmation', async () => {
            await select('all'); await cdp.wait("document.querySelector('#suggestionTable tr td')?.textContent === '4'");
            confirmNext = false; await click('删除'); await delay(100);
            assert.equal(records[3].state, 'public'); assert.equal(confirms, 1);
            confirmNext = true; await click('删除'); await cdp.wait("document.querySelector('#suggestionTable tr td')?.textContent === '3'");
            assert.equal(records[3].state, 'deleted'); assert.equal(confirms, 2);
        });
        await t.test('unknown write result keeps row until refreshed', async () => {
            failWrite = true; await click('隐藏');
            await cdp.wait("document.getElementById('toast').textContent.includes('操作结果未确认')");
            assert.equal(await cdp.eval("document.querySelector('#suggestionTable tr td').textContent"), '3');
            assert.equal(await cdp.eval("document.querySelector('#suggestionTable tr .actions button').disabled"), true);
            failWrite = false; await click('刷新');
            await cdp.wait("document.querySelector('#suggestionTable tr .actions button')?.disabled === false");
            assert.equal(records[2].state, 'public');
        });
        await t.test('403 reports permission failure and can retry', async () => {
            forbid = true; await click('刷新');
            await cdp.wait("document.getElementById('suggestionStatus').textContent.includes('没有建议管理权限')");
            assert.equal(await cdp.eval("document.getElementById('suggestionRetry').hidden"), false);
            forbid = false; await click('重新加载');
            await cdp.wait("document.querySelectorAll('#suggestionTable tr').length === 2");
        });
        await t.test('late filter results cannot overwrite the current view', async () => {
            delayPublic = true; await select('public'); await delay(80); await select('hidden');
            await cdp.wait("document.querySelector('#suggestionTable tr td')?.textContent === '2'");
            await delay(850);
            assert.equal(await cdp.eval("document.querySelector('#suggestionTable tr td').textContent"), '2');
        });
        await t.test('narrow navigation retains an accessible suggestions icon', async () => {
            await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: false });
            assert.equal(await cdp.eval("document.querySelector('#tab-suggestions').getAttribute('aria-label')"), '建议管理');
            assert.equal(await cdp.eval("document.querySelector('#tab-suggestions svg').getBoundingClientRect().width > 0"), true);
        });
        assert.deepEqual(cdp.errors, []);
    } finally {
        if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.socket.close(); }
        browser.kill(); await new Promise(done => server.close(done));
        try { const actual = await realpath(profile); assert.equal(actual, profile); assert.equal(dirname(actual), temporaryRoot); assert.ok(basename(actual).startsWith('mona-admin-suggestions-')); await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
    }
});
