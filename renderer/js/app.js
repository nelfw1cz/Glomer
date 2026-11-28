/* PyForge renderer: editor, lighting, modes. Pure logic lives in core.js; OS access goes through window.pyforge (preload.js). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const root = document.documentElement;
const api = window.pyforge;
const osReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let reduceMotion = osReduce;

/* The demo script from the Qt version */
const DEFAULT_CODE = `# PyForge — демо-скрипт.
# Переключайте режимы на панели слева: RPG, карта связей, машина времени, заметки.

import random


def greet(name):
    """Приветствие игрока."""
    print(f"Привет, {name}!")


def roll_dice():
    return random.randint(1, 6)


def game_round(name):
    greet(name)
    score = roll_dice() + roll_dice()
    print("Очки за раунд:", score)
    return score


if __name__ == "__main__":
    game_round("Гость")
`;

/* ───────────── elements ───────────── */
const ta = $('#ta'), hl = $('#hl'), hlin = $('#hlin'), gin = $('#gin'), curline = $('#curline');
const panel = $('#editor'), surf = $('#surf'), sctx = surf.getContext('2d');
const mini = $('#mini'), mctx = mini.getContext('2d');
const notes = $('#notes'), nctx = notes.getContext('2d');
const orb = $('#orb'), core = $('#core'), con = $('#console'), codebox = $('#codebox');
const LH = 22, PAD_T = 14, PAD_L = 16;
let CW = 8.1;

/* ───────────── document state ───────────── */
let currentPath = '';
let savedText = DEFAULT_CODE;
let scrubbing = false;          // time travel: showing a past snapshot
let liveText = '';              // the real text while scrubbing
const getText = () => (scrubbing ? liveText : ta.value);
const isDirty = () => getText() !== savedText;

function updateTitle() {
  const name = currentPath ? currentPath.split(/[\\/]/).pop() : 'Безымянный';
  $('#fname').textContent = name;
  $('#dirty').hidden = !isDirty();
  const te = $('#tabs').children[active];
  if (te) te.classList.toggle('dirty', isDirty());
  document.title = 'PyForge — ' + name + (isDirty() ? ' *' : '');
}

/* ───────────── render ───────────── */
let lines = [], tokEls = [], tokMeta = [], lineEls = [];
function render() {
  const res = PF.tokenize(ta.value);
  lines = res.lines; tokMeta = res.meta;
  hl.innerHTML = lines.map((l) => '<div class="l">' + l.h + '</div>').join('');
  tokEls = [...hl.querySelectorAll('.t')];
  gin.innerHTML = lines.map((_, i) => '<div>' + (i + 1) + '</div>').join('');
  lineEls = [...gin.children];
  curLn = 0;
  maskDirty = true;
  syncScroll(); updateCursor(); drawMini(); schedule(); updateTitle();
}
function syncScroll() {
  hlin.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
  gin.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
}
let curLn = 0;
function updateCursor() {
  const v = ta.value, p = ta.selectionStart, before = v.slice(0, p);
  const ln = before.split('\n').length, col = p - before.lastIndexOf('\n');
  $('#pos').textContent = 'Ln ' + ln + ', Col ' + col;
  curline.style.transform = 'translateY(' + (PAD_T + (ln - 1) * LH) + 'px)';
  if (curLn && lineEls[curLn - 1]) lineEls[curLn - 1].classList.remove('on');
  if (lineEls[ln - 1]) lineEls[ln - 1].classList.add('on');
  curLn = ln;
}
function measure() {
  const s = document.createElement('span');
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:13.5px/22px var(--mono);font-variant-ligatures:none';
  s.textContent = 'M'.repeat(60);
  codebox.appendChild(s);
  const w = s.getBoundingClientRect().width / 60;
  s.remove();
  if (w > 3) CW = w;
}

/* ───────────── skins ───────────── */
let SKINS = [{ id: 'neon', name: 'Neon', vars: {}, decor: { type: 'brackets', inset: 10, colors: {} }, glass: 'frost', texture: 'none', scheme: 'dark' }];
let appliedVars = [];
const decorLayer = new PFDecor.Layer($('#decor'));
const lens = PFLens.create({ source: $('#aurora') });
let lensPref = true;
// the WebGL lens only runs for the liquid theme, and not over a custom background picture (it can only see the aurora)
function updateLens() { lens.setActive(lensPref && SKINS[skinIdx].glass === 'liquid' && !document.body.classList.contains('hasbg')); }
let skinIdx = 0, sk = {};
function readSkin() {
  const cs = getComputedStyle(root);
  const g = (n) => cs.getPropertyValue(n).trim();
  sk = { acc: g('--acc'), torch: g('--torch'), a1: g('--aur1'), a2: g('--aur2'), a3: g('--aur3'),
    tok: { k: g('--k'), b: g('--b'), s: g('--s'), n: g('--n'), c: g('--c'), d: g('--d'), f: g('--f'), cl: g('--cl'), co: g('--co'), o: g('--o') } };
}
function setSkin(i, announce) {
  skinIdx = (i + SKINS.length) % SKINS.length;
  const t = SKINS[skinIdx];
  appliedVars.forEach((k) => root.style.removeProperty(k));
  appliedVars = Object.keys(t.vars);
  for (const k of appliedVars) root.style.setProperty(k, t.vars[k]);
  root.dataset.skin = t.id;
  root.dataset.glass = t.glass || 'frost'; root.dataset.tex = t.texture || 'none';
  root.style.colorScheme = t.scheme || 'dark'; root.dataset.scheme = t.scheme || 'dark';
  root.style.setProperty('--decor-inset', ((t.decor && t.decor.inset) || 0) + 'px');
  decorLayer.set(t.decor);
  $('#skinBtn').textContent = 'Тема: ' + t.name;
  readSkin(); drawMini(); schedule();
  if (mode === 2) buildMap();
  updateLens(); lens.refresh();
  if (announce) toast('Тема ' + t.name);
  try { localStorage.setItem('pf-theme', t.id); } catch (e) {}
}
async function loadThemes() {
  let list = [];
  try { list = (api.listThemes ? await api.listThemes() : []) || []; } catch (e) {}
  if (!Array.isArray(list)) list = [];
  const byId = new Map(), problems = [];
  for (const it of list) {
    if (it.error) { problems.push(it.file + ': ' + it.error); continue; }
    const r = PF.parseTheme(it.data);
    if (!r.ok) { problems.push(it.file + ': ' + r.error); continue; }
    r.warnings.forEach((w) => problems.push(it.file + ': ' + w));
    byId.set(r.theme.id, r.theme);          // later directory (user) overrides built-in
  }
  if (byId.size) {
    const cur = SKINS[skinIdx].id;
    SKINS = [...byId.values()];
    if (byId.has('neon')) SKINS.unshift(...SKINS.splice(SKINS.findIndex((t) => t.id === 'neon'), 1));
    let saved = cur; try { saved = localStorage.getItem('pf-theme') || cur; } catch (e) {}
    const idx = SKINS.findIndex((t) => t.id === saved);
    setSkin(idx < 0 ? 0 : idx, false);
  }
  if (problems.length) toast('Темы: ' + problems[0] + (problems.length > 1 ? ' (+' + (problems.length - 1) + ')' : ''));
}

