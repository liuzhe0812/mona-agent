#!/usr/bin/env node
// 新建作品.mjs：建一个作品目录（一段口播 + 一套风格 = 一个作品），后面的转写、分镜、页面、渲染都在这个目录里做。
//
// 用法：
//   node 新建作品.mjs <作品目录> --style 手绘笔记 --example token     用自带的 Token 例子（第一次用：确认电脑能出片）
//   node 新建作品.mjs <作品目录> --style 手绘笔记 --audio 我的口播.m4a [--script 稿子.txt]   自己的口播
//   node 新建作品.mjs --list                                            列出有哪些风格
// 作品目录里会有：作品.json（配置）、口播.wav、index.html（从风格文件夹复制来的页面）、动效部件.js（v1.2，转场和次要动作）；Token 例子还有字幕、分镜、timeline.js。
// 作品目录已经存在时只补缺的文件，不覆盖已有的（要覆盖页面加 --force）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const STYLES = path.join(SKILL, 'styles');
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const styleNames = () => fs.readdirSync(STYLES).filter((n) => fs.existsSync(path.join(STYLES, n, '示例_Token.html')));

const args = process.argv.slice(2);
const o = { _: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i] ?? die(`参数 ${a} 后面缺值`);
  if (a === '--style') o.style = v();
  else if (a === '--example') o.example = v();
  else if (a === '--audio') o.audio = v();
  else if (a === '--script') o.script = v();
  else if (a === '--force') o.force = true;
  else if (a === '--list') o.list = true;
  else if (a === '-h' || a === '--help') o.help = true;
  else if (a.startsWith('-')) die(`不认识的参数：${a}`);
  else o._.push(a);
}
if (o.list) {
  // 每套两行：看起来什么样（风格卡第一段的第一句）、适合讲什么（「适合」那句，到分号为止）；整句打印，不截半句
  for (const n of styleNames()) {
    const card = path.join(STYLES, n, '风格卡.md');
    const md = fs.existsSync(card) ? fs.readFileSync(card, 'utf8') : '';
    const para = md.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
    const sents = para.split('。').map((x) => x.trim()).filter(Boolean);
    const look = sents[0] ? sents[0] + '。' : '';
    const fit = (sents.find((x) => x.startsWith('适合')) || '').split('；')[0];
    const grade = (md.match(/\*\*分级：([AB])\*\*/) || [])[1];
    const tpl = fs.existsSync(path.join(STYLES, n, '模板.html')) ? '' : '（没有 模板.html）';
    console.log(`  ${n.padEnd(6, '　')}  ${grade ? grade + ' 级' : ''}${tpl}  ${look}`);
    if (fit) console.log(`  ${''.padEnd(6, '　')}        ${fit}。`);
  }
  console.log('\nA 级：底座直接用，换内容只写场景；B 级：版式和 Token 的比喻绑在一起，要先重排版式或想新比喻（多花 15–20 分钟）。每套的样子看 styles/<风格>/静帧/ 里的 3 张图。');
  process.exit(0);
}
if (o.help || !o._.length || !o.style) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(3, 9).join('\n'));
  process.exit(o.help ? 0 : 1);
}

// 风格：接受「手绘笔记」「S22」「手绘」这种写法
const names = styleNames();
const style = names.find((n) => n === o.style) || names.find((n) => n.includes(o.style)) ||
  names.find((n) => (fs.readFileSync(path.join(STYLES, n, '示例_Token.html'), 'utf8').slice(0, 600)).includes(o.style));
if (!style) die(`没有「${o.style}」这套风格。现有：${names.join('、')}`);
const sdir = path.join(STYLES, style);

const dir = path.resolve(o._[0]);
if (dir.startsWith(SKILL + path.sep)) die('作品目录不要放在 skill 文件夹里面，放到用户自己的项目或桌面上');
fs.mkdirSync(dir, { recursive: true });
const put = (src, name, force = false) => {
  const dst = path.join(dir, name);
  if (fs.existsSync(dst) && !force) { console.log(`  已有 ${name}，不覆盖`); return; }
  fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o644); console.log(`  ✓ ${name}`);   // v1.3：skill 文件夹是只读的时候，复制出来的页面也会是只读，改成可写
};

const cfg = { style, audio: '口播.wav', subtitles: '字幕.json', storyboard: '分镜.json', timeline: 'timeline.js', page: 'index.html', output: `${path.basename(dir)}.mp4` };
const fast = /立体卡通|超现实拼贴|复古剪纸|黑底科技/.test(style);   // 满屏颗粒的几套，PNG 截图慢，默认用 jpeg 截图
if (fast) cfg.format = 'jpeg';

if (o.example) {
  const ex = path.join(SKILL, 'examples', o.example);
  if (!fs.existsSync(ex)) die(`没有这个例子：${o.example}（有：${fs.readdirSync(path.join(SKILL, 'examples')).join('、')}）`);
  for (const f of ['口播.wav', '字幕.json', '字幕.srt', '分镜.json', '分镜.md', '稿子.txt']) if (fs.existsSync(path.join(ex, f))) put(path.join(ex, f), f);
  put(path.join(sdir, '示例_Token.html'), 'index.html', o.force);
} else {
  if (o.audio) {
    const src = path.resolve(o.audio);
    if (!fs.existsSync(src)) die(`找不到口播文件：${src}`);
    const dst = path.join(dir, '口播.wav');
    if (fs.existsSync(dst) && !o.force) console.log('  已有 口播.wav，不覆盖');
    else {
      // 统一转成 44.1 kHz 立体声 16 位 wav（wav、m4a、mp3、mov 都行）
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', dst]);
      const d = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst], { encoding: 'utf8' }).trim();
      console.log(`  ✓ 口播.wav（${d.toFixed(2)} 秒）${d > 65 ? '  注意：超过 60 秒，建议分段做' : ''}`);
    }
  }
  if (o.script) put(path.resolve(o.script), '稿子.txt');
  const tpl = fs.existsSync(path.join(sdir, '模板.html')) ? '模板.html' : '示例_Token.html';
  put(path.join(sdir, tpl), 'index.html', o.force);
  if (tpl === '示例_Token.html') console.log('  这套还没有通用模板：index.html 是 Token 例子的页面，按 风格卡.md「换内容时怎么改」保留底座、重写场景');
}
put(path.join(HERE, '动效部件.js'), '动效部件.js');   // v1.2：转场和次要动作的共用部件，模板里的 fxBefore / fxAfter 调它
const cfgPath = path.join(dir, '作品.json');
if (!fs.existsSync(cfgPath) || o.force) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`  ✓ 作品.json（风格 ${style}${fast ? '，截图用 jpeg' : ''}）`);

if (fs.existsSync(path.join(dir, '字幕.json')) && fs.existsSync(path.join(dir, '分镜.json'))) {
  execFileSync(process.execPath, [path.join(HERE, '生成timeline.mjs'), dir], { stdio: 'inherit' });
}
console.log(`\n作品目录：${dir}\n风格卡：${path.join(sdir, '风格卡.md')}`);
console.log(o.example
  ? `下一步：node "${path.join(HERE, 'render.mjs')}" "${path.join(dir, 'index.html')}"`
  : '下一步：转写出 字幕.json → 写 分镜.json → node 生成timeline.mjs <作品目录> → 照风格卡改 index.html（见 SKILL.md 用法一）');
