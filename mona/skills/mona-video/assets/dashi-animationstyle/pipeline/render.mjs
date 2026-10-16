#!/usr/bin/env node
// render.mjs：把一个定义了 window.seek(t)、舞台 1920×1080 的 HTML 逐帧截图，编成 H.264 + 口播音频的 mp4。
// 无头 Chrome + Chrome DevTools Protocol（Node 自带 WebSocket），不依赖任何 npm 包。
// 每次运行：调试端口由系统随机分配（--remote-debugging-port=0），Chrome 配置和临时文件放在自己的临时目录，
// 所以多个渲染可以同时跑，互不干扰。用法见 SKILL.md，或 `node render.mjs --help`。
// 出处：我们做风格测试时的共用 render.mjs（10-07）；skill 版（10-08）改了：口播和输出默认从作品目录的
// 作品.json 读、没有就找页面旁边的 口播.wav；Chrome 自动找；--no-subtitle；开头检查 Node 版本和 ffmpeg。
// v1.1（10-08 晚，按观众实测改）：--no-subtitle 的输出一律带「_无字幕」（给了 -o 也加）；--scan 扫片拼图、--check-marks 关键词前后帧拼图；
// --stills 出图前把同一前缀的旧静帧挪进 旧静帧/。

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const W = 1920, H = 1080;