/* ───────────── lighting ───────────── */
let rtx = false, lx = 0, ly = 0, raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; lighting(); }); }
function sizeCanvas(c, ctx, w, h) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawSurface() {
  const w = panel.clientWidth, h = panel.clientHeight;
  sizeCanvas(surf, sctx, w, h);
  sctx.clearRect(0, 0, w, h);
  sctx.globalCompositeOperation = 'lighter';
  const blob = (x, y, r, rgb, a) => {
    const g = sctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(.5, 'rgba(' + rgb + ',' + (a * .35) + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
    sctx.fillStyle = g; sctx.fillRect(0, 0, w, h);
  };
  if (rtx) { blob(lx, ly, 640, sk.torch, .42); blob(lx, ly, 200, sk.torch, .22); }
  else { blob(w * .12, h * .05, 640, sk.acc, .10); blob(w * .95, h * .95, 560, sk.a2, .07); }
}

const glassEls = [...document.querySelectorAll('.glass')];
let maskData = null, maskW = 1, maskH = 1, maskDirty = true;
const mcan = document.createElement('canvas'), mctx2 = mcan.getContext('2d', { willReadFrequently: true });
const rays = $('#rays'), rctx = rays.getContext('2d');
const RAYS = 220;
function buildMask() {
  const w = panel.clientWidth, h = panel.clientHeight;
  maskW = Math.max(1, Math.ceil(w / 2)); maskH = Math.max(1, Math.ceil(h / 2));
  mcan.width = maskW; mcan.height = maskH;
  mctx2.clearRect(0, 0, maskW, maskH);
  mctx2.fillStyle = '#fff';
  const st = ta.scrollTop, sl = ta.scrollLeft, left = codebox.offsetLeft + PAD_L;
  for (let i = 0; i < tokMeta.length; i++) {
    const t = tokMeta[i], y = PAD_T + t.line * LH + 5 - st;
    if (y < -20 || y > h) continue;
    mctx2.fillRect((left + t.col * CW - sl) / 2, y / 2, Math.max(1, t.n * CW / 2), 6);
  }
  maskData = mctx2.getImageData(0, 0, maskW, maskH).data;
  maskDirty = false;
}
/* Ray-march from the light through the glyph mask: light only travels through the gaps between lines and words. */
function drawRays() {
  const w = panel.clientWidth, h = panel.clientHeight;
  sizeCanvas(rays, rctx, w, h);
  rctx.clearRect(0, 0, w, h);
  if (!rtx) return;
  if (maskDirty || !maskData) buildMask();
  const R = 760, dth = Math.PI * 2 / RAYS;
  const g = rctx.createRadialGradient(lx, ly, 0, lx, ly, R);
  g.addColorStop(0, 'rgba(' + sk.torch + ',.6)'); g.addColorStop(.3, 'rgba(' + sk.torch + ',.24)'); g.addColorStop(1, 'rgba(' + sk.torch + ',0)');
  rctx.fillStyle = g; rctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < RAYS; i++) {
    const a = i * dth, cx = Math.cos(a), cy = Math.sin(a);
    let T = 1, r = 26;
    for (; r < R; r += 5) {
      const x = lx + cx * r, y = ly + cy * r;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      if (maskData[((y >> 1) * maskW + (x >> 1)) * 4 + 3] > 0) { T *= .8; if (T < .18) break; }
    }
    rctx.globalAlpha = .05 * (.45 + .55 * T);
    rctx.beginPath();
    rctx.moveTo(lx, ly);
    rctx.lineTo(lx + Math.cos(a - dth * .6) * r, ly + Math.sin(a - dth * .6) * r);
    rctx.lineTo(lx + Math.cos(a + dth * .6) * r, ly + Math.sin(a + dth * .6) * r);
    rctx.closePath(); rctx.fill();
  }
  rctx.globalAlpha = 1; rctx.globalCompositeOperation = 'source-over';
}
/* Every glass panel gets the light position in its own coordinates, so the edge nearest the light catches a highlight. */
function updateGlass() {
  if (!rtx) return;
  const pr = panel.getBoundingClientRect(), X = pr.left + lx, Y = pr.top + ly;
  for (const el of glassEls) {
    if (el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--lx', (X - r.left) + 'px');
    el.style.setProperty('--ly', (Y - r.top) + 'px');
  }
}
function lighting() {
  drawSurface();
  drawRays();
  updateGlass();
  if (!rtx) return;
  const st = ta.scrollTop, sl = ta.scrollLeft, H = panel.clientHeight, left = codebox.offsetLeft + PAD_L;
  for (let i = 0; i < tokEls.length; i++) {
    const t = tokMeta[i];
    const y = PAD_T + t.line * LH + LH / 2 - st;
    if (y < -60 || y > H + 60) continue;
    const x = left + (t.col + t.n / 2) * CW - sl;
    const vx = x - lx, vy = y - ly, d = Math.hypot(vx, vy) || 1, k = clamp(d / 650, 0, 1);
    const len = 1.5 + k * 9, nx = vx / d, ny = vy / d;
    tokEls[i].style.cssText = '--sx:' + (nx * len).toFixed(2) + ';--sy:' + (ny * len).toFixed(2) + ';--sb:' + (.5 + k * 6).toFixed(2);
  }
}
function placeLight(x, y) {
  lx = clamp(x, 10, panel.clientWidth - 10); ly = clamp(y, 10, panel.clientHeight - 10);
  orb.style.transform = 'translate(' + lx + 'px,' + ly + 'px)';
  schedule();
}
let dragging = false;
core.addEventListener('pointerdown', (e) => { dragging = true; core.setPointerCapture(e.pointerId); e.preventDefault(); });
core.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = panel.getBoundingClientRect();
  placeLight(e.clientX - r.left, e.clientY - r.top);
});
const endDrag = () => { dragging = false; };
core.addEventListener('pointerup', endDrag); core.addEventListener('pointercancel', endDrag);
core.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 60 : 20, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); placeLight(lx + d[0], ly + d[1]); }
});

