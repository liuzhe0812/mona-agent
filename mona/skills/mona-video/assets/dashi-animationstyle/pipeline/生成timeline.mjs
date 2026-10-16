#!/usr/bin/env node
// 生成timeline.mjs：字幕.json + 分镜.json → timeline.js（页面用 <script src="timeline.js"></script> 引入，得到 window.TL）。
// 出处：我们做风格测试时的生成timeline.mjs（写死了 Token 那段的文件名）；skill 版改成从参数或作品.json 读，
// Token 专用字段（例句、数据样例）变成可选，加了 标题 / 高亮 / 字幕强调 / 素材 几个通用字段。
//
// 用法：
//   node 生成timeline.mjs <作品目录>          读 作品目录/作品.json 里的 subtitles、storyboard、timeline（没有就用
//                                              字幕.json、分镜.json、timeline.js），写 作品目录/timeline.js
//   node 生成timeline.mjs --subs 字幕.json --storyboard 分镜.json -o timeline.js
// 分镜.json 字段见 SKILL.md「分镜.json 怎么写」；examples/token/分镜.json 是完整例子。
import fs from 'node:fs';
import path from 'node:path';

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const args = process.argv.slice(2);
let subsPath, sbPath, outPath, dir;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i] ?? die(`参数 ${a} 后面缺值`);
  if (a === '--subs') subsPath = v();
  else if (a === '--storyboard') sbPath = v();
  else if (a === '-o' || a === '--out') outPath = v();
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(4, 9).join('\n')); process.exit(0); }
  else if (a.startsWith('-')) die(`不认识的参数：${a}`);
  else dir = a;
}
if (dir) {
  dir = path.resolve(dir);
  const cfgPath = path.join(dir, '作品.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  subsPath ??= path.join(dir, cfg.subtitles || '字幕.json');
  sbPath ??= path.join(dir, cfg.storyboard || '分镜.json');
  outPath ??= path.join(dir, cfg.timeline || 'timeline.js');
}
if (!subsPath || !sbPath || !outPath) die('用法：node 生成timeline.mjs <作品目录>，或 --subs 字幕.json --storyboard 分镜.json -o timeline.js');
for (const f of [subsPath, sbPath]) if (!fs.existsSync(f)) die(`找不到 ${f}`);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`${f} 不是合法的 JSON：${e.message}`); } };
const subs = read(subsPath), sb = read(sbPath);

// ---------- 字幕 ----------
if (!Array.isArray(subs.cues) || !subs.cues.length) die(`${subsPath} 里没有 cues（字幕条）`);
if (!Array.isArray(subs.chars) || !subs.chars.length) die(`${subsPath} 里没有 chars（字级时间）`);
const duration = +(sb.duration ?? subs.duration);
if (!(duration > 0)) die('不知道时长：分镜.json 或 字幕.json 里要有 duration（秒）');
const cues = subs.cues.map((c, i, a) => {
  const show = c.show ?? Math.max(0, c.start - 0.05);
  const next = a[i + 1];
  let hide = c.hide ?? (next ? (next.show ?? Math.max(0, next.start - 0.05)) : duration);
  if (!next && hide < duration) hide = duration;   // v1.3：分镜.json 的 duration 比口播长（片尾多停一会儿）时，最后一条字幕留到片尾
  return { id: c.id ?? i + 1, text: c.text, start: c.start, end: c.end, show: +show.toFixed(3), hide: +hide.toFixed(3) };
});
cues.forEach((c, i) => { if (i && c.show < cues[i - 1].show) die(`字幕第 ${c.id} 条的时间比上一条早，检查 字幕.json`); });

// ---------- 镜头（没写 shots 时按句子自动分：每个句子一个镜头，给快速试渲用） ----------
let shots = sb.shots;
if (!Array.isArray(shots) || !shots.length) {
  const groups = Array.isArray(subs.sentences) && subs.sentences.length ? subs.sentences.map((s) => s.cues) : cues.map((c) => [c.id]);
  shots = groups.map((ids, k) => ({ id: k + 1, cues: ids, title: ids.map((id) => cues.find((c) => c.id === id)?.text || '').join('') }));
  console.log(`  分镜.json 里没有 shots，按句子自动分了 ${shots.length} 个镜头（只适合试渲，正式做要自己写分镜）`);
}
shots = shots.map((s, k) => {
  const cs = (s.cues || []).map((id) => cues.find((c) => c.id === id)).filter(Boolean);
  const start = s.start ?? (k === 0 ? 0 : cs[0]?.show);
  const end = s.end ?? (k === shots.length - 1 ? duration : undefined);
  return { id: s.id ?? k + 1, start, end, title: s.title || '', cues: s.cues || [], keywords: s['关键字'] || s.keywords || [],
    ...(s['要讲清'] ? { 要讲清: s['要讲清'] } : {}), ...(s['运动设想'] ? { 运动设想: s['运动设想'] } : {}) };
});
shots.forEach((s, k) => { if (s.end === undefined) s.end = shots[k + 1]?.start ?? duration; });
shots.forEach((s, k) => {
  if (!(s.start >= 0) || !(s.end > s.start)) die(`镜头 ${s.id} 的起止不对：${s.start}–${s.end}`);
  if (k && Math.abs(s.start - shots[k - 1].end) > 0.02) console.log(`  注意：镜头 ${shots[k - 1].id} 结束 ${shots[k - 1].end} 和镜头 ${s.id} 开始 ${s.start} 没接上`);
});
if (Math.abs(shots[shots.length - 1].end - duration) > 0.05) console.log(`  注意：最后一个镜头到 ${shots[shots.length - 1].end} 秒结束，片长 ${duration} 秒`);

