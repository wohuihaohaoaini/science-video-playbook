/* 抗氰呼吸 · 交替途径 —— 全片动画（设计负责人：克拉克）
 *
 * 渲染接口（给 Codex 的管线用）：
 *   await filmReady()          加载字体、照片和配音时长，并建立时间线
 *   renderFrame(t)             把第 t 秒的画面画到 canvas#c 上，纯函数，可以任意顺序调用
 *   window.TIMELINE            { total, refsStart, tempo, lines:[{id,text,scene,start,end}] }
 *   getSfxCues()               [{t, name, gain}] 音效触发点
 *
 * 时间线规则写在 buildTimeline() 里。配音时长从 ../build/vo_durations.json 读取（{"L01": 3.42, ...}），
 * 文件不存在时按每秒 4.6 字估算，只用于预览。
 */
(function () {
'use strict';

const W = 1920, H = 1080, FPS = 30, MIN_TOTAL = 240, REFS_LEN = 16;
let TOTAL = MIN_TOTAL;
const C = { paper: '#F5F4F0', ink: '#111111', grey: '#8A8A8A', light: '#D6D4CE', red: '#E30613' };
// 12 栏网格
const M = 120, TOP = 96, GUT = 24, COLW = 118;
const col = i => M + i * (COLW + GUT);           // 第 i 栏左边线（0 起）
const span = n => n * COLW + (n - 1) * GUT;      // n 栏宽度

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

window.FILM = { width: W, height: H, fps: FPS, duration: TOTAL };

// ───────────────────────── 工具 ─────────────────────────
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, p) => a + (b - a) * p;
const eOut = p => 1 - Math.pow(1 - clamp(p), 4);                    // easeOutQuart
const eIO = p => { p = clamp(p); return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
const pr = (t, a, d) => clamp((t - a) / d);                          // 线性进度
const io = (t, a, d) => eOut(pr(t, a, d));                           // 进场进度
function hash(n) { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); }

function font(size, weight = 400) { return `${weight} ${size}px Inter, NotoSC, "PingFang SC", "Helvetica Neue", sans-serif`; }

function text(s, x, y, o = {}) {
  ctx.save();
  ctx.font = font(o.size || 32, o.weight || 400);
  ctx.fillStyle = o.color || C.ink;
  ctx.globalAlpha *= (o.alpha == null ? 1 : o.alpha);
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.base || 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = (o.ls || 0) + 'px';
  ctx.fillText(s, x, y);
  const w = ctx.measureText(s).width;
  ctx.restore();
  return w;
}
function measure(s, size, weight = 400, ls = 0) {
  ctx.save(); ctx.font = font(size, weight); if ('letterSpacing' in ctx) ctx.letterSpacing = ls + 'px';
  const w = ctx.measureText(s).width; ctx.restore(); return w;
}
// 中英混排按字符折行（英文单词不拆）
function wrap(s, size, weight, maxW) {
  const tokens = s.match(/[A-Za-z0-9₀-₉⁺⁻°.\-]+|\s+|./g) || [];
  const lines = []; let cur = '';
  for (const tk of tokens) {
    const next = cur + tk;
    if (measure(next, size, weight) > maxW && cur.trim()) { lines.push(cur); cur = tk.trimStart(); }
    else cur = next;
  }
  if (cur) lines.push(cur);
  // 避免行首标点
  for (let i = 1; i < lines.length; i++) {
    while (/^[，。；：、！？）」』”]/.test(lines[i])) { lines[i - 1] += lines[i][0]; lines[i] = lines[i].slice(1); }
  }
  return lines;
}
// 逐行上推进场的文本块
function para(s, x, y, o, p) {
  const lines = wrap(s, o.size, o.weight || 400, o.maxW || 800);
  const lh = (o.lh || 1.5) * o.size;
  lines.forEach((ln, i) => {
    const q = eOut(clamp(p * (lines.length + 1) - i));
    text(ln, x, y + i * lh + (1 - q) * 24, Object.assign({}, o, { alpha: (o.alpha == null ? 1 : o.alpha) * q }));
  });
  return lines.length * lh;
}
function rect(x, y, w, h, color, alpha = 1) { ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.fillRect(x, y, w, h); ctx.restore(); }
function strokeRect(x, y, w, h, color, lw = 2, alpha = 1) { ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw); ctx.restore(); }
function circle(x, y, r, color, alpha = 1) { ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
function ring(x, y, r, color, lw = 2, alpha = 1, a0 = 0, a1 = Math.PI * 2) { ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); ctx.restore(); }
function line(x1, y1, x2, y2, color, lw = 2, p = 1, alpha = 1, dash = null) {
  if (p <= 0) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'butt';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(lerp(x1, x2, p), lerp(y1, y2, p)); ctx.stroke(); ctx.restore();
}
function arrowHead(x, y, ang, color, s = 14, alpha = 1) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s, -s * .45); ctx.lineTo(-s, s * .45); ctx.closePath(); ctx.fill(); ctx.restore();
}
function arrow(x1, y1, x2, y2, color, lw = 2, p = 1, alpha = 1) {
  if (p <= 0) return;
  const xe = lerp(x1, x2, p), ye = lerp(y1, y2, p);
  line(x1, y1, xe, ye, color, lw, 1, alpha);
  arrowHead(xe, ye, Math.atan2(y2 - y1, x2 - x1), color, 10 + lw * 2, alpha);
}
// 折线路径：长度、取点、按进度描线
function mkPath(pts) {
  const seg = []; let L = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
  return { pts, seg, L };
}
function pathAt(P, s) {
  s = clamp(s, 0, P.L);
  for (let i = 0; i < P.seg.length; i++) {
    if (s <= P.seg[i] || i === P.seg.length - 1) { const q = P.seg[i] ? s / P.seg[i] : 0; const a = P.pts[i], b = P.pts[i + 1]; return [lerp(a[0], b[0], q), lerp(a[1], b[1], q)]; }
    s -= P.seg[i];
  }
}
function drawPath(P, color, lw, p, alpha = 1, dash = null) {
  if (p <= 0) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'miter';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(P.pts[0][0], P.pts[0][1]);
  let left = P.L * clamp(p);
  for (let i = 0; i < P.seg.length && left > 0; i++) {
    const q = Math.min(1, left / P.seg[i]); const a = P.pts[i], b = P.pts[i + 1];
    ctx.lineTo(lerp(a[0], b[0], q), lerp(a[1], b[1], q)); left -= P.seg[i];
  }
  ctx.stroke(); ctx.restore();
}
function clipRect(x, y, w, h, fn) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); fn(); ctx.restore(); }

// ───────────────────────── 资源 ─────────────────────────
const PHOTOS = { skunk: 'skunk_snow.jpg', helico: 'helicodiceros.jpg', amorpho: 'amorphophallus.jpg', alocasia: 'alocasia.jpg' };
const IMG = {};
let NARR = null, DUR = null;

function loadImg(src, tries = 6) { return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => tries > 1 ? setTimeout(() => loadImg(src, tries - 1).then(res), 200) : res(null); im.src = src; }); }
async function getJSON(u, required = false) {
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) return await r.json(); if (r.status === 404 && !required) return null; } catch (e) {}
    await new Promise(res => setTimeout(res, 150 * (i + 1)));
  }
  if (required) throw new Error('failed to load ' + u);
  return null;
}