/* ───────────── minimap ───────────── */
function drawMini() {
  const w = 64, h = panel.clientHeight;
  sizeCanvas(mini, mctx, w, h);
  mctx.clearRect(0, 0, w, h);
  const lh = Math.min(3, Math.max(1, (h - 8) / Math.max(lines.length, 1)));
  lines.forEach((L, i) => L.t.forEach((t) => {
    mctx.fillStyle = (sk.tok && sk.tok[t.k]) || '#999';
    mctx.globalAlpha = .75;
    mctx.fillRect(6 + t.c * .55, 6 + i * lh, Math.max(1, t.n * .55), Math.max(1, lh - 1));
  }));
  mctx.globalAlpha = 1;
  const total = Math.max(lines.length * LH + PAD_T + 60, 1), vh = ta.clientHeight;
  const sc = lh * lines.length / total;
  mctx.fillStyle = 'rgba(255,255,255,.08)';
  mctx.fillRect(0, 6 + ta.scrollTop * sc, w, Math.max(14, vh * sc));
}
mini.addEventListener('pointerdown', (e) => {
  const r = mini.getBoundingClientRect();
  const total = Math.max(lines.length * LH + PAD_T + 60, 1);
  const lh = Math.min(3, Math.max(1, (r.height - 8) / Math.max(lines.length, 1)));
  ta.scrollTop = ((e.clientY - r.top - 6) / (lh * lines.length)) * total - ta.clientHeight / 2;
});

/* ───────────── aurora background ───────────── */
const aur = $('#aurora'), actx = aur.getContext('2d');
let aLast = 0;
function aurora(t) {
  if (document.hidden) { requestAnimationFrame(aurora); return; }
  if (t - aLast > 42 || reduceMotion) {
    aLast = t;
    const w = Math.ceil(innerWidth / 5), h = Math.ceil(innerHeight / 5);
    if (aur.width !== w || aur.height !== h) { aur.width = w; aur.height = h; }
    actx.globalCompositeOperation = 'source-over';
    actx.clearRect(0, 0, w, h);
    actx.globalCompositeOperation = 'lighter';
    const blobs = [[sk.a1, .00009, .00013, 0, .46], [sk.a2, .00012, .00008, 2.1, .52], [sk.a3, .00007, .00011, 4.2, .40]];
    blobs.forEach(([rgb, fx, fy, ph, r]) => {
      const x = (.5 + .38 * Math.sin(t * fx + ph)) * w, y = (.5 + .34 * Math.cos(t * fy + ph * 1.3)) * h, R = r * Math.max(w, h);
      const g = actx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, 'rgba(' + rgb + ',.34)'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
      actx.fillStyle = g; actx.fillRect(0, 0, w, h);
    });
    lens.mark();
  }
  if (!reduceMotion) { auroraOn = true; requestAnimationFrame(aurora); } else auroraOn = false;
}
let auroraOn = true;
function setMotion(on) {
  reduceMotion = osReduce || !on;
  decorLayer.setReduce(reduceMotion);
  if (!reduceMotion && !auroraOn) { auroraOn = true; requestAnimationFrame(aurora); }
}

/* ───────────── toasts ───────────── */
let toastT = 0;
function toast(msg, color) {
  const el = $('#toast');
  el.textContent = msg; el.style.color = color || '';
  el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2200);
}
let rtT = 0;
function bigToast(title, sub, tone) {
  const el = $('#rtoast');
  $('#rtTitle').textContent = title; $('#rtSub').textContent = sub;
  el.className = 'rtoast ' + tone;
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(rtT); rtT = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ───────────── editing helpers ───────────── */
function insert(text) {
  ta.focus();
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
function transformLines(fn) {
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  const ls = a === 0 ? 0 : v.lastIndexOf('\n', a - 1) + 1;
  let le = v.indexOf('\n', b); if (le < 0) le = v.length;
  const seg = v.slice(ls, le).split('\n').map(fn).join('\n');
  ta.setSelectionRange(ls, le);
  insert(seg);
  ta.setSelectionRange(ls, ls + seg.length);
}
function enterWithIndent() {
  const v = ta.value, p = ta.selectionStart;
  const ls = p === 0 ? 0 : v.lastIndexOf('\n', p - 1) + 1;
  insert('\n' + PF.indentAfterEnter(v.slice(ls, p)));
  lineCommitted();
}
/* "line committed" = Enter pressed: RPG awards XP, time travel snapshots straight away */
function lineCommitted() {
  rpg.onLineCommitted(); rpgRender();
  if (mode === 3 && !scrubbing) snapshot();
}
ta.addEventListener('keydown', (e) => {
  if (ta.readOnly) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
    if (e.shiftKey) transformLines((l) => l.replace(/^ {1,4}/, ''));
    else if (multi) transformLines((l) => '    ' + l);
    else insert('    ');
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
    e.preventDefault(); enterWithIndent();
  }
});
ta.addEventListener('scroll', () => { maskDirty = true; syncScroll(); drawMini(); schedule(); });
['keyup', 'click', 'select', 'focus'].forEach((ev) => ta.addEventListener(ev, updateCursor));
document.addEventListener('selectionchange', () => { if (document.activeElement === ta) updateCursor(); });

/* snippets (SnippetBar.cpp) */
const SNIPS = [
  ['for', 'for i in range(10):\n    '], ['for…in', 'for item in items:\n    '], ['while', 'while condition:\n    '],
  ['def', 'def function_name(args):\n    """Описание"""\n    '], ['if/else', 'if condition:\n    \nelse:\n    '],
  ['try', 'try:\n    \nexcept Exception as e:\n    print(e)\n'], ['class', 'class MyClass:\n    def __init__(self):\n        '],
  ['with', 'with open("file.txt", encoding="utf-8") as f:\n    data = f.read()\n'], ['lambda', 'lambda x: x']
];
{
  const cap = document.createElement('span');
  cap.className = 'dimcap'; cap.textContent = 'ШАБЛОНЫ';
  $('#snips').appendChild(cap);
}
SNIPS.forEach(([label, body]) => {
  const b = document.createElement('button');
  b.className = 'chip'; b.type = 'button'; b.textContent = label;
  b.addEventListener('click', () => {
    if (ta.readOnly) return;
    ta.focus();
    const v = ta.value, p = ta.selectionStart, ls = p === 0 ? 0 : v.lastIndexOf('\n', p - 1) + 1;
    const before = v.slice(ls, p);
    // like the Qt version: a snippet starts on its own line when the cursor is mid-line
    insert((before.trim() ? '\n' : '') + body);
  });
  $('#snips').appendChild(b);
});

/* ───────────── bot templates (aiogram) ───────────── */
function revealCaret() {
  const y = PAD_T + (ta.value.slice(0, ta.selectionStart).split('\n').length - 1) * LH;
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 60) ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
}
// Replaces only the part of the text that changed, so the edit is one undo step (Ctrl+Z).
function applyText(next, caret) {
  const cur = ta.value;
  if (next === cur) return;
  const max = Math.min(cur.length, next.length);
  let a = 0, b = 0;
  while (a < max && cur[a] === next[a]) a++;
  while (b < max - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  ta.focus();
  ta.setSelectionRange(a, cur.length - b);
  const repl = next.slice(a, next.length - b);
  if (repl) insert(repl); else document.execCommand('delete');
  const c = clamp(caret, 0, ta.value.length);
  ta.setSelectionRange(c, c);
  revealCaret(); updateCursor();
}
function insertBot(t, btn) {
  if (ta.readOnly) return;
  if (t.skeleton) {
    if (ta.value.trim() && !btn.dataset.armed) { // the skeleton replaces the whole file: ask with a second click
      btn.dataset.armed = '1'; btn.textContent = 'Заменить код?';
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = t.label; }, 4000);
      return;
    }
    delete btn.dataset.armed; btn.textContent = t.label;
    applyText(t.text, t.text.length);
    toast('Каркас бота вставлен');
    return;
  }
  const r = PF.insertTopLevel(ta.value, t.body);
  const full = PF.ensureImports(r.text, t.needs);
  applyText(full, r.caret + (full.length - r.text.length));
}
const wizard = PFBotWizard.create({ api, toast, onOpenMain: async (p) => { await explorer.setRoot(dirOf(p)); return openPathInEditor(p); } });
{
  const nb = document.createElement('button');
  nb.className = 'chip primary'; nb.type = 'button'; nb.textContent = '＋ Создать бота…';
  nb.title = 'Мастер: токен, хендлеры, готовая папка проекта';
  nb.addEventListener('click', () => wizard.open());
  $('#botbar').appendChild(nb);
}
PFBots.GROUPS.forEach((g) => {
  const cap = document.createElement('span');
  cap.className = 'dimcap'; cap.textContent = g.title;
  $('#botbar').appendChild(cap);
  g.items.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = t.label; b.title = t.tip || '';
    b.addEventListener('click', () => insertBot(t, b));
    $('#botbar').appendChild(b);
  });
});