const HELP = `用法：
  node render.mjs <作品目录/index.html> [选项]                 成片：30 帧/秒逐帧渲染，合上口播，出 mp4
  node render.mjs <作品目录/index.html> --preview              预览：10 帧/秒、960×540，快
  node render.mjs <作品目录/index.html> --stills 2.1,7.5,12.6  静帧：按给定秒数导出 1920×1080 PNG，外加一张 480 宽的检查图
  node render.mjs <作品目录/index.html> --scan --check-marks   检查图（不出片，十几秒）：扫片拼图 + 关键词前后帧拼图

默认值从页面旁边的 作品.json 读（新建作品.mjs 会写好）：口播用其中的 audio，输出用其中的 output；
没有 作品.json 时，口播找页面旁边的 口播.wav，输出是「页面所在文件夹名.mp4」放在页面旁边。

选项：
  -o, --out <文件>        输出 mp4（预览默认在文件名后加「_预览」）
  --audio <文件>          音频（默认见上）；--no-audio 不要声音
  --config <作品.json>    指定作品配置（默认用页面旁边的 作品.json）
  --no-subtitle           不画字幕（页面地址加 ?nosub=1，页面里的 NOSUB 开关生效；回剪映统一加字幕时用）。
                          输出文件名自动加「_无字幕」（给了 -o 也加，名字里已经有「无字幕」就不再加），
                          不会覆盖带字幕的成片；静帧、检查图的文件名也加「_无字幕」
  --check-determinism auto|秒,秒  确定性检查（v1.3，不出片）：每个时刻在新打开的页面里单独截一张，再先跳到片尾附近、
                          倒回来截一张，比两张是否逐像素相同。不同 = 画面跟 seek 的先后有关（常见原因：画布的 lineCap、
                          lineJoin、setLineDash、globalAlpha 等状态没复位，漏到了下一帧），按时间顺序出片时不一定看得出。
                          auto = 取片长的 25%、50%、75%
  --scan                  扫片拼图：每秒 3 帧、每格 480×270、一张 4×8 格（约 10.7 秒），按片长出几张
                          （检查/扫片_1.png …，旧的同名扫片先删掉），看截断、叠字、空白、换镜头
  --check-marks           关键词前后帧拼图：每个关键词开始前 0.1 秒、后 0.35 秒各一帧，一行两个词（前、后、前、后），
                          出 检查/卡点.png 和 卡点_说明.txt（第几行是哪个词）；手写类风格「后」那帧字可能还没写完，看有没有开始出现
                          这两个只截检查用的小图、不出片；可以和 --no-subtitle、--outdir 一起用
  --fps <n>               帧率（成片默认 30，预览默认 10）
  --scale <x>             截图缩放（成片 1，预览 0.5）
  --duration <秒>         时长（默认依次取 window.DURATION、window.TL.duration、音频时长）
  --from <秒> --to <秒>   只渲染一段（音频同步截取），用于局部检查
  --format png|jpeg       截图格式（默认 png，无损）；--quality <n> jpeg 质量（默认 92）。和 --stills 一起用时出 jpg 静帧（质量默认 90）
  --crf <n>               x264 质量（成片默认 18，预览 26）
  --outdir <目录>         --stills 的输出目录（默认页面旁边）；--scan / --check-marks 的输出目录（默认页面旁边的 检查/）
  --prefix <名>           静帧文件名前缀（默认页面所在文件夹名）。出静帧前，同一目录里同一前缀的旧静帧和旧 480 宽检查图
                          会先挪进 旧静帧/<前缀_时分秒>/，文件夹里只留这一批；调试用的静帧换个前缀（例如 --prefix 调试）就不会互相挪
  --gpu                   允许 Chrome 用 GPU（默认关，软件渲染更稳定、并行时不抢显卡）
  --keep                  保留临时目录（调试用）；--tmp <目录> 临时目录放哪（默认系统临时目录）
  --chrome <路径>         Chrome 可执行文件（默认自动找：环境变量 CHROME_PATH → Google Chrome → Chromium → Edge → Brave）
`;

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(`参数 ${a} 后面缺值`); return argv[++i]; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-o': case '--out': o.out = val(); break;
      case '--audio': o.audio = val(); break;
      case '--no-audio': o.noAudio = true; break;
      case '--config': o.config = val(); break;
      case '--no-subtitle': case '--nosub': o.noSub = true; break;
      case '--fps': o.fps = +val(); break;
      case '--scale': o.scale = +val(); break;
      case '--duration': o.duration = +val(); break;
      case '--from': o.from = +val(); break;
      case '--to': o.to = +val(); break;
      case '--format': o.format = val(); break;
      case '--quality': o.quality = +val(); break;
      case '--crf': o.crf = +val(); break;
      case '--preview': o.preview = true; break;
      case '--stills': o.stills = val().split(',').map((s) => +s.trim()).filter((x) => Number.isFinite(x)); break;
      case '--scan': o.scan = true; break;
      case '--check-marks': o.checkMarks = true; break;
      case '--check-determinism': o.determinism = val(); break;
      case '--outdir': o.outdir = val(); break;
      case '--prefix': o.prefix = val(); break;
      case '--gpu': o.gpu = true; break;
      case '--keep': o.keep = true; break;
      case '--chrome': o.chrome = val(); break;
      case '--tmp': o.tmp = val(); break;
      default:
        if (a.startsWith('-')) die(`不认识的参数：${a}\n\n${HELP}`);
        o._.push(a);
    }
  }
  return o;
}
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function fail(msg) { throw new Error(msg); }   // Chrome 起来之后出错用 fail：抛出去，由 finally 关掉 Chrome、删临时目录
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtS = (ms) => (ms / 1000).toFixed(1) + ' 秒';
const bjTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });   // 本机时间（v1.3 起不再固定北京时间）

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
  constructor(url) {
    this.url = url; this.seq = 0; this.pending = new Map(); this.listeners = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`连不上 Chrome 调试端口：${e.message || this.url}`));
      ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('Chrome 连接已断开')); this.pending.clear(); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        if (m.id !== undefined) {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(`${p.method} 失败：${m.error.message}${m.error.data ? '（' + m.error.data + '）' : ''}`));
          else p.resolve(m.result);
        } else if (m.method) {
          for (const l of this.listeners) if (l.method === m.method && (!l.session || l.session === m.sessionId)) l.fn(m.params);
        }
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`等 ${method} 超过 ${timeoutMs / 1000} 秒`)); }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(method, fn, session) { this.listeners.push({ method, fn, session }); }
  once(method, session, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const l = { method, session, fn: (p) => { clearTimeout(timer); this.listeners.splice(this.listeners.indexOf(l), 1); resolve(p); } };
      const timer = setTimeout(() => { this.listeners.splice(this.listeners.indexOf(l), 1); reject(new Error(`等 ${method} 超过 ${timeoutMs / 1000} 秒`)); }, timeoutMs);
      this.listeners.push(l);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------- Chrome ----------------
// 自动找 Chrome：--chrome → 环境变量 CHROME_PATH → 常见安装位置 → PATH 里的命令。找不到返回 null。
// 只有 Google Chrome 实测过；Chromium、Edge、Brave 是同一个内核，理论上能用，没实测。
export function findChrome(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const home = os.homedir();
  const mac = [
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
    'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  for (const rel of mac) for (const root of ['/Applications', path.join(home, 'Applications')]) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) return p;
  }
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { const p = execFileSync('which', [cmd], { encoding: 'utf8' }).trim(); if (p) return p; } catch {}
  }
  return null;
}
export const CHROME_HINT = `找不到 Chrome。
  · 装 Google Chrome（https://www.google.com/chrome/ ，装到「应用程序」文件夹），装完重跑；
  · 或者用 --chrome <路径> 指定别的 Chromium 内核浏览器（Edge、Brave、Chromium；没实测），
    也可以设环境变量 CHROME_PATH=<路径>。`;

