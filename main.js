'use strict';
// PyForge main process: window, file dialogs, Python runner.
// The renderer never touches Node: everything goes through preload.js and the handlers below.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const pkg = require('./package.json');
const PFcore = require('./renderer/js/core.js');
const { pathToFileURL } = require('url');

let win = null;
let allowClose = false;   // set once the renderer has confirmed there is nothing unsaved
let child = null;         // running Python process, if any
let userStopped = false;
let tmpDir = null;
let pythonCmd = null;     // cached: 'py' | 'python' | 'python3'

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ── see-through window: system blur of the desktop (Acrylic on Windows 11, vibrancy on macOS) ──
// Chosen at window creation, so the switch lives in a file next to the settings and needs a restart.
const winCfgFile = () => path.join(app.getPath('userData'), 'window.json');
function glassSupported() {
  if (process.platform === 'darwin' || process.platform === 'linux') return true; // on Linux the compositor does the blur, see the help in Settings
  if (process.platform !== 'win32') return false;
  const build = parseInt(String(os.release()).split('.')[2], 10);
  return build >= 22000; // Windows 11
}
function readWinCfg() { try { return JSON.parse(fs.readFileSync(winCfgFile(), 'utf8')) || {}; } catch (e) { return {}; } }
let glassActive = false;
function createWindow() {
  glassActive = glassSupported() && readWinCfg().clear === true;
  const glassOpts = !glassActive ? { backgroundColor: '#06080c' }
    : process.platform === 'darwin' ? { backgroundColor: '#00000000', vibrancy: 'under-window', visualEffectState: 'active' }
    : process.platform === 'linux' ? { backgroundColor: '#00000000', transparent: true }
    : { backgroundColor: '#00000000', backgroundMaterial: 'acrylic' };
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    ...glassOpts,
    show: false,
    title: 'PyForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing goes through the renderer so it can ask about unsaved changes.
  win.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      send('app:close-request');
    }
  });
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// ───────────── window ─────────────
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('app:confirm-close', () => {
  allowClose = true;
  if (win) win.close();
});

// ───────────── dialogs and files ─────────────
ipcMain.handle('dialog:ask-save', async () => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'PyForge',
    message: 'Документ был изменён.\nСохранить изменения?',
    buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return r.response; // 0 save, 1 discard, 2 cancel
});

ipcMain.handle('dialog:error', async (_e, title, message) => {
  await dialog.showMessageBox(win, {
    type: 'error',
    title: String(title || 'Ошибка'),
    message: String(message || ''),
    buttons: ['OK']
  });
});

