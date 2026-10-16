// 动效部件.js（v1.2，v1.3 加了 resetCtx、iris、sweep）：7 套模板都能调的转场和次要动作。画面只由 t 决定，随机都按种子 / 帧号算，可以逐帧截图。
// 为什么有它、什么时候用哪个：knowledge/动效和画面变化.md（第三节转场表、第六节手法、第八节本文件）。
//
// 怎么接（新建作品.mjs 会把本文件复制进作品目录；7 套 模板.html 已经写好了接口）：
//   <script src="动效部件.js"></script>     模板里紧跟在 timeline.js 后面
//   function fxBefore(t) {}                  画场景之前调，镜头变换已经设好：在这里叠镜头类（推移 push、慢推 zoom、整体抖 jitter）
//   function fxAfter(t) {}                   场景画完、页眉字幕之前调，变换已复位：在这里盖转场（glitch、erase、pageTurn、paperCover）和粒子 particles
//   两个函数默认是空的，不写就什么都不做，画面和 v1.1 一模一样。全局只多一个对象 window.动效，不和模板里的变量撞名。
//
// 例（黑底科技模板里，每次换镜头故障撕裂 + 一直飘光点）：
//   const CUTS = TL.shots.slice(1).map((s) => s.start);
//   function fxAfter(t) { 动效.particles(g, t, { kind: '光点', n: 40, color: '#e5cf95' }); 动效.glitch(g, t, CUTS); }
// 例（手绘笔记模板里，换镜头整屏推走）：
//   function fxBefore(t) { const p = 动效.push(t, CUTS); if (p) 动效.shift(g, p, C.paper); }
//
// 函数一览（x = 画布 2d 上下文，t = 秒，cuts = 换场时刻数组；o = 选项，都有默认值）：
//   转场  glitch(x,t,cuts,o) 故障撕裂 | erase(x,t,cuts,o) 黑板擦擦掉 | pageTurn(x,t,cuts,o) 翻页 | paperCover(x,t,cuts,o) 纸片掉落盖满再掉走
//         push(t,cuts,o) → {dx,dy} 推移量，配 shift(x,p,fill) 用
//   进场  paperDrop(x,t,t0,draw,o) 纸片掉落（draw(x) 在原点画这片纸，可用 paper(x,key,w,h,color) 画撕边纸）| neonText(x,t,text,cx,cy,times,o) 灯管字逐字通电
//   次要  particles(x,t,o) 粒子（光点 / 雨 / 纸屑 / 粉笔灰）| sway(t,ph,o) 呼吸摇摆 | blink(t,o) 闪烁 | jitter(t,i,o) 定格抖动
//   v1.3  resetCtx(x) 每帧开头把画布状态整套复位（防「画面跟 seek 先后有关」）| iris(x,t,cuts,o) 圆形遮罩收拢再张开 |
//         sweep(x,t,cuts,o) 几条色块横扫盖满再扫走；这两个都可以用 o.area = [x,y,w,h] 只盖一块（例如不盖页眉、字幕带）
//   别的  zoom(t,t0,o) 慢推倍数 | shake(t,t0,o) 震屏量 | anticipate(p,o) 预备 | ease 缓动 | bloom(x,o) 泛光 | scan(x,o) 扫描线和暗角
(() => {
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const prog = (t, t0, d) => clamp((t - t0) / d);
  const ease = {
    linear: (p) => p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inCubic: (p) => p * p * p,
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p, s = 1.5) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2),
  };
  const hash = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  const near = (t, cuts, a, b = a) => { for (const c of cuts || []) if (t >= c - a && t <= c + b) return c; return null; };
  const tmp = {};
  const canvasOf = (k, w, h) => {
    let c = tmp[k]; if (!c || c.width !== w || c.height !== h) { c = tmp[k] = document.createElement('canvas'); c.width = w; c.height = h; }
    return c;
  };

  // 故障撕裂：切点前后 o.d 秒，把当前画面切成横带左右错开 + 重影 + 色块（第 3 组不用 skill 霓虹版 post.js）
  function glitch(x, t, cuts, o = {}) {
    const d = o.d ?? 0.14, c = near(t, cuts, d); if (c === null) return;
    const a = 1 - Math.abs(t - c) / d, W = x.canvas.width, H = x.canvas.height, T = canvasOf('glitch', W, H), tx = T.getContext('2d');
    tx.setTransform(1, 0, 0, 1, 0, 0); tx.clearRect(0, 0, W, H); tx.drawImage(x.canvas, 0, 0);
    const f = Math.floor(t * 30), cols = o.colors || ['#ff2bd6', '#00f0ff'], amp = (o.dx ?? 170) * a;
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.filter = 'none';
    for (let i = 0; i < (o.bands ?? 10); i++) {
      const y = hash(f * 13 + i) * H, h = 10 + hash(f * 7 + i) * 90, dx = (hash(f * 3 + i) - 0.5) * 2 * amp;
      x.drawImage(T, 0, y, W, h, dx, y, W, h);
    }
    x.globalCompositeOperation = 'screen'; x.globalAlpha = 0.4 * a; x.drawImage(T, 16 * a, 0);
    x.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 5; i++) {
      x.fillStyle = cols[i % cols.length]; x.globalAlpha = 0.3 * a;
      x.fillRect(hash(f + i * 5) * W, hash(f * 2 + i) * H, 80 + hash(f + i) * 420, 4 + hash(f * 5 + i) * 14);
    }
    x.restore();
  }

  const paintFill = (x, fill, W, H) => {
    if (fill && fill.width) x.drawImage(fill, 0, 0, W, H); else { x.fillStyle = fill; x.fillRect(0, 0, W, H); }
  };
  // 擦除：切点前 o.pre 秒，板擦从左往右把画面擦回底（o.fill：颜色 / pattern / 底图画布），切点时整屏是空底，
  // 新镜头接着一笔笔写出来；擦除边带波浪、留一点粉笔灰（第 2 组不用 skill 粉笔版 scenes.py、frameutil.py）
  function erase(x, t, cuts, o = {}) {
    const pre = o.pre ?? 0.45, post = o.post ?? 0.25, c = near(t, cuts, pre, post); if (c === null) return;
    const W = x.canvas.width, H = x.canvas.height, dust = o.dust ?? '#efeee4';
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.filter = 'none';
    if (t >= c) {   // 切点之后：只剩一层慢慢散掉的粉笔灰
      x.globalAlpha = 0.045 * (1 - prog(t, c, post)); x.fillStyle = dust;
      for (let i = 0; i < 6; i++) x.fillRect(0, (hash(i + c) * 0.8 + 0.1) * H, W, 30 + 40 * hash(i * 3 + c));
      x.restore(); return;
    }
    const p = prog(t, c - pre, pre), ex = -120 + (W + 240) * ease.inOutCubic(p);
    x.beginPath(); x.moveTo(0, 0);
    for (let y = 0; y <= H; y += 20) x.lineTo(ex - 60 - 40 * Math.sin(y / 50), y);
    x.lineTo(0, H); x.closePath(); x.save(); x.clip();
    paintFill(x, o.fill ?? '#2f4a3d', W, H);
    x.globalAlpha = 0.045; x.fillStyle = dust;
    for (let i = 0; i < 6; i++) x.fillRect(0, (hash(i + c) * 0.8 + 0.1) * H, W, 30 + 40 * hash(i * 3 + c));
    x.restore();
    if (o.tool !== false) eraserAt(x, ex, H * 0.42 + 160 * Math.sin(p * Math.PI * 5));
    x.restore();
  }
  function eraserAt(x, cx, cy) {   // 黑板擦：木头背 + 灰毡面 + 影子
    x.save(); x.globalAlpha = 1;
    x.fillStyle = 'rgba(0,0,0,0.3)'; x.beginPath(); x.roundRect(cx - 84, cy - 24, 194, 80, 14); x.fill();
    x.fillStyle = '#805634'; x.strokeStyle = '#543620'; x.lineWidth = 3;
    x.beginPath(); x.roundRect(cx - 95, cy - 40, 190, 52, 12); x.fill(); x.stroke();
    x.fillStyle = '#686870'; x.beginPath(); x.roundRect(cx - 95, cy + 4, 190, 38, 8); x.fill();
    x.strokeStyle = 'rgba(150,150,156,0.47)'; x.lineWidth = 2;
    for (let k = 0; k < 5; k++) { x.beginPath(); x.moveTo(cx - 85, cy + 14 + k * 6); x.lineTo(cx + 85, cy + 14 + k * 6); x.stroke(); }
    x.restore();
  }
  // 翻页：一张纸从右往左扫过去，切点时整屏被盖住（这一刻换内容），然后露出新镜头。o.paper 纸色，o.d 总时长
  function pageTurn(x, t, cuts, o = {}) {
    const d = o.d ?? 0.6, c = near(t, cuts, d / 2); if (c === null) return;
    const W = x.canvas.width, H = x.canvas.height, s = ease.inOutCubic(prog(t, c - d / 2, d));
    const L = W + 220 - s * (2 * W + 900), R = L + W + 440;
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.filter = 'none';
    const sh = x.createLinearGradient(L - 110, 0, L - 50, 0);   // 纸在画面上投的影
    sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.3)');
    x.fillStyle = sh; x.fillRect(L - 110, 0, 60, H);
    x.beginPath(); x.moveTo(L - 160, 0); x.lineTo(R - 160, 0); x.lineTo(R + 60, H); x.lineTo(L + 60, H); x.closePath();
    x.fillStyle = o.paper ?? '#efe7d6'; x.fill(); x.save(); x.clip();
    const fold = x.createLinearGradient(L - 50, 0, L + 110, 0);   // 翻起来那条边的明暗
    fold.addColorStop(0, 'rgba(0,0,0,0.22)'); fold.addColorStop(0.3, 'rgba(255,255,255,0.35)'); fold.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = fold; x.fillRect(L - 160, 0, 300, H);
    x.restore(); x.restore();
  }

  // 撕边纸片的多边形：每条边每 40 像素一个点，往里外抖 ±o.tear 像素（按种子，一次算好缓存）
  const polys = {};
  function tornRect(key, w, h, tear = 6) {
    if (polys[key]) return polys[key];
    const pts = [], seed = key.length * 7.7 + [...key].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const edge = (x0, y0, x1, y1, nx, ny, k) => {
      const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 40));
      for (let i = 0; i < n; i++) { const u = i / n, j = (hash(seed + k * 31 + i * 1.7) - 0.5) * 2 * tear; pts.push([x0 + (x1 - x0) * u + nx * j, y0 + (y1 - y0) * u + ny * j]); }
    };
    edge(-w / 2, -h / 2, w / 2, -h / 2, 0, 1, 1); edge(w / 2, -h / 2, w / 2, h / 2, 1, 0, 2);
    edge(w / 2, h / 2, -w / 2, h / 2, 0, 1, 3); edge(-w / 2, h / 2, -w / 2, -h / 2, 1, 0, 4);
    return (polys[key] = pts);
  }
  function fillPoly(x, pts, dx = 0, dy = 0) {
    x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo(px + dx, py + dy) : x.moveTo(px + dx, py + dy))); x.closePath(); x.fill();
  }
  // 一片撕边纸：底色 + 偏右下的暖棕投影（第 1 组不用 skill 剪纸版 piece.py 的做法，投影不用灰黑）
  function paper(x, key, w, h, color, o = {}) {
    const pts = tornRect(key, w, h, o.tear ?? 6);
    x.fillStyle = o.shadow ?? 'rgba(70,45,25,0.32)'; fillPoly(x, pts, 6, 9);
    x.fillStyle = color; fillPoly(x, pts);
  }

  // 纸片掉落盖满再掉走（转场）：切点前 o.pre 秒一片片掉下来盖满画面，切点换内容，之后 o.post 秒一片片掉出画面
  function paperCover(x, t, cuts, o = {}) {
    const pre = o.pre ?? 0.4, post = o.post ?? 0.45, c = near(t, cuts, pre, post); if (c === null) return;
    const W = x.canvas.width, H = x.canvas.height, cols = o.cols ?? 4, rows = o.rows ?? 3;
    const colors = o.colors || ['#e9dcc3', '#d9c4a0', '#c96f4a', '#e3b04b', '#7a9e7e', '#d98b8b'];
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.filter = 'none';
    for (let k = 0; k < cols * rows; k++) {
      const i = k % cols, j = Math.floor(k / cols), dl = hash(k * 3.3 + c) * 0.15;
      const p = prog(t, c - pre + dl, pre - 0.15), q = prog(t, c + dl, post - 0.15);
      if (p <= 0 || q >= 1) continue;
      const dir = hash(k + 0.5) > 0.5 ? 1 : -1, r0 = (hash(k * 1.9) - 0.5) * 0.14;
      const y = (j + 0.5) * H / rows - (H + 300) * (1 - ease.outBack(p, 1.2)) + (H + 400) * ease.inCubic(q);
      x.save(); x.translate((i + 0.5) * W / cols + (hash(k * 5.1) - 0.5) * 40, y);
      x.rotate(r0 + dir * ((1 - p) * 0.2 + q * 0.45));
      paper(x, 'cover' + k, W / cols + 130, H / rows + 130, colors[(k * 7 + j) % colors.length], o);
      x.restore();
    }
    x.restore();
  }
  // 纸片掉落（进场）：从 t0 起 o.d 秒，从上方 o.h 像素掉到 (o.x, o.y)，落地前转 o.rot 度回正；o.t1 之后掉出画面。
  // draw(x) 在原点画这片纸（可以用 动效.paper）。一组纸片拼标题时 t0 一个比一个晚 0.08–0.12 秒
  function paperDrop(x, t, t0, draw, o = {}) {
    const p = prog(t, t0, o.d ?? 0.45), q = o.t1 === undefined ? 0 : prog(t, o.t1, o.dOut ?? 0.35);
    if (t < t0 || q >= 1) return;
    x.save(); x.translate(o.x ?? 0, (o.y ?? 0) - (o.h ?? 750) * (1 - ease.outBack(p, 1.2)) + 900 * ease.inCubic(q));
    x.rotate(((o.rot ?? 8) * (1 - p) + 25 * q) * Math.PI / 180); draw(x); x.restore();
  }

  // 推移：切点前 o.d/2 秒旧内容加速推出画面，切点后新内容从另一边减速推进来。返回 {dx, dy}（不在转场里返回 null）
  // o.dir：'left'（默认，往左推）/ 'right' / 'up' / 'down'。配 shift(x, p) 在 fxBefore 里用；背景画在场景之前就不跟着动
  function push(t, cuts, o = {}) {
    const h = (o.d ?? 0.5) / 2, c = near(t, cuts, h); if (c === null) return null;
    const dir = o.dir ?? 'left', W = o.W ?? 1920, H = o.H ?? 1080, k = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    const m = t < c ? ease.inCubic(prog(t, c - h, h)) : -(1 - ease.outCubic(prog(t, c, h)));
    return { dx: k[0] * W * m, dy: k[1] * H * m };
  }
  // 在屏幕坐标里平移当前变换（不受镜头缩放影响）；fill 给了就先把整屏涂成底（背景也跟着推时用）
  function shift(x, p, fill) {
    if (!p) return;
    const m = x.getTransform();
    if (fill !== undefined) { x.save(); x.setTransform(1, 0, 0, 1, 0, 0); paintFill(x, fill, x.canvas.width, x.canvas.height); x.restore(); }
    x.setTransform(new DOMMatrix().translateSelf(p.dx, p.dy).multiplySelf(m));
  }

  // 灯管字逐字通电：先画暗的灯管轮廓；第 i 个字从 times[i] 起 o.d 秒乱闪（亮 / 暗 两次），然后常亮，偶尔再闪一下。
  // times：每个字的通电时刻数组（用 TL.chars 里这几个字的 start），或一个数 t0（之后每字晚 o.step 秒）。
  // 单个字小面积闪；整块招牌别一起闪（通用规则第六节：1 秒内闪不超过 3 次）。第 3 组不用 skill 霓虹版 s3.js
  function neonText(x, t, text, cx, cy, times, o = {}) {
    const chars = [...text], size = o.size ?? 160, col = o.color ?? '#ff3fa4', d = o.d ?? 0.3;
    const tt = Array.isArray(times) ? times : chars.map((_, i) => times + i * (o.step ?? 0.12));
    x.save(); x.font = `${o.weight ?? 900} ${size}px ${o.family ?? '"PingFang SC", "Hiragino Sans GB", sans-serif'}`;
    x.textBaseline = 'middle'; x.textAlign = 'left';
    const ws = chars.map((ch) => x.measureText(ch).width), gap = o.gap ?? size * 0.08;
    let px = o.align === 'left' ? cx : cx - (ws.reduce((s, w) => s + w, 0) + gap * (chars.length - 1)) / 2;
    chars.forEach((ch, i) => {
      x.globalAlpha = 1; x.shadowBlur = 0; x.lineWidth = Math.max(1.5, size / 70); x.strokeStyle = o.off ?? 'rgba(150,80,170,0.4)';
      x.strokeText(ch, px, cy);
      const k = (t - (tt[i] ?? 1e9)) / d;
      const a = k < 0 ? 0 : k < 1 ? [1, 0.12, 1, 0.12, 0.7, 1][Math.floor(k * 6)] : (hash(Math.floor(t * 20) + i * 13) > 1 - (o.flick ?? 0.015) ? 0.45 : 1);
      if (a > 0) {
        x.globalAlpha = a; x.shadowColor = col; x.shadowBlur = o.glow ?? size * 0.45; x.fillStyle = col; x.fillText(ch, px, cy);
        x.shadowBlur = size * 0.1; x.fillStyle = o.core ?? 'rgba(255,255,255,0.7)'; x.fillText(ch, px, cy);
      }
      px += ws[i] + gap;
    });
    x.restore();
  }

  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const sprites = {};
  function glowDot(col) {   // 柔光点贴图（每种颜色只画一次）；颜色要写成 #rrggbb
    if (sprites[col]) return sprites[col];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const cx = c.getContext('2d'), r = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, rgba(col, 1)); r.addColorStop(0.3, rgba(col, 0.55)); r.addColorStop(1, rgba(col, 0));
    cx.fillStyle = r; cx.fillRect(0, 0, 64, 64); return (sprites[col] = c);
  }
  // 粒子（次要动作）：o.kind = '光点'（往上飘、会闪的柔光点）/ '雨'（斜雨丝）/ '纸屑'（翻转飘落的小纸片）/ '粉笔灰'（往下落的小白点）
  // o.n 个数、o.color（#rrggbb 或数组）、o.area [x0,y0,x1,y1]（默认整屏去掉底部 180 像素字幕区）、o.alpha、o.seed
  function particles(x, t, o = {}) {
    const kind = o.kind ?? '光点', W = x.canvas.width, H = x.canvas.height, [x0, y0, x1, y1] = o.area ?? [0, 0, W, H - 180];
    const def = { 纸屑: ['#c96f4a', '#e3b04b', '#7a9e7e', '#d98b8b'], 雨: '#a0c8ff', 粉笔灰: '#efeee4', 光点: '#ffffff' };
    const cols = [].concat(o.color ?? def[kind] ?? '#ffffff'), n = o.n ?? 40, s0 = o.seed ?? 1, aw = x1 - x0, ah = y1 - y0;
    const mod = (v, m) => ((v % m) + m) % m;
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.beginPath(); x.rect(x0, y0, aw, ah); x.clip();
    for (let i = 0; i < n; i++) {
      const h1 = hash(s0 * 101 + i * 1.31), h2 = hash(s0 * 37 + i * 2.17), h3 = hash(s0 * 53 + i * 3.71), col = cols[i % cols.length];
      if (kind === '雨') {
        const y = y0 + mod(h1 * ah + (900 + 600 * h2) * t, ah + 60) - 30, px = x0 + mod(h3 * aw * 1.3 - y * 0.12, aw);
        x.globalAlpha = o.alpha ?? 0.18; x.strokeStyle = col; x.lineWidth = 1.5;
        x.beginPath(); x.moveTo(px, y); x.lineTo(px - 5, y + 38); x.stroke();
      } else if (kind === '纸屑') {
        const y = y0 + mod(h1 * ah + (60 + 60 * h2) * t, ah + 40) - 20, px = x0 + h3 * aw + 30 * Math.sin(1.3 * t + i), s = 8 + 8 * h2;
        x.save(); x.translate(px, y); x.rotate((1 + 2 * h3) * t + i); x.scale(1, Math.cos(2.2 * t + i));
        x.globalAlpha = o.alpha ?? 0.9; x.fillStyle = col; x.fillRect(-s / 2, -s / 4, s, s / 2); x.restore();
      } else {   // 光点往上飘、粉笔灰往下落
        const glow = kind === '光点', v = (glow ? 12 : 8) + 18 * h2, r = glow ? 3 + 6 * h3 : 1 + 2 * h3;
        const y = y0 + mod(h1 * ah + (glow ? -v : v) * t, ah), px = x0 + mod(h3 * aw + 20 * Math.sin(0.5 * t + i * 1.7), aw);
        x.globalAlpha = (o.alpha ?? (glow ? 0.6 : 0.25)) * (0.55 + 0.45 * Math.sin(1.3 * t + i * 2.3));
        if (glow) x.drawImage(glowDot(col), px - r * 3, y - r * 3, r * 6, r * 6);
        else { x.fillStyle = col; x.beginPath(); x.arc(px, y, r, 0, Math.PI * 2); x.fill(); }
      }
    }
    x.restore();
  }

  // 定格抖动：t 量化到每秒 o.fps 张（默认 15），每一格按格号和 i（第几个东西）带种子抖一点。返回 {t, dx, dy, r}
  // 用法：const j = 动效.jitter(t, 3); 位置用 j.t 算，画之前 translate(j.dx, j.dy)、rotate(j.r)
  function jitter(t, i = 0, o = {}) {
    const fps = o.fps ?? 15, k = Math.floor(t * fps + 1e-6), a = o.amp ?? 1.5, r = (o.rot ?? 0.6) * Math.PI / 180;
    return { t: k / fps, dx: (hash(k * 7.1 + i * 13.3) - 0.5) * 2 * a, dy: (hash(k * 3.7 + i * 5.9) - 0.5) * 2 * a, r: (hash(k * 1.3 + i * 9.1) - 0.5) * 2 * r };
  }
  // 呼吸 / 摇摆（次要动作）：返回 {dy, r, s}，ph 每个东西给不同的数。默认上下 3 像素、转 1 度、缩放 1%
  function sway(t, ph = 0, o = {}) {
    return { dy: (o.dy ?? 3) * Math.sin(2.3 * t + ph), r: (o.deg ?? 1) * Math.PI / 180 * Math.sin(1.7 * t + ph), s: 1 + (o.breath ?? 0.01) * Math.sin(2.3 * t + ph * 1.3) };
  }
  // 闪烁：返回 0–1。o.period 秒一次（默认 1，REC 灯、光标），o.duty 亮的比例；o.smooth 为 true 时是柔和明暗（星星）
  function blink(t, o = {}) {
    const p = o.period ?? 1, u = (((t + (o.ph ?? 0)) % p) + p) % p / p;
    return o.smooth ? 0.5 + 0.5 * Math.cos(u * Math.PI * 2) : (u < (o.duty ?? 0.5) ? 1 : 0);
  }
  // 慢推：镜头开始 t0 后每秒放大 o.rate（默认 1.2%），o.max 秒封顶（默认 5）。返回倍数
  const zoom = (t, t0, o = {}) => 1 + (o.rate ?? 0.012) * clamp(t - t0, 0, o.max ?? 5);
  // 震屏：t0 起 o.d 秒（默认 0.2），幅度 o.amp 像素（默认 12）衰减。返回 {dx, dy}，在 fxBefore 里 shift(x, 它)
  function shake(t, t0, o = {}) {
    const d = o.d ?? 0.2; if (t < t0 || t > t0 + d) return { dx: 0, dy: 0 };
    const f = Math.floor(t * 30), a = (o.amp ?? 12) * Math.pow(1 - (t - t0) / d, 2);
    return { dx: (hash(f) - 0.5) * 2 * a, dy: (hash(f + 0.7) - 0.5) * 2 * a };
  }
  // 预备：把 0–1 的进度改成「先往反方向退 o.back（默认 8%）再冲过去」，前 o.a（默认 0.2）的时间用来预备
  function anticipate(p, o = {}) {
    const a = o.a ?? 0.2, b = o.back ?? 0.08;
    return p <= 0 ? 0 : p < a ? -b * Math.sin(Math.PI * p / a) : ease.outCubic((p - a) / (1 - a));
  }
  // 泛光：整帧缩到 1/4 模糊后 lighter 叠回去（霓虹、黑底科技）。放在 fxAfter 最后、字幕之前
  function bloom(x, o = {}) {
    const W = x.canvas.width, H = x.canvas.height, w = W / 4, h = H / 4, B = canvasOf('bloom', w, h), b = B.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0); b.filter = 'none'; b.clearRect(0, 0, w, h);
    b.filter = `blur(${o.blur ?? 5}px)`; b.drawImage(x.canvas, 0, 0, w, h); b.filter = 'none';
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.globalCompositeOperation = 'lighter'; x.globalAlpha = o.alpha ?? 0.45;
    x.drawImage(B, 0, 0, W, H); x.restore();
  }
  // 扫描线 + 暗角：一张画布只画一次，每帧盖一下（霓虹、黑底科技）
  function scan(x, o = {}) {
    const W = x.canvas.width, H = x.canvas.height, gap = o.gap ?? 4, al = o.alpha ?? 0.2, vg = o.vignette ?? 0.7;
    const S = canvasOf(`scan${gap}_${al}_${vg}`, W, H);
    if (!S.done) {
      const s = S.getContext('2d'); s.fillStyle = `rgba(0,0,0,${al})`;
      for (let y = 0; y < H; y += gap) s.fillRect(0, y, W, gap / 2);
      const r = s.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
      r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, `rgba(0,0,0,${vg})`); s.fillStyle = r; s.fillRect(0, 0, W, H);
      S.done = true;
    }
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.drawImage(S, 0, 0); x.restore();
  }

  // v1.3：每帧开头调一次，把画布状态整套复位。上一帧留下的 lineCap / lineJoin / setLineDash / globalAlpha / 阴影……
  // 会漏到下一帧，按时间顺序出片看不出来，单独出静帧或倒着 seek 就不一样（立体卡通、黑底科技、复古报刊的旧示例页都踩过）。
  // 离屏画布如果每帧重画，也要对它调一次。检查：node render.mjs <页面> --check-determinism auto
  function resetCtx(x) {
    if (typeof x.reset === 'function') x.reset();   // Chrome 99 起有；会清空画布
    else { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, x.canvas.width, x.canvas.height); }
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
    x.lineCap = 'butt'; x.lineJoin = 'miter'; x.miterLimit = 10; x.lineWidth = 1; x.setLineDash([]); x.lineDashOffset = 0;
    x.shadowBlur = 0; x.shadowColor = 'rgba(0,0,0,0)'; x.shadowOffsetX = 0; x.shadowOffsetY = 0;
    x.textAlign = 'start'; x.textBaseline = 'alphabetic'; x.imageSmoothingEnabled = true; x.fillStyle = '#000'; x.strokeStyle = '#000';
  }
  const areaOf = (x, o) => o.area || [0, 0, x.canvas.width, x.canvas.height];

  // v1.3 圆形遮罩：切点前 o.pre 秒圆从大收到 0（圆外填 o.fill），切点后 o.post 秒再从 0 张开；圆心 o.cx / o.cy（默认区域中心）
  // 适合扁平流程图、扁平插画、立体卡通、黏土（知识文件第三节）
  function iris(x, t, cuts, o = {}) {
    const pre = o.pre ?? 0.35, post = o.post ?? 0.35, c = near(t, cuts, pre, post); if (c === null) return;
    const [ax, ay, aw, ah] = areaOf(x, o), cx = o.cx ?? ax + aw / 2, cy = o.cy ?? ay + ah / 2;
    const R = Math.hypot(Math.max(cx - ax, ax + aw - cx), Math.max(cy - ay, ay + ah - cy)) + 4;
    const k = t < c ? 1 - ease.inCubic(prog(t, c - pre, pre)) : ease.outCubic(prog(t, c, post));
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
    x.beginPath(); x.rect(ax, ay, aw, ah); x.arc(cx, cy, Math.max(0, R * k), 0, Math.PI * 2, true);
    x.fillStyle = o.fill ?? '#1a1410'; x.fill('evenodd');
    if (o.ring && k > 0.02 && k < 0.98) { x.beginPath(); x.arc(cx, cy, R * k, 0, Math.PI * 2); x.lineWidth = o.ringWidth ?? 10; x.strokeStyle = o.ring; x.stroke(); }
    x.restore();
  }

  // v1.3 色块横扫：几条颜色的宽带从左往右扫，切点那一刻正好盖满 o.area，切点后接着扫出右边。o.colors 从前到后，o.d 总时长
  // 适合扁平流程图、复古剪纸（彩纸条）、包豪斯、孟菲斯
  function sweep(x, t, cuts, o = {}) {
    const d = o.d ?? 0.66, cols = o.colors || ['#fbbf2f', '#ee8013', '#1a1410'], lag = o.lag ?? 0.12, slant = o.slant ?? 120;
    const L = lag * (cols.length - 1), a = (0.5 + L) / (1 + L);   // 切点落在整段的 a 处：最后一条带正好走到一半（盖满）
    const c = near(t, cuts, d * a, d * (1 - a)); if (c === null) return;
    const [ax, ay, aw, ah] = areaOf(x, o), P = prog(t, c - d * a, d);
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
    x.beginPath(); x.rect(ax, ay, aw, ah); x.clip();
    cols.forEach((col, i) => {   // 每条带：前沿从左边外面走到右边外面；后沿晚 lag，切点时最后一条正好盖满
      const q = ease.inOutCubic(clamp(P * (1 + L) - lag * i, 0, 1));
      const span = aw + slant * 2, head = ax - slant + q * 2 * span, tail = head - span;
      x.beginPath(); x.moveTo(tail, ay + ah); x.lineTo(tail + slant, ay); x.lineTo(head + slant, ay); x.lineTo(head, ay + ah); x.closePath();
      x.fillStyle = col; x.fill();
    });
    x.restore();
  }

  window.动效 = { glitch, erase, pageTurn, paperCover, push, shift, paperDrop, paper, neonText, particles,
    jitter, sway, blink, zoom, shake, anticipate, bloom, scan, ease, hash, clamp, prog, resetCtx, iris, sweep };
})();
