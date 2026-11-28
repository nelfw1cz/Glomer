'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const { ensureImports, insertTopLevel } = require('../renderer/js/core.js');
const { GROUPS, SKELETON } = require('../renderer/js/bots.js');

const py = ['python3', 'python', 'py'].find((c) => { const r = spawnSync(c, ['--version']); return !r.error && r.status === 0; });
const parses = (code) => {
  const r = spawnSync(py, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr };
};
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const items = GROUPS.flatMap((g) => g.items).filter((t) => !t.skeleton);
const count = (code, re) => (code.match(re) || []).length;

test('imports are merged into an existing line', () => {
  const out = ensureImports('from aiogram.types import Message\n\nx = 1\n', ['from aiogram.types import CallbackQuery', 'from aiogram.types import Message']);
  assert.ok(out.startsWith('from aiogram.types import Message, CallbackQuery\n'), out);
});
test('ensureImports is idempotent', () => {
  const needs = ['import logging', 'from aiogram import F', 'from aiogram.types import Message'];
  const once = ensureImports('x = 1\n', needs);
  assert.strictEqual(ensureImports(once, needs), once);
});
test('plain imports are not duplicated', () => {
  assert.strictEqual(count(ensureImports(SKELETON, ['import logging']), /^import logging$/gm), 1);
});
test('parenthesised imports are respected', () => {
  const out = ensureImports('from aiogram.types import (\n    Message,\n)\n', ['from aiogram.types import Message', 'from aiogram.types import CallbackQuery']);
  assert.strictEqual(count(out, /Message/g), 1);
  assert.ok(out.includes('from aiogram.types import CallbackQuery'));
});
test('handlers go before main(), not after it', () => {
  const r = insertTopLevel(SKELETON, '@router.message()\nasync def h(m):\n    pass');
  assert.ok(r.text.indexOf('async def h') < r.text.indexOf('async def main'));
  assert.strictEqual(r.text.slice(r.caret - 4, r.caret), 'pass');
});
test('without main() the code is appended to the end', () => {
  const r = insertTopLevel('router = 1\n', 'x = 2');
  assert.strictEqual(r.text, 'router = 1\n\n\nx = 2\n');
});
test('every template has a label, a tip and a body or text', () => {
  for (const g of GROUPS) for (const t of g.items) assert.ok(t.label && t.tip && (t.body || t.text), t.label);
});

if (!py) { console.log('  --  no Python on PATH: syntax checks skipped'); }
else {
  test('the skeleton is valid Python', () => { const r = parses(SKELETON); assert.ok(r.ok, r.err); });
  test('each template is valid inside the skeleton', () => {
    for (const t of items) {
      const r = insertTopLevel(SKELETON, t.body);
      const code = ensureImports(r.text, t.needs);
      const p = parses(code);
      assert.ok(p.ok, t.label + ': ' + p.err);
    }
  });
  test('each template is valid in an empty file', () => {
    for (const t of items) {
      const r = insertTopLevel('', t.body);
      const p = parses(ensureImports(r.text, t.needs));
      assert.ok(p.ok, t.label + ': ' + p.err);
    }
  });
  test('all templates together: valid, no duplicate import lines', () => {
    let code = SKELETON;
    for (const t of items) { const r = insertTopLevel(code, t.body); code = ensureImports(r.text, t.needs); }
    const p = parses(code);
    assert.ok(p.ok, p.err);
    const importLines = code.split('\n').filter((l) => /^(import|from)\s/.test(l));
    assert.strictEqual(new Set(importLines).size, importLines.length, importLines.join('\n'));
    for (const name of ['Message', 'CallbackQuery', 'Command', 'FSMContext', 'InlineKeyboardBuilder']) {
      assert.strictEqual(count(code, new RegExp('^from .* import .*\\b' + name + '\\b', 'gm')), 1, name);
    }
  });
}
const { buildProject, TOKEN_RE, NAME_RE } = require('../renderer/js/bots.js');
const labels = items.map((t) => t.label);
const TOK = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCzgfN-s';
test('buildProject: every handler combination is valid Python', () => {
  for (const set of [[], ['/start'], labels, ['эхо', '/start', 'текст'], ['FSM-анкета', 'inline']]) {
    const { files } = buildProject(set, TOK);
    const p = parses(files['main.py']);
    assert.ok(p.ok, set.join(',') + '\n' + p.err);
  }
});
test('buildProject: token goes to .env only, never into main.py', () => {
  const { files } = buildProject(['/start'], TOK);
  assert.ok(files['.env'].includes('BOT_TOKEN=' + TOK + '\n'));
  assert.ok(!files['main.py'].includes(TOK) && !files['README.md'].includes(TOK));
  assert.ok(/^\.env$/m.test(files['.gitignore']));
});
test('buildProject: empty token is allowed and noted in the README', () => {
  const { files } = buildProject(['/start'], '');
  assert.ok(files['.env'].includes('BOT_TOKEN=\n'));
  assert.ok(files['README.md'].includes('пустой'));
});
test('buildProject: echo handler is always last, imports are not duplicated', () => {
  const { files, picked } = buildProject(['эхо', 'текст', '/start', 'callback'], TOK);
  assert.deepStrictEqual(picked, ['/start', 'текст', 'callback', 'эхо']);
  const code = files['main.py'];
  assert.ok(code.indexOf('async def echo') > code.indexOf('async def on_btn'));
  assert.ok(code.indexOf('async def echo') < code.indexOf('async def main'));
  const imp = code.split('\n').filter((l) => /^(import|from)\s/.test(l));
  assert.strictEqual(new Set(imp).size, imp.length);
});
test('buildProject: requirements mention aiogram and python-dotenv; unknown labels are ignored', () => {
  const { files, picked } = buildProject(['/start', 'нет такого'], '');
  assert.ok(/aiogram/.test(files['requirements.txt']) && /python-dotenv/.test(files['requirements.txt']));
  assert.deepStrictEqual(picked, ['/start']);
});
test('token and folder-name validation', () => {
  assert.ok(TOKEN_RE.test(TOK));
  for (const bad of ['', 'abc', '123:short', TOK + '\nX=1', ' ' + TOK, TOK + '!']) assert.ok(!TOKEN_RE.test(bad), JSON.stringify(bad));
  for (const ok of ['bot-1', 'магазин_бот', 'my_bot']) assert.ok(NAME_RE.test(ok), ok);
  for (const bad of ['', '../x', 'a/b', 'a\\b', 'x'.repeat(41), 'a b', '.env']) assert.ok(!NAME_RE.test(bad), JSON.stringify(bad));
});

console.log('\n' + passed + ' passed');