async function launchChrome(opts, tmp) {
  const exe = findChrome(opts.chrome);
  if (!exe) die(opts.chrome ? `--chrome 给的路径不存在：${opts.chrome}` : CHROME_HINT);
  const userDir = path.join(tmp, 'chrome-profile');
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    ...(opts.gpu ? [] : ['--disable-gpu']),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let errText = '';
  proc.stderr.on('data', (d) => { if (errText.length < 20000) errText += d; });
  proc.stderr.on('error', () => {});
  const portFile = path.join(userDir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (true) {
    const m = errText.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return { proc, ws: m[1], userDir };
    if (fs.existsSync(portFile)) {
      const [port, p] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && p) return { proc, ws: `ws://127.0.0.1:${port}${p}`, userDir };
    }
    if (proc.exitCode !== null || proc.signalCode !== null) fail(`Chrome 启动后立刻退出了：\n${errText.slice(0, 2000)}`);
    if (Date.now() - t0 > 30000) { proc.kill('SIGKILL'); fail(`Chrome 30 秒内没有给出调试地址：\n${errText.slice(0, 2000)}`); }
    await sleep(25);
  }
}

// 关 Chrome：先 SIGTERM，2 秒没退再 SIGKILL；最后把命令行里带着本次临时目录的残留子进程（GPU、渲染进程等）清掉
// ——临时目录名是唯一的，不会误伤别的渲染任务或日常用的 Chrome。
// （试过先发 CDP 的 Browser.close，Chrome 反而会卡在退出流程里好几秒，所以不用。）
async function killChrome(proc, userDir) {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
    for (let i = 0; i < 40 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(50);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  if (userDir) {
    try {
      const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 });
      for (const line of ps.split('\n')) {
        if (!line.includes(userDir)) continue;
        const pid = parseInt(line, 10);
        if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    } catch {}
  }
  // 子进程可能还握着 stderr 管道，主动断开，免得 Node 等它们几秒才退出
  if (proc) { try { proc.stderr && proc.stderr.destroy(); } catch {} proc.unref(); }
}

