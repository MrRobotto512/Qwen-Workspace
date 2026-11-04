'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/renderer/testgate.js');

test('which changed files need a test, and what kind they are', () => {
  for (const p of ['wc.js', 'game/index.html', 'calc.py', 'app.tsx', 'build.ps1']) assert.ok(T.isCode(p), p);
  for (const p of ['README.md', 'config.json', 'style.css', 'notes.txt', 'QWEN.md']) assert.ok(!T.isCode(p), p);
  assert.strictEqual(T.kindOf('runner.html', '<canvas>'), 'page');
  assert.strictEqual(T.kindOf('wc.js', "const f = process.argv[2];"), 'cli');
  assert.strictEqual(T.kindOf('stats.js', 'function mean() {}\nmodule.exports = { mean };'), 'module');
  assert.strictEqual(T.kindOf('lib.mjs', 'export function x() {}'), 'module');
  assert.strictEqual(T.kindOf('calc.py', 'def add(a, b):\n    return a + b\n'), 'module');
  assert.strictEqual(T.kindOf('tool.py', 'import sys\nprint(sys.argv[1])'), 'cli');
  assert.strictEqual(T.kindOf('run.py', 'print("hi")'), 'script');
});

test('the reminder names the right test for each file', () => {
  const t = T.nudgeText([{ path: 'wc.js', kind: 'cli' }, { path: 'runner.html', kind: 'page' }, { path: 'calc.py', kind: 'module' }], 'win32');
  assert.match(t, /^You changed wc\.js, runner\.html, calc\.py but have not run them since/);
  assert.match(t, /wc\.js: run it on a small example with run_command \(e\.g\. node wc\.js <example input>\) — work out the right answer for that example yourself first/);
  assert.match(t, /runner\.html: call test_app with "runner\.html"/);
  assert.match(t, /python -c "import calc; print\(calc\.<function>\(<example>\)\)"/, 'python on Windows');
  assert.match(T.nudgeText([{ path: 'calc.py', kind: 'module' }], 'linux'), /python3 -c "import calc/);
  assert.match(T.nudgeText([{ path: 'stats.js', kind: 'module' }], 'linux'), /node -e "const m = require\('\.\/stats\.js'\)/);
  assert.match(T.nudgeText([{ path: 'a.js', kind: 'script' }], 'linux'), /have not run it since/);
});

test('a user who asked not to run it is not overruled', () => {
  for (const w of ["just write the file, don't run it", 'Create the script without running it', 'do not test it yet', 'just write the code']) assert.ok(T.userSaidNoTest([w]), w);
  for (const w of ['make wc.js and check it works', 'run the tests', 'fix the bug']) assert.ok(!T.userSaidNoTest([w]), w);
});
