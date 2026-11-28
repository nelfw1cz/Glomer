/* PyForge core: pure logic with no DOM access, so it runs in the app and under `npm test`.
   Ported from the C++ sources: CodeHighlighter, CodeEditor (auto-indent), MindMapWidget, RpgModule, TimeTravelModule. */
(function (root) {
  'use strict';

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ───────── syntax highlighting (CodeHighlighter.cpp) ───────── */
  const KEYWORDS = new Set((
    'def class if elif else for while return import from as with try except finally raise pass break continue ' +
    'global nonlocal lambda yield assert del in is not and or async await'
  ).split(' '));
  const CONSTANTS = new Set(['True', 'False', 'None', 'self', 'cls']);
  const BUILTINS = new Set((
    'print len range int float str list dict set tuple open input type isinstance super enumerate zip ' +
    'sum min max abs sorted map filter bool bytes repr round any all'
  ).split(' '));

  // groups: 1 triple string, 2 comment, 3 string, 4 decorator, 5 number, 6 identifier
  const TOKEN_RE = new RegExp(
    '("""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))' +
    '|(#[^\\n]*)' +
    '|([fFrRbBuU]{0,2}"(?:\\\\.|[^"\\\\\\n])*"?|[fFrRbBuU]{0,2}\'(?:\\\\.|[^\'\\\\\\n])*\'?)' +
    '|(@[A-Za-z_][\\w.]*)' +
    '|(\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b)' +
    '|([A-Za-z_]\\w*)',
    'g'
  );

  // Returns per-line html plus a flat token list {line, col, n, k} used by the lighting pass.
  function tokenize(text) {
    const lines = [{ h: '', t: [] }];
    const meta = [];
    let col = 0;

    const add = (cls, s, fstr) => {
      s.split('\n').forEach((part, i) => {
        if (i > 0) { lines.push({ h: '', t: [] }); col = 0; }
        if (!part) return;
        const L = lines[lines.length - 1];
        if (!cls && /^\s+$/.test(part)) { L.h += esc(part); col += part.length; return; }
        let inner = esc(part);
        if (fstr) inner = inner.replace(/\{[^{}]*\}/g, (m) => '<span class="ip">' + m + '</span>');
        const k = cls || 'o';
        L.h += '<span class="t ' + k + '">' + inner + '</span>';
        L.t.push({ c: col, n: part.length, k });
        meta.push({ line: lines.length - 1, col, n: part.length });
        col += part.length;
      });
    };

    let last = 0;
    let prev = '';
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      if (m[0] === '') { TOKEN_RE.lastIndex++; continue; }
      if (m.index > last) {
        const gap = text.slice(last, m.index);
        add('', gap);
        if (/\S/.test(gap)) prev = '';
      }
      const s = m[0];
      let cls = '';
      let fstr = false;
      if (m[1]) cls = 's';
      else if (m[2]) cls = 'c';
      else if (m[3]) { cls = 's'; fstr = /^[A-Za-z]*/.exec(s)[0].toLowerCase().includes('f'); }
      else if (m[4]) cls = 'd';
      else if (m[5]) cls = 'n';
      else if (KEYWORDS.has(s)) cls = 'k';
      else if (CONSTANTS.has(s)) cls = 'co';
      else if (prev === 'def') cls = 'f';
      else if (prev === 'class') cls = 'cl';
      else if (BUILTINS.has(s)) cls = 'b';
      prev = (m[6] && (s === 'def' || s === 'class')) ? s : '';
      add(cls, s, fstr);
      last = m.index + s.length;
    }
    if (last < text.length) add('', text.slice(last));
    return { lines, meta };
  }

  /* ───────── auto-indent (CodeEditor::keyPressEvent) ───────── */
  // `before` is the text of the current line left of the cursor.
  function indentAfterEnter(before) {
    let indent = /^[ \t]*/.exec(before)[0];
    if (before.trimEnd().endsWith(':')) indent += '    ';
    return indent;
  }

  /* ───────── call graph (MindMapWidget::rebuildFromCode) ───────── */
  const DEF_RE = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

  function stripComment(line) {
    // good enough for graph building: cut an unquoted '#'
    let q = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '#') return line.slice(0, i);
    }
    return line;
  }

  function parseFunctions(code) {
    const src = code.split('\n');
    const fns = [];
    const seen = new Set();
    src.forEach((l, i) => {
      const m = DEF_RE.exec(l);
      if (m && !seen.has(m[2])) { seen.add(m[2]); fns.push({ name: m[2], indent: m[1].length, defLine: i, endLine: i, calls: [] }); }
    });
    for (const f of fns) {
      let end = f.defLine;
      for (let i = f.defLine + 1; i < src.length; i++) {
        if (!src[i].trim()) continue;
        if (/^[ \t]*[)\]]/.test(src[i])) { end = i; continue; } // closing line of a multi-line signature
        if (/^[ \t]*/.exec(src[i])[0].length <= f.indent) break;
        end = i;
      }
      f.endLine = end;
    }
    const calls = new Set();
    const edges = [];
    for (const f of fns) {
      for (const g of fns) {
        if (f.name === g.name) continue; // recursion is not drawn
        const re = new RegExp('\\b' + g.name + '\\s*\\(');
        let found = false;
        for (let i = f.defLine + 1; i <= f.endLine && !found; i++) {
          if (DEF_RE.test(src[i])) continue; // a nested def line is a definition, not a call
          if (re.test(stripComment(src[i]))) found = true;
        }
        const key = f.name + '>' + g.name;
        if (found && !calls.has(key)) { calls.add(key); edges.push([f.name, g.name]); f.calls.push(g.name); }
      }
    }
    return { fns, edges };
  }


  /* Source of one function (with its decorators), dedented. Lines are 1-based in the original code. */
  function extractFunction(code, name) {
    const f = parseFunctions(code).fns.find((x) => x.name === name);
    if (!f) return null;
    const src = code.split('\n');
    const ind = (l) => /^[ \t]*/.exec(l)[0].length;
    let start = f.defLine;
    while (start > 0 && /^[ \t]*@/.test(src[start - 1]) && ind(src[start - 1]) === f.indent) start--;
    const text = src.slice(start, f.endLine + 1).map((l) => l.slice(Math.min(f.indent, ind(l)))).join('\n');
    return { name, text, startLine: start + 1, endLine: f.endLine + 1 };
  }

  /* ───────── Code-RPG (RpgModule.cpp) ───────── */
  const MAX_HP = 100;

  class Rpg {
    constructor(onToast) {
      this.onToast = onToast || function () {};
      this.level = 1; this.xp = 0; this.hp = MAX_HP; this.combo = 0; this.bestCombo = 0;
      this.active = false;
    }
    xpNeeded() { return 100 + (this.level - 1) * 50; }
    onLineCommitted() {
      if (!this.active) return; // isolation: no XP outside the mode
      this.combo++;
      this.gainXp(4);
    }
    onRunFinished(success) {
      if (!this.active) return;
      if (success) {
        this.combo++;
        this.hp = Math.min(MAX_HP, this.hp + 5);
        this.gainXp(30);
      } else {
        this.combo = 0;
        this.damage(18);
      }
    }
    gainXp(n) {
      this.xp += n;
      while (this.xp >= this.xpNeeded()) {
        this.xp -= this.xpNeeded();
        this.level++;
        this.onToast('LEVEL UP!', 'Достигнут уровень ' + this.level + '. Так держать, кодер!', 'violet');
      }
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    }
    damage(n) {
      this.hp -= n;
      if (this.hp <= 0) {
        this.hp = MAX_HP;
        this.xp = Math.max(0, this.xp - 30);
        this.onToast('ВЫ ПОГИБЛИ', 'Код оказался сильнее. Возрождение, комбо сброшено.', 'red');
      }
    }
    // Colour of the HP bar follows the remaining health.
    hpTone() { const r = this.hp / MAX_HP; return r > 0.5 ? 'green' : (r > 0.25 ? 'amber' : 'red'); }
  }

  /* ───────── Time Travel (TimeTravelModule.cpp) ───────── */
  class History {
    constructor(max) { this.max = max || 400; this.snaps = []; }
    capture(text, time) {
      const last = this.snaps[this.snaps.length - 1];
      if (last && last.text === text) return false; // nothing changed
      this.snaps.push({ text, time: time || Date.now() });
      while (this.snaps.length > this.max) this.snaps.shift(); // ring buffer
      return true;
    }
    get size() { return this.snaps.length; }
    get last() { return this.snaps.length - 1; }
    at(i) { return this.snaps[i]; }
  }

  /* ───────── bot templates: imports and placement ───────── */
  // Adds the imports a template needs, merging names into an existing `from x import ...` line when there is one.
  function ensureImports(code, needs) {
    const lines = code.split('\n');
    const insertLine = (line) => {
      const stop = lines.findIndex((l) => /^(def |class |async def |@)/.test(l));
      const limit = stop < 0 ? lines.length : stop;
      let last = -1;
      for (let i = 0; i < limit; i++) if (/^(import|from)\s/.test(lines[i])) last = i;
      if (last >= 0) { lines.splice(last + 1, 0, line); return; }
      let i = 0;
      while (i < lines.length && /^\s*#/.test(lines[i])) i++;
      lines.splice(i, 0, line);
      if (lines[i + 1] !== undefined && lines[i + 1].trim() !== '') lines.splice(i + 1, 0, '', '');
    };
    for (const need of needs || []) {
      const m = /^from\s+(\S+)\s+import\s+(.+)$/.exec(need);
      if (m) {
        const re = new RegExp('^from\\s+' + m[1].replace(/\./g, '\\.') + '\\s+import\\s+(.+)$');
        for (const name of m[2].split(',').map((s) => s.trim())) {
          let simple = -1, has = false;
          lines.forEach((l, i) => {
            const mm = re.exec(l);
            if (!mm) return;
            let text = mm[1].replace(/#.*$/, '');
            if (text.includes('(') && !text.includes(')')) { // multi-line import: read on until the closing bracket
              for (let j = i + 1; j < lines.length; j++) { text += ' ' + lines[j].replace(/#.*$/, ''); if (lines[j].includes(')')) break; }
            }
            const names = text.replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
            if (names.includes(name)) has = true;
            if (simple < 0 && !/[()\\]/.test(mm[1])) simple = i;
          });
          if (has) continue;
          if (simple >= 0) lines[simple] += ', ' + name; else insertLine('from ' + m[1] + ' import ' + name);
        }
      } else {
        const p = /^import\s+(\S+)$/.exec(need);
        if (p && !lines.some((l) => new RegExp('^import\\s+' + p[1] + '\\b').test(l))) insertLine(need);
      }
    }
    return lines.join('\n');
  }

  // Top-level code (handlers, classes) goes before `main()` / `if __name__` so the bot registers it; otherwise to the end.
  function insertTopLevel(code, body) {
    const lines = code.split('\n');
    const idx = lines.findIndex((l) => /^(async def main\b|def main\b|if __name__\b)/.test(l));
    const offset = idx < 0 ? code.length : lines.slice(0, idx).join('\n').length + (idx > 0 ? 1 : 0);
    const before = code.slice(0, offset).replace(/\s+$/, '');
    const after = code.slice(offset);
    const b = body.replace(/\s+$/, '');
    const prefix = before ? before + '\n\n\n' : '';
    return { text: prefix + b + '\n' + (after ? '\n\n' + after : ''), caret: prefix.length + b.length };
  }


  /* Theme files: validate and sanitize untrusted JSON. Returns {ok, theme, warnings} or {ok:false, error}. */
  const SAFE_VAL = /^[#\w\s.,%()'"\/-]*$/;
  const BAD_VAL = /url\s*\(|expression|javascript:|@import|<|>|[;{}\\]/i;
  const SAFE_COL = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%\/]+\)|[a-z]{3,20})$/i;
  const DECOR_TYPES = ['vines', 'frame', 'brackets', 'map', 'none'];
  const ENUMS = { glass: ['frost', 'liquid'], texture: ['none', 'paper'], scheme: ['dark', 'light'] };
  function parseTheme(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'theme must be an object' };
    const id = String(raw.id == null ? '' : raw.id).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return { ok: false, error: 'bad id (a-z, 0-9, - _, up to 32)' };
    const warnings = [];
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 24) : (typeof raw.id === 'string' ? raw.id : id);
    const vars = {};
    for (const [k, v] of Object.entries(raw.vars && typeof raw.vars === 'object' ? raw.vars : {})) {
      if (!/^--[a-z][a-z0-9-]*$/i.test(k)) { warnings.push('var ' + k + ': name must start with --'); continue; }
      const val = String(v).trim();
      if (!val || val.length > 200 || BAD_VAL.test(val) || !SAFE_VAL.test(val)) { warnings.push('var ' + k + ': unsafe value dropped'); continue; }
      vars[k] = val;
    }
    const d = raw.decor && typeof raw.decor === 'object' ? raw.decor : {};
    let type = String(d.type || 'none');
    if (!DECOR_TYPES.includes(type)) { warnings.push('decor.type "' + type + '" unknown'); type = 'none'; }
    let inset = Number(d.inset); if (!isFinite(inset)) inset = 0;
    inset = Math.max(0, Math.min(40, inset));
    const colors = {};
    for (const [k, v] of Object.entries(d.colors && typeof d.colors === 'object' ? d.colors : {})) {
      const list = Array.isArray(v) ? v : [v];
      const ok = list.filter((c) => typeof c === 'string' && SAFE_COL.test(c.trim()));
      if (ok.length !== list.length) warnings.push('decor.colors.' + k + ': bad colour dropped');
      if (ok.length) colors[k] = Array.isArray(v) ? ok : ok[0];
    }
    const fx = {};
    for (const [k, list] of Object.entries(ENUMS)) {
      const v = raw[k] == null ? list[0] : String(raw[k]);
      if (!list.includes(v)) { warnings.push(k + ' "' + v + '" unknown (use ' + list.join(' / ') + ')'); fx[k] = list[0]; } else fx[k] = v;
    }
    return { ok: true, theme: { id, name, vars, decor: { type, inset, colors }, glass: fx.glass, texture: fx.texture, scheme: fx.scheme }, warnings };
  }


  /* 1 / 0 / -1 for "v1.2.0" vs "1.10". Pre-release suffixes are ignored. */
  function cmpVersion(a, b) {
    const p = (v) => String(v).trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
    const x = p(a), y = p(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }


  /* ───────── git helpers (pure) ───────── */
  const GIT_CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  // Parses `git status --porcelain=v1 -z`: [{x, y, path, orig, kind: new|mod|del|ren|conflict}]
  function parseGitStatus(z) {
    const t = String(z).split('\0'), out = [];
    for (let i = 0; i < t.length; i++) {
      const s = t[i];
      if (s.length < 4) continue;
      const x = s[0], y = s[1], p = s.slice(3), xy = x + y;
      let orig = '';
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') orig = t[++i] || '';
      let kind = 'mod';
      if (xy === '??') kind = 'new';
      else if (GIT_CONFLICT.has(xy)) kind = 'conflict';
      else if (orig) kind = 'ren';
      else if (x === 'D' || y === 'D') kind = 'del';
      else if (x === 'A') kind = 'new';
      out.push({ x, y, path: p, orig, kind });
    }
    return out;
  }
  // 'secret' = probably credentials, 'junk' = generated files that normally stay out of git, '' = fine
  function gitRisky(p) {
    const s = String(p).replace(/\\/g, '/');
    if (/(^|\/)\.env(\.[\w.-]+)?$/i.test(s) && !/\.(example|sample|template|dist)$/i.test(s)) return 'secret';
    if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(s) || /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/.test(s) || /(^|\/)(credentials|secrets?)(\.[\w-]+)?$/i.test(s)) return 'secret';
    if (/(^|\/)(node_modules|__pycache__|\.venv|venv)\//.test(s) || /\.pyc$/i.test(s)) return 'junk';
    return '';
  }
  // A path inside the repository: relative, no "..", no drive letter, no NUL.
  function safeRelPath(p) {
    if (typeof p !== 'string' || !p || p.length > 1000 || p.includes('\0')) return false;
    if (/^([\\/]|[A-Za-z]:)/.test(p)) return false;
    return !p.split(/[\\/]/).includes('..');
  }


  /* ───────── agent chat helpers (pure) ───────── */
  // Rough size of a prompt. Code and Cyrillic cost more than "4 chars per token", so this errs on the high side.
  const estimateTokens = (s) => Math.ceil(String(s || '').length / 3);

  const SECRET_WORD = '(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)';
  const SECRET_RES = [
    [/\b\d{5,14}:[A-Za-z0-9_-]{30,50}\b/g, '***'],                                   // Telegram bot token
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***'],                                             // OpenAI-style keys
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***'],                                        // GitHub tokens
    [new RegExp('^(\\s*[\\w.-]*' + SECRET_WORD + '[\\w.-]*\\s*[=:]\\s*)(["\'])[^"\'\\n]{8,}\\2', 'gim'), '$1$2***$2'],   // TOKEN = "long value"
    [new RegExp('^(\\s*(?:export\\s+)?[A-Z0-9_]*' + SECRET_WORD + '[A-Z0-9_]*\\s*=\\s*)[A-Za-z0-9_\\-./+=:]{12,}[ \\t]*$', 'gm'), '$1***']   // .env style
  ];
  // Hides things that look like credentials before text leaves the machine. Returns { text, count }.
  function redactSecrets(text) {
    let out = String(text), count = 0;
    for (const [re, rep] of SECRET_RES) out = out.replace(re, (...m) => { count++; return rep.replace(/\$(\d)/g, (_, i) => m[+i]); });
    return { text: out, count };
  }

  /* Builds the request. Token savers: only the last `keep` chat messages are re-sent, old questions carry no code
     (only the newest one gets the context), the context is capped and secrets are masked. */
  function buildAgentMessages({ system, history, keep, context, question, maxContextChars }) {
    const cap = maxContextChars || 12000;
    const past = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    const kept = keep > 0 ? past.slice(-keep) : [];
    let ctx = '', truncated = false, redacted = 0;
    if (context && context.text) {
      let t = context.text;
      if (t.length > cap) { t = t.slice(0, cap) + '\n… [обрезано]'; truncated = true; }
      const r = redactSecrets(t);
      redacted = r.count;
      ctx = 'Контекст (' + (context.label || 'код') + '):\n```python\n' + r.text + '\n```\n\n';
    }
    const messages = [{ role: 'system', content: system }, ...kept, { role: 'user', content: ctx + String(question) }];
    const estTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    return { messages, estTokens, truncated, redacted };
  }

  // Splits a reply into text and ``` code blocks. An unclosed fence (a reply that is still streaming) counts as code.
  function splitFences(text) {
    const parts = [], re = /```([\w+-]*)[^\S\n]*\n?/g;
    let last = 0, open = null, m;
    const s = String(text);
    while ((m = re.exec(s))) {
      if (!open) { if (m.index > last) parts.push({ type: 'text', text: s.slice(last, m.index) }); open = { lang: m[1] || '', at: re.lastIndex }; }
      else { parts.push({ type: 'code', lang: open.lang, text: s.slice(open.at, m.index).replace(/\n$/, '') }); open = null; last = re.lastIndex; }
      if (!open) last = re.lastIndex;
    }
    if (open) parts.push({ type: 'code', lang: open.lang, text: s.slice(open.at).replace(/\n$/, ''), open: true });
    else if (last < s.length) parts.push({ type: 'text', text: s.slice(last) });
    return parts;
  }

  const api = { estimateTokens, redactSecrets, buildAgentMessages, splitFences, parseGitStatus, gitRisky, safeRelPath, cmpVersion, parseTheme, esc, tokenize, indentAfterEnter, parseFunctions, extractFunction, Rpg, History, MAX_HP, ensureImports, insertTopLevel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PF = api;
})(typeof window !== 'undefined' ? window : globalThis);