/* ───────────── Code-RPG ───────────── */
const rpg = new PF.Rpg(bigToast);
function rpgRender() {
  $('#lvl').textContent = 'LV ' + rpg.level;
  $('#xpTxt').textContent = rpg.xp + ' / ' + rpg.xpNeeded() + ' XP';
  $('#hpTxt').textContent = rpg.hp + ' / ' + PF.MAX_HP + ' HP';
  $('#xpFill').style.width = (rpg.xp / rpg.xpNeeded() * 100) + '%';
  const hp = $('#hpFill');
  hp.style.width = (rpg.hp / PF.MAX_HP * 100) + '%';
  hp.className = 'fl ' + (rpg.hpTone() === 'green' ? '' : rpg.hpTone());
  const c = $('#combo');
  c.textContent = '×' + rpg.combo; c.classList.toggle('hot', rpg.combo >= 5);
}

/* ───────────── Time Travel ───────────── */
let history = new PF.History(400);
const slider = $('#tslider');
let snapTimer = 0;
function snapshot() {
  if (scrubbing) return;
  if (history.capture(ta.value)) tmRefresh();
  else tmInfo();
}
function tmRefresh() {
  slider.max = Math.max(0, history.last);
  if (!scrubbing) slider.value = history.last;
  tmInfo();
}
function tmInfo() {
  const v = +slider.value, last = history.last, info = $('#tinfo');
  slider.style.setProperty('--p', (last > 0 ? v / last * 100 : 100) + '%');
  if (!scrubbing) { info.textContent = '● LIVE · кадров: ' + history.size; info.classList.remove('past'); }
  else {
    info.textContent = '◂ кадр ' + (v + 1) + '/' + history.size + ' · ' + new Date(history.at(v).time).toLocaleTimeString('ru-RU');
    info.classList.add('past');
  }
}
slider.addEventListener('input', () => {
  const v = +slider.value;
  if (v >= history.last) { tmLive(); return; }
  if (!scrubbing) { snapshot(); liveText = ta.value; scrubbing = true; ta.readOnly = true; panel.classList.add('past'); }
  ta.value = history.at(v).text; render(); tmInfo();
});
function tmLive() {
  if (scrubbing) {
    scrubbing = false; ta.readOnly = false; ta.value = liveText; panel.classList.remove('past'); render();
  }
  slider.value = history.last; tmInfo();
}
$('#tback').addEventListener('click', tmLive);
ta.addEventListener('input', () => {
  render();
  if (mode === 3 && !scrubbing) { clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 600); } // 600 ms debounce
});

