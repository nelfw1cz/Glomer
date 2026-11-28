'use strict';
const assert = require('assert');
const { tokenize, indentAfterEnter, parseFunctions, Rpg, History } = require('../renderer/js/core.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const classes = (src) => tokenize(src).lines.map((l) => l.t.map((t) => t.k));

/* ── highlighter ── */
test('keywords, builtins, constants, numbers', () => {
  const [c] = classes('if x is None: print(42)');
  assert.deepStrictEqual(c.filter((k) => k !== 'o'), ['k', 'k', 'co', 'b', 'n']);
});
test('def and class names get their own colour', () => {
  const [a, b] = classes('def run():\nclass Foo:');
  assert.ok(a.includes('f'));
  assert.ok(b.includes('cl'));
});
test('comment wins over code inside the same line', () => {
  const [c] = classes('x = 1  # def not_a_function');
  assert.strictEqual(c[c.length - 1], 'c');
  assert.ok(!c.includes('f'));
});
test('triple-quoted string spans lines and keeps line count', () => {
  const r = tokenize('a = """one\ntwo\nthree"""\nb = 2');
  assert.strictEqual(r.lines.length, 4);
  assert.strictEqual(r.lines[1].t[0].k, 's');
  assert.strictEqual(r.lines[2].t[0].k, 's');
});
test('f-string placeholders are marked', () => {
  const r = tokenize('print(f"hi {name}")');
  assert.ok(r.lines[0].h.includes('<span class="ip">{name}</span>'));
});
test('html is escaped', () => {
  assert.ok(tokenize('x = "<b>"').lines[0].h.includes('&lt;b&gt;'));
});
test('token columns match the source text', () => {
  const src = '    return value + 1';
  const r = tokenize(src);
  for (const m of r.meta) assert.ok(src.slice(m.col, m.col + m.n).trim().length > 0);
});

/* ── auto-indent ── */
test('Enter after colon adds 4 spaces', () => assert.strictEqual(indentAfterEnter('def f():'), '    '));
test('Enter keeps current indent', () => assert.strictEqual(indentAfterEnter('    x = 1'), '    '));
test('Enter after colon inside a block nests', () => assert.strictEqual(indentAfterEnter('    if a:'), '        '));
test('trailing spaces after colon still count', () => assert.strictEqual(indentAfterEnter('if a:   '), '    '));

/* ── call graph ── */
const SAMPLE = [
  'def greet(name):', '    print(name)', '',
  'def roll():', '    return 4', '',
  'def game(name):', '    greet(name)', '    # roll() in a comment', '    return 1', '',
  'def boss():', '    x = roll()', '    game("a")', ''
].join('\n');

test('finds all functions', () => {
  assert.deepStrictEqual(parseFunctions(SAMPLE).fns.map((f) => f.name), ['greet', 'roll', 'game', 'boss']);
});
test('finds calls and ignores comments', () => {
  const e = parseFunctions(SAMPLE).edges.map((x) => x.join('>')).sort();
  assert.deepStrictEqual(e, ['boss>game', 'boss>roll', 'game>greet']);
});
test('recursion is not drawn', () => {
  assert.strictEqual(parseFunctions('def f(n):\n    return f(n - 1)\n').edges.length, 0);
});
test('methods inside a class are found and bounded by indentation', () => {
  const g = parseFunctions('class A:\n    def a(self):\n        return 1\n    def b(self):\n        return a(1)\n');
  assert.deepStrictEqual(g.edges, [['b', 'a']]);
});
test('no functions gives empty graph', () => {
  const g = parseFunctions('x = 1\nprint(x)\n');
  assert.strictEqual(g.fns.length, 0);
  assert.strictEqual(g.edges.length, 0);
});

/* ── RPG ── */
test('XP is not awarded while the mode is inactive', () => {
  const r = new Rpg();
  r.onLineCommitted(); r.onRunFinished(true);
  assert.strictEqual(r.xp, 0); assert.strictEqual(r.combo, 0);
});
test('a committed line gives +4 XP and +1 combo', () => {
  const r = new Rpg(); r.active = true;
  r.onLineCommitted();
  assert.strictEqual(r.xp, 4); assert.strictEqual(r.combo, 1);
});
test('clean run gives +30 XP, +5 HP (capped) and combo', () => {
  const r = new Rpg(); r.active = true; r.hp = 90;
  r.onRunFinished(true);
  assert.strictEqual(r.xp, 30); assert.strictEqual(r.hp, 95); assert.strictEqual(r.combo, 1);
  r.hp = 98; r.onRunFinished(true);
  assert.strictEqual(r.hp, 100);
});
test('failed run costs 18 HP and resets combo', () => {
  const r = new Rpg(); r.active = true; r.combo = 7;
  r.onRunFinished(false);
  assert.strictEqual(r.hp, 82); assert.strictEqual(r.combo, 0);
});
test('level up carries XP over and gets more expensive', () => {
  const toasts = [];
  const r = new Rpg((t) => toasts.push(t)); r.active = true;
  r.gainXp(105);
  assert.strictEqual(r.level, 2); assert.strictEqual(r.xp, 5); assert.strictEqual(r.xpNeeded(), 150);
  assert.deepStrictEqual(toasts, ['LEVEL UP!']);
});
test('one big reward can level up several times', () => {
  const r = new Rpg(); r.active = true;
  r.gainXp(100 + 150 + 200 + 10);
  assert.strictEqual(r.level, 4); assert.strictEqual(r.xp, 10);
});
test('death respawns with full HP and an XP penalty', () => {
  const toasts = [];
  const r = new Rpg((t) => toasts.push(t)); r.active = true; r.hp = 10; r.xp = 50;
  r.onRunFinished(false);
  assert.strictEqual(r.hp, 100); assert.strictEqual(r.xp, 20); assert.deepStrictEqual(toasts, ['ВЫ ПОГИБЛИ']);
  r.xp = 5; r.hp = 5; r.damage(18);
  assert.strictEqual(r.xp, 0);
});
test('HP bar colour follows health', () => {
  const r = new Rpg();
  r.hp = 80; assert.strictEqual(r.hpTone(), 'green');
  r.hp = 40; assert.strictEqual(r.hpTone(), 'amber');
  r.hp = 10; assert.strictEqual(r.hpTone(), 'red');
});

/* ── time travel ── */
test('identical text is not captured twice', () => {
  const h = new History();
  assert.strictEqual(h.capture('a'), true);
  assert.strictEqual(h.capture('a'), false);
  assert.strictEqual(h.size, 1);
});
test('ring buffer drops the oldest snapshots', () => {
  const h = new History(5);
  for (let i = 0; i < 9; i++) h.capture('v' + i);
  assert.strictEqual(h.size, 5);
  assert.strictEqual(h.at(0).text, 'v4');
  assert.strictEqual(h.at(h.last).text, 'v8');
});
test('default capacity is 400 like the C++ version', () => {
  const h = new History();
  for (let i = 0; i < 450; i++) h.capture('v' + i);
  assert.strictEqual(h.size, 400);
});

const { extractFunction } = require('../renderer/js/core.js');
const SRC = `import x

@decorator
@other(1)
def a(p):
    # comment
    return b(p)

    # trailing


def b(q,
      r=1):
    return q


class C:
    def method(self):
        return a(1)


def sig(
    one,
    two,
):
    return one
`;
test('extractFunction: decorators included, body cut at the next def', () => {
  const r = extractFunction(SRC, 'a');
  assert.strictEqual(r.text, '@decorator\n@other(1)\ndef a(p):\n    # comment\n    return b(p)\n\n    # trailing');
  assert.strictEqual(r.startLine, 3);
});
test('extractFunction: a method is dedented', () => {
  assert.strictEqual(extractFunction(SRC, 'method').text, 'def method(self):\n    return a(1)');
});
test('extractFunction: multi-line signatures keep the whole body', () => {
  assert.strictEqual(extractFunction(SRC, 'sig').text, 'def sig(\n    one,\n    two,\n):\n    return one');
  assert.ok(extractFunction(SRC, 'b').text.endsWith('return q'));
});
test('extractFunction: unknown name gives null', () => {
  assert.strictEqual(extractFunction(SRC, 'nope'), null);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));

{
  const { cmpVersion } = require('../renderer/js/core.js');
  const t2 = (n, f) => { try { f(); console.log('  ok  ' + n); } catch (e) { console.error('FAIL  ' + n + '\n      ' + e.message); process.exitCode = 1; } };
  t2('cmpVersion compares numerically, ignores v and suffix', () => {
    assert.strictEqual(cmpVersion('v1.10.0', '1.9.9'), 1);
    assert.strictEqual(cmpVersion('0.3', '0.3.0'), 0);
    assert.strictEqual(cmpVersion('0.2.0', '0.3.0'), -1);
    assert.strictEqual(cmpVersion('1.0.0-beta', '1.0.0'), 0);
  });
}

{
  const { parseGitStatus, gitRisky, safeRelPath } = require('../renderer/js/core.js');
  const t3 = (n, f) => { try { f(); console.log('  ok  ' + n); } catch (e) { console.error('FAIL  ' + n + '\n      ' + e.message); process.exitCode = 1; } };
  t3('parseGitStatus: kinds, renames take the next token, spaces survive', () => {
    const r = parseGitStatus(' M a.py\0?? new file.py\0 D gone.py\0R  new.py\0old.py\0UU c.py\0A  added.py\0');
    assert.deepStrictEqual(r.map((f) => [f.kind, f.path, f.orig]), [['mod', 'a.py', ''], ['new', 'new file.py', ''], ['del', 'gone.py', ''], ['ren', 'new.py', 'old.py'], ['conflict', 'c.py', ''], ['new', 'added.py', '']]);
    assert.deepStrictEqual(parseGitStatus(''), []);
  });
  t3('gitRisky flags secrets and junk, lets normal files and .env.example through', () => {
    for (const p of ['.env', 'bot/.env', '.env.local', 'k/server.pem', 'id_rsa', 'a\\secrets.json']) assert.strictEqual(gitRisky(p), 'secret', p);
    for (const p of ['node_modules/x/y.js', '__pycache__/a.pyc', 'a.pyc', 'sub/.venv/lib.py']) assert.strictEqual(gitRisky(p), 'junk', p);
    for (const p of ['main.py', '.env.example', 'environment.py', 'keyboard.py', 'README.md']) assert.strictEqual(gitRisky(p), '', p);
  });
  t3('safeRelPath rejects escapes', () => {
    for (const p of ['a/b.py', 'имя.py', '[x].py']) assert.ok(safeRelPath(p), p);
    for (const p of ['', '../a', 'a/../../b', '/etc', '\\x', 'C:\\x', 'a\0b', 5, null]) assert.ok(!safeRelPath(p), String(p));
  });
}

{
  const { estimateTokens, redactSecrets, buildAgentMessages, splitFences } = require('../renderer/js/core.js');
  const t4 = (n, f) => { try { f(); console.log('  ok  ' + n); } catch (e) { console.error('FAIL  ' + n + '\n      ' + e.message); process.exitCode = 1; } };
  t4('redactSecrets masks tokens and keys, leaves ordinary code alone', () => {
    const tg = '123456789:AAE' + 'x'.repeat(32);
    const src = 'BOT_TOKEN=' + tg + '\nOPENAI_API_KEY=sk-' + 'a'.repeat(30) + '\napi_key = "supersecretvalue123"\ntoken_count = 5\nprint("token:", token)\nname = "bot"\nx = "' + tg + '"\n';
    const r = redactSecrets(src);
    assert.ok(!r.text.includes(tg) && !r.text.includes('sk-aaaa') && !r.text.includes('supersecretvalue123'), r.text);
    assert.ok(r.text.includes('token_count = 5') && r.text.includes('print("token:", token)') && r.text.includes('name = "bot"'), r.text);
    assert.ok(r.count >= 4, String(r.count));
    assert.strictEqual(redactSecrets('def f(): return 1').count, 0);
  });
  t4('buildAgentMessages: keeps only the last N messages, context only on the newest question', () => {
    const hist = [1, 2, 3, 4, 5, 6].map((i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'm' + i }));
    const r = buildAgentMessages({ system: 'S', history: hist, keep: 2, context: { label: 'функция f', text: 'def f(): pass' }, question: 'что тут?' });
    assert.deepStrictEqual(r.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.strictEqual(r.messages[1].content, 'm5');
    assert.ok(r.messages[3].content.includes('```python\ndef f(): pass\n```') && r.messages[3].content.endsWith('что тут?'));
    assert.ok(!r.messages.slice(0, 3).some((m) => m.content.includes('def f')));
    assert.strictEqual(buildAgentMessages({ system: 'S', history: hist, keep: 0, question: 'q' }).messages.length, 2);
    assert.strictEqual(buildAgentMessages({ system: 'S', history: hist, keep: 4, question: 'q' }).messages[1].content, 'm3');
  });
  t4('buildAgentMessages: caps the context, masks secrets, estimates tokens', () => {
    const big = 'x = 1\n'.repeat(5000);
    const r = buildAgentMessages({ system: 'S', history: [], keep: 4, context: { label: 'файл', text: big }, question: 'q', maxContextChars: 1000 });
    assert.ok(r.truncated && r.messages[1].content.includes('[обрезано]') && r.messages[1].content.length < 1300);
    const s = buildAgentMessages({ system: 'S', history: [], keep: 4, context: { label: 'файл', text: 'API_KEY = "abcdefghijklmnop"' }, question: 'q' });
    assert.strictEqual(s.redacted, 1);
    assert.ok(!s.messages[1].content.includes('abcdefghijklmnop'));
    assert.ok(estimateTokens('привет') >= 2 && r.estTokens > 100);
  });
  t4('splitFences: text, code, unclosed fence while streaming', () => {
    assert.deepStrictEqual(splitFences('a\n```python\nx = 1\n```\nb'), [{ type: 'text', text: 'a\n' }, { type: 'code', lang: 'python', text: 'x = 1' }, { type: 'text', text: 'b' }]);
    const o = splitFences('hi ```py\nprint(1)');
    assert.deepStrictEqual(o.map((p) => p.type), ['text', 'code']); assert.ok(o[1].open && o[1].text === 'print(1)');
    assert.deepStrictEqual(splitFences('просто текст'), [{ type: 'text', text: 'просто текст' }]);
    assert.strictEqual(splitFences('```\nA\n```\n```js\nB\n```').filter((p) => p.type === 'code').length, 2);
  });
}