// 照片：铺满给定框（object-fit: cover），并转成灰度；焦点 fx, fy ∈ [0,1]
function photo(key, x, y, w, h, o = {}) {
  const im = IMG[key];
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (!im) {
    rect(x, y, w, h, '#BDBBB5');
    text((o.label || key).toUpperCase(), x + 24, y + 48, { size: 20, weight: 500, color: C.ink, ls: 2 });
    text('PHOTO PLACEHOLDER', x + 24, y + 76, { size: 16, color: C.ink, alpha: .6, ls: 2 });
  } else {
    const s = Math.max(w / im.width, h / im.height) * (o.zoom || 1);
    const dw = im.width * s, dh = im.height * s;
    const fx = o.fx == null ? .5 : o.fx, fy = o.fy == null ? .5 : o.fy;
    const dx = x + (w - dw) * fx, dy = y + (h - dh) * fy;
    ctx.filter = 'grayscale(1) contrast(1.12)';
    ctx.drawImage(im, dx, dy, dw, dh);
  }
  ctx.restore();
}

// ───────────────────────── 时间线 ─────────────────────────
const SCENE_OF = {};
const GAP_IN = 0.45, GAP_SCENE = 1.2, GAP_TITLE = 3.4, T0 = 1.0, TAIL = 2.4;

function buildTimeline() {
  const lines = NARR.lines.map(l => {
    const est = l.text.length / 4.6;
    return { id: l.id, text: l.text, scene: l.scene, dur: (DUR && DUR[l.id]) || est, measured: !!(DUR && DUR[l.id]) };
  });
  // 按自然节奏排：句间、场间停顿固定，不压缩；正文不足 224 s 时把停顿拉长到刚好 224 s（总长不少于 4 分钟）
  const gaps = lines.map((l, i) => i === 0 ? 0 : (lines[i - 1].scene === 'S1' && l.scene === 'S3') ? GAP_TITLE : (l.scene === lines[i - 1].scene ? GAP_IN : GAP_SCENE));
  const speech = lines.reduce((a, l) => a + l.dur, 0);
  const fixed = gaps.filter(g => g === GAP_TITLE).length * GAP_TITLE;
  const flex = gaps.reduce((a, b) => a + (b === GAP_TITLE ? 0 : b), 0);
  const minBody = (MIN_TOTAL - REFS_LEN) - TAIL - T0;
  const gScale = Math.max(1, (minBody - speech - fixed) / flex);
  let t = T0;
  lines.forEach((l, i) => {
    const g = gaps[i] * (gaps[i] === GAP_TITLE ? 1 : gScale);
    t += g; l.start = +t.toFixed(3); l.end = +(t + l.dur).toFixed(3); t += l.dur;
  });
  const refsStart = +(t + TAIL).toFixed(3);
  TOTAL = +(refsStart + REFS_LEN).toFixed(3);
  window.FILM.duration = TOTAL;
  return { total: TOTAL, refsStart, tempo: 1, gapScale: +gScale.toFixed(3), lines };
}

let TL, SC = {};
const cue = id => { const l = TL.lines.find(x => x.id === id); return l ? l.start : 0; };
const cueEnd = id => { const l = TL.lines.find(x => x.id === id); return l ? l.end : 0; };

function buildScenes() {
  const first = s => TL.lines.find(l => l.scene === s);
  const lead = 0.5;
  SC.S1 = 0;
  SC.S2 = cueEnd('L04') + 0.45;
  SC.S3 = first('S3').start - 0.7;
  SC.S4 = first('S4').start - lead;
  SC.S5 = first('S5').start - lead;
  SC.S6 = first('S6').start - lead;
  SC.S7 = first('S7').start - lead;
  SC.S8 = first('S8').start - lead;
  SC.S9 = first('S9').start - lead;
  SC.S10 = first('S10').start - lead;
  SC.S11 = TL.refsStart;
  SC.END = TOTAL;
}
const ORDER = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'];

window.filmReady = async function () {
  NARR = await getJSON('../script/narration.json', true);
  DUR = await getJSON('../build/vo_durations.json');
  const ims = await Promise.all(Object.entries(PHOTOS).map(async ([k, f]) => [k, await loadImg('../assets/photos/' + f)]));
  ims.forEach(([k, im]) => { IMG[k] = im; });
  const missing = ims.filter(([, im]) => !im).map(([k]) => k);
  if (missing.length && !/preview/.test(location.search)) throw new Error('photos failed to load: ' + missing.join(','));
  try { await document.fonts.load(font(40, 400) , '抗氰呼吸 ATP'); await Promise.all([400, 500, 700, 900].map(w => document.fonts.load(font(40, w), '抗氰呼吸 Aa'))); } catch (e) {}
  await document.fonts.ready;
  TL = buildTimeline(); buildScenes();
  window.TIMELINE = TL; window.SCENES = SC;
  return TL;
};

// ───────────────────────── 公共版式元素 ─────────────────────────
function header(num, en, zh, t, dark) {
  const a = io(t, 0.1, 0.6);
  const fg = dark ? C.paper : C.ink;
  text(num, col(0), TOP + 18, { size: 18, weight: 700, color: C.red, alpha: a, ls: 1 });
  text(en, col(1), TOP + 18, { size: 18, weight: 500, color: dark ? '#9A9A9A' : C.grey, alpha: a, ls: 3 });
  text(zh, col(4), TOP + 18, { size: 18, weight: 500, color: dark ? '#9A9A9A' : C.grey, alpha: a });
  line(col(0), TOP + 40, col(0) + span(12), TOP + 40, fg, 2, eIO(pr(t, 0, 0.9)), 0.9);
}

function subtitle(t, dark) {
  const l = TL.lines.find(x => t >= x.start - 0.05 && t < x.end + 0.15);
  if (!l) return;
  const a = clamp(Math.min((t - l.start + 0.05) / 0.12, (l.end + 0.15 - t) / 0.12));
  const lines = wrap(l.text, 40, 500, span(10));
  const lh = 58, y0 = H - TOP - (lines.length - 1) * lh;
  rect(col(0), y0 - 38, 6, 40 + (lines.length - 1) * lh, C.red, a);
  lines.forEach((s, i) => text(s, col(0) + 30, y0 + i * lh, { size: 40, weight: 500, color: dark ? C.paper : C.ink, alpha: a }));
}

// 场与场之间：红色细线从左到右划过（配 sweep 音效）
function wipe(t, at, dark) {
  const p = pr(t, at - 0.25, 0.6);
  if (p <= 0 || p >= 1) return;
  const x0 = lerp(-200, W, eIO(p));
  rect(x0, 0, 200, 8, C.red);
}

// ───────────────────────── 电子传递链（S3–S5、S9 共用） ─────────────────────────
const MEM_Y = 560, MEM_H = 64;   // 膜中线与厚度
const CH = {
  nadh: [col(0) + 40, 760], I: [col(2) + 20, MEM_Y], Q: [col(3) + 90, MEM_Y], III: [col(5) + 30, MEM_Y],
  c: [col(6) + 60, MEM_Y - 92], IV: [col(7) + 70, MEM_Y], o2: [col(7) + 70, 790], syn: [col(10) + 40, MEM_Y],
  aox: [col(4) + 40, MEM_Y + 150], o2b: [col(4) + 40, 820]
};
const MAIN = mkPath([CH.nadh, [CH.I[0], 760], CH.I, CH.Q, CH.III, CH.c, CH.IV, CH.o2]);
const BRANCH = mkPath([CH.nadh, [CH.I[0], 760], CH.I, CH.Q, CH.aox, CH.o2b]);
const BR_ONLY = mkPath([CH.Q, CH.aox, CH.o2b]);
const S_Q_MAIN = (() => { let s = 0; for (let i = 0; i < 3; i++) s += MAIN.seg[i]; return s; })();  // 主路到 Q 的长度
const S_IV_MAIN = (() => { let s = 0; for (let i = 0; i < 6; i++) s += MAIN.seg[i]; return s; })();