/* ───────────── notes layer ───────────── */
const strokes = []; let tool = 'pen', cur = null;
function notesSize() { sizeCanvas(notes, nctx, panel.clientWidth, panel.clientHeight); notesRedraw(); }
function notesRedraw() {
  const w = panel.clientWidth, h = panel.clientHeight;
  nctx.clearRect(0, 0, w, h);
  if (mode !== 4) return;
  nctx.lineCap = 'round'; nctx.lineJoin = 'round'; nctx.shadowBlur = 0;
  nctx.strokeStyle = 'rgba(167,139,250,.47)'; nctx.lineWidth = 2;
  nctx.beginPath(); nctx.roundRect(1, 1, w - 2, h - 2, 10); nctx.stroke();
  nctx.fillStyle = 'rgba(167,139,250,.67)'; nctx.font = '12px ' + getComputedStyle(root).getPropertyValue('--ui');
  nctx.fillText('РЕЖИМ ЗАМЕТОК · рисуйте мышью поверх кода', 16, 26);
  [...strokes, cur].filter(Boolean).forEach((s) => {
    const col = s.type === 'pen' ? 'rgba(255,70,70,.78)' : '#ffb02e';
    nctx.strokeStyle = col; nctx.lineWidth = s.type === 'pen' ? 5 : 3; nctx.shadowColor = col; nctx.shadowBlur = 10;
    nctx.beginPath();
    if (s.type === 'pen') { s.pts.forEach((p, i) => (i ? nctx.lineTo(p[0], p[1]) : nctx.moveTo(p[0], p[1]))); nctx.stroke(); }
    else {
      const a = s.pts[0], b = s.pts[s.pts.length - 1];
      nctx.moveTo(a[0], a[1]); nctx.lineTo(b[0], b[1]); nctx.stroke();
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      nctx.beginPath();
      nctx.moveTo(b[0], b[1]); nctx.lineTo(b[0] - 16 * Math.cos(ang - .5), b[1] - 16 * Math.sin(ang - .5));
      nctx.moveTo(b[0], b[1]); nctx.lineTo(b[0] - 16 * Math.cos(ang + .5), b[1] - 16 * Math.sin(ang + .5));
      nctx.stroke();
    }
    nctx.shadowBlur = 0;
  });
}
const npt = (e) => { const r = notes.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
notes.addEventListener('pointerdown', (e) => {
  if (mode !== 4) return;
  notes.setPointerCapture(e.pointerId);
  const p = npt(e);
  cur = { type: tool, pts: [p, p] };
  notesRedraw();
});
notes.addEventListener('pointermove', (e) => {
  if (!cur) return;
  if (cur.type === 'pen') cur.pts.push(npt(e)); else cur.pts[cur.pts.length - 1] = npt(e);
  notesRedraw();
});
const noteEnd = () => { if (cur) { strokes.push(cur); cur = null; notesRedraw(); } };
notes.addEventListener('pointerup', noteEnd); notes.addEventListener('pointercancel', noteEnd);
function setTool(t) { tool = t; $('#toolPen').setAttribute('aria-pressed', t === 'pen'); $('#toolArrow').setAttribute('aria-pressed', t === 'arrow'); }
$('#toolPen').addEventListener('click', () => setTool('pen'));
$('#toolArrow').addEventListener('click', () => setTool('arrow'));
$('#toolClear').addEventListener('click', () => { strokes.length = 0; notesRedraw(); });

/* ───────────── call graph ───────────── */
const svg = $('#svg'), gN = $('#gNodes'), gE = $('#gEdges'), NS = 'http://www.w3.org/2000/svg';
const pos = new Map(); let vb = { x: 0, y: 0, w: 960, h: 540 };
const setVB = () => svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
function buildMap() {
  const { fns, edges } = PF.parseFunctions(ta.value);
  gN.replaceChildren(); gE.replaceChildren();
  $('#mapEmpty').hidden = fns.length > 0;
  if (!fns.length) return;
  const called = new Set(edges.map((e) => e[1]));
  const outs = new Map(fns.map((f) => [f.name, f.calls]));
  // columns by call depth: entry points (never called) on the left
  const depth = new Map();
  const walk = (n, d, seen) => {
    if (seen.has(n)) return;
    if ((depth.get(n) ?? -1) < d) depth.set(n, d);
    const s2 = new Set(seen).add(n);
    (outs.get(n) || []).forEach((c) => walk(c, d + 1, s2));
  };
  fns.forEach((f) => { if (!called.has(f.name)) walk(f.name, 0, new Set()); });
  fns.forEach((f) => { if (!depth.has(f.name)) depth.set(f.name, 0); });
  const cols = new Map();
  depth.forEach((d, n) => { if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); });
  cols.forEach((names, d) => names.forEach((n, i) => {
    if (!pos.has(n)) pos.set(n, { x: 90 + d * 270, y: 270 + (i - (names.length - 1) / 2) * 100 });
  }));
  const dims = (n) => ({ w: Math.max(120, n.length * 9 + 46), h: 42 });
  const edgeEls = [];
  edges.forEach(([a, b]) => { const p = mk('path', { class: 'edge', 'marker-end': 'url(#arr)' }); gE.appendChild(p); edgeEls.push([p, a, b]); });
  const upd = () => edgeEls.forEach(([p, a, b]) => {
    const A = pos.get(a), B = pos.get(b), da = dims(a), db = dims(b);
    const x1 = A.x + da.w, y1 = A.y + da.h / 2, x2 = B.x, y2 = B.y + db.h / 2, k = Math.max(50, Math.abs(x2 - x1) / 2);
    p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + (x1 + k) + ' ' + y1 + ',' + (x2 - k) + ' ' + y2 + ',' + x2 + ' ' + y2);
  });
  fns.forEach((f) => {
    const n = f.name, { w, h } = dims(n), p = pos.get(n);
    const rgb = !called.has(n) ? sk.acc : (f.calls.length ? '167,139,250' : '74,222,128');
    const g = mk('g', { class: 'node', transform: 'translate(' + p.x + ' ' + p.y + ')', tabindex: 0 });
    g.style.setProperty('--nc', rgb);
    const label = mk('text', { x: w / 2, y: h / 2 + 4.5, 'text-anchor': 'middle' });
    label.textContent = n + '()';
    g.append(mk('rect', { width: w, height: h, rx: 12 }), label);
    let off = null;
    const pt = (e) => { const q = svg.createSVGPoint(); q.x = e.clientX; q.y = e.clientY; return q.matrixTransform(svg.getScreenCTM().inverse()); };
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); g.setPointerCapture(e.pointerId); const q = pt(e); off = { x: q.x - p.x, y: q.y - p.y }; });
    g.addEventListener('pointermove', (e) => { if (!off) return; const q = pt(e); p.x = q.x - off.x; p.y = q.y - off.y; g.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')'); upd(); });
    g.addEventListener('pointerup', () => { off = null; });
    g.addEventListener('dblclick', () => showFunction(n));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); showFunction(n); } }); // preventDefault: otherwise this same Enter would press the dialog's focused button
    gN.appendChild(g);
  });
  upd();
  $('#arr path').setAttribute('fill', 'rgb(' + sk.acc + ')');
}
let pan = null;
svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); pan = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; });
svg.addEventListener('pointermove', (e) => {
  if (!pan) return;
  const r = svg.getBoundingClientRect(), s = vb.w / r.width;
  vb.x = pan.vx - (e.clientX - pan.x) * s; vb.y = pan.vy - (e.clientY - pan.y) * s; setVB();
});
svg.addEventListener('pointerup', () => { pan = null; });
svg.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = svg.getBoundingClientRect(), f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  const nw = clamp(vb.w * f, 300, 3000), k = nw / vb.w;
  const mx = vb.x + (e.clientX - r.left) / r.width * vb.w, my = vb.y + (e.clientY - r.top) / r.height * vb.h;
  vb = { x: mx - (mx - vb.x) * k, y: my - (my - vb.y) * k, w: nw, h: vb.h * k }; setVB();
}, { passive: false });

/* ───────────── function viewer: read-only code of one function ───────────── */
let fnOpen = false;
function showFunction(name) {
  const f = PF.extractFunction(ta.value, name);
  if (!f || fnOpen) return;
  fnOpen = true;
  const opener = document.activeElement;
  const res = PF.tokenize(f.text);
  const { h } = PFModal;
  const gut = h('div', { class: 'cv-gut' });
  const code = h('pre', { class: 'cv-code', tabindex: '0', 'aria-label': 'Код функции ' + name + ', только чтение' });
  res.lines.forEach((l, i) => {
    gut.append(h('div', { text: String(f.startLine + i) }));
    const d = h('div', { class: 'l' }); d.innerHTML = l.h; code.append(d); // html comes from PF.tokenize, which escapes the source
  });
  const bCopy = h('button', { class: 'chip', type: 'button', text: 'Копировать' });
  const bGoto = h('button', { class: 'chip', type: 'button', text: 'К месту в редакторе' });
  const bClose = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
  const dlg = h('div', { class: 'dlg fnview', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fnTitle' },
    h('div', { class: 'dlg-h' }, h('h2', { id: 'fnTitle', text: name + '()' }), h('span', { class: 'ro', text: 'только чтение · строки ' + f.startLine + '–' + f.endLine })),
    h('div', { class: 'codeview' }, gut, code),
    h('div', { class: 'dlg-f' }, bCopy, bGoto, h('span', { class: 'sp' }), bClose));
  const back = h('div', { class: 'modal-back' }, dlg);
  document.body.append(back);
  let untrap = null;
  const close = () => { untrap(); back.remove(); fnOpen = false; if (opener && opener.focus) opener.focus(); };
  untrap = PFModal.trap(dlg, close);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  bClose.addEventListener('click', close);
  bCopy.addEventListener('click', () => {
    const fallback = () => { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Выделено: нажми Ctrl+C'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.text).then(() => toast('Код скопирован'), fallback); else fallback();
  });
  bGoto.addEventListener('click', () => {
    close();
    setMode(0);
    const off = ta.value.split('\n').slice(0, f.startLine - 1).join('\n').length + (f.startLine > 1 ? 1 : 0);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(off, off); revealCaret(); updateCursor(); });
  });
  bClose.focus();
}

