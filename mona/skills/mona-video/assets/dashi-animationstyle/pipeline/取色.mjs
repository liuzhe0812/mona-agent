#!/usr/bin/env node
// 取色：从参考图里取主色（k-means）和指定坐标的颜色，写风格说明时用。只读图片，不改原图。
// 用法：node 取色.mjs <图片> [主色个数=14] [x:y ...]
//   例：node 取色.mjs 参考图.jpg 16 60:40 400:330   → 列出 16 个主色（按面积排序）和两个点的颜色
// 坐标是原图像素坐标（先用 sips -g pixelWidth -g pixelHeight 看尺寸）。gif 取第一帧。
import { execFileSync } from 'node:child_process';

const [, , img, kArg, ...pts] = process.argv;
if (!img) { console.log('用法：node 取色.mjs <图片> [主色个数=14] [x:y ...]'); process.exit(1); }
const K = +kArg || 14;
const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', img], { encoding: 'utf8' }).trim().split(',').map(Number);
const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', img, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
const px = [];
for (let i = 0; i + 2 < raw.length; i += 3 * 3) px.push([raw[i], raw[i + 1], raw[i + 2]]);   // 每 3 个像素取 1 个
let C = Array.from({ length: K }, (_, i) => px[Math.floor((i + 0.5) * px.length / K)].slice());
for (let it = 0; it < 25; it++) {
  const S = C.map(() => [0, 0, 0, 0]);
  for (const p of px) {
    let b = 0, bd = 1e9;
    C.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; b = j; } });
    const s = S[b]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
  }
  C = S.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]] : C[j]));
}
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
console.log(`图片 ${W}×${H}，主色（按面积）：`);
C.sort((a, b) => (b[3] || 0) - (a[3] || 0)).forEach((c) => console.log(`  ${hex(c)}  ${((c[3] || 0) / px.length * 100).toFixed(1)}%`));
for (const p of pts) {
  const [x, y] = p.split(':').map(Number);
  const i = (y * W + x) * 3;
  console.log(`  点 ${x},${y}  ${hex([raw[i], raw[i + 1], raw[i + 2]])}`);
}