function membrane(p, dark) {
  const fg = dark ? C.paper : C.ink;
  const x0 = col(0), x1 = col(0) + span(12);
  line(x0, MEM_Y - MEM_H / 2, lerp(x0, x1, p), MEM_Y - MEM_H / 2, fg, 2);
  line(x0, MEM_Y + MEM_H / 2, lerp(x0, x1, p), MEM_Y + MEM_H / 2, fg, 2);
  const a = io(p, .4, .6);
  text('膜间隙', x0, MEM_Y - MEM_H / 2 - 40, { size: 18, weight: 500, color: C.grey, alpha: a, ls: 1 });
  text('基质', x0, MEM_Y + MEM_H / 2 + 52, { size: 18, weight: 500, color: C.grey, alpha: a, ls: 1 });
  text('线粒体内膜', x1, MEM_Y - MEM_H / 2 - 14, { size: 18, weight: 500, color: C.grey, alpha: a, align: 'right' });
}

function complexBox(cx, cy, label, a, o = {}) {
  if (a <= 0) return;
  const w = o.w || 96, h = o.h || 150;
  const y = cy - h / 2 + (1 - a) * 30;
  const fill = o.fill || C.ink, fg = o.fg || C.paper;
  if (o.outline) strokeRect(cx - w / 2, y, w, h, o.outline, 3, a);
  else rect(cx - w / 2, y, w, h, fill, a);
  text(label, cx, y + h / 2 + 12, { size: o.size || 34, weight: 700, color: o.outline ? o.outline : fg, align: 'center', alpha: a });
  if (o.cap) text(o.cap, cx, y - 16, { size: 18, weight: 500, color: o.capColor || C.grey, align: 'center', alpha: a });
}

// 电子：沿路径匀速流动的红点。block = 阻断点（路径长度），被挡住的电子在阻断点前堆积
function electrons(P, t, o = {}) {
  const n = o.n || 9, speed = o.speed || 260, gap = P.L / n;
  const a = o.alpha == null ? 1 : o.alpha;
  for (let i = 0; i < n * 2; i++) {
    let s = ((t * speed) + i * gap) % (P.L + gap * 2) - gap;
    if (s < 0 || s > P.L) continue;
    if (o.block != null && s > o.block - 6) {
      // 堆积：越靠后的电子越密
      const k = Math.floor((s - o.block) / gap);
      s = o.block - 14 - (k % 6) * 20;
      if (s < 0) continue;
    }
    const [x, y] = pathAt(P, s);
    circle(x, y, o.r || 11, o.color || C.red, a);
  }
}

// 质子：从复合体处穿过膜向上跳的 H⁺
function protons(x, t, a, phase = 0, dark) {
  if (a <= 0) return;
  for (let k = 0; k < 2; k++) {
    const q = ((t * 0.55 + phase + k * 0.5) % 1);
    const y = lerp(MEM_Y - 110, MEM_Y - 210, eOut(q));
    const al = a * (q < .8 ? 1 : (1 - q) / .2);
    text('H⁺', x + 58 + k * 10, y, { size: 24, weight: 700, color: dark ? C.paper : C.ink, alpha: al });
  }
}

function synthase(t, a, rate, dark) {
  if (a <= 0) return;
  const [x, y] = CH.syn;
  const fg = dark ? C.paper : C.ink;
  rect(x - 30, y - 70, 60, 140, fg, a);
  circle(x, y + 120, 54, fg, a);
  text('ATP 合酶', x, y - 96, { size: 18, weight: 500, color: C.grey, align: 'center', alpha: a });
  // H⁺ 回流
  for (let k = 0; k < 3; k++) {
    const q = ((t * 0.7 * rate + k / 3) % 1);
    text('H⁺', x - 70, lerp(y - 180, y + 40, q), { size: 22, weight: 700, color: fg, alpha: a * rate * Math.sin(q * Math.PI) });
  }
  text('ADP + Pi → ATP', x + 80, y + 128, { size: 24, weight: 700, color: fg, alpha: a });
}

function chainStatic(t, a, st, dark) {
  const fg = dark ? C.paper : C.ink, bg = dark ? C.ink : C.paper;
  text('NADH', CH.nadh[0] - 10, CH.nadh[1] + 50, { size: 30, weight: 700, color: fg, alpha: a.nadh });
  complexBox(CH.I[0], CH.I[1], 'I', a.I, { fill: fg, fg: bg, cap: '复合体 I' });
  circle(CH.Q[0], CH.Q[1], 30 * a.Q, fg);
  text('Q', CH.Q[0], CH.Q[1] + 11, { size: 30, weight: 700, color: bg, align: 'center', alpha: a.Q });
  text('泛醌', CH.Q[0], CH.Q[1] - 52, { size: 18, weight: 500, color: C.grey, align: 'center', alpha: a.Q });
  const dead = st.dead || 0;   // 0–1 氰化物导致的“失活”
  const cIII = dead > 0 ? C.grey : fg;
  complexBox(CH.III[0], CH.III[1], 'III', a.III, dead > 0.5 ? { outline: C.grey, cap: '复合体 III' } : { fill: fg, fg: bg, cap: '复合体 III' });
  circle(CH.c[0], CH.c[1], 22 * a.c, dead > 0.5 ? C.grey : fg);
  text('c', CH.c[0], CH.c[1] + 8, { size: 24, weight: 700, color: bg, align: 'center', alpha: a.c });
  text('细胞色素 c', CH.c[0], CH.c[1] - 34, { size: 18, weight: 500, color: C.grey, align: 'center', alpha: a.c });
  complexBox(CH.IV[0], CH.IV[1], 'IV', a.IV, dead > 0.5 ? { outline: C.grey, cap: '复合体 IV' } : { fill: fg, fg: bg, cap: '复合体 IV' });
  text('O₂ → H₂O', CH.o2[0] + 20, CH.o2[1] + 12, { size: 30, weight: 700, color: dead > 0.5 ? C.grey : fg, alpha: a.o2 });
}

