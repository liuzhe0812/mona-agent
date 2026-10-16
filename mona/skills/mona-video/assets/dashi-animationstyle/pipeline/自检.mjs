#!/usr/bin/env node
// 自检.mjs：检查这台电脑能不能出片——Node、ffmpeg、Chrome、whisper（可选）、各套风格要用的字体。几秒钟跑完。
// 用法：node 自检.mjs                 全部检查（字体按 7 套风格逐套报）
//       node 自检.mjs --style 手绘笔记   只报这一套的字体
// 字体为什么要单独查：兰亭黑、圆体、手札体、翩翩体等是 macOS「按需下载」的字体，没下载时系统只带一部分字，
// Chrome 里一个词可能一半是这个字体、一半退回苹方。所以这里查的是完整字体文件在不在，不是只看字体名。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findChrome, CHROME_HINT } from './render.mjs';

const args = process.argv.slice(2);
const onlyStyle = args.includes('--style') ? args[args.indexOf('--style') + 1] : null;
let bad = 0, warn = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, hint) => { bad++; console.log(`  ✗ ${m}${hint ? '\n      ' + hint.replace(/\n/g, '\n      ') : ''}`); };
const may = (m, hint) => { warn++; console.log(`  ! ${m}${hint ? '\n      ' + hint.replace(/\n/g, '\n      ') : ''}`); };
const run = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };

console.log(`系统：${os.type()} ${os.release()}（${os.arch()}）${process.platform !== 'darwin' ? '  —— 只在 macOS 上测过，字体检查只认 macOS 的字体位置' : ''}`);
console.log('\n【软件】');
const major = +process.versions.node.split('.')[0];
if (major >= 22 && typeof WebSocket !== 'undefined') ok(`Node ${process.version}`);
else no(`Node ${process.version}：要 22 以上（渲染用 Node 自带的 WebSocket）`, 'brew install node，或到 https://nodejs.org 下载安装包');
const ffv = run('ffmpeg', ['-version']);
if (ffv && run('ffprobe', ['-version'])) ok(`ffmpeg ${ffv.split('\n')[0].split(' ')[2] || ''}（含 ffprobe）`);
else no('没有 ffmpeg / ffprobe（合成 mp4、截音频、静音检测都要用）', 'brew install ffmpeg（没有 Homebrew 先装 https://brew.sh ）');
const chrome = findChrome();
if (chrome) ok(`Chrome：${chrome}`); else no('没有找到 Chrome', CHROME_HINT);

// whisper：可选。有它能自动转写出字级时间；没有就走「稿子 + 静音检测」的后备（字幕.mjs --script）
const wcli = run('which', ['whisper-cli']) || run('which', ['whisper-cpp']);
const modelDirs = [process.env.WHISPER_MODEL && path.dirname(process.env.WHISPER_MODEL), path.join(os.homedir(), '.cache/whisper-cpp'), path.join(os.homedir(), '.cache/whisper'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp'].filter(Boolean);
const models = modelDirs.flatMap((d) => { try { return fs.readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f) && !/silero|for-tests/.test(f)).map((f) => path.join(d, f)); } catch { return []; } });
if (wcli && models.length) ok(`whisper-cli：${wcli}；模型 ${models.map((m) => path.basename(m)).join('、')}`);
else may(`没有 ${wcli ? 'whisper 模型' : 'whisper-cli'}（可选）`, '没有也能做：给稿子，用 字幕.mjs --script 按静音检测排时间（句子边界要对一遍）。\n想装：brew install whisper-cpp，再下载模型 ggml-large-v3-turbo.bin（约 1.6 GB）放到 ~/.cache/whisper-cpp/');

