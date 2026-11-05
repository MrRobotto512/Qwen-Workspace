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

test('v0.58: which commands test the changed code, and what a failed test said', () => {
  assert.ok(T.isTestOf('node wc.js sample.txt', ['wc.js']));
  assert.ok(T.isTestOf('python -c "import calc; print(calc.add(1, 2))"', ['calc.py']));
  assert.ok(T.isTestOf('npm test', []) && T.isTestOf('python -m unittest', []) && T.isTestOf('pytest -x', []));
  assert.ok(!T.isTestOf('pip install requests', ['calc.py']), 'an install is not a test of calc.py');
  assert.ok(!T.isTestOf('where python', ['wc.js']));
  assert.ok(!T.isTestOf('node -e "process.exit(3)"', ['tool.js']));
  assert.ok(!T.isTestOf('npm run build', ['app.js']));
  assert.strictEqual(T.failureSummary('Page "Runner" loaded in 0.3s.\nNo console errors.\nA 1024×768 screenshot was taken, but the current model cannot see images.\nThe self-test returned no steps. It must return {"version": 1}'), 'The self-test returned no steps. It must return {"version": 1}');
  assert.strictEqual(T.failureSummary('Exit code: 1\nexpected "3 7 34", got "4 7 34"'), 'Exit code: 1 · expected "3 7 34", got "4 7 34"');
  assert.match(T.failedTestText({ tool: 'test_app', target: 'runner.html', summary: 'The self-test returned no steps.' }), /^Your last test failed — test_app runner\.html: The self-test returned no steps\. The task is not done while it fails\./);
  assert.match(T.failedTestText({ tool: 'run_command', target: 'node wc.js s.txt', summary: 'x' }), /`node wc\.js s\.txt`/);
  const b = T.brokenText([{ path: 'config.json', line: 7, message: 'Unexpected non-whitespace character after JSON', text: '}' }]);
  assert.match(b, /^config\.json still has a syntax error[\s\S]*config\.json line 7: Unexpected non-whitespace character after JSON \(line 7 is: \}\)[\s\S]*rewrite whole with write_file/);
});