// ───────────────────────── 各场 ─────────────────────────
function S1(t, T) {
  rect(0, 0, W, H, C.paper);
  // 照片从左向右展开
  const pw = span(7), ph = 640, px = col(0), py = TOP + 70;
  const rev = eIO(pr(t, 0.2, 1.4));
  clipRect(px, py, pw * rev, ph, () => photo('skunk', px, py, pw, ph, { fx: .5, fy: .55, zoom: 1 + 0.04 * (t / 14), label: 'Symplocarpus renifolius' }));
  text('Symplocarpus renifolius', px, py + ph + 36, { size: 20, weight: 500, color: C.grey, alpha: io(t, 1.4, .8) });
  text('臭菘 · 天南星科', px + pw, py + ph + 36, { size: 20, weight: 500, color: C.grey, align: 'right', alpha: io(t, 1.4, .8) });

  const rx = col(8);
  // 读数：L03 时滚动到位
  const c3 = cue('L03') - T;
  const pA = io(t, c3, 1.4), pS = io(t, c3 + 0.6, 1.8);
  text('AIR', rx, 330, { size: 22, weight: 700, color: C.grey, ls: 3, alpha: io(t, c3 - .3, .5) });
  const air = Math.round(lerp(0, -5, pA));
  const airS = (air < 0 ? '−' : '') + Math.abs(air).toFixed(0);
  text(airS, rx, 470, { size: 150, weight: 900, color: C.grey, alpha: io(t, c3 - .3, .5), ls: -4 });
  text('°C', rx + measure(airS, 150, 900, -4) + 16, 470, { size: 48, weight: 700, color: C.grey, alpha: io(t, c3 - .3, .5) });
  text('SPADIX 花序', rx, 590, { size: 22, weight: 700, color: C.red, ls: 3, alpha: io(t, c3 + .3, .5) });
  const sp = lerp(-5, 20, pS);
  const spS = (sp < 0 ? '−' : '+') + Math.abs(sp).toFixed(0);
  text(spS, rx, 730, { size: 150, weight: 900, color: C.red, alpha: io(t, c3 + .3, .5), ls: -4 });
  text('°C', rx + measure(spS, 150, 900, -4) + 16, 730, { size: 48, weight: 700, color: C.red, alpha: io(t, c3 + .3, .5) });
  line(rx, 520, rx + span(4), 520, C.ink, 2, eIO(pr(t, c3, .8)));
  text('示意读数：气温在零下时，花序可保持约 20 °C', rx, 790, { size: 18, color: C.grey, alpha: io(t, c3 + 1.5, .6) });

  // 片名前置：左上角极小的节目标识
  text('PLANT PHYSIOLOGY  /  01', col(0), TOP + 18, { size: 18, weight: 500, color: C.grey, ls: 3, alpha: io(t, .3, .8) });
  line(col(0), TOP + 40, col(0) + span(12), TOP + 40, C.ink, 2, eIO(pr(t, 0, 1.2)));
  // L04：红线划出
  const c4 = cue('L04') - T;
  rect(rx, 860, span(4) * eIO(pr(t, c4 + 1.2, 1.0)), 8, C.red);
}

function S2(t, T, dur) {
  rect(0, 0, W, H, C.paper);
  const a = io(t, 0.05, .7);
  const x = col(0) + (1 - eOut(pr(t, 0.05, .9))) * -120;
  clipRect(col(0), 200, span(12), 520, () => {
    text('抗氰呼吸', x, 560, { size: 260, weight: 900, color: C.ink, ls: -6 });
  });
  rect(col(0) + measure('抗氰呼吸', 260, 900, -6) + 30, 486, 74 * io(t, .6, .4), 74, C.red);
  text('ALTERNATIVE PATHWAY', col(0), 680, { size: 44, weight: 700, color: C.ink, ls: 6, alpha: io(t, .5, .6) });
  text('交替途径  ·  植物的一条“发热”呼吸支路', col(0), 744, { size: 30, weight: 500, color: C.grey, alpha: io(t, .8, .6) });
  line(col(0), 800, col(0) + span(12), 800, C.ink, 2, eIO(pr(t, .3, 1)));
  text('Cyanide-resistant respiration', col(8), 850, { size: 22, weight: 500, color: C.grey, alpha: io(t, 1, .6) });
  text('02', col(0), TOP + 18, { size: 18, weight: 700, color: C.red, alpha: a });
  // 结尾整体上移淡出
  const out = pr(t, dur - .4, .4);
  if (out > 0) rect(0, 0, W, H, C.paper, eIO(out));
}

// S3–S5：同一张电子传递链图，状态随旁白推进
function Chain(t, abs) {
  rect(0, 0, W, H, C.paper);
  const T3 = SC.S3, tl = abs - T3;
  const c5 = cue('L05') - T3, c6 = cue('L06') - T3, c7 = cue('L07') - T3, c8 = cue('L08') - T3, c9 = cue('L09') - T3;
  const c10 = cue('L10') - T3, c11 = cue('L11') - T3, c12 = cue('L12') - T3;
  const inS4 = abs >= SC.S4, inS5 = abs >= SC.S5;
  if (!inS4) header('03', 'CYTOCHROME PATHWAY', '细胞色素途径', tl, false);
  else if (!inS5) header('04', 'CYANIDE BLOCK', '氰化物阻断', abs - SC.S4, false);
  else header('05', 'ALTERNATIVE OXIDASE', '交替氧化酶 AOX', abs - SC.S5, false);

  membrane(eIO(pr(tl, 0.1, 1.2)), false);
  const a = {
    nadh: io(tl, c5 + .6, .6), I: io(tl, c5 + 1.2, .6), Q: io(tl, c5 + 1.6, .6), III: io(tl, c5 + 2.0, .6),
    c: io(tl, c5 + 2.4, .6), IV: io(tl, c5 + 2.8, .6), o2: io(tl, c5 + 3.4, .6)
  };
  const dead = io(tl, c8 + 1.2, .8);
  // 主路轨迹
  const pathP = eIO(pr(tl, c5 + 0.8, 3.0));
  drawPath(MAIN, dead > .5 ? C.light : C.ink, 2, pathP, 1, dead > .5 ? [8, 8] : null);
  chainStatic(tl, a, { dead }, false);

  // 电子流
  const flowA = io(tl, c5 + 3.2, .8);
  const branchOpen = io(tl, c11, 1.6);
  if (!inS4 || dead < .5) electrons(MAIN, tl, { alpha: flowA, speed: 240 });
  else if (branchOpen < 0.05) electrons(MAIN, tl, { alpha: 1, speed: 240 * (1 - .5 * dead), block: S_Q_MAIN + 230 });
  // 质子泵（I、III、IV）
  const pumpA = io(tl, c6, .8) * (1 - dead);
  protons(CH.I[0], tl, pumpA, 0); protons(CH.III[0], tl, pumpA, .33); protons(CH.IV[0], tl, pumpA, .66);
  const synA = io(tl, c6 + 1.5, .8);
  synthase(tl, synA, lerp(1, .35, dead), false);
  // L07：主干线高亮
  if (tl > c7 && !inS4) {
    drawPath(MAIN, C.red, 4, eIO(pr(tl, c7 + .2, 1.6)));
    text('细胞色素途径', col(0), 250, { size: 56, weight: 900, color: C.ink, alpha: io(tl, c7 + .4, .6) });
    text('终点：复合体 IV（细胞色素 c 氧化酶）', col(0), 296, { size: 24, weight: 500, color: C.grey, alpha: io(tl, c7 + 1.2, .6) });
  }
  // S4：氰化物
  if (inS4) {
    const drop = io(tl, c8 + .2, .7);
    const bx = CH.IV[0], by = lerp(150, MEM_Y - 120, drop);
    rect(bx - 60, by - 40, 120, 80, C.red);
    text('CN⁻', bx, by + 13, { size: 36, weight: 900, color: C.paper, align: 'center' });
    if (drop >= 1) { line(bx - 70, MEM_Y - 90, bx + 70, MEM_Y + 90, C.red, 6); line(bx + 70, MEM_Y - 90, bx - 70, MEM_Y + 90, C.red, 6); }
    text('氰化物', bx + 80, by - 6, { size: 22, weight: 700, color: C.red, alpha: drop });
    if (!inS5) {
      text('主干线中断', col(0), 250, { size: 56, weight: 900, color: C.ink, alpha: io(tl, c8 + 1.6, .6) });
      const q = io(tl, c9 + .3, .6);
      text('但植物的耗氧呼吸', col(4), 250, { size: 56, weight: 900, color: C.ink, alpha: q });
      text('仍在继续', col(4) + measure('但植物的耗氧呼吸', 56, 900) + 24, 250, { size: 56, weight: 900, color: C.red, alpha: q });
      text('氰化物存在时，O₂ 仍被持续消耗', col(4), 296, { size: 24, weight: 500, color: C.grey, alpha: q });
    }
  }
  // S5：AOX 支路
  if (inS5) {
    const draw = eIO(pr(tl, c10 + .4, 1.4));
    drawPath(BR_ONLY, C.red, 4, draw);
    const aa = io(tl, c10 + 1.2, .6);
    circle(CH.aox[0], CH.aox[1], 46 * aa, C.red);
    text('AOX', CH.aox[0], CH.aox[1] + 10, { size: 28, weight: 900, color: C.paper, align: 'center', alpha: aa });
    text('交替氧化酶', CH.aox[0] + 64, CH.aox[1] + 8, { size: 24, weight: 700, color: C.red, alpha: aa });
    text('O₂ → H₂O', CH.o2b[0] + 20, CH.o2b[1] + 12, { size: 30, weight: 700, color: C.red, alpha: io(tl, c11 + 1.6, .6) });
    if (branchOpen > 0.05) {
      electrons(BRANCH, tl, { alpha: branchOpen, speed: 240 });
      // 从 Q 绕开 III、IV 的标注
      const q = io(tl, c11 + 1.0, .6);
      text('绕开 III、IV', CH.aox[0] + 64, CH.aox[1] + 46, { size: 22, weight: 500, color: C.grey, alpha: q });
    }
    const q12 = io(tl, c12 + .2, .7);
    text('抗氰呼吸', col(0), 250, { size: 56, weight: 900, color: C.ink, alpha: q12 });
    text('CYANIDE-RESISTANT', col(0) + 260, 250, { size: 22, weight: 700, color: C.red, ls: 3, alpha: q12 });
    text('= 交替途径', col(0), 296, { size: 28, weight: 500, color: C.grey, alpha: io(tl, c12 + .9, .6) });
  }
}