ipcMain.handle('file:pick-open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Открыть Python-файл',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [
      { name: 'Python Files', extensions: ['py'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

const MAX_OPEN_BYTES = 5 * 1024 * 1024;
ipcMain.handle('file:read', async (_e, filePath) => {
  if (typeof filePath !== 'string') return { error: 'bad-args' };
  try {
    const st = await fs.promises.stat(filePath);
    if (st.isDirectory()) return { error: 'Это папка, а не файл.' };
    if (st.size > MAX_OPEN_BYTES) return { error: 'Файл слишком большой для редактора (больше 5 МБ).' };
    const buf = await fs.promises.readFile(filePath);
    if (buf.subarray(0, 8000).includes(0)) return { error: 'Похоже на бинарный файл, открывать его в редакторе не буду.' };
    return { text: buf.toString('utf8').replace(/^\uFEFF/, '') };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('file:pick-save', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить как...',
    defaultPath: path.join(os.homedir(), 'script.py'),
    filters: [{ name: 'Python Files', extensions: ['py'] }]
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.endsWith('.py') ? r.filePath : r.filePath + '.py';
});

ipcMain.handle('file:write', async (_e, filePath, text) => {
  if (typeof filePath !== 'string' || typeof text !== 'string') return { error: 'bad-args' };
  try {
    await fs.promises.writeFile(filePath, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('bg:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выбрать фоновое изображение',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { url: pathToFileURL(r.filePaths[0]).href };
});

// ───────────── Python runner ─────────────
// Probe py -> python -> python3 asynchronously, so the UI never freezes while looking for an interpreter.
function probe(cmd) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    let p;
    try {
      p = spawn(cmd, ['--version'], { windowsHide: true });
    } catch (_) {
      resolve(false);
      return;
    }
    timer = setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } finish(false); }, 4000);
    p.on('error', () => finish(false));
    p.on('exit', (code) => finish(code === 0));
  });
}

async function detectPython() {
  if (pythonCmd) return pythonCmd;
  for (const cmd of ['py', 'python', 'python3']) {
    if (await probe(cmd)) {
      pythonCmd = cmd;
      return cmd;
    }
  }
  return null;
}

// Scripts of a saved file run next to it (so relative paths and .env work); otherwise in the temp dir.
function runCwd(arg, fallback) {
  try { if (typeof arg === 'string' && path.isAbsolute(arg) && fs.statSync(arg).isDirectory()) return arg; } catch (e) { /* fall back */ }
  return fallback;
}

ipcMain.handle('py:run', async (_e, code, cwdArg) => {
  if (typeof code !== 'string') return { error: 'bad-args' };
  if (child) return { error: 'busy' };
  const python = await detectPython();
  if (!python) return { error: 'no-python' };
  try {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyforge-'));
    const file = path.join(tmpDir, 'main.py');
    fs.writeFileSync(file, code, 'utf8');
    userStopped = false;
    const proc = spawn(python, ['-X', 'utf8', file], {
      cwd: runCwd(cwdArg, tmpDir),
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => send('py:out', d));
    proc.stderr.on('data', (d) => send('py:err', d));
    proc.on('error', (err) => {
      if (child === proc) child = null;
      send('py:error', err && err.code === 'ENOENT' ? 'no-python' : String((err && err.message) || err));
    });
    proc.on('close', (exitCode, signal) => {
      if (child === proc) child = null;
      send('py:exit', { code: exitCode, signal, stopped: userStopped });
    });
    return { started: true, path: file };
  } catch (err) {
    child = null;
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.on('py:stop', () => {
  if (!child) return;
  userStopped = true;
  if (process.platform === 'win32') {
    // `py` is a launcher: kill the whole tree, otherwise the real python.exe keeps running.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
});

// ───────────── git (status + local commit; no push, no network) ─────────────
const GIT_MAX_FILES = 5000;
function git(args, cwd, opts) {
  const { input, timeout = 30000, env } = opts || {};
  return new Promise((resolve) => {
    let out = '', err = '', finished = false, child, timer;
    const fin = (r) => { if (finished) return; finished = true; clearTimeout(timer); resolve(r); };
    try {
      child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env } });
    } catch (e) { return resolve({ code: -1, out, err: String(e.message) }); }
    timer = setTimeout(() => { child.kill(); fin({ code: -1, out, err: err + 'timeout', timeout: true }); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 8e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => fin({ code: -1, out, err: e.message, enoent: e.code === 'ENOENT' }));
    child.on('close', (code) => fin({ code, out, err }));
    child.stdin.end(input == null ? undefined : input);
  });
}
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
// shared by status and commit: finds the repository root or says why there is none
async function gitRoot(dir) {
  if (!absNotRoot(dir)) return { error: 'bad-args' };
  if (!isDir(dir)) return { error: 'bad-dir' };
  const v = await git(['--version'], os.tmpdir());
  if (v.enoent || v.code !== 0) return { error: 'no-git' };
  const r = await git(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) return /dubious ownership|safe\.directory/i.test(r.err) ? { error: 'unsafe-repo' } : { error: 'not-repo' };
  return { root: r.out.trim() };
}
async function gitHasIdentity(root) {
  const n = await git(['config', 'user.name'], root), e = await git(['config', 'user.email'], root);
  return n.code === 0 && n.out.trim() !== '' && e.code === 0 && e.out.trim() !== '';
}
async function gitChanges(root) {
  const s = await git(['status', '--porcelain=v1', '-z', '-uall'], root, { env: { GIT_OPTIONAL_LOCKS: '0' } });
  if (s.code !== 0) return { error: 'failed', detail: s.err.trim().slice(-400) };
  return { files: PFcore.parseGitStatus(s.out) };
}
ipcMain.handle('git:status', async (_e, dir) => {
  const g = await gitRoot(dir);
  if (g.error) return g;
  const c = await gitChanges(g.root);
  if (c.error) return c;
  const b = await git(['symbolic-ref', '--short', 'HEAD'], g.root);
  return { ok: true, root: g.root, branch: b.code === 0 ? b.out.trim() : '', identity: await gitHasIdentity(g.root), files: c.files.slice(0, GIT_MAX_FILES), truncated: c.files.length > GIT_MAX_FILES };
});
ipcMain.handle('git:commit', async (_e, o) => {
  if (!o || !Array.isArray(o.files) || o.files.length < 1 || o.files.length > GIT_MAX_FILES || typeof o.message !== 'string') return { error: 'bad-args' };
  const message = o.message.replace(/\r\n/g, '\n').trim();
  if (!message || message.length > 4000 || o.files.some((f) => !PFcore.safeRelPath(f))) return { error: 'bad-args' };
  const g = await gitRoot(o.dir);
  if (g.error) return g;
  if (!(await gitHasIdentity(g.root))) return { error: 'no-identity' };
  const c = await gitChanges(g.root);
  if (c.error) return c;
  if (c.files.some((f) => f.kind === 'conflict')) return { error: 'conflict' };
  // only paths that really are changed right now may be committed, whatever the renderer sent
  const changed = new Set();
  c.files.forEach((f) => { changed.add(f.path); if (f.orig) changed.add(f.orig); });
  const files = [...new Set(o.files)].filter((f) => changed.has(f));
  if (!files.length) return { error: 'nothing' };
  const spec = files.join('\0');
  // the old name of a rename is already gone from the index, `git add` would refuse it; `commit` still needs it
  const oldNames = new Set(c.files.filter((f) => f.orig && f.kind === 'ren').map((f) => f.orig));
  const addList = files.filter((f) => !oldNames.has(f));
  const add = addList.length
    ? await git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], g.root, { input: addList.join('\0') })
    : { code: 0, err: '' };
  if (add.code !== 0) return { error: /index\.lock/.test(add.err) ? 'locked' : 'failed', detail: add.err.trim().slice(-400) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-msg-'));
  const msgFile = path.join(tmp, 'msg.txt');
  try {
    fs.writeFileSync(msgFile, message + '\n', { encoding: 'utf8', mode: 0o600 });
    const cm = await git(['--literal-pathspecs', 'commit', '-F', msgFile, '--pathspec-from-file=-', '--pathspec-file-nul'], g.root, { input: spec, timeout: 120000 });
    if (cm.code !== 0) {
      const t = cm.err + cm.out;
      if (/nothing (added )?to commit|no changes added/i.test(t)) return { error: 'nothing' };
      if (/index\.lock/.test(t)) return { error: 'locked' };
      if (/partial commit during a merge/i.test(t)) return { error: 'merging' };
      if (/Author identity unknown|unable to auto-detect email/i.test(t)) return { error: 'no-identity' };
      return { error: 'failed', detail: t.trim().slice(-400) };
    }
    const h = await git(['rev-parse', '--short', 'HEAD'], g.root);
    return { ok: true, hash: h.out.trim(), count: files.length };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

ipcMain.handle('win:glass-info', async () => ({ platform: process.platform, supported: glassSupported(), enabled: glassSupported() && readWinCfg().clear === true, active: glassActive }));
ipcMain.handle('win:glass-set', async (_e, on) => {
  if (typeof on !== 'boolean' || !glassSupported()) return { error: 'unsupported' };
  try { fs.writeFileSync(winCfgFile(), JSON.stringify({ ...readWinCfg(), clear: on })); } catch (e) { return { error: String(e.message) }; }
  return { ok: true };
});

// ───────────── agent chat (OpenAI-compatible API). The key lives only here, encrypted; the renderer never sees it. ─────────────
const AI_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: '', maxTokens: 700, keep: 4, budget: 60000 };
const AI_MAX_CHARS = 80000;           // hard stop against an accidental huge (= expensive) request
const aiFile = () => path.join(app.getPath('userData'), 'ai.json');
function aiRead() { try { return { ...AI_DEFAULTS, ...JSON.parse(fs.readFileSync(aiFile(), 'utf8')) }; } catch (e) { return { ...AI_DEFAULTS }; } }
function aiKey(c) {
  if (c.key && safeStorage.isEncryptionAvailable()) { try { return safeStorage.decryptString(Buffer.from(c.key, 'base64')); } catch (e) { /* unreadable → fall through */ } }
  return String(process.env.PYFORGE_API_KEY || '');   // fallback for systems without a keyring
}
// https anywhere, plain http only for a server on this machine (Ollama, LM Studio…)
function aiBaseUrlOk(u) {
  try {
    const x = new URL(u);
    if (x.username || x.password || x.search || x.hash) return false;
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
  } catch (e) { return false; }
}
const aiPublic = (c) => ({ baseUrl: c.baseUrl, model: c.model, maxTokens: c.maxTokens, keep: c.keep, budget: c.budget, hasKey: !!aiKey(c), canStoreKey: safeStorage.isEncryptionAvailable() });
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
ipcMain.handle('ai:get', async () => aiPublic(aiRead()));
ipcMain.handle('ai:set', async (_e, o) => {
  if (!o || typeof o !== 'object') return { error: 'bad-args' };
  const c = aiRead();
  if (o.baseUrl !== undefined) { const u = String(o.baseUrl).trim().replace(/\/+$/, ''); if (!aiBaseUrlOk(u)) return { error: 'bad-url' }; c.baseUrl = u; }
  if (o.model !== undefined) { const m = String(o.model).trim(); if (m && !/^[\w.:/@+-]{1,100}$/.test(m)) return { error: 'bad-model' }; c.model = m; }
  if (o.maxTokens !== undefined) { if (!intIn(o.maxTokens, 50, 8000)) return { error: 'bad-limit' }; c.maxTokens = o.maxTokens; }
  if (o.keep !== undefined) { if (!intIn(o.keep, 0, 12)) return { error: 'bad-limit' }; c.keep = o.keep; }
  if (o.budget !== undefined) { if (!intIn(o.budget, 0, 5000000)) return { error: 'bad-limit' }; c.budget = o.budget; }
  if (o.clearKey === true) delete c.key;
  else if (typeof o.key === 'string' && o.key.trim()) {
    const k = o.key.trim();
    if (k.length < 8 || k.length > 400 || /[\s\u0000-\u001f]/.test(k)) return { error: 'bad-key' };
    if (!safeStorage.isEncryptionAvailable()) return { error: 'no-encryption' };
    c.key = safeStorage.encryptString(k).toString('base64');
  }
  try { fs.writeFileSync(aiFile(), JSON.stringify(c), { mode: 0o600 }); } catch (e) { return { error: 'write' }; }
  return { ok: true, config: aiPublic(c) };
});

const aiActive = new Map();           // request id → AbortController
class AiError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; } }
const aiHttpCode = (s) => (s === 401 || s === 403 ? 'auth' : s === 404 ? 'not-found' : s === 402 ? 'balance' : s === 429 ? 'rate' : s === 400 ? 'bad-request' : s >= 500 ? 'server' : 'http');

// Sends one chat request and streams the text through onText. Retries (max 2) only for the two parameters that some servers refuse.
async function aiStream({ base, key, model, messages, maxTokens, signal, onText }) {
  let useUsage = true, tokenParam = 'max_tokens';
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model, messages, stream: true, [tokenParam]: maxTokens };
    if (useUsage) body.stream_options = { include_usage: true };
    let res;
    try {
      // redirect:'error' → the key can never follow a redirect to another host
      res = await fetch(base + '/chat/completions', { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
    } catch (e) { throw (signal.aborted ? new AiError(signal.reason === 'timeout' ? 'timeout' : 'aborted') : new AiError('network')); }
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 600);
      if (res.status === 400 && useUsage && /stream_options/i.test(t)) { useUsage = false; continue; }
      if (res.status === 400 && tokenParam === 'max_tokens' && /max_completion_tokens/i.test(t)) { tokenParam = 'max_completion_tokens'; continue; }
      throw new AiError(aiHttpCode(res.status), PFcore.redactSecrets(t).text);
    }
    let usage = null;
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('event-stream')) {                       // server ignored stream:true
      const j = await res.json().catch(() => null);
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof txt !== 'string') throw new AiError('bad-reply');
      onText(txt);
      if (j.usage) usage = { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens };
      return { usage };
    }
    const dec = new TextDecoder(); let buf = '';
    const line = (l) => {
      if (!l.startsWith('data:')) return;
      const d = l.slice(5).trim();
      if (!d || d === '[DONE]') return;
      let j; try { j = JSON.parse(d); } catch (e) { return; }
      if (j.error) throw new AiError('server', PFcore.redactSecrets(String(j.error.message || '')).text);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta && typeof delta.content === 'string' && delta.content) onText(delta.content);
      if (j.usage) usage = { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens };
    };
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
      }
      if (buf) line(buf.replace(/\r$/, ''));
    } catch (e) {
      if (e instanceof AiError) throw e;
      throw (signal.aborted ? new AiError(signal.reason === 'timeout' ? 'timeout' : 'aborted') : new AiError('network'));
    }
    return { usage };
  }
  throw new AiError('bad-request');
}
ipcMain.handle('ai:chat', async (e, o) => {
  const sender = e.sender;
  const say = (ch, p) => { try { if (!sender.isDestroyed || !sender.isDestroyed()) sender.send(ch, p); } catch (x) { /* window gone */ } };
  if (!o || !Number.isInteger(o.id) || !Array.isArray(o.messages) || o.messages.length < 1 || o.messages.length > 30) return { error: 'bad-args' };
  let chars = 0;
  for (const m of o.messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return { error: 'bad-args' };
    chars += m.content.length;
  }
  if (chars > AI_MAX_CHARS) return { error: 'too-big' };
  const c = aiRead(), key = aiKey(c);
  if (!c.model) return { error: 'no-model' };
  if (!key) return { error: 'no-key' };
  if (aiActive.size) return { error: 'busy' };
  const ctl = new AbortController();
  aiActive.set(o.id, ctl);
  const maxTokens = intIn(o.maxTokens, 1, 8000) ? Math.min(o.maxTokens, c.maxTokens) : c.maxTokens;
  const first = setTimeout(() => ctl.abort('timeout'), 30000), total = setTimeout(() => ctl.abort('timeout'), 240000);
  let started = false;
  (async () => {
    try {
      const r = await aiStream({ base: c.baseUrl, key, model: c.model, messages: o.messages, maxTokens, signal: ctl.signal, onText: (t) => { if (!started) { started = true; clearTimeout(first); } say('ai:chunk', { id: o.id, text: t }); } });
      say('ai:done', { id: o.id, usage: r.usage });
    } catch (err) {
      say('ai:error', { id: o.id, error: err.code || 'network', detail: err.detail || '' });
    } finally { clearTimeout(first); clearTimeout(total); aiActive.delete(o.id); }
  })();
  return { ok: true };
});
ipcMain.handle('ai:abort', async (_e, id) => { const c = aiActive.get(id); if (c) c.abort('user'); return { ok: true }; });

