'use strict';
// Exercises main.js (Python runner and file IPC) against a fake `electron` module, with the real Python on this machine.
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const handlers = {};
const revealed = [];
const sent = [];
const opened = [];
const fakeElectron = {
  app: { getVersion: () => '0.3.0', getPath: () => require('os').tmpdir(), whenReady: () => Promise.resolve(), on() {}, quit() {} },
  BrowserWindow: class {
    constructor() { this.webContents = { send: (...a) => sent.push(a), setWindowOpenHandler() {}, on() {}, openDevTools() {} }; }
    once() {} on() {} loadFile() {} isDestroyed() { return false; } minimize() {} close() {}
    static getAllWindows() { return [1]; }
  },
  ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { handlers['on:' + c] = f; } },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from('enc:' + t), decryptString: (b) => b.toString().slice(4) },
  dialog: {},
  Menu: { setApplicationMenu() {} },
  shell: { openExternal: async (u) => { opened.push(u); }, openPath: async () => '', trashItem: async (p) => { fs.rmSync(p, { recursive: true, force: true }); }, showItemInFolder: (p) => { revealed.push(p); } }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 8000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } };
const events = (name) => sent.filter((s) => s[0] === name).map((s) => s[1]);
const reset = () => { sent.length = 0; };

let passed = 0, skipped = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