// ---------------- 字体 ----------------
// 文件索引：系统字体、按需下载的字体（AssetsV2）、用户装的字体
const dirs = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')];
const files = new Set();
for (const d of dirs) { try { for (const f of fs.readdirSync(d)) files.add(f.toLowerCase()); } catch {} }
// 测试用：设 FONT_CHECK_SIMULATE_NEW_MAC=1 时不看按需下载的字体和用户字体，模拟一台新 Mac
const SIM = process.env.FONT_CHECK_SIMULATE_NEW_MAC === '1';
if (SIM) { files.clear(); for (const d of dirs.slice(0, 2)) { try { for (const f of fs.readdirSync(d)) files.add(f.toLowerCase()); } catch {} } }
for (const root of SIM ? [] : ['/System/Library/AssetsV2']) {
  let subs = []; try { subs = fs.readdirSync(root).filter((n) => /Font/.test(n)); } catch {}
  for (const s of subs) { let assets = []; try { assets = fs.readdirSync(path.join(root, s)); } catch {}
    for (const a of assets) { try { for (const f of fs.readdirSync(path.join(root, s, a, 'AssetData'))) files.add(f.toLowerCase()); } catch {} } }
}
const has = (re) => [...files].some((f) => re.test(f));
// 字体表：kind = 系统（一直在）/ 按需（要在「字体册」下载）/ 自装（用户自己装的，没有就退到替代）
const F = {
  'PingFang SC': { kind: '系统', re: /^pingfang/ },
  'Songti SC': { kind: '系统', re: /^songti\.ttc$/ },
  'Times New Roman': { kind: '系统', re: /^times new roman/ },
  'Helvetica Neue': { kind: '系统', re: /^helveticaneue/ },
  'Avenir Next': { kind: '系统', re: /^avenir next/ },
  'Baskerville': { kind: '系统', re: /^baskerville/ },
  'Arial Rounded MT Bold': { kind: '系统', re: /^arial rounded/ },
  'DIN Condensed': { kind: '系统', re: /^din condensed/ },
  'Hoefler Text': { kind: '系统', re: /^hoefler text/ },
  'Lantinghei SC': { kind: '按需', re: /^lantinghei\.ttc$/, cn: '兰亭黑-简' },
  'Yuanti SC': { kind: '按需', re: /^yuanti\.ttc$/, cn: '圆体-简' },
  'Hannotate SC': { kind: '按需', re: /^hannotate\.ttc$/, cn: '手札体-简' },
  'HanziPen SC': { kind: '按需', re: /^hanzipen\.ttc$/, cn: '翩翩体-简' },
  'MiSans': { kind: '自装', re: /^misans/ },
  'Source Han Sans': { kind: '自装', re: /^(sourcehansans|source han sans|思源黑体)/ },
  'Source Han Serif': { kind: '自装', re: /^(sourcehanserif|source han serif|思源宋体)/ },
  'Montserrat': { kind: '自装', re: /^montserrat/ },
  'Bebas Neue': { kind: '自装', re: /^bebas/ },
};
// 每套风格用到的字体（照各套页面的字体栈；fallback = 没有时退到什么）
const STYLE_FONTS = {
  扁平流程图: [['MiSans', '兰亭黑-简 Heavy（特粗）/ 苹方'], ['Lantinghei SC', '苹方（粗细轻一档）']],
  手绘笔记: [['Hannotate SC', '苹方（手写感没了）'], ['Yuanti SC', '苹方'], ['HanziPen SC', '苹方'], ['Arial Rounded MT Bold']],
  复古报刊: [['Songti SC'], ['Times New Roman'], ['Helvetica Neue']],
  复古剪纸: [['Source Han Sans', '兰亭黑-简 / 苹方'], ['Source Han Serif', '宋体-简'], ['Lantinghei SC', '苹方'], ['DIN Condensed'], ['Bebas Neue', 'DIN Condensed']],
  超现实拼贴: [['Source Han Serif', '宋体-简'], ['Montserrat', 'Avenir Next'], ['Hoefler Text'], ['HanziPen SC', '苹方'], ['Hannotate SC', '苹方']],
  立体卡通: [['Lantinghei SC', '苹方'], ['Yuanti SC', '苹方'], ['Helvetica Neue']],
  黑底科技: [['Source Han Serif', '宋体-简'], ['Songti SC'], ['Baskerville']],
};
console.log('\n【字体】（✓ 有完整字体；! 用户自装字体没有，会自动退到替代；✗ 按需下载字体没下载，要先下）');
const toDownload = new Set();
for (const [style, list] of Object.entries(STYLE_FONTS)) {
  if (onlyStyle && !style.includes(onlyStyle)) continue;
  const parts = [];
  for (const [name, fb] of list) {
    const f = F[name], here = has(f.re);
    if (here) parts.push(`✓${name}`);
    else if (f.kind === '按需') { parts.push(`✗${name}`); toDownload.add(`${f.cn}（${name}）`); }
    else if (f.kind === '自装') parts.push(`!${name}→${fb}`);
    else parts.push(`✗${name}（系统字体不见了？）`);
  }
  const mark = parts.some((p) => p.startsWith('✗')) ? '✗' : parts.some((p) => p.startsWith('!')) ? '!' : '✓';
  console.log(`  ${mark} ${style}：${parts.join('  ')}`);
}
if (toDownload.size) {
  bad++;
  console.log(`\n  要先下载的字体：${[...toDownload].join('、')}`);
  console.log('    做法：打开「字体册」（Font Book）→ 搜字体名（例如「兰亭黑」）→ 点「下载」；下完重跑本自检。');
  console.log('    不下载也能渲染，但这些字会退回苹方，或者一个词里一半是这个字体、一半是苹方。');
}
console.log(`\n${bad ? `有 ${bad} 处要处理（✗）` : '必需的都齐了'}${warn ? `，${warn} 处可选（!）` : ''}。${bad ? '' : '下一步：渲自带的 Token 例子（见 SKILL.md「第一次用」）。'}`);
process.exitCode = bad ? 1 : 0;
