/* Decor layer: ornaments drawn with code on a canvas over the window edges (vines, frame, neon brackets).
   Layout is deterministic (seeded), only the sway animates. */
(function (root) {
  'use strict';

  const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  function leaf(ctx, x, y, ang, L, color) {
    const W = L * 0.38;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(L * 0.5, -W, L, 0); ctx.quadraticCurveTo(L * 0.5, W, 0, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
    ctx.restore();
  }

  /* a wavy vine along the top and bottom edge, leaves swaying, orange berries */
  function vines(ctx, w, h, d, t) {
    const c = d.colors || {}, inset = d.inset || 18;
    const leafCols = [].concat(c.leaf || []).filter(Boolean);
    if (!leafCols.length) leafCols.push('#2fd37a', '#16a085', '#7be8a8');
    const vineCol = c.vine || '#c0701f', berryCol = c.berry || '#ffa63d';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    [['top', 0], ['bottom', 1]].forEach(([side, k]) => {
      const R = rng(1234 + k * 99);
      const out = side === 'top' ? 1 : -1; // direction into the window
      const base = side === 'top' ? inset * 0.45 : h - inset * 0.45;
      const ph = R() * 6, ph2 = R() * 6, amp = inset * 0.24;
      const yAt = (x) => base + out * (Math.sin(x * 0.021 + ph) * amp + Math.sin(x * 0.053 + ph2) * amp * 0.45) + Math.sin(t * 0.0011 + x * 0.01) * 0.8;

      for (const [lw, off, a] of [[2.6, 0, 1], [1.4, 3, 0.6]]) {
        ctx.strokeStyle = vineCol; ctx.globalAlpha = a; ctx.lineWidth = lw; ctx.beginPath();
        for (let x = -8; x <= w + 8; x += 6) {
          const y = yAt(x) + out * off * Math.sin(x * 0.04 + 1);
          if (x === -8) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      let x = 10 + R() * 14, i = 0;
      while (x < w - 6) {
        const y = yAt(x), slope = (yAt(x + 3) - yAt(x - 3)) / 6;
        const dir = i % 2 ? 1 : -1;
        const ang = Math.atan(slope) + dir * (0.9 + R() * 0.7) + Math.sin(t * 0.0013 + x * 0.05) * 0.1;
        leaf(ctx, x, y, ang, 13 + R() * 12, leafCols[(R() * leafCols.length) | 0]);
        if (R() < 0.28) {
          ctx.save();
          ctx.shadowColor = berryCol; ctx.shadowBlur = 6; ctx.fillStyle = berryCol;
          ctx.beginPath(); ctx.arc(x + (R() - 0.5) * 8, y + out * (3 + R() * 3), 2.2 + R() * 0.8, 0, 6.2832); ctx.fill();
          ctx.restore();
        }
        x += 24 + R() * 22; i++;
      }

      // hanging tendrils with a leaf at the tip
      for (let n = 0; n < Math.max(2, (w / 260) | 0); n++) {
        const tx = 80 + R() * (w - 160), ty = yAt(tx), len = 16 + R() * 26, sway = Math.sin(t * 0.0012 + n * 2) * 4;
        ctx.strokeStyle = vineCol; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx + sway + 6, ty + out * len * 0.5, tx + sway, ty + out * len); ctx.stroke();
        leaf(ctx, tx + sway, ty + out * len, out * 1.5 + sway * 0.05, 11 + R() * 6, leafCols[(R() * leafCols.length) | 0]);
      }
    });
  }

  /* gold double frame with corner ornaments and rivets, torch-like flicker */
  function frame(ctx, w, h, d, t) {
    const c = d.colors || {}, gold = c.gold || '#e0a84a', stone = c.stone || '#8a7a63';
    const m = (d.inset || 16) * 0.5, flick = 0.5 + 0.08 * Math.sin(t * 0.003) + 0.04 * Math.sin(t * 0.0071);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = gold; ctx.globalAlpha = flick; ctx.lineWidth = 1.4; ctx.shadowColor = gold; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.roundRect(m, m, w - 2 * m, h - 2 * m, 6); ctx.stroke();
    ctx.shadowBlur = 0; ctx.strokeStyle = stone; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.roundRect(m + 4, m + 4, w - 2 * m - 8, h - 2 * m - 8, 4); ctx.stroke();

    ctx.globalAlpha = 0.95; ctx.strokeStyle = gold; ctx.fillStyle = gold; ctx.lineWidth = 3;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const cx = sx > 0 ? m : w - m, cy = sy > 0 ? m : h - m;
      ctx.beginPath(); ctx.moveTo(cx, cy + sy * 38); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 38, cy); ctx.stroke();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
      ctx.fillRect(-4.5, -4.5, 9, 9); ctx.restore();
      ctx.beginPath(); ctx.arc(cx + sx * 14, cy + sy * 14, 2.2, 0, 6.2832); ctx.fill();
    }
    ctx.fillStyle = stone; ctx.globalAlpha = 0.8;
    for (let x = 150; x < w - 120; x += 140) for (const y of [m, h - m]) { ctx.beginPath(); ctx.arc(x, y, 2.1, 0, 6.2832); ctx.fill(); }
    for (let y = 150; y < h - 120; y += 140) for (const x of [m, w - m]) { ctx.beginPath(); ctx.arc(x, y, 2.1, 0, 6.2832); ctx.fill(); }
    ctx.fillStyle = gold; ctx.globalAlpha = 0.9;
    for (const y of [m, h - m]) { ctx.save(); ctx.translate(w / 2, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-5, -5, 10, 10); ctx.restore(); }
  }

  /* glowing corner brackets, a faint edge line and a light running along the top */
  function brackets(ctx, w, h, d, t) {
    const c = d.colors || {}, line = c.line || '#22d3ee', line2 = c.line2 || '#a78bfa';
    const m = (d.inset || 10) * 0.5, len = 40;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = line; ctx.shadowColor = line; ctx.shadowBlur = 12; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const cx = sx > 0 ? m : w - m, cy = sy > 0 ? m : h - m;
      ctx.beginPath(); ctx.moveTo(cx, cy + sy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * len, cy); ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 0.16; ctx.strokeStyle = line2; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m + len + 10, m); ctx.lineTo(w - m - len - 10, m); ctx.moveTo(m + len + 10, h - m); ctx.lineTo(w - m - len - 10, h - m); ctx.stroke();
    const run = ((t * 0.18) % (w + 200)) - 100;
    ctx.globalAlpha = 1; ctx.fillStyle = line2; ctx.shadowColor = line2; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(run, m, 2.4, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(w - run, h - m, 2.4, 0, 6.2832); ctx.fill();
  }


  /* torn, burnt map edge: the window is a sheet of parchment lying on a dark table; ragged scorched border with glowing embers */
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  function map(ctx, w, h, d, t) {
    const c = d.colors || {}, table = c.table || '#120b05', ember = c.ember || '#ff7a1a', scorch = c.scorch || '#2a1405';
    const inset = d.inset || 22, base = inset * 0.42, amp = inset * 0.4, step = 7;
    const off = (i, seed) => base + (Math.sin(i * 0.37 + seed) * 0.4 + Math.sin(i * 0.91 + seed * 2) * 0.25 + (hash(i * 3.1 + seed * 17) - 0.5) * 0.7) * amp
      + (hash(Math.floor(i / 9) + seed * 91) < 0.13 ? hash(i * 0.7 + seed) * amp * 1.3 : 0); // occasional bites
    const edge = new Path2D(), pts = [];
    for (let x = 0; x <= w; x += step) pts.push([x, off(x / step, 1)]);
    for (let y = 0; y <= h; y += step) pts.push([w - off(y / step, 2), y]);
    for (let x = w; x >= 0; x -= step) pts.push([x, h - off(x / step, 3)]);
    for (let y = h; y >= 0; y -= step) pts.push([off(y / step, 4), y]);
    pts.forEach(([x, y], i) => (i ? edge.lineTo(x, y) : edge.moveTo(x, y)));
    edge.closePath();
    const outside = new Path2D(); outside.rect(0, 0, w, h); outside.addPath(edge);
    ctx.fillStyle = table; ctx.fill(outside, 'evenodd');
    ctx.lineJoin = 'round';
    // darkening that creeps into the sheet
    for (const [lw, a] of [[64, 0.07], [36, 0.1], [18, 0.16]]) { ctx.strokeStyle = scorch; ctx.globalAlpha = a; ctx.lineWidth = lw; ctx.stroke(edge); }
    ctx.globalAlpha = 0.95; ctx.lineWidth = 7; ctx.strokeStyle = scorch; ctx.stroke(edge);
    const glow = 0.4 + 0.12 * Math.sin(t * 0.004) + 0.06 * Math.sin(t * 0.011);
    ctx.globalAlpha = glow; ctx.lineWidth = 1.6; ctx.strokeStyle = ember; ctx.shadowColor = ember; ctx.shadowBlur = 10; ctx.stroke(edge);
    ctx.shadowBlur = 0;
    for (let k = 0; k < 16; k++) { // embers that pulse at different phases
      const p = pts[Math.floor(hash(k * 5.5) * pts.length)], a = 0.25 + 0.35 * Math.max(0, Math.sin(t * 0.003 + k * 1.7));
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 16);
      g.addColorStop(0, ember); g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.globalAlpha = a; ctx.fillStyle = g; ctx.fillRect(p[0] - 16, p[1] - 16, 32, 32);
    }
  }

  const TYPES = { vines, frame, brackets, map };

  class Layer {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.decor = null; this.raf = 0; this.last = 0;
      this.osReduce = matchMedia('(prefers-reduced-motion: reduce)').matches; this.reduce = this.osReduce;
      addEventListener('resize', () => this.draw(performance.now()));
    }
    setReduce(v) {
      this.reduce = !!v;
      if (this.reduce) { cancelAnimationFrame(this.raf); this.raf = 0; } else this.loop();
      this.draw(performance.now());
    }
    set(decor) {
      this.decor = decor && TYPES[decor.type] ? decor : null;
      this.draw(performance.now());
      this.loop();
    }
    draw(t) {
      const { ctx, cv } = this;
      const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!this.decor) return;
      ctx.save();
      TYPES[this.decor.type](ctx, w, h, this.decor, this.reduce ? 0 : t);
      ctx.restore();
    }
    loop() {
      if (this.reduce || this.raf || !this.decor) return;
      const tick = (t) => {
        this.raf = 0;
        if (!this.decor || this.reduce) return;
        if (!document.hidden && t - this.last > 45) { this.last = t; this.draw(t); }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  root.PFDecor = { Layer, TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
