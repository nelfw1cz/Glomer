'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTheme } = require('../renderer/js/core.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const dir = path.join(__dirname, '..', 'renderer', 'themes');
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('built-in themes are valid and have no warnings', () => {
  for (const f of ['neon.json', 'jungle.json', 'medieval.json']) {
    const r = parseTheme(load(f));
    assert.ok(r.ok, f + ': ' + r.error);
    assert.deepStrictEqual(r.warnings, [], f);
  }
});
test('every built-in theme defines the same colour variables as neon', () => {
  const ref = Object.keys(load('neon.json').vars).sort();
  for (const f of ['jungle.json', 'medieval.json']) {
    const keys = Object.keys(load(f).vars).filter((k) => k !== '--ui').sort();
    assert.deepStrictEqual(keys, ref, f);
  }
});
test('decor types: vines, frame, brackets', () => {
  assert.deepStrictEqual(['neon', 'jungle', 'medieval'].map((n) => parseTheme(load(n + '.json')).theme.decor.type), ['brackets', 'vines', 'frame']);
});
test('a theme needs a valid id', () => {
  assert.strictEqual(parseTheme({}).ok, false);
  assert.strictEqual(parseTheme({ id: 'bad id!' }).ok, false);
  assert.strictEqual(parseTheme([]).ok, false);
  assert.strictEqual(parseTheme(null).ok, false);
});
test('minimal theme works, name falls back to id', () => {
  const r = parseTheme({ id: 'Mine' });
  assert.ok(r.ok);
  assert.strictEqual(r.theme.id, 'mine'); assert.strictEqual(r.theme.name, 'Mine');
  assert.strictEqual(r.theme.decor.type, 'none');
});
test('dangerous CSS values are dropped, the theme still loads', () => {
  const r = parseTheme({ id: 'x', vars: {
    '--bg': '#000', '--a': 'url(http://evil/x.png)', '--b': 'red; } body { display:none', '--c': '</style>', 'color': 'red'
  } });
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(r.theme.vars), ['--bg']);
  assert.strictEqual(r.warnings.length, 4);
});
test('decor: unknown type, bad colours and inset are handled', () => {
  const r = parseTheme({ id: 'x', decor: { type: 'lasers', inset: 999, colors: { vine: 'javascript:1', leaf: ['#fff', 'rgb(1,2,3)'], gold: '#e0a84a' } } });
  assert.ok(r.ok);
  assert.strictEqual(r.theme.decor.type, 'none');
  assert.strictEqual(r.theme.decor.inset, 40);
  assert.deepStrictEqual(Object.keys(r.theme.decor.colors).sort(), ['gold', 'leaf']);
  assert.ok(r.warnings.length >= 2);
});
test('font stacks with quotes are allowed', () => {
  const r = parseTheme({ id: 'f', vars: { '--ui': "Georgia, 'Palatino Linotype', serif" } });
  assert.strictEqual(r.theme.vars['--ui'], "Georgia, 'Palatino Linotype', serif");
});

test('new themes (pirate, liquid) are valid, complete and carry their effects', () => {
  const ref = Object.keys(load('neon.json').vars);
  for (const [f, fx] of [['pirate.json', { scheme: 'light', texture: 'paper', glass: 'frost' }], ['liquid.json', { scheme: 'dark', texture: 'none', glass: 'liquid' }]]) {
    const r = parseTheme(load(f));
    assert.ok(r.ok && r.warnings.length === 0, f + ' ' + JSON.stringify(r.warnings));
    for (const k of ref) assert.ok(k in r.theme.vars, f + ' misses ' + k);
    assert.deepStrictEqual({ scheme: r.theme.scheme, texture: r.theme.texture, glass: r.theme.glass }, fx, f);
  }
  assert.strictEqual(parseTheme(load('pirate.json')).theme.decor.type, 'map');
});
test('glass / texture / scheme: defaults, and unknown values fall back with a warning', () => {
  const d = parseTheme({ id: 'x' }).theme;
  assert.deepStrictEqual([d.glass, d.texture, d.scheme], ['frost', 'none', 'dark']);
  const r = parseTheme({ id: 'x', glass: 'lava', texture: 'paper', scheme: 'sepia' });
  assert.deepStrictEqual([r.theme.glass, r.theme.texture, r.theme.scheme], ['frost', 'paper', 'dark']);
  assert.strictEqual(r.warnings.length, 2);
});
test('light themes override the dark-theme tints (hover / on-accent / error colours)', () => {
  const v = parseTheme(load('pirate.json')).theme.vars;
  for (const k of ['--hl', '--on-acc', '--chip-fg', '--console-fg', '--err']) assert.ok(k in v, k);
});

console.log('\n' + passed + ' passed');