/* ───────────── run (real Python through the main process) ───────────── */
let running = false, lastStderr = '';
function out(text, cls) {
  const s = document.createElement('span');
  if (cls) s.className = 'cl ' + cls;
  s.textContent = text;
  con.appendChild(s);
  con.scrollTop = con.scrollHeight;
}
function setBusy(b) { running = b; $('#run').classList.toggle('busy', b); $('#runLbl').textContent = b ? 'Стоп' : 'Запустить'; }
const NO_PYTHON = '❌ Интерпретатор Python не найден.\n   Установи Python 3 с python.org (галочка "Add to PATH")\n   или убедись, что команда py / python / python3 доступна в PATH.\n';

async function runScript() {
  if (running) { api.stopPython(); return; } // second click = emergency stop
  if (scrubbing) tmLive();
  con.replaceChildren();
  out('▸ Запуск …\n', 'dim');
  lastStderr = '';
  setBusy(true);
  const dir = currentPath ? currentPath.replace(/[\\/][^\\/]*$/, '') : '';
  const r = await api.runPython(ta.value, dir || undefined); // a saved file runs next to itself, so .env and relative paths work
  if (r && r.error) {
    out(r.error === 'no-python' ? NO_PYTHON : '▸ Ошибка запуска: ' + r.error + '\n', 'err');
    setBusy(false);
  }
}
api.onPyOut((d) => out(d));
api.onPyErr((d) => { lastStderr += d; out(d, 'err'); });
api.onPyError((e) => {
  out(e === 'no-python' ? NO_PYTHON : '▸ Ошибка процесса: ' + e + '\n', 'err');
  setBusy(false);
});
api.onPyExit(({ code, stopped }) => {
  setBusy(false);
  if (stopped) { out('\n▸ Остановлено.\n', 'dim'); return; } // a manual stop is not a failure for the RPG
  const ok = code === 0 && !lastStderr.trim();               // success = exit code 0 and empty stderr
  out(ok ? '\n▸ Готово (код 0). Отличная работа!\n' : '\n▸ Процесс завершён с кодом ' + code + (lastStderr.trim() ? ' (есть stderr)' : '') + '.\n', ok ? 'ok' : 'err');
  const mm = /No module named '(\w+)/.exec(lastStderr);
  if (mm) out('▸ Не хватает модуля «' + mm[1] + '». Установи его командой: pip install ' + mm[1] + '\n', 'dim');
  rpg.onRunFinished(ok); rpgRender();
});
$('#run').addEventListener('click', runScript);

/* ───────────── tabs ───────────── */
// The live document lives in ta / currentPath / savedText / strokes; tabs[] holds the snapshots of the other tabs.
const { h } = PFModal;
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const blankTab = () => ({ path: '', text: '', saved: '', sel: [0, 0], top: 0, left: 0, strokes: [] });
let tabs = [blankTab()];
let active = 0;
const tabDirty = (i) => (i === active ? isDirty() : tabs[i].text !== tabs[i].saved);
const tabPath = (i) => (i === active ? currentPath : tabs[i].path);

function captureTab() {
  const t = tabs[active];
  t.path = currentPath; t.text = getText(); t.saved = savedText;
  t.sel = [ta.selectionStart, ta.selectionEnd]; t.top = ta.scrollTop; t.left = ta.scrollLeft; t.strokes = strokes.slice();
}
function loadTab(i) {
  active = i;
  const t = tabs[i];
  currentPath = t.path; savedText = t.saved;
  ta.value = t.text;
  ta.setSelectionRange(t.sel[0], t.sel[1]);
  ta.scrollTop = t.top; ta.scrollLeft = t.left;
  strokes.length = 0; strokes.push(...t.strokes);
  history = new PF.History(400);          // time travel is per document
  const ed = $('#editor'); ed.classList.remove('swap'); void ed.offsetWidth; ed.classList.add('swap');
  render(); notesRedraw();
  if (mode === 2) buildMap();
  if (mode === 3) { snapshot(); tmRefresh(); }
  renderTabs(); explorer.markActive();
}
function switchTab(i) {
  if (i === active || i < 0 || i >= tabs.length) return;
  if (scrubbing) tmLive();
  captureTab(); loadTab(i);
}
function newTab(text, path) {
  if (scrubbing) tmLive();
  captureTab();
  const t = blankTab(); t.text = t.saved = text || ''; t.path = path || '';
  tabs.push(t);
  loadTab(tabs.length - 1);
  ta.focus();
}
async function closeTab(i) {
  if (scrubbing) tmLive();
  if (i !== active) switchTab(i);
  if (!(await maybeSave())) return false;
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(blankTab());
  loadTab(Math.min(i, tabs.length - 1));
  return true;
}
let shownTabs = 0;
function renderTabs() {
  const bar = $('#tabs');
  const grew = tabs.length > shownTabs; shownTabs = tabs.length;
  bar.replaceChildren();
  tabs.forEach((_, i) => {
    const p = tabPath(i);
    const el = h('div', {
      class: 'tab' + (i === active ? ' on' : '') + (grew && i === active ? ' pop' : '') + (tabDirty(i) ? ' dirty' : ''), role: 'tab', 'data-i': String(i),
      'aria-selected': String(i === active), title: p || 'Безымянный', tabindex: i === active ? '0' : '-1'
    }, h('span', { class: 'tname', text: p ? p.split(/[\\/]/).pop() : 'Безымянный' }),
      h('button', { class: 'tclose', type: 'button', tabindex: '-1', 'aria-label': 'Закрыть вкладку', title: 'Закрыть (Ctrl+W)' }));
    bar.append(el);
  });
  bar.append(h('button', { class: 'tabnew', type: 'button', title: 'Новый файл (Ctrl+N)', 'aria-label': 'Новая вкладка', text: '+' }));
  const on = bar.children[active];
  if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
$('#tabs').addEventListener('click', (e) => {
  if (e.target.closest('.tabnew')) { newTab(); return; }
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const i = +tab.dataset.i;
  if (e.target.closest('.tclose')) closeTab(i); else switchTab(i);
});
$('#tabs').addEventListener('auxclick', (e) => { // middle click closes
  const tab = e.button === 1 && e.target.closest('.tab');
  if (tab) { e.preventDefault(); closeTab(+tab.dataset.i); }
});
$('#tabs').addEventListener('keydown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const i = +tab.dataset.i;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    switchTab((i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length);
    const on = $('#tabs').children[active]; if (on) on.focus();
  } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(i); }
  else if (e.key === 'Delete') { e.preventDefault(); closeTab(i); }
});
// a file was renamed or moved (maybe a whole folder): keep the tabs pointing at it
function onRenamed(from, to) {
  const remap = (p) => (PFExplorer.under(p, from) ? to + p.slice(from.length) : p);
  tabs.forEach((t) => { t.path = remap(t.path); });
  currentPath = remap(currentPath);
  renderTabs(); updateTitle();
}
// a file went to the recycle bin: the tab keeps its code, but becomes an unsaved untitled one
function onTrashed(p) {
  let hit = false;
  tabs.forEach((t, i) => {
    if (!PFExplorer.under(i === active ? currentPath : t.path, p)) return;
    hit = true;
    if (i === active) { currentPath = ''; savedText = null; } else { t.path = ''; t.saved = null; }
  });
  if (hit) { renderTabs(); updateTitle(); toast('Файл удалён. Вкладка осталась с кодом: можно сохранить его заново'); }
}