function S6(t, T) {
  rect(0, 0, W, H, C.paper);
  header('06', 'ENERGY BUDGET', '能量去向', t, false);
  const c13 = cue('L13') - T, c14 = cue('L14') - T, c15 = cue('L15') - T, c16 = cue('L16') - T;
  // 大字：AOX 不泵质子
  const q = io(t, c13 + .2, .7);
  text('AOX', col(0), 300, { size: 120, weight: 900, color: C.red, alpha: q, ls: -2 });
  text('不泵质子', col(0) + measure('AOX', 120, 900, -2) + 30, 300, { size: 120, weight: 900, color: C.ink, alpha: q, ls: -2 });
  text('AOX itself pumps no protons', col(0), 350, { size: 22, weight: 500, color: C.grey, ls: 1, alpha: io(t, c13 + .8, .6) });

  // 两条路线的泵位点
  const rows = [
    { name: '细胞色素途径', en: 'CYTOCHROME', pumps: [1, 1, 1], atp: .72, heat: .28, y: 450 },
    { name: '交替途径', en: 'ALTERNATIVE', pumps: [1, 0, 0], atp: .26, heat: .74, y: 600 }
  ];
  rows.forEach((r, i) => {
    const a = io(t, c14 + i * .5, .7);
    const y = r.y;
    text(r.name, col(0), y + 10, { size: 36, weight: 900, color: C.ink, alpha: a });
    text(r.en, col(0), y + 44, { size: 18, weight: 700, color: C.grey, ls: 3, alpha: a });
    ['I', 'III', 'IV'].forEach((lab, k) => {
      const x = col(3) + k * 110, on = r.pumps[k];
      const aa = io(t, c14 + .6 + i * .5 + k * .15, .5);
      if (on) rect(x, y - 30, 80, 80, C.ink, aa); else strokeRect(x, y - 30, 80, 80, C.grey, 3, aa);
      text(lab, x + 40, y + 22, { size: 30, weight: 700, color: on ? C.paper : C.grey, align: 'center', alpha: aa });
      if (on) text('H⁺↑', x + 40, y - 44, { size: 18, weight: 700, color: C.ink, align: 'center', alpha: aa });
    });
    // 条形：ATP（黑） + 热（红）
    const bx = col(6), bw = span(6), p1 = eIO(pr(t, c15 + i * .4, 1.2));
    const wa = bw * r.atp * p1, wh = bw * r.heat * eIO(pr(t, c15 + .5 + i * .4, 1.2));
    rect(bx, y - 30, wa, 80, C.ink);
    rect(bx + wa, y - 30, wh, 80, C.red);
    if (p1 > .5) {
      text('ATP', bx + 20, y + 22, { size: 30, weight: 900, color: C.paper, alpha: io(t, c15 + .6 + i * .4, .4) });
      text('热', bx + wa + 20, y + 22, { size: 30, weight: 900, color: C.paper, alpha: io(t, c15 + 1.1 + i * .4, .4) });
    }
  });
  text('能量去向示意，非实测比例', col(6), 690, { size: 18, color: C.grey, alpha: io(t, c15 + 1.5, .6) });
  // L16：纠偏说明
  const q16 = io(t, c16 + .2, .6);
  rect(col(6), 730, 8, 120 * q16, C.red);
  text('不是“零 ATP”，也不是“全部变热”', col(6) + 30, 766, { size: 32, weight: 900, color: C.ink, alpha: q16 });
  text('糖酵解、三羧酸循环和复合体 I 仍能贡献 ATP；', col(6) + 30, 806, { size: 24, weight: 500, color: C.grey, alpha: io(t, c16 + .9, .6) });
  text('改变的是能量的分配比例。', col(6) + 30, 842, { size: 24, weight: 500, color: C.grey, alpha: io(t, c16 + 1.4, .6) });
}