// ---------------- 页面 ----------------
async function openPage(cdp, htmlPath, query = '') {
  // v1.2：页面引了 动效部件.js、旁边没有（老作品目录、手动 cp 模板时），就从 pipeline 复制一份过去
  // v1.3：页面在 skill 自己的文件夹里时不复制（不往 skill 里写东西）
  const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const inSkill = path.resolve(htmlPath).startsWith(SKILL_DIR + path.sep);
  if (!inSkill) try {
    const fx = path.join(path.dirname(path.resolve(htmlPath)), '动效部件.js');
    if (!fs.existsSync(fx) && fs.readFileSync(htmlPath, 'utf8').includes('src="动效部件.js"')) {
      fs.copyFileSync(fileURLToPath(new URL('./动效部件.js', import.meta.url)), fx);
      console.log(`  已把 动效部件.js 复制到页面旁边：${fx}`);
    }
  } catch { /* 复制不了也照常打开：页面里没调用 动效 就不影响 */ }
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p, t) => cdp.send(m, p, sessionId, t);
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push(`${d.exception?.description || d.text || '未知错误'}（${d.url ? path.basename(decodeURIComponent(d.url)) : ''}:${d.lineNumber ?? '?'}）`);
  }, sessionId);
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') console.log(`  页面 console.${p.type}：${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
  }, sessionId);
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry;
    if (e.level === 'error' && e.source !== 'violation') console.log(`  页面报错：${e.text.slice(0, 300)}${e.url ? '（' + decodeURIComponent(e.url) + '）' : ''}`);
  }, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once('Page.loadEventFired', sessionId, 60000);
  const nav = await S('Page.navigate', { url: pathToFileURL(path.resolve(htmlPath)).href + query });
  if (nav.errorText) fail(`页面打不开：${nav.errorText}`);
  await loaded;
  // 等页面准备好：window.seek 是函数，且 window.ready 不是 false；页面一报错就停
  const t0 = Date.now();
  while (true) {
    if (errors.length) fail(`页面加载时出错：\n  ${errors.join('\n  ')}`);
    const ok = await evaluate(S, `typeof window.seek === 'function' && window.ready !== false`);
    if (ok) break;
    if (Date.now() - t0 > 20000) fail('页面 20 秒内没有定义 window.seek(t)（或 window.ready 一直是 false）');
    await sleep(100);
  }
  const info = await evaluate(S, `(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const tl = window.TL || {};
    return {
      duration: (typeof window.DURATION === 'number' ? window.DURATION : (typeof tl.duration === 'number' ? tl.duration : null)),
      sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    };
  })()`, 30000);
  if (errors.length) fail(`页面加载时出错：\n  ${errors.join('\n  ')}`);
  if (info.sw > W || info.sh > H) console.log(`  注意：页面内容尺寸 ${info.sw}×${info.sh} 超出 ${W}×${H}，超出部分不会被截到`);
  return { S, errors, info };
}