/* ───────────── files ───────────── */
const explorer = PFExplorer.create({ api, toast, onOpen: (p) => openPathInEditor(p), onRenamed, onTrashed, activePath: () => currentPath });
async function saveFile() {
  if (!currentPath) return saveAsFile();
  const text = getText();
  const r = await api.writeFile(currentPath, text);
  if (r.error) { api.showError('Ошибка', 'Не удалось записать файл.\n' + r.error); return false; }
  savedText = text; updateTitle(); renderTabs();
  toast('Сохранено');
  if (explorer.root && PFExplorer.under(currentPath, explorer.root)) explorer.refresh();
  return true;
}
async function saveAsFile() {
  const p = await api.pickSave();
  if (!p) return false;
  currentPath = p;
  return saveFile();
}
// false = the user cancelled, so the caller must stop (close tab / quit)
async function maybeSave() {
  if (!isDirty()) return true;
  const a = await api.askSave();
  if (a === 0) return saveFile();
  return a === 1;
}
// Opens in a tab; a file that is already open is just brought to front.
async function openPathInEditor(p) {
  const i = tabs.findIndex((_, k) => tabPath(k) === p);
  if (i >= 0) { switchTab(i); return true; }
  const r = await api.readFile(p);
  if (r.error) { api.showError('Ошибка', 'Не удалось открыть файл.\n' + r.error); return false; }
  const untouched = !currentPath && !isDirty() && (getText() === '' || getText() === DEFAULT_CODE);
  if (untouched) { // an empty "Безымянный" tab is replaced instead of piling up
    if (scrubbing) tmLive();
    const t = blankTab(); t.path = p; t.text = t.saved = r.text;
    tabs[active] = t; loadTab(active);
  } else newTab(r.text, p);
  return true;
}
async function openFile() {
  const p = await api.pickOpen();
  if (p) await openPathInEditor(p);
}
async function setBackground() {
  const r = await api.pickImage();
  if (!r) return;
  $('#bgimg').style.backgroundImage = 'url("' + r.url + '")';
  document.body.classList.add('hasbg');
  updateLens();
  toast('Фон применён');
}
api.onCloseRequest(async () => {
  for (let i = 0; i < tabs.length; i++) {
    if (!tabDirty(i)) continue;
    switchTab(i);
    if (!(await maybeSave())) return;
  }
  api.confirmClose();
});

/* ───────────── modes ───────────── */
const ICONS = {
  code: '<path d="M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  graph: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 8.4l2.7 7.4M15.8 8l-2.7 7.8M8.5 7h7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  pen: '<path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'
};
ICONS.robot = '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4.5M9 13h.01M15 13h.01M9.5 16.5h5M3 12.5v2M21 12.5v2"/><circle cx="12" cy="4" r=".8"/>';
const MODES = [
  ['Стандарт', '34,211,238', 'code', 'Стандартный режим'],
  ['Code-RPG', '255,77,133', 'bolt', 'Code-RPG: XP за строки, HP за ошибки, комбо'],
  ['Карта связей', '74,222,128', 'graph', 'Граф вызовов функций'],
  ['Машина времени', '255,176,46', 'clock', 'Перемотка истории кода'],
  ['Заметки', '167,139,250', 'pen', 'Рисование поверх кода'],
  ['RTX Light', '255,140,26', 'sun', 'RTX освещение: перетаскивай свет!'],
  ['Боты aiogram', '56,189,248', 'robot', 'Шаблоны для Telegram-ботов на aiogram']
];
let mode = -1;
const side = $('#side');
MODES.forEach((m, i) => {
  const b = document.createElement('button');
  b.className = 'sbtn'; b.type = 'button'; b.title = m[3]; b.setAttribute('aria-label', m[3]); b.setAttribute('aria-pressed', 'false');
  b.style.setProperty('--c', m[1]);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[m[2]] + '</svg>';
  b.addEventListener('click', () => setMode(i));
  side.appendChild(b);
});
function setMode(i) {
  if (i === mode) return;
  if (mode === 3) { clearTimeout(snapTimer); tmLive(); } // you can't leave the mode while stuck in the past
  mode = i;
  rpg.active = i === 1;
  [...side.children].forEach((b, k) => b.setAttribute('aria-pressed', k === i));
  const M = MODES[i], mn = $('#modeName');
  root.style.setProperty('--mc', M[1]);
  mn.style.setProperty('--mc', M[1]);
  mn.textContent = 'РЕЖИМ · ' + M[0].toUpperCase();
  mn.classList.remove('swap'); void mn.offsetWidth; mn.classList.add('swap');
  const sw = $('#sweep'); sw.classList.remove('go'); void sw.offsetWidth; sw.classList.add('go');
  const keep = ['hasbg', 'has-ex', 'has-chat'].filter((c) => document.body.classList.contains(c)); // classes owned by other features
  document.body.className = keep.join(' ') + (keep.length ? ' ' : '') + 'm' + i + (i === 5 ? ' rtx' : '');
  rtx = i === 5;
  $('#hud').hidden = i !== 1;
  $('#snips').hidden = i !== 0;
  $('#botbar').hidden = i !== 6;
  $('#timebar').hidden = i !== 3;
  $('#padbar').hidden = i !== 4;
  $('#stage').hidden = i === 2;
  $('#mapPane').hidden = i !== 2;
  if (i === 1) rpgRender();
  if (i === 2) { buildMap(); setVB(); }
  if (i === 3) { snapshot(); tmRefresh(); }
  requestAnimationFrame(() => { layout(); if (i !== 2) ta.focus({ preventScroll: true }); });
  setTimeout(() => { maskDirty = true; schedule(); }, 650);
}