function S7(t, T) {
  rect(0, 0, W, H, C.paper);
  header('07', 'SKUNK CABBAGE', '臭菘：在寒冷中开花', t, false);
  const c17 = cue('L17') - T, c18 = cue('L18') - T, c19 = cue('L19') - T, c20 = cue('L20') - T;
  // 左侧照片
  const pw = span(4), ph = 520, px = col(0), py = 200;
  clipRect(px, py, pw * eIO(pr(t, .1, 1)), ph, () => photo('skunk', px, py, pw, ph, { fx: .45, fy: .5, zoom: 1.25, label: 'Symplocarpus renifolius' }));
  text('臭菘', px, py + ph + 48, { size: 36, weight: 900, alpha: io(t, .6, .6) });
  text('Symplocarpus renifolius', px + 90, py + ph + 48, { size: 22, weight: 500, color: C.grey, alpha: io(t, .6, .6) });
  text('东北亚林下沼泽、湿草甸 · 早春先花后叶', px, py + ph + 84, { size: 20, weight: 500, color: C.grey, alpha: io(t, .9, .6) });
  // L17：AOX + UCP 标签
  const fadeTags = 1 - io(t, c20, .4);
  const q17 = io(t, c17 + 1.5, .6) * fadeTags;
  const gx = col(5);
  rect(gx, 200, 150, 56, C.red, q17); text('AOX ↑', gx + 75, 238, { size: 26, weight: 900, color: C.paper, align: 'center', alpha: q17 });
  const q17b = io(t, c17 + 3.0, .6) * fadeTags;
  strokeRect(gx + 170, 200, 170, 56, C.ink, 3, q17b); text('UCP 参与', gx + 255, 238, { size: 24, weight: 700, color: C.ink, align: 'center', alpha: q17b });
  const q17c = io(t, c17 + 4.2, .6) * fadeTags;
  text('呼吸速率', gx + 370, 238, { size: 24, weight: 700, alpha: q17c }); arrow(gx + 480, 246, gx + 480, 206, C.red, 4, q17c);

  const swap = io(t, c19 - .2, .6);   // 温度曲线 → 花粉柱状图
  // 温度曲线图
  const ax = col(5), ay = 300, aw = span(7), ah = 470;
  const yOf = v => ay + ah - (v + 15) / 45 * ah;      // −15 ~ 30 °C
  const ga = io(t, c18 - .3, .6) * (1 - swap);
  if (ga > 0) {
    ctx.save(); ctx.globalAlpha = ga;
    line(ax, ay + ah, ax + aw, ay + ah, C.ink, 2);
    [-10, 0, 10, 20, 30].forEach(v => { text(v + '°', ax - 14, yOf(v) + 8, { size: 18, color: C.grey, align: 'right' }); line(ax, yOf(v), ax + aw, yOf(v), C.light, 1); });
    line(ax, yOf(0), ax + aw, yOf(0), C.grey, 2);
    const pAir = eIO(pr(t, c18, 2.2)), pSp = eIO(pr(t, c18 + .6, 2.4));
    const N = 120, air = [], sp = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, x = ax + u * aw;
      const va = -3 + 6 * Math.sin(u * Math.PI * 4.2 + .6) - 4 * u + 1.2 * Math.sin(u * 37);
      const vs = 20.5 + 0.9 * Math.sin(u * Math.PI * 4.2 + .6) + 0.5 * Math.sin(u * 23);
      air.push([x, yOf(va)]); sp.push([x, yOf(vs)]);
    }
    drawPath(mkPath(air), C.grey, 3, pAir);
    drawPath(mkPath(sp), C.red, 5, pSp);
    text('花序温度', ax + aw - 10, yOf(20.5) - 22, { size: 24, weight: 900, color: C.red, align: 'right', alpha: io(t, c18 + 2.4, .6) });
    text('气温', ax + aw - 10, yOf(-6) + 48, { size: 24, weight: 700, color: C.grey, align: 'right', alpha: io(t, c18 + 1.8, .6) });
    text('°C', ax - 14, ay - 20, { size: 18, color: C.grey, align: 'right' });
    text('示意：零下气温中，花序约 20 °C 并随气温调节', ax, ay + ah + 44, { size: 18, color: C.grey });
    ctx.restore();
  }
  // 花粉萌发柱状图
  if (swap > 0) {
    ctx.save(); ctx.globalAlpha = swap;
    const temps = [8, 13, 18, 23, 28, 33], vals = [.03, .22, .58, 1, .6, .2];
    const bw = 110, g = (aw - bw * 6) / 5;
    text('花粉萌发', ax, ay + 10, { size: 40, weight: 900 });
    text('POLLEN GERMINATION vs TEMPERATURE', ax + 190, ay + 10, { size: 18, weight: 700, color: C.grey, ls: 2 });
    line(ax, ay + ah, ax + aw, ay + ah, C.ink, 2);
    temps.forEach((tc, i) => {
      const x = ax + i * (bw + g), hgt = (ah - 120) * vals[i] * eOut(pr(t, c19 + .3 + i * .12, .8));
      rect(x, ay + ah - hgt, bw, hgt, tc === 23 ? C.red : C.ink);
      text(tc + ' °C', x + bw / 2, ay + ah + 40, { size: 26, weight: tc === 23 ? 900 : 500, color: tc === 23 ? C.red : C.ink, align: 'center' });
    });
    text('最适 ≈ 23 °C', ax + 3 * (bw + g) + bw / 2, ay + ah - (ah - 120) - 20, { size: 26, weight: 900, color: C.red, align: 'center', alpha: io(t, c19 + 1.4, .5) });
    text('8 °C 几乎不萌发', ax, ay + ah - 60, { size: 22, weight: 700, color: C.grey, alpha: io(t, c19 + 2.2, .5) });
    text('示意，据 Seymour et al., 2009', ax, ay + ah + 76, { size: 18, color: C.grey });
    ctx.restore();
  }
  // L20：结论
  const q20 = io(t, c20 + .3, .6);
  if (q20 > 0) {
    rect(col(5), 200, 8, 56 * q20, C.red);
    text('产热 → 花粉能萌发 → 完成受精', col(5) + 30, 240, { size: 32, weight: 900, alpha: q20 });
  }
}

function S8(t, T) {
  rect(0, 0, W, H, C.paper);
  header('08', 'HEAT CARRIES SCENT', '热量与气味', t, false);
  const c21 = cue('L21') - T, c22 = cue('L22') - T, c23 = cue('L23') - T, c24 = cue('L24') - T, c25 = cue('L25') - T;
  const cards = [
    { k: 'helico', zh: '死马海芋', la: 'Helicodiceros muscivorus', hab: '地中海岛屿 · 海边岩地', pol: '丽蝇（寻找腐肉）', c: c22, fy: .4 },
    { k: 'amorpho', zh: '巨魔芋', la: 'Amorphophallus titanum', hab: '苏门答腊热带雨林', pol: '食腐甲虫、蝇类', c: c23, fy: .62 },
    { k: 'alocasia', zh: '海芋', la: 'Alocasia odora', hab: '亚洲亚热带、热带林缘', pol: '专一的果蝇（Colocasiomyia）', c: c24, fy: .45 }
  ];
  cards.forEach((cd, i) => {
    const x = col(i * 4), w = span(4), y = 200, h = 430;
    const a = io(t, cd.c - .2, .7);
    const active = t >= cd.c - .2 && (i === 2 ? t < c25 : t < cards[i + 1].c - .2);
    clipRect(x, y, w, h * eIO(pr(t, cd.c - .2, .9)), () => photo(cd.k, x, y, w, h, { fy: cd.fy, label: cd.la }));
    // 气味：同心圆弧从花序顶端扩散
    if (a > 0) clipRect(x, y, w, h, () => {
      const ox = x + w * .5, oy = y + h * .42;
      for (let k = 0; k < 4; k++) {
        const q = ((t * .45 + k / 4) % 1);
        ring(ox, oy, 30 + q * 220, C.red, 5, (active ? 1 : .35) * (1 - q) * a, -Math.PI * .95, -Math.PI * .05);
      }
    });
    text(cd.zh, x, y + h + 56, { size: 40, weight: 900, alpha: a });
    text(cd.la, x, y + h + 92, { size: 20, weight: 500, color: C.grey, alpha: a });
    line(x, y + h + 116, x + w, y + h + 116, C.ink, 2, a);
    text('生境', x, y + h + 156, { size: 18, weight: 700, color: C.grey, alpha: a });
    text(cd.hab, x + 70, y + h + 156, { size: 22, weight: 500, alpha: a });
    text('传粉', x, y + h + 194, { size: 18, weight: 700, color: C.grey, alpha: a });
    text(cd.pol, x + 70, y + h + 194, { size: 22, weight: 500, alpha: a });
    if (i === 0) {
      const q = io(t, c22 + 2.6, .6);
      rect(x, y, 230, 50, C.red, q); text('热量本身也能诱蝇', x + 14, y + 34, { size: 22, weight: 700, color: C.paper, alpha: q });
    }
  });
  // L21 开头的引导句
  const q21 = io(t, c21 + .1, .5) * (1 - io(t, c22 - .4, .4));
  text('其他天南星科植物：热量另有用处', col(0), 420, { size: 56, weight: 900, alpha: q21 });
  // L25：对比
  const q25 = io(t, c25 + .2, .7);
  if (q25 > 0) {
    rect(0, 640, W, H - 640, C.paper, q25);
    const y = 760;
    text('臭菘', col(0), y, { size: 44, weight: 900, alpha: q25 });
    text('产热 → 抵御低温', col(2), y, { size: 44, weight: 900, color: C.ink, alpha: q25 });
    text('死马海芋 · 巨魔芋 · 海芋', col(0), y + 90, { size: 44, weight: 900, alpha: io(t, c25 + .9, .6) });
    text('产热 → 传送气味', col(5) + 40, y + 90, { size: 44, weight: 900, color: C.red, alpha: io(t, c25 + .9, .6) });
    line(col(0), y + 30, col(0) + span(12), y + 30, C.ink, 2, eIO(pr(t, c25 + .3, .8)));
  }
}