async function evaluate(S, expression, timeoutMs = 30000) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面脚本出错：${d.exception?.description || d.text}`);
  }
  return r.result.value;
}

async function seekAndShoot(S, errors, t, shot) {
  await evaluate(S, `Promise.resolve(window.seek(${t.toFixed(6)})).then(() => 1)`);
  if (errors.length) throw new Error(`seek(${t.toFixed(3)}) 时页面出错：\n  ${errors.join('\n  ')}`);
  const params = { format: shot.format, clip: { x: 0, y: 0, width: W, height: H, scale: shot.scale }, captureBeyondViewport: false, optimizeForSpeed: true };
  if (shot.format === 'jpeg') params.quality = shot.quality;
  const { data } = await S('Page.captureScreenshot', params, 60000);
  return Buffer.from(data, 'base64');
}

// ---------------- 工具 ----------------
function probeDuration(file) {
  try {
    return +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  } catch { return null; }
}
function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) return reject(new Error('ffmpeg 已退出'));
    if (stream.write(buf)) return resolve();
    const onDrain = () => { stream.off('close', onClose); resolve(); };
    const onClose = () => { stream.off('drain', onDrain); reject(new Error('ffmpeg 中途退出')); };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  });
}

// ---------------- 主流程 ----------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts._.length) { console.log(HELP); process.exit(opts.help ? 0 : 1); }
  if (opts.stills && !opts.stills.length) die('--stills 后面要写秒数，用逗号隔开，例如 --stills 2.1,7.5,12.6');
  // 环境：Node 22 以上才有自带的 WebSocket；ffmpeg / ffprobe 要在 PATH 里
  if (typeof WebSocket === 'undefined') die(`Node 版本太低（现在是 ${process.version}，要 22 以上，自带 WebSocket）。Mac 上：brew install node，或到 https://nodejs.org 下载安装包。`);
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { die('找不到 ffmpeg。Mac 上：brew install ffmpeg（没有 Homebrew 先装 https://brew.sh ）。'); }
  const html = path.resolve(opts._[0]);
  if (!fs.existsSync(html)) die(`找不到页面：${html}`);
  const pageDir = path.dirname(html);
  const baseName = path.basename(pageDir);
  // 作品配置：--config 指定，或页面旁边的 作品.json；里面的相对路径都相对于配置文件所在目录
  const cfgPath = opts.config ? path.resolve(opts.config) : path.join(pageDir, '作品.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { die(`作品配置读不了（${cfgPath}）：${e.message}`); }
  } else if (opts.config) die(`找不到作品配置：${cfgPath}`);
  const cfgDir = path.dirname(cfgPath);
  const fromCfg = (k) => (cfg[k] ? path.resolve(cfgDir, cfg[k]) : null);
  if (opts.stills && (opts.scan || opts.checkMarks)) die('--stills 和 --scan / --check-marks 分两次跑');
  if (opts.determinism && (opts.stills || opts.scan || opts.checkMarks)) die('--check-determinism 单独跑');
  const mode = opts.determinism ? 'determinism' : opts.stills ? 'stills' : (opts.scan || opts.checkMarks) ? 'check' : opts.preview ? 'preview' : 'final';
  const nsTag = opts.noSub ? '_无字幕' : '';   // 不画字幕时，所有输出文件名都带「_无字幕」，不覆盖带字幕的版本
  const fps = opts.fps || (mode === 'preview' ? 10 : 30);
  const scale = opts.scale || (mode === 'preview' ? 0.5 : 1);
  const format = opts.format || cfg.format || 'png';
  const quality = opts.quality || 92;
  const crf = opts.crf ?? (mode === 'preview' ? 26 : 18);
  const defAudio = fromCfg('audio') || path.join(pageDir, '口播.wav');
  let audio = opts.noAudio ? null : (opts.audio ? path.resolve(opts.audio) : defAudio);
  if (audio && !fs.existsSync(audio)) {
    if (opts.audio || cfg.audio) die(`找不到音频：${audio}`);
    if (mode === 'final' || mode === 'preview') console.log(`  页面旁边没有 作品.json 也没有 口播.wav，输出不带声音（要声音用 --audio <文件>）`);
    audio = null;
  }
  const query = opts.noSub ? '?nosub=1' : '';

  const tmp = fs.mkdtempSync(path.join(opts.tmp || os.tmpdir(), 'render-'));
  let chrome = null, cdp = null, ff = null, part = null, userDir = path.join(tmp, 'chrome-profile');
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    try { cdp && cdp.close(); } catch {}
    await killChrome(chrome, userDir);
    if (ff && ff.exitCode === null) ff.kill('SIGKILL');
    if (part && fs.existsSync(part)) fs.rmSync(part, { force: true });   // 没渲完的半成品不留
    if (!opts.keep) fs.rmSync(tmp, { recursive: true, force: true });
  };
  let interrupted = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { if (interrupted) return; interrupted = true; console.error(`\n收到 ${sig}，清理后退出`); await cleanup(); process.exit(130); });

  const T0 = Date.now();
  try {
    const launched = await launchChrome(opts, tmp);
    chrome = launched.proc;
    cdp = new CDP(launched.ws);
    await cdp.open();
    const port = new URL(launched.ws).port;
    console.log(`[${bjTime()}] Chrome 已启动（调试端口 ${port}，临时目录 ${tmp}）`);
    const { S, errors, info } = await openPage(cdp, html, query);
    if (opts.noSub) {
      const hasSwitch = await evaluate(S, `typeof NOSUB !== 'undefined' ? NOSUB : null`);
      if (hasSwitch !== true) console.log('  注意：页面里没有 NOSUB 开关，--no-subtitle 不起作用（页面要有 const NOSUB = /[?&]nosub=1/.test(location.search)）');
    }
    const tLoad = Date.now() - T0;

    // ---------- 确定性检查（v1.3）：同一个 t，单独 seek 和「先跳到别处再回来」画出来要一模一样 ----------
    if (mode === 'determinism') {
      const dur = opts.duration || info.duration || (audio ? probeDuration(audio) : null);
      if (!dur) fail('不知道时长：请用 --duration 指定，或在页面里设 window.DURATION');
      const times = opts.determinism === 'auto' ? [0.25, 0.5, 0.75].map((k) => +(dur * k).toFixed(2))
        : opts.determinism.split(',').map((x) => +x.trim()).filter((x) => Number.isFinite(x));
      if (!times.length) fail('--check-determinism 后面写 auto，或用逗号隔开的秒数');
      const far = +(dur * 0.95).toFixed(2);
      let bad = 0;
      for (const t of times) {
        const p = await openPage(cdp, html, query);           // 每个时刻都用新打开的页面，先单独截
        const a = await seekAndShoot(p.S, p.errors, t, { format: 'png', scale: 0.5 });
        await seekAndShoot(p.S, p.errors, far, { format: 'png', scale: 0.25 });
        await seekAndShoot(p.S, p.errors, Math.max(0, t / 2), { format: 'png', scale: 0.25 });
        const b = await seekAndShoot(p.S, p.errors, t, { format: 'png', scale: 0.5 });
        const same = Buffer.compare(a, b) === 0;
        if (!same) bad++;
        console.log(`  ${same ? '✓' : '✗'} ${t.toFixed(2)} 秒：单独 seek 和「先跳到 ${far} 秒、${(t / 2).toFixed(2)} 秒再回来」${same ? '一样' : '不一样'}`);
      }
      console.log(bad ? `✗ ${bad} / ${times.length} 个时刻不一致：画面跟 seek 的先后有关。每帧开头把画布状态整套复位（ctx.reset() 后再设默认值；离屏画布也要），用到随机数的在 seek(t) 里重建种子，再跑一次。`
        : `✓ ${times.length} 个时刻都一致`);
      console.log(`[${bjTime()}] 完成，用时 ${fmtS(Date.now() - T0)}`);
      if (bad) process.exitCode = 2;
      return;
    }

    // ---------- 静帧 ----------
    if (mode === 'stills') {
      const outdir = path.resolve(opts.outdir || pageDir);
      fs.mkdirSync(outdir, { recursive: true });
      const prefix0 = opts.prefix || baseName;
      const prefix = nsTag && !prefix0.includes('无字幕') ? prefix0 + nsTag : prefix0;
      // 同一前缀的旧静帧、旧检查图先挪走（不删），文件夹里只留这一批，免得新旧混在一起
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const oldRe = new RegExp(`^${esc}_(静帧_-?\\d+(\\.\\d+)?s\\.(png|jpg)|480宽检查\\.png)$`);
      const isOld = (f) => oldRe.test(f);
      const olds = fs.readdirSync(outdir).filter(isOld);
      if (olds.length) {
        const hms = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
        const bak = path.join(outdir, '旧静帧', `${prefix}_${hms}`);
        fs.mkdirSync(bak, { recursive: true });
        for (const f of olds) fs.renameSync(path.join(outdir, f), path.join(bak, f));
        console.log(`  上一批同名前缀的 ${olds.length} 个文件挪到了 ${bak}`);
      }
      const files = [];
      for (const t of opts.stills) {
        const jpg = opts.format === 'jpeg';   // v1.3：命令行写了 --format jpeg 就出 jpg（风格文件夹的 静帧/ 用 jpg）
        const buf = await seekAndShoot(S, errors, t, jpg ? { format: 'jpeg', quality: opts.quality || 90, scale: 1 } : { format: 'png', scale: 1 });
        const f = path.join(outdir, `${prefix}_静帧_${t.toFixed(2)}s.${jpg ? 'jpg' : 'png'}`);
        fs.writeFileSync(f, buf);
        files.push(f);
        console.log(`  ✓ ${f}`);
      }
      // 480 宽检查图：把静帧缩到 480 像素宽竖排（手机竖屏看横屏视频的宽度），看字幕和关键字是否还读得清
      const sheet = path.join(outdir, `${prefix}_480宽检查.png`);
      const inputs = files.flatMap((f) => ['-i', f]);
      const filter = files.map((_, i) => `[${i}:v]scale=480:-1:flags=area[s${i}]`).join(';') + ';' + files.map((_, i) => `[s${i}]`).join('') + (files.length > 1 ? `vstack=inputs=${files.length}` : 'null');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-frames:v', '1', '-update', '1', sheet]);
      console.log(`  ✓ ${sheet}`);
      console.log(`[${bjTime()}] 完成，用时 ${fmtS(Date.now() - T0)}`);
      return;
    }

    // ---------- 检查图（不出片）：扫片拼图、关键词前后帧拼图；每格 480×270，从页面直接截，和成片同一时刻的画面一样 ----------
    if (mode === 'check') {
      const dur = opts.duration || info.duration || (audio ? probeDuration(audio) : null);
      if (!dur) fail('不知道时长：请用 --duration 指定，或在页面里设 window.DURATION');
      const outdir = path.resolve(opts.outdir || path.join(pageDir, '检查'));
      fs.mkdirSync(outdir, { recursive: true });
      const lastT = Math.max(0, (Math.ceil(dur * 30 - 1e-6) - 1) / 30);   // 成片最后一帧的时间
      const frameT = (t) => Math.min(Math.max(0, Math.round(t * 30) / 30), lastT);   // 对到成片的帧上
      let nSheet = 0;
      const sheetOf = async (times, cols, file) => {   // 截一组小图，按 cols 列拼成一张（最后一行不满时空着）
        const sub = fs.mkdtempSync(path.join(tmp, 'sheet-'));
        for (let k = 0; k < times.length; k++) {
          const buf = await seekAndShoot(S, errors, frameT(times[k]), { format: 'png', scale: 0.25 });
          fs.writeFileSync(path.join(sub, `f_${String(k + 1).padStart(4, '0')}.png`), buf);
        }
        const rows = Math.ceil(times.length / cols);
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(sub, 'f_%04d.png'),
          '-vf', `tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', '-update', '1', file]);
        nSheet++;
        console.log(`  ✓ ${file}`);
      };
      if (opts.scan) {
        const base = `扫片${nsTag}`;
        for (const f of fs.readdirSync(outdir)) if (new RegExp(`^${base}_\\d+\\.png$`).test(f)) fs.rmSync(path.join(outdir, f));   // 旧扫片先删（片子变短时张数会变少）
        const times = []; for (let k = 0; k / 3 <= lastT + 1e-6; k++) times.push(k / 3);
        const per = 32;   // 4 列 × 8 行，约 10.7 秒一张
        for (let s = 0; s * per < times.length; s++) {
          const ts = times.slice(s * per, (s + 1) * per);
          console.log(`  扫片 ${s + 1}：${ts[0].toFixed(2)}–${ts[ts.length - 1].toFixed(2)} 秒（每格 1/3 秒，从左到右、从上到下）`);
          await sheetOf(ts, 4, path.join(outdir, `${base}_${s + 1}.png`));
        }
      }
      if (opts.checkMarks) {
        const marks = Object.entries(await evaluate(S, `(window.TL && window.TL.marks) || {}`)).map(([name, m]) => ({ name, start: m.start })).filter((m) => Number.isFinite(m.start)).sort((a, b) => a.start - b.start);
        if (!marks.length) console.log('  TL.marks 里没有关键词，不出卡点拼图（分镜.json 的 marks 是空的？）');
        else {
          const times = marks.flatMap((m) => [m.start - 0.1, m.start + 0.35]);
          const lines = [`关键词前后帧（卡点${nsTag}.png）：每格 480×270；一行两个词，顺序是「词1 前、词1 后、词2 前、词2 后」；前 = 开始说之前 0.1 秒，后 = 开始说之后 0.35 秒。`,
            '要看的是：「前」那格还没有这个词对应的动作，「后」那格已经开始出现（手写、逐字浮现的风格这时可能只写了一两个字，开始出现就算对上）。', ''];
          for (let r = 0; r * 2 < marks.length; r++) {
            const a = marks[r * 2], b = marks[r * 2 + 1];
            lines.push(`第 ${String(r + 1).padStart(2)} 行：左 ${a.name}（${a.start.toFixed(2)} 秒）` + (b ? `　右 ${b.name}（${b.start.toFixed(2)} 秒）` : ''));
          }
          await sheetOf(times, 4, path.join(outdir, `卡点${nsTag}.png`));
          fs.writeFileSync(path.join(outdir, `卡点${nsTag}_说明.txt`), lines.join('\n') + '\n');
          console.log(`  ✓ ${path.join(outdir, `卡点${nsTag}_说明.txt`)}\n  ${lines.slice(3).join('\n  ')}`);
        }
      }
      console.log(`[${bjTime()}] 完成，出了 ${nSheet} 张拼图，用时 ${fmtS(Date.now() - T0)}`);
      return;
    }

    // ---------- 视频 ----------
    let duration = opts.duration || info.duration || (audio ? probeDuration(audio) : null);
    if (!duration) fail('不知道时长：请用 --duration 指定，或在页面里设 window.DURATION');
    const from = opts.from || 0;
    const to = Math.min(opts.to ?? duration, duration);
    if (!(to > from)) fail(`时间段不对：--from ${from} --to ${to}`);
    const nFrames = Math.ceil((to - from) * fps - 1e-6);
    const outLen = nFrames / fps;
    const suffix = `${mode === 'preview' ? '_预览' : ''}${nsTag}${opts.from !== undefined || opts.to !== undefined ? `_${from}-${to}s` : ''}`;
    const cfgOut = fromCfg('output');
    const defOut = cfgOut ? cfgOut.replace(/\.mp4$/i, '') + suffix + '.mp4' : path.join(pageDir, `${baseName}${suffix}.mp4`);
    let out = path.resolve(opts.out || defOut);
    // --no-subtitle 时就算 -o 给的是带字幕成片的名字，也加「_无字幕」，不覆盖带字幕的那版
    if (nsTag && !path.basename(out).includes('无字幕')) { const ext = path.extname(out); out = out.slice(0, out.length - ext.length) + nsTag + (ext || '.mp4'); }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    part = out.replace(/\.mp4$/i, '') + '.rendering.mp4';
    const outW = Math.round(W * scale), outH = Math.round(H * scale);
    console.log(`  ${mode === 'preview' ? '预览' : '成片'}：${from}–${to} 秒，${fps} 帧/秒，共 ${nFrames} 帧，${outW}×${outH}，截图 ${format}${audio ? '，音频 ' + path.basename(audio) : '，无音频'}${opts.noSub ? '，不画字幕' : ''}`);
    console.log(`  输出：${out}`);

    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', format === 'jpeg' ? 'mjpeg' : 'png', '-i', 'pipe:0'];
    if (audio) ffArgs.push('-ss', String(from), '-t', String(outLen), '-i', audio);
    ffArgs.push('-map', '0:v');
    if (audio) ffArgs.push('-map', '1:a', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k');
    ffArgs.push(
      '-vf', `scale=${outW}:${outH}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      '-c:v', 'libx264', '-preset', mode === 'preview' ? 'veryfast' : 'medium', '-crf', String(crf), '-tune', 'animation',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-r', String(fps), '-t', String(outLen), '-movflags', '+faststart', part);
    ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (d) => { if (ffErr.length < 20000) ffErr += d; });
    const ffDone = new Promise((resolve) => ff.on('close', (code) => resolve(code)));
    ff.stdin.on('error', () => {});

    const tStart = Date.now();
    let tSeekShot = 0;
    for (let i = 0; i < nFrames; i++) {
      const t = from + i / fps;
      const a = Date.now();
      const buf = await seekAndShoot(S, errors, t, { format, quality, scale });
      tSeekShot += Date.now() - a;
      await writeAsync(ff.stdin, buf);
      if ((i + 1) % 60 === 0 || i + 1 === nFrames) {
        const el = Date.now() - tStart, per = el / (i + 1);
        console.log(`  帧 ${String(i + 1).padStart(4)}/${nFrames}  平均 ${per.toFixed(0)} 毫秒/帧  已用 ${fmtS(el)}  预计还要 ${fmtS(per * (nFrames - i - 1))}`);
      }
    }
    ff.stdin.end();
    const code = await ffDone;
    if (code !== 0) fail(`ffmpeg 编码失败（退出码 ${code}）：\n${ffErr.slice(-3000)}`);
    fs.renameSync(part, out); part = null;
    const tFrames = Date.now() - tStart;
    const per = tFrames / nFrames;
    console.log(`[${bjTime()}] ✓ ${out}`);
    console.log(`  统计：启动+加载 ${fmtS(tLoad)}；逐帧 ${nFrames} 帧共 ${fmtS(tFrames)}（平均 ${per.toFixed(0)} 毫秒/帧，其中 seek+截图 ${(tSeekShot / nFrames).toFixed(0)} 毫秒）；总计 ${fmtS(Date.now() - T0)}`);
    const st = fs.statSync(out);
    console.log(`  文件 ${(st.size / 1048576).toFixed(1)} MB，时长 ${probeDuration(out)?.toFixed(2)} 秒`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// 只有直接运行时才跑（自检.mjs 会 import 这里的 findChrome）
const realp = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realp(process.argv[1]) === realp(fileURLToPath(import.meta.url))) main();