/* ───────────── layout, keys, window ───────────── */
function layout() {
  const w = panel.clientWidth, h = panel.clientHeight;
  if (!w || !h) return;
  if (!lx && !ly) { lx = w * .64; ly = h * .3; }
  placeLight(lx, ly);
  maskDirty = true; notesSize(); drawMini(); schedule();
}
new ResizeObserver(layout).observe(panel);
addEventListener('resize', () => { maskDirty = true; schedule(); });

// e.code, not e.key: shortcuts must work on the Russian keyboard layout too
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const modal = !!document.querySelector('.modal-back');
  if (mod && !modal && e.code === 'KeyN' && !e.shiftKey) { e.preventDefault(); newTab(); return; }
  if (mod && !modal && e.code === 'KeyW') { e.preventDefault(); closeTab(active); return; }
  if (mod && !modal && e.code === 'Tab') { e.preventDefault(); switchTab((active + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length); return; }
  if (mod && !modal && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); explorer.toggle(); return; }
  if (mod && !modal && e.shiftKey && e.code === 'KeyO') { e.preventDefault(); explorer.openFolder(); return; }
  if (e.key === 'F5' || (mod && e.key === 'Enter')) { e.preventDefault(); runScript(); }
  else if (mod && e.code === 'KeyO') { e.preventDefault(); openFile(); }
  else if (mod && e.code === 'KeyS') { e.preventDefault(); e.shiftKey ? saveAsFile() : saveFile(); }
  else if (mod && e.code === 'KeyB') { e.preventDefault(); setBackground(); }
  else if (mod && e.code === 'KeyT') { e.preventDefault(); setSkin(skinIdx + 1, true); }
  else if (mod && !modal && e.shiftKey && e.code === 'KeyL') { e.preventDefault(); agent.toggle(); }
  else if (mod && !modal && e.shiftKey && e.code === 'KeyG') { e.preventDefault(); gitDialog.open(); }
  else if (mod && !modal && e.code === 'Comma') { e.preventDefault(); settings.open(); }
  else if (mod && !modal && (e.code === 'Equal' || e.code === 'NumpadAdd')) { e.preventDefault(); settings.zoomBy(0.1); }
  else if (mod && !modal && (e.code === 'Minus' || e.code === 'NumpadSubtract')) { e.preventDefault(); settings.zoomBy(-0.1); }
  else if (mod && !modal && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); settings.zoomReset(); }
});
$('#agentBtn').addEventListener('click', () => agent.toggle());
$('#gitBtn').addEventListener('click', () => gitDialog.open());
$('#setBtn').addEventListener('click', () => settings.open());
$('#themeDir').addEventListener('click', () => { if (api.openThemesFolder) api.openThemesFolder(); });
$('#skinBtn').addEventListener('click', () => setSkin(skinIdx + 1, true));
$('#wMin').addEventListener('click', () => api.minimize());
$('#wMax').addEventListener('click', () => api.toggleMaximize());
$('#wClose').addEventListener('click', () => api.close());
$('#titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.toggleMaximize(); });

const tabsWithUnsaved = () => tabs.reduce((n, _, i) => n + (tabDirty(i) && tabPath(i) ? 1 : 0), 0);
async function saveAllOpen() {
  for (let i = 0; i < tabs.length; i++) {
    if (!tabDirty(i) || !tabPath(i)) continue;
    if (i === active) { await saveFile(); continue; }
    const t = tabs[i], r = await api.writeFile(t.path, t.text);
    if (!r.error) t.saved = t.text;
  }
  renderTabs(); updateTitle();
}
function agentContext(mode) {
  const name = currentPath ? currentPath.split(/[\\/]/).pop() : 'без имени';
  if (currentPath && PF.gitRisky(currentPath) === 'secret') return { blocked: 'Файл похож на секретный (.env, ключи): код в запрос не отправляется.' };
  const code = ta.value;
  if (!code.trim()) return null;
  if (mode === 'file') return { label: 'файл ' + name, text: code };
  const a = ta.selectionStart, b = ta.selectionEnd;
  if (a !== b) return { label: 'выделение, ' + (code.slice(a, b).split('\n').length) + ' стр.', text: code.slice(a, b) };
  const line = code.slice(0, a).split('\n').length;
  let best = null;   // the innermost function that contains the cursor line (0-based defLine/endLine from parseFunctions)
  for (const f of PF.parseFunctions(code).fns) {
    if (f.defLine <= line - 1 && line - 1 <= f.endLine && (!best || f.endLine - f.defLine < best.endLine - best.defLine)) best = f;
  }
  const fx = best && PF.extractFunction(code, best.name);
  if (fx) return { label: 'функция ' + fx.name, text: fx.text };
  const rows = code.split('\n'), from = Math.max(0, line - 21);
  return { label: 'строки ' + (from + 1) + '–' + Math.min(rows.length, line + 20), text: rows.slice(from, line + 20).join('\n') };
}
function insertIntoEditor(text) {
  ta.focus();
  if (!document.execCommand('insertText', false, text)) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
  toast('Вставлено в редактор (Ctrl+Z отменяет)');
}
const agent = PFAgent.create({ api, toast, getContext: agentContext, insertCode: insertIntoEditor });
const gitDialog = PFGit.create({
  api, toast,
  getDir: () => explorer.root || (currentPath ? dirOf(currentPath) : ''),
  unsavedCount: tabsWithUnsaved, saveAll: saveAllOpen
});
const settings = PFSettings.create({
  api, toast,
  themes: () => SKINS, themeIndex: () => skinIdx, setTheme: (i) => setSkin(i, false),
  onMotion: setMotion,
  onLens: (v) => { lensPref = v; updateLens(); },
  onBase: (v) => lens.setBase(v)
});

/* ───────────── boot ───────────── */
ta.value = DEFAULT_CODE;
readSkin();
measure();
render();
setMode(0);
requestAnimationFrame(aurora);
loadThemes();
settings.apply();
settings.scheduleCheck();
if (api.winGlassInfo) api.winGlassInfo().then((g) => { if (g && g.active) { document.documentElement.dataset.clear = 'on'; lens.setClear(true); } });
renderTabs();
explorer.restore();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); render(); });
})();