// ---------- 关键词时间：在指定字幕条（不写 cue 就在全文）里按字找短语，取第一个字的起点、最后一个字的终点 ----------
function findPhrase(phrase, cueId, nth = 1) {
  const cs = cueId ? subs.chars.filter((c) => c.cue === cueId) : subs.chars;
  let hit = 0;
  for (let i = 0; i < cs.length; i++) {
    let s = '';
    for (let j = i; j < cs.length; j++) {
      s += cs[j].text;
      if (s === phrase) { if (++hit === nth) return { start: cs[i].start, end: cs[j].end }; break; }
      if (!phrase.startsWith(s)) break;
    }
  }
  return null;
}
const marks = {};
for (const m of sb.marks || []) {
  const phrase = m.phrase || m.name;
  const found = findPhrase(phrase, m.cue, m.nth || 1);
  if (!found) {
    const where = m.cue ? `第 ${m.cue} 条字幕「${cues.find((c) => c.id === m.cue)?.text ?? '（没有这条）'}」` : '全文';
    die(`关键词「${m.name}」：${where}里找不到「${phrase}」${m.nth > 1 ? `的第 ${m.nth} 次` : ''}（字级时间里英文词算一个字，例如 Token、AI）`);
  }
  marks[m.name] = found;
}
// 各镜头的「时间点」（这个镜头要卡点的关键词）只给人看、不进 TL；名字要在 marks 里，不在就提醒（v1.1）
for (const s of Array.isArray(sb.shots) ? sb.shots : []) for (const k of s['时间点'] || [])
  if (!Object.prototype.hasOwnProperty.call(marks, k)) console.log(`  注意：镜头 ${s.id ?? '?'} 的时间点「${k}」不在 marks 里（marks 漏写了，或者名字写得不一样）`);

// ---------- 全片固定上色的词（强调色 A/B）和字幕里要强调的词 ----------
const hl = (sb['高亮'] || []).map((h, i) => (typeof h === 'string' ? { text: h, role: i === 0 ? 'A' : 'B' } : { text: h.text, role: h.role || (i === 0 ? 'A' : 'B') }));
const TL = {
  duration, fps: sb.fps || 30, size: sb.size || [1920, 1080],
  title: sb['标题'] || '',
  text: subs.text || cues.map((c) => c.text).join(''),
  cues, chars: subs.chars, shots, marks,
  highlights: hl,
  emphasis: sb['字幕强调'] || [],
  assets: sb['素材'] ?? null,
  // Token 例子专用的老字段（新内容里是 null）
  example: sb['例句'] ? { text: sb['例句'], tokens: sb['例句切分'] || [] } : null,
  data: sb['数据样例'] ? sb['数据样例']['句子'] : null,
};

const js = `// 自动生成，不要手改：改 字幕.json 或 分镜.json 后重跑 node 生成timeline.mjs <作品目录>
// 页面里用 <script src="timeline.js"></script> 引入（和页面放在同一个文件夹），得到 window.TL。时间单位秒。
window.TL = ${JSON.stringify(TL, null, 1)};
(function (TL) {
  // 当前该显示的字幕（按 show/hide），没有返回 null
  TL.cueAt = function (t) { for (const c of TL.cues) if (t >= c.show && t < c.hide) return c; return null; };
  // 当前镜头
  TL.shotAt = function (t) { for (const s of TL.shots) if (t >= s.start && t < s.end) return s; return TL.shots[TL.shots.length - 1]; };
  // 关键词开始说的时间，例如 TL.mark('Token')；TL.markEnd('Token') 是说完的时间；没有这个词会抛错，不确定时先 TL.has('词')
  TL.has = function (name) { return Object.prototype.hasOwnProperty.call(TL.marks, name); };
  TL.mark = function (name) { const m = TL.marks[name]; if (!m) throw new Error('TL.marks 里没有 ' + name); return m.start; };
  TL.markEnd = function (name) { const m = TL.marks[name]; if (!m) throw new Error('TL.marks 里没有 ' + name); return m.end; };
})(window.TL);
`;
fs.writeFileSync(outPath, js);
console.log(`已写 ${outPath}`);
console.log(`  片长 ${duration} 秒，字幕 ${cues.length} 条，镜头 ${shots.length} 个，关键词 ${Object.keys(marks).length} 个${hl.length ? '，固定上色 ' + hl.map((h) => h.text + '=' + h.role).join('、') : ''}`);
for (const [k, v] of Object.entries(marks)) console.log(`  ${k.padEnd(10)} ${v.start.toFixed(2)}–${v.end.toFixed(2)}`);