function S9(t, T) {
  rect(0, 0, W, H, C.ink);
  header('09', 'SAFETY VALVE', '逆境中的泄压阀', t, true);
  const c26 = cue('L26') - T, c27 = cue('L27') - T, c28 = cue('L28') - T, c29 = cue('L29') - T;
  // L26：叶和根
  const q26 = io(t, c26 + .2, .6);
  text('不只在花里', col(0), 300, { size: 64, weight: 900, color: C.paper, alpha: q26 });
  text('叶、根等普通组织中同样存在 AOX', col(0), 356, { size: 26, weight: 500, color: '#9A9A9A', alpha: io(t, c26 + 1, .6) });
  // 简化的链：横线 + 三个节点
  const y = 580, x0 = col(0), x1 = col(0) + span(12);
  const chainA = io(t, c27 - .4, .8);
  line(x0, y, x1, y, C.paper, 2, eIO(pr(t, c27 - .4, 1)));
  const nodes = [[col(2), 'I'], [col(5), 'Q'], [col(8), 'III / IV']];
  nodes.forEach(([x, l], k) => { rect(x - 40, y - 40, 80, 80, C.paper, chainA); text(l, x, y + 10, { size: l.length > 2 ? 20 : 30, weight: 700, color: C.ink, align: 'center', alpha: chainA }); });
  text('低温 · 干旱 · 强光', col(9) + 40, 500, { size: 26, weight: 700, color: C.red, alpha: io(t, c27, .6) });
  const valve = io(t, c28 + 1.0, 1.0);        // 泄压阀打开
  const jam = io(t, c27 + 1.0, 1.5) * (1 - valve);
  // 电子：堵车时挤在 Q 与 III 之间
  for (let i = 0; i < 18; i++) {
    const base = ((t * 160 + i * 70) % (x1 - x0));
    const flowX = x0 + base;
    const jx = col(5) + 60 + (i % 6) * 28 + 4 * Math.sin(t * 9 + i), jy = y + (Math.floor(i / 6) - 1) * 26;
    const x = lerp(flowX, jx, jam), yy = lerp(y, jy, jam);
    circle(x, yy, 9, C.red, chainA);
  }
  // ROS 迸出
  if (jam > .3) {
    for (let k = 0; k < 10; k++) {
      const q = ((t * .8 + hash(k)) % 1), ang = -Math.PI * (.15 + .7 * hash(k + 9));
      const r = 60 + q * 260, px = col(6) + Math.cos(ang) * r, py = y - 40 + Math.sin(ang) * r;
      arrowHead(px, py, ang, C.red, 22, jam * (1 - q));
    }
    text('活性氧 ROS', col(9) + 40, 380, { size: 30, weight: 900, color: C.red, alpha: jam });
    text('氧化损伤', col(9) + 40, 424, { size: 24, weight: 500, color: '#9A9A9A', alpha: jam });
  }
  // AOX 支路
  const bx = col(5), by = y + 190;
  const bra = io(t, c28 + .3, .9);
  if (bra > 0) {
    line(bx, y + 40, bx, by - 46, C.red, 4, eIO(bra));
    circle(bx, by, 46 * bra, C.red);
    text('AOX', bx, by + 10, { size: 28, weight: 900, color: C.paper, align: 'center', alpha: bra });
    text('消耗多余还原力', bx + 70, by + 10, { size: 26, weight: 700, color: C.paper, alpha: io(t, c28 + 1.2, .6) });
    text('O₂ → H₂O', bx + 70, by + 50, { size: 24, weight: 500, color: '#9A9A9A', alpha: io(t, c28 + 1.6, .6) });
    // 支路电子流
    for (let k = 0; k < 4; k++) {
      const q = ((t * .9 + k / 4) % 1);
      circle(bx, lerp(y + 40, by - 40, q), 8, C.red, valve);
    }
  }
  // L29：结论
  const q29 = io(t, c29 + .2, .6);
  text('热只是副产物', col(8), 780, { size: 40, weight: 900, color: '#9A9A9A', alpha: q29 });
  text('保护细胞才是重点', col(8), 836, { size: 40, weight: 900, color: C.paper, alpha: io(t, c29 + .9, .6) });
}

function S10(t, T, dur) {
  rect(0, 0, W, H, C.paper);
  header('10', 'SUMMARY', '一条支路，三种用途', t, false);
  const c30 = cue('L30') - T, c31 = cue('L31') - T;
  const q = io(t, c30 + .2, .7);
  text('抗氰呼吸', col(0), 330, { size: 150, weight: 900, alpha: q, ls: -4 });
  text('绕开细胞色素途径的电子支路', col(0), 400, { size: 32, weight: 500, color: C.grey, alpha: io(t, c30 + 1, .6) });
  text('少存 ATP', col(7), 300, { size: 44, weight: 900, alpha: io(t, c30 + 3.2, .6) });
  text('多放热', col(7), 360, { size: 44, weight: 900, color: C.red, alpha: io(t, c30 + 4.0, .6) });
  text('为线粒体留出弹性', col(7), 420, { size: 44, weight: 900, alpha: io(t, c30 + 5.0, .6) });
  const mods = [['01', '产热', '臭菘在寒冷中开花'], ['02', '传粉', '借热量传送气味'], ['03', '保护', '逆境中减少活性氧']];
  mods.forEach(([n, a, b], i) => {
    const x = col(i * 4), y = 560, aa = io(t, c31 + .5 + i * 1.4, .6);
    line(x, y, x + span(4) - 20, y, C.ink, 2, aa);
    text(n, x, y + 120, { size: 110, weight: 900, color: i === 0 ? C.red : C.ink, alpha: aa, ls: -3 });
    text(a, x, y + 200, { size: 48, weight: 900, alpha: aa });
    text(b, x, y + 250, { size: 26, weight: 500, color: C.grey, alpha: aa });
  });
  const out = pr(t, dur - .6, .6);
  if (out > 0) rect(0, 0, W, H, C.paper, eIO(out));
}