// ───────────── about / updates ─────────────
const REPO = (String((pkg.repository && pkg.repository.url) || pkg.repository || '').match(/([\w.-]+\/[\w.-]+?)(?:\.git)?$/) || [])[1] || '';
ipcMain.handle('app:info', async () => ({ name: 'PyForge', version: app.getVersion(), repo: REPO }));
// Only asks GitHub for the latest release and compares versions; nothing is downloaded or installed.
ipcMain.handle('app:check-update', () => new Promise((resolve) => {
  if (!REPO) return resolve({ error: 'no-repo' });
  const req = https.get({ host: 'api.github.com', path: '/repos/' + REPO + '/releases/latest', headers: { 'User-Agent': 'PyForge', Accept: 'application/vnd.github+json' }, timeout: 8000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (body.length < 200000) body += d; });
    res.on('end', () => {
      if (res.statusCode === 404) return resolve({ error: 'no-releases' });
      if (res.statusCode !== 200) return resolve({ error: 'network' });
      try {
        const j = JSON.parse(body), tag = String(j.tag_name || ''), url = String(j.html_url || '');
        if (!/^v?\d+(\.\d+){0,3}/.test(tag) || !url.startsWith('https://github.com/')) return resolve({ error: 'bad-release' });
        const current = app.getVersion();
        resolve({ ok: true, current, latest: tag.replace(/^v/i, ''), url, newer: PFcore.cmpVersion(tag, current) > 0 });
      } catch (e) { resolve({ error: 'network' }); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve({ error: 'network' }));
}));
ipcMain.handle('app:open-url', async (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://github.com/') || url.length > 300) return { error: 'bad-url' };
  await shell.openExternal(url);
  return { ok: true };
});

// ───────────── explorer (folder tree) ─────────────
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const absNotRoot = (p) => typeof p === 'string' && path.isAbsolute(p) && path.dirname(p) !== p;
function validName(n) {
  return typeof n === 'string' && n.length > 0 && n.length <= 255 && n === n.trim() &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(n) && n !== '.' && n !== '..' && !/[. ]$/.test(n);
}

ipcMain.handle('fs:pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Открыть папку', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('fs:list', async (_e, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { error: 'bad-args' };
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = ents
      .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
      .slice(0, 5000)
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }));
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
    return { entries };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});