(async () => {
  await sleep(50); // let whenReady() register everything

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));

  await test('file write/read round trip keeps Cyrillic', async () => {
    const f = path.join(tmp, 'a.py');
    assert.deepStrictEqual(await handlers['file:write']({}, f, 'print("Привет")\n'), { ok: true });
    assert.strictEqual((await handlers['file:read']({}, f)).text, 'print("Привет")\n');
  });
  await test('BOM is stripped when reading', async () => {
    const f = path.join(tmp, 'bom.py');
    fs.writeFileSync(f, '﻿x = 1\n');
    assert.strictEqual((await handlers['file:read']({}, f)).text, 'x = 1\n');
  });
  await test('reading a missing file reports an error instead of throwing', async () => {
    assert.ok((await handlers['file:read']({}, path.join(tmp, 'nope.py'))).error);
  });
  await test('bad arguments are rejected', async () => {
    assert.deepStrictEqual(await handlers['file:write']({}, 42, 'x'), { error: 'bad-args' });
    assert.deepStrictEqual(await handlers['py:run']({}, null), { error: 'bad-args' });
  });

  // is there a Python at all?
  reset();
  const probe = await handlers['py:run']({}, 'print("probe")');
  if (probe.error === 'no-python') {
    console.log('  --  no Python on PATH: runner tests skipped, "no-python" path verified');
    skipped = 3; passed++;
  } else {
    await waitFor(() => events('py:exit').length);
    await test('stdout is streamed and exit code is 0', async () => {
      assert.ok(events('py:out').join('').includes('probe'));
      assert.strictEqual(events('py:exit')[0].code, 0);
    });
    await test('unicode output survives (-X utf8)', async () => {
      reset();
      await handlers['py:run']({}, 'print("Привет, мир ✓")');
      await waitFor(() => events('py:exit').length);
      assert.ok(events('py:out').join('').includes('Привет, мир ✓'), JSON.stringify(events('py:out')));
    });
    await test('a crashing script gives stderr and exit code 1', async () => {
      reset();
      await handlers['py:run']({}, 'raise ValueError("boom")');
      await waitFor(() => events('py:exit').length);
      assert.ok(events('py:err').join('').includes('ValueError: boom'));
      assert.strictEqual(events('py:exit')[0].code, 1);
    });
    await test('a second run while busy is refused, stop kills the first', async () => {
      reset();
      const r1 = await handlers['py:run']({}, 'import time\nprint("start", flush=True)\ntime.sleep(30)');
      assert.strictEqual(r1.started, true);
      assert.deepStrictEqual(await handlers['py:run']({}, 'print(1)'), { error: 'busy' });
      await waitFor(() => events('py:out').join('').includes('start'));
      handlers['on:py:stop']();
      await waitFor(() => events('py:exit').length);
      assert.strictEqual(events('py:exit')[0].stopped, true);
      // and the runner is free again
      reset();
      assert.strictEqual((await handlers['py:run']({}, 'print(2)')).started, true);
      await waitFor(() => events('py:exit').length);
    });
    await test('a script runs in the folder passed as cwd', async () => {
      reset();
      const dir = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      await handlers['py:run']({}, 'import os; print(os.getcwd())', dir);
      await waitFor(() => events('py:exit').length);
      assert.strictEqual(fs.realpathSync(events('py:out').join('').trim()), fs.realpathSync(dir));
    });
  }

  await test('bots:create makes bot-1, bot-2 and refuses bad input', async () => {
    const parent = path.join(tmp, 'bots');
    const files = { 'main.py': 'print(1)\n', '.env': 'BOT_TOKEN=x\n', 'requirements.txt': 'aiogram\n' };
    const a = await handlers['bots:create']({}, { parent, files });
    assert.strictEqual(a.ok, true); assert.strictEqual(a.name, 'bot-1');
    assert.strictEqual(fs.readFileSync(path.join(a.dir, '.env'), 'utf8'), 'BOT_TOKEN=x\n');
    assert.strictEqual((await handlers['bots:create']({}, { parent, files })).name, 'bot-2');
    const named = await handlers['bots:create']({}, { parent, files, name: 'мой-бот' });
    assert.strictEqual(named.name, 'мой-бот');
    assert.strictEqual((await handlers['bots:create']({}, { parent, files, name: 'мой-бот' })).error, 'exists');
    assert.strictEqual((await handlers['bots:create']({}, { parent, files, name: '../evil' })).error, 'bad-name');
    assert.strictEqual((await handlers['bots:create']({}, { parent, files: { '../x.py': 'a' } })).error, 'bad-files');
    assert.strictEqual((await handlers['bots:create']({}, { parent: 'relative', files })).error, 'bad-args');
    assert.ok(!fs.existsSync(path.join(tmp, 'evil')));
  });
  await test('bots:check-token rejects a malformed token without any network call', async () => {
    assert.deepStrictEqual(await handlers['bots:check-token']({}, 'nope'), { error: 'format' });
    assert.deepStrictEqual(await handlers['bots:check-token']({}, 42), { error: 'format' });
  });
  await test('bots:open-dir validates its argument', async () => {
    assert.deepStrictEqual(await handlers['bots:open-dir']({}, path.join(tmp, 'missing')), { error: 'bad-args' });
    assert.deepStrictEqual(await handlers['bots:open-dir']({}, 5), { error: 'bad-args' });
    assert.deepStrictEqual(await handlers['bots:open-dir']({}, tmp), { ok: true });
  });

  await test('file:read refuses binary files, folders and huge files, strips the BOM', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rd-'));
    fs.writeFileSync(path.join(d, 'bom.py'), '\uFEFFprint(1)\n');
    fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(d, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    assert.strictEqual((await handlers['file:read']({}, path.join(d, 'bom.py'))).text, 'print(1)\n');
    assert.ok((await handlers['file:read']({}, path.join(d, 'bin.dat'))).error.includes('бинарный'));
    assert.ok((await handlers['file:read']({}, path.join(d, 'big.txt'))).error.includes('большой'));
    assert.ok((await handlers['file:read']({}, d)).error.includes('папка'));
  });
  await test('fs:list: folders first, natural order, ignored folders hidden, dotfiles shown', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'ls-'));
    for (const n of ['b.py', 'a10.py', 'a2.py', '.env']) fs.writeFileSync(path.join(d, n), '');
    for (const n of ['src', '.git', 'node_modules', '__pycache__']) fs.mkdirSync(path.join(d, n));
    const r = await handlers['fs:list']({}, d);
    assert.deepStrictEqual(r.entries.map((e) => e.name), ['src', '.env', 'a2.py', 'a10.py', 'b.py']);
    assert.strictEqual(r.entries[0].dir, true); assert.strictEqual(r.entries[0].path, path.join(d, 'src'));
    assert.ok((await handlers['fs:list']({}, path.join(d, 'nope'))).error);
    assert.strictEqual((await handlers['fs:list']({}, 'relative')).error, 'bad-args');
  });
  await test('fs:create: file and folder, never overwrites, rejects bad names', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'cr-'));
    const f = await handlers['fs:create']({}, { parent: d, name: 'x.py' });
    assert.deepStrictEqual(f, { ok: true, path: path.join(d, 'x.py') });
    fs.writeFileSync(path.join(d, 'x.py'), 'keep');
    assert.strictEqual((await handlers['fs:create']({}, { parent: d, name: 'x.py' })).error, 'exists');
    assert.strictEqual(fs.readFileSync(path.join(d, 'x.py'), 'utf8'), 'keep');
    assert.strictEqual((await handlers['fs:create']({}, { parent: d, name: 'sub', dir: true })).ok, true);
    assert.ok(fs.statSync(path.join(d, 'sub')).isDirectory());
    assert.strictEqual((await handlers['fs:create']({}, { parent: d, name: 'sub', dir: true })).error, 'exists');
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'a:b', 'a?', ' a', 'a.', 'x'.repeat(256), 5]) {
      assert.strictEqual((await handlers['fs:create']({}, { parent: d, name: bad })).error, 'bad-name', JSON.stringify(bad));
    }
    assert.strictEqual((await handlers['fs:create']({}, { parent: 'rel', name: 'a' })).error, 'bad-args');
  });
  await test('fs:rename: renames in place, refuses an existing target and bad names', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rn-'));
    fs.writeFileSync(path.join(d, 'a.py'), 'A'); fs.writeFileSync(path.join(d, 'b.py'), 'B');
    const r = await handlers['fs:rename']({}, { path: path.join(d, 'a.py'), name: 'c.py' });
    assert.deepStrictEqual(r, { ok: true, path: path.join(d, 'c.py') });
    assert.ok(!fs.existsSync(path.join(d, 'a.py')));
    assert.strictEqual((await handlers['fs:rename']({}, { path: path.join(d, 'c.py'), name: 'b.py' })).error, 'exists');
    assert.strictEqual(fs.readFileSync(path.join(d, 'b.py'), 'utf8'), 'B');
    assert.strictEqual((await handlers['fs:rename']({}, { path: path.join(d, 'c.py'), name: '../x' })).error, 'bad-name');
    assert.strictEqual((await handlers['fs:rename']({}, { path: path.parse(d).root, name: 'x' })).error, 'bad-args');
    assert.strictEqual((await handlers['fs:rename']({}, { path: path.join(d, 'c.py'), name: 'c.py' })).ok, true);
  });
  await test('fs:trash and fs:reveal validate paths and use the shell', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'tr-'));
    fs.writeFileSync(path.join(d, 'gone.py'), '');
    assert.deepStrictEqual(await handlers['fs:trash']({}, path.join(d, 'gone.py')), { ok: true });
    assert.ok(!fs.existsSync(path.join(d, 'gone.py')));
    assert.strictEqual((await handlers['fs:trash']({}, 'rel')).error, 'bad-args');
    assert.strictEqual((await handlers['fs:trash']({}, path.parse(d).root)).error, 'bad-args');
    assert.deepStrictEqual(await handlers['fs:reveal']({}, d), { ok: true });
    assert.deepStrictEqual(revealed, [d]);
    assert.strictEqual((await handlers['fs:reveal']({}, 7)).error, 'bad-args');
  });

  const https = require('https');
  const fakeGet = (status, body) => (opts, cb) => {
    const { EventEmitter } = require('events');
    const res = new EventEmitter(); res.statusCode = status; res.setEncoding = () => {};
    const req = new EventEmitter(); req.destroy = () => {};
    setImmediate(() => { cb(res); res.emit('data', body); res.emit('end'); });
    return req;
  };
  const realGet = https.get;
  await test('app:info reports version and repo', async () => {
    const i = await handlers['app:info']();
    assert.strictEqual(i.version, '0.3.0'); assert.strictEqual(i.repo, 'nelfw1cz/Glomer');
  });
  await test('update check: newer / same / 404 / garbage / foreign url', async () => {
    const rel = (tag, url) => JSON.stringify({ tag_name: tag, html_url: url });
    https.get = fakeGet(200, rel('v0.4.0', 'https://github.com/nelfw1cz/Glomer/releases/tag/v0.4.0'));
    let r = await handlers['app:check-update'](); assert.ok(r.ok && r.newer && r.latest === '0.4.0');
    https.get = fakeGet(200, rel('v0.3.0', 'https://github.com/x/y'));
    r = await handlers['app:check-update'](); assert.ok(r.ok && !r.newer);
    https.get = fakeGet(404, ''); assert.strictEqual((await handlers['app:check-update']()).error, 'no-releases');
    https.get = fakeGet(200, 'not json'); assert.strictEqual((await handlers['app:check-update']()).error, 'network');
    https.get = fakeGet(200, rel('v9.0.0', 'https://evil.example/x')); assert.strictEqual((await handlers['app:check-update']()).error, 'bad-release');
    https.get = realGet;
  });
  await test('open-url only allows https://github.com/', async () => {
    assert.deepStrictEqual(await handlers['app:open-url']({}, 'https://github.com/nelfw1cz/Glomer'), { ok: true });
    for (const u of ['http://github.com/x', 'https://github.com.evil.com/x', 'file:///etc/passwd', 5]) assert.strictEqual((await handlers['app:open-url']({}, u)).error, 'bad-url');
    assert.deepStrictEqual(opened, ['https://github.com/nelfw1cz/Glomer']);
  });

  /* ── git: real repositories in temp dirs ── */
  const { execFileSync } = require('child_process');
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (e) { hasGit = false; }
  if (!hasGit) { skipped++; console.log('  skip git tests (git not installed)'); } else {
    process.env.GIT_CONFIG_GLOBAL = os.devnull; process.env.GIT_CONFIG_NOSYSTEM = '1';
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const G = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    const W = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
    G('init', '-q');
    const paths = (r) => r.files.map((f) => f.path).sort();
    await test('git status: bad args, missing folder, not a repository', async () => {
      assert.strictEqual((await handlers['git:status']({}, 'rel')).error, 'bad-args');
      assert.strictEqual((await handlers['git:status']({}, path.join(tmp, 'nope'))).error, 'bad-dir');
      assert.strictEqual((await handlers['git:status']({}, fs.mkdtempSync(path.join(tmp, 'plain-')))).error, 'not-repo');
    });
    await test('git status lists new files (also in subfolders), reports identity', async () => {
      W('a.py', 'a = 1\n'); W('.env', 'BOT_TOKEN=x\n'); W('sub/b.py', 'b = 1\n'); W('имя файла.py', 'c = 1\n'); W('[x].py', 'd = 1\n');
      const r = await handlers['git:status']({}, path.join(repo, 'sub'));   // asked from a subfolder
      assert.ok(r.ok);
      assert.deepStrictEqual(paths(r), ['.env', '[x].py', 'a.py', 'sub/b.py', 'имя файла.py'].sort());
      assert.strictEqual(r.identity, false);
      assert.ok(r.files.every((f) => f.kind === 'new'));
    });
    await test('commit is refused without git identity', async () => {
      assert.strictEqual((await handlers['git:commit']({}, { dir: repo, files: ['a.py'], message: 'x' })).error, 'no-identity');
    });
    G('config', 'user.name', 'T'); G('config', 'user.email', 't@example.com');
    await test('commit takes only the chosen files; secrets and others stay out; odd names are literal', async () => {
      assert.strictEqual((await handlers['git:status']({}, repo)).identity, true);
      const msg = 'Привет "мир" \'x\' $HOME `ls`\n\nвторая строка';
      const r = await handlers['git:commit']({}, { dir: repo, files: ['a.py', 'имя файла.py', '[x].py'], message: msg });
      assert.ok(r.ok && r.count === 3 && /^[0-9a-f]{4,}$/.test(r.hash), JSON.stringify(r));
      assert.deepStrictEqual(G('show', '--name-only', '--format=', '-z', 'HEAD').split('\0').filter(Boolean).sort(), ['[x].py', 'a.py', 'имя файла.py'].sort());
      assert.strictEqual(G('log', '-1', '--format=%B').trim(), msg);
      assert.deepStrictEqual(paths(await handlers['git:status']({}, repo)), ['.env', 'sub/b.py']);
    });
    await test('partial commit leaves other staged files staged', async () => {
      W('a.py', 'a = 2\n'); G('add', 'sub/b.py');
      const r = await handlers['git:commit']({}, { dir: repo, files: ['a.py'], message: 'only a' });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(G('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['a.py']);
      assert.ok(G('diff', '--cached', '--name-only').includes('sub/b.py'));
    });
    await test('deleted and renamed files are committed', async () => {
      fs.rmSync(path.join(repo, 'a.py')); G('mv', '[x].py', 'x2.py');
      const st = await handlers['git:status']({}, repo);
      const ren = st.files.find((f) => f.kind === 'ren');
      assert.ok(ren && ren.orig === '[x].py' && ren.path === 'x2.py', JSON.stringify(st.files));
      const r = await handlers['git:commit']({}, { dir: repo, files: ['a.py', 'x2.py', '[x].py'], message: 'del + rename' });
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(!fs.existsSync(path.join(repo, 'a.py')));
      assert.ok(G('ls-files').includes('x2.py') && !G('ls-files').includes('[x].py'));
    });
    await test('commit validates its input and ignores files that did not change', async () => {
      for (const bad of [{ files: [], message: 'x' }, { files: ['a'], message: '  ' }, { files: ['../x'], message: 'x' }, { files: ['/etc/passwd'], message: 'x' }, { files: ['C:\\x'], message: 'x' }, { files: [5], message: 'x' }])
        assert.strictEqual((await handlers['git:commit']({}, { dir: repo, ...bad })).error, 'bad-args', JSON.stringify(bad));
      assert.strictEqual((await handlers['git:commit']({}, { dir: repo, files: ['x2.py'], message: 'again' })).error, 'nothing');
      assert.strictEqual((await handlers['git:commit']({}, { dir: repo, files: ['nope.py'], message: 'x' })).error, 'nothing');
    });
    await test('a stale index.lock is reported, not hung', async () => {
      W('lock.py', '1\n'); fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
      const r = await handlers['git:commit']({}, { dir: repo, files: ['lock.py'], message: 'x' });
      fs.rmSync(path.join(repo, '.git', 'index.lock'));
      assert.strictEqual(r.error, 'locked', JSON.stringify(r));
    });
  }

  /* ── agent chat: config, key handling, streaming against a fake OpenAI-compatible server ── */
  const aiCfgPath = path.join(os.tmpdir(), 'ai.json');
  const realFetch = global.fetch;
  const sse = (...lines) => lines.map((l) => 'data: ' + (typeof l === 'string' ? l : JSON.stringify(l)) + '\n\n').join('');
  const fakeRes = (status, body, ct = 'text/event-stream') => ({ ok: status >= 200 && status < 300, status, headers: { get: () => ct },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    body: (async function* () { const b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7); })() });
  const calls = [];
  const setFetch = (fn) => { global.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return fn(calls.length, init); }; };
  const chat = async (id, extra) => {
    reset(); calls.length = 0;
    const ev = { sender: { send: (...a) => sent.push(a), isDestroyed: () => false } };
    const r = await handlers['ai:chat'](ev, { id, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Привет' }], ...extra });
    if (r.ok) await waitFor(() => events('ai:done').length + events('ai:error').length > 0);
    return r;
  };
  try { fs.rmSync(aiCfgPath, { force: true }); } catch (e) { /* none yet */ }

  await test('agent config: defaults, validation, key stored encrypted and never returned', async () => {
    let c = await handlers['ai:get']();
    assert.deepStrictEqual([c.hasKey, c.model, c.maxTokens, c.keep], [false, '', 700, 4]);
    for (const bad of [{ baseUrl: 'http://evil.example/v1' }, { baseUrl: 'ftp://x' }, { baseUrl: 'https://u:p@x.com/v1' }, { baseUrl: 'nonsense' }, { model: 'a b' }, { maxTokens: 5 }, { keep: 99 }, { key: 'short' }, { key: 'has space in key 123' }])
      assert.ok((await handlers['ai:set']({}, bad)).error, JSON.stringify(bad));
    const r = await handlers['ai:set']({}, { baseUrl: 'https://api.example.com/v1/', model: 'small-model', key: 'sk-test-1234567890', maxTokens: 300, keep: 2, budget: 20000 });
    assert.ok(r.ok && r.config.hasKey && r.config.baseUrl === 'https://api.example.com/v1');
    assert.ok(!JSON.stringify(r).includes('sk-test') && !JSON.stringify(await handlers['ai:get']()).includes('sk-test'));
    const raw = fs.readFileSync(aiCfgPath, 'utf8');
    assert.ok(!raw.includes('sk-test-1234567890'), 'key must not be stored in plain text');
    assert.strictEqual((await handlers['ai:set']({}, { baseUrl: 'http://localhost:11434/v1' })).ok, true);
    assert.strictEqual((await handlers['ai:set']({}, { baseUrl: 'https://api.example.com/v1' })).ok, true);
  });
  await test('chat streams text, reports usage, sends bearer key and capped max_tokens', async () => {
    setFetch(() => fakeRes(200, sse({ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет ✓' } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }, '[DONE]')));
    const r = await chat(1, { maxTokens: 5000 });
    assert.ok(r.ok);
    assert.strictEqual(events('ai:chunk').map((c) => c.text).join(''), 'Привет ✓');
    assert.deepStrictEqual(events('ai:done')[0].usage, { prompt: 12, completion: 3 });
    const c = calls[0];
    assert.strictEqual(c.url, 'https://api.example.com/v1/chat/completions');
    assert.strictEqual(c.init.headers.Authorization, 'Bearer sk-test-1234567890');
    assert.strictEqual(c.init.redirect, 'error');
    assert.strictEqual(c.body.max_tokens, 300, 'never above the configured cap');
    assert.strictEqual(c.body.model, 'small-model'); assert.strictEqual(c.body.stream, true);
  });
  await test('chat adapts to servers that refuse stream_options or max_tokens', async () => {
    setFetch((n) => n === 1 ? fakeRes(400, { error: { message: 'Unknown parameter: stream_options' } }, 'application/json')
      : n === 2 ? fakeRes(400, { error: { message: "Use 'max_completion_tokens' instead of 'max_tokens'" } }, 'application/json')
      : fakeRes(200, sse({ choices: [{ delta: { content: 'ok' } }] }, '[DONE]')));
    await chat(2);
    assert.strictEqual(calls.length, 3);
    assert.ok(!('stream_options' in calls[2].body) && calls[2].body.max_completion_tokens === 300 && !('max_tokens' in calls[2].body));
    assert.strictEqual(events('ai:chunk').map((c) => c.text).join(''), 'ok');
    assert.strictEqual(events('ai:done')[0].usage, null);
  });
  await test('chat copes with a server that ignores stream:true', async () => {
    setFetch(() => fakeRes(200, { choices: [{ message: { content: 'целиком' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, 'application/json'));
    await chat(3);
    assert.strictEqual(events('ai:chunk')[0].text, 'целиком'); assert.deepStrictEqual(events('ai:done')[0].usage, { prompt: 5, completion: 1 });
  });
  await test('chat errors are classified and never leak the key', async () => {
    for (const [status, code] of [[401, 'auth'], [404, 'not-found'], [429, 'rate'], [402, 'balance'], [500, 'server']]) {
      setFetch(() => fakeRes(status, { error: { message: 'Incorrect API key provided: sk-test-1234567890abcdef' } }, 'application/json'));
      await chat(10 + status);
      const e = events('ai:error')[0];
      assert.strictEqual(e.error, code);
      assert.ok(!e.detail.includes('sk-test-1234567890abcdef'), 'detail: ' + e.detail);
    }
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    await chat(20); assert.strictEqual(events('ai:error')[0].error, 'network');
    setFetch(() => fakeRes(200, sse({ error: { message: 'overloaded' } })));
    await chat(21); assert.strictEqual(events('ai:error')[0].error, 'server');
  });
  await test('chat input is validated: size, roles, missing key/model, one request at a time', async () => {
    const ev = { sender: { send() {}, isDestroyed: () => false } };
    assert.strictEqual((await handlers['ai:chat'](ev, { id: 1, messages: [{ role: 'user', content: 'x'.repeat(90000) }] })).error, 'too-big');
    assert.strictEqual((await handlers['ai:chat'](ev, { id: 1, messages: [{ role: 'root', content: 'x' }] })).error, 'bad-args');
    assert.strictEqual((await handlers['ai:chat'](ev, { id: 'a', messages: [{ role: 'user', content: 'x' }] })).error, 'bad-args');
    let release; const gate = new Promise((r) => { release = r; });
    setFetch(async (n, init) => { await gate; if (init.signal.aborted) throw new Error('aborted'); return fakeRes(200, sse('[DONE]')); });
    reset(); calls.length = 0;
    const ev2 = { sender: { send: (...a) => sent.push(a), isDestroyed: () => false } };
    assert.ok((await handlers['ai:chat'](ev2, { id: 30, messages: [{ role: 'user', content: 'x' }] })).ok);
    assert.strictEqual((await handlers['ai:chat'](ev2, { id: 31, messages: [{ role: 'user', content: 'x' }] })).error, 'busy');
    await handlers['ai:abort']({}, 30); release();
    await waitFor(() => events('ai:error').length > 0);
    assert.strictEqual(events('ai:error')[0].error, 'aborted');
    await handlers['ai:set']({}, { clearKey: true });
    assert.strictEqual((await handlers['ai:chat'](ev, { id: 32, messages: [{ role: 'user', content: 'x' }] })).error, 'no-key');
    await handlers['ai:set']({}, { model: '' });
    assert.strictEqual((await handlers['ai:chat'](ev, { id: 33, messages: [{ role: 'user', content: 'x' }] })).error, 'no-model');
  });
  global.fetch = realFetch;
  try { fs.rmSync(aiCfgPath, { force: true }); } catch (e) { /* ignore */ }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed' + (skipped ? ', ' + skipped + ' skipped' : '') + (process.exitCode ? ', some FAILED' : ''));
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