const REFS = [
  [
    ['1', 'Moore A L, Shiba T, Young L, Harada S, Kita K, Ito K.', 'Unraveling the heater: new insights into the structure of the alternative oxidase.', 'Annual Review of Plant Biology, 2013, 64: 637–663.', 'DOI: 10.1146/annurev-arplant-042811-105432'],
    ['2', 'Onda Y, Kato Y, Abe Y, et al.', 'Functional coexpression of the mitochondrial alternative oxidase and uncoupling protein underlies thermoregulation in the thermogenic florets of skunk cabbage.', 'Plant Physiology, 2008, 146(2): 636–645.', 'DOI: 10.1104/pp.107.113563'],
    ['3', 'Seymour R S, Ito Y, Onda Y, Ito K.', 'Effects of floral thermogenesis on pollen function in Asian skunk cabbage Symplocarpus renifolius.', 'Biology Letters, 2009, 5(4): 568–570.', 'DOI: 10.1098/rsbl.2009.0064']
  ],
  [
    ['4', 'Angioy A M, Stensmyr M C, Urru I, Puliafito M, Collu I, Hansson B S.', 'Function of the heater: the dead horse arum revisited.', 'Proceedings of the Royal Society B (Suppl.), 2004, 271(S3): S13–S15.', 'DOI: 10.1098/rsbl.2003.0111'],
    ['5', 'Vanlerberghe G C.', 'Alternative oxidase: a mitochondrial respiratory pathway to maintain metabolic and signaling homeostasis during abiotic and biotic stress in plants.', 'International Journal of Molecular Sciences, 2013, 14(4): 6805–6847.', 'DOI: 10.3390/ijms14046805']
  ]
];

function S11(t, T, dur) {
  rect(0, 0, W, H, C.paper);
  const half = dur / 2;
  text('参考文献', col(0), 190, { size: 56, weight: 900, color: C.red, alpha: io(t, .1, .6) });
  text('REFERENCES', col(0) + measure('参考文献', 56, 900) + 28, 190, { size: 28, weight: 700, color: C.red, ls: 4, alpha: io(t, .3, .6) });
  line(col(0), 226, col(0) + span(12), 226, C.ink, 2, eIO(pr(t, 0, 1)));
  text('完整文献与链接见视频简介', col(8), 190, { size: 22, weight: 500, color: C.grey, alpha: io(t, .6, .6) });
  REFS.forEach((page, pi) => {
    const t0 = pi * half;
    const aIn = io(t, t0 + .3, .7), aOut = pi === 0 ? eIO(pr(t, half - .5, .5)) : 0;
    const a = aIn * (1 - aOut);
    if (a <= 0) return;
    ctx.save(); ctx.translate(-40 * aOut, 0);
    let y = 320;
    page.forEach((r, k) => {
      const aa = a * io(t, t0 + .3 + k * .25, .6);
      text('[' + r[0] + ']', col(0), y, { size: 30, weight: 900, color: C.red, alpha: aa });
      const x = col(1);
      text(r[1], x, y, { size: 30, weight: 700, alpha: aa });
      let yy = y + 44;
      wrap(r[2], 30, 400, span(11)).forEach(s => { text(s, x, yy, { size: 30, weight: 400, alpha: aa }); yy += 44; });
      text(r[3], x, yy, { size: 30, weight: 400, color: C.ink, alpha: aa }); yy += 44;
      text(r[4], x, yy, { size: 26, weight: 500, color: C.grey, alpha: aa });
      y = yy + 76;
    });
    ctx.restore();
  });
  text(pi2(t, half), col(11) + COLW, H - TOP, { size: 22, weight: 700, color: C.grey, align: 'right', alpha: io(t, .3, .6) });
  // 末尾 1 秒淡到纸白
  const out = pr(t, dur - 1.0, 1.0);
  if (out > 0) rect(0, 0, W, H, C.paper, eIO(out));
}
function pi2(t, half) { return t < half ? '1 / 2' : '2 / 2'; }

// ───────────────────────── 主渲染 ─────────────────────────
window.renderFrame = function (t) {
  t = clamp(t, 0, TOTAL - 1e-6);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.filter = 'none';
  let k = 0; while (k < ORDER.length - 1 && t >= SC[ORDER[k + 1]]) k++;
  const name = ORDER[k], T = SC[name], next = k < ORDER.length - 1 ? SC[ORDER[k + 1]] : SC.END, dur = next - T, lt = t - T;
  let dark = false;
  switch (name) {
    case 'S1': S1(lt, T); break;
    case 'S2': S2(lt, T, dur); break;
    case 'S3': case 'S4': case 'S5': Chain(lt, t); break;
    case 'S6': S6(lt, T); break;
    case 'S7': S7(lt, T); break;
    case 'S8': S8(lt, T); break;
    case 'S9': S9(lt, T); dark = true; break;
    case 'S10': S10(lt, T, dur); break;
    case 'S11': S11(lt, T, dur); break;
  }
  if (name !== 'S11' && name !== 'S2') subtitle(t, dark);
  // 场间红线划过（S3→S4→S5 同一张图，不划）
  ['S2', 'S3', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'].forEach(s => wipe(t, SC[s], dark));
};

// ───────────────────────── 封面（1920×1080，导出 PNG 用） ─────────────────────────
window.renderCover = function () {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
  rect(0, 0, W, H, C.paper);
  // 右侧黑白照片，占 5 栏，出血到右边和上下边
  const px = col(7), pw = W - px;
  photo('skunk', px, 0, pw, H, { fx: .5, fy: .5, label: 'Symplocarpus renifolius' });
  rect(px, 0, 16, H, C.red);
  text('PLANT PHYSIOLOGY', col(0), TOP + 18, { size: 22, weight: 700, color: C.ink, ls: 4 });
  line(col(0), TOP + 44, col(6) + COLW, TOP + 44, C.ink, 3);
  text('植物为什么会发热？', col(0), 330, { size: 64, weight: 900, color: C.ink });
  text('抗氰', col(0), 590, { size: 250, weight: 900, color: C.ink, ls: -8 });
  text('呼吸', col(0), 840, { size: 250, weight: 900, color: C.ink, ls: -8 });
  rect(col(0) + measure('呼吸', 250, 900, -8) + 24, 760, 80, 80, C.red);
  text('交替途径  /  AOX', col(0), 940, { size: 40, weight: 700, color: C.red, ls: 2 });
  text('ALTERNATIVE PATHWAY', col(0), 990, { size: 24, weight: 700, color: C.grey, ls: 4 });
};

window.getSfxCues = function () {
  const out = [];
  const add = (t, name, gain = 1) => out.push({ t: +t.toFixed(3), name, gain });
  ['S2', 'S3', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'].forEach(s => add(SC[s] - .25, 'sweep', .7));
  add(cue('L03'), 'warm', .8); add(cue('L03') + .6, 'tick');
  add(SC.S2 + .05, 'thud', .6); add(SC.S2 + .6, 'tick');
  ['I', 'Q', 'III', 'c', 'IV'].forEach((_, i) => add(cue('L05') + 1.2 + i * .4, 'tick', .6));
  add(cue('L08') + .85, 'thud', 1);
  add(cue('L10') + .4, 'branch', .9); add(cue('L10') + 1.2, 'tick');
  add(cue('L13') + .2, 'tick'); add(cue('L15'), 'warm', .6);
  add(cue('L17') + 1.5, 'tick'); add(cue('L18') + .6, 'warm', .7);
  for (let i = 0; i < 6; i++) add(cue('L19') + .3 + i * .12, 'tick', .5);
  ['L22', 'L23', 'L24'].forEach(id => add(cue(id) - .2, 'tick', .7));
  for (let i = 0; i < 8; i++) add(cue('L27') + 1.4 + i * .45 + hash(i) * .2, 'pop', .4 + .6 * hash(i + 3));
  add(cue('L28') + .3, 'branch', .9);
  for (let i = 0; i < 3; i++) add(cue('L31') + .5 + i * 1.4, 'tick', .8);
  return out.sort((a, b) => a.t - b.t);
};
})();