ipcMain.handle('fs:create', async (_e, o) => {
  if (!o || typeof o.parent !== 'string' || !path.isAbsolute(o.parent)) return { error: 'bad-args' };
  if (!validName(o.name)) return { error: 'bad-name' };
  const target = path.join(o.parent, o.name);
  try {
    if (o.dir) fs.mkdirSync(target); else fs.writeFileSync(target, '', { flag: 'wx' });
    return { ok: true, path: target };
  } catch (err) {
    return { error: err && err.code === 'EEXIST' ? 'exists' : String((err && err.message) || err) };
  }
});
ipcMain.handle('fs:rename', async (_e, o) => {
  if (!o || !absNotRoot(o.path)) return { error: 'bad-args' };
  if (!validName(o.name)) return { error: 'bad-name' };
  const to = path.join(path.dirname(o.path), o.name);
  if (to === o.path) return { ok: true, path: to };
  const sameFile = process.platform === 'win32' && to.toLowerCase() === o.path.toLowerCase(); // case-only rename on Windows
  try {
    if (!sameFile && fs.existsSync(to)) return { error: 'exists' };
    fs.renameSync(o.path, to);
    return { ok: true, path: to };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});
// To the recycle bin, never a hard delete.
ipcMain.handle('fs:trash', async (_e, p) => {
  if (!absNotRoot(p)) return { error: 'bad-args' };
  try { await shell.trashItem(p); return { ok: true }; } catch (err) { return { error: String((err && err.message) || err) }; }
});
ipcMain.handle('fs:reveal', async (_e, p) => {
  if (!absNotRoot(p)) return { error: 'bad-args' };
  shell.showItemInFolder(p);
  return { ok: true };
});

// ───────────── bot projects ─────────────
const BOT_FILES = ['main.py', '.env', 'requirements.txt', 'README.md', '.gitignore'];
const TOKEN_RE = /^\d{5,14}:[A-Za-z0-9_-]{30,50}$/;
const NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

ipcMain.handle('bots:default-dir', async () => path.join(app.getPath('documents'), 'PyForge', 'bots'));
ipcMain.handle('bots:pick-dir', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Куда сохранить бота',
    defaultPath: typeof start === 'string' && start ? start : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('bots:create', async (_e, opts) => {
  if (!opts || typeof opts.parent !== 'string' || !path.isAbsolute(opts.parent) || !opts.files || typeof opts.files !== 'object') return { error: 'bad-args' };
  let name = typeof opts.name === 'string' ? opts.name.trim() : '';
  if (name && !NAME_RE.test(name)) return { error: 'bad-name' };
  const entries = Object.entries(opts.files);
  if (!entries.length || entries.some(([f, t]) => !BOT_FILES.includes(f) || typeof t !== 'string' || t.length > 200000)) return { error: 'bad-files' };
  try {
    fs.mkdirSync(opts.parent, { recursive: true });
    let dir;
    if (name) {
      dir = path.join(opts.parent, name);
      if (fs.existsSync(dir)) return { error: 'exists' };
    } else {
      for (let n = 1; n < 1000; n++) { name = 'bot-' + n; dir = path.join(opts.parent, name); if (!fs.existsSync(dir)) break; }
    }
    fs.mkdirSync(dir);
    for (const [f, t] of entries) fs.writeFileSync(path.join(dir, f), t, { encoding: 'utf8', mode: f === '.env' ? 0o600 : 0o644 });
    return { ok: true, dir, name, main: path.join(dir, 'main.py') };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});
// Only on an explicit click in the wizard: asks Telegram who this token belongs to (getMe).
ipcMain.handle('bots:check-token', (_e, token) => new Promise((resolve) => {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return resolve({ error: 'format' });
  const req = https.get({ host: 'api.telegram.org', path: '/bot' + token + '/getMe', timeout: 8000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (body.length < 20000) body += d; });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        resolve(j && j.ok && j.result ? { ok: true, username: j.result.username, name: j.result.first_name } : { error: 'rejected' });
      } catch (e) { resolve({ error: 'network' }); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve({ error: 'network' }));
}));
ipcMain.handle('bots:open-dir', async (_e, dir) => {
  try {
    if (typeof dir !== 'string' || !fs.statSync(dir).isDirectory()) return { error: 'bad-args' };
    const err = await shell.openPath(dir);
    return err ? { error: err } : { ok: true };
  } catch (e) { return { error: 'bad-args' }; }
});

// ───────────── themes ─────────────
// Built-in themes live in renderer/themes, user themes in <userData>/themes (same id overrides the built-in one).
function themeDirs() {
  return [path.join(__dirname, 'renderer', 'themes'), path.join(app.getPath('userData'), 'themes')];
}
ipcMain.handle('themes:list', async () => {
  const out = [];
  for (const dir of themeDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort(); } catch (e) { continue; }
    for (const n of names) {
      try { out.push({ file: n, data: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^\uFEFF/, '')) }); }
      catch (e) { out.push({ file: n, error: String(e.message || e) }); }
    }
  }
  return out;
});
ipcMain.handle('themes:open-folder', async () => {
  const dir = themeDirs()[1];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ex = path.join(dir, 'example-theme.json.example');
    if (!fs.existsSync(ex)) fs.copyFileSync(path.join(themeDirs()[0], 'neon.json'), ex);
    await shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ───────────── lifecycle ─────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { allowClose = false; createWindow(); }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (child) { try { child.kill(); } catch (_) { /* ignore */ } }
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});
