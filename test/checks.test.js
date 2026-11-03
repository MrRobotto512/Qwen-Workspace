'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/renderer/checks.js');

test('parseChecksFile accepts the object or array form and cleans entries', () => {
  const r = C.parseChecksFile(JSON.stringify({ checks: [{ name: 'tests', command: 'npm test' }, { command: 'npm run lint', timeoutSec: 5 }, { name: 'tests', command: 'dup' }, { command: '' }, { command: 'a\nb' }] }));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.checks, [
    { name: 'tests', command: 'npm test', timeoutSec: 300 },
    { name: 'npm run', command: 'npm run lint', timeoutSec: 10 }
  ]);
  assert.equal(C.parseChecksFile('[{"command":"pytest -q"}]').checks[0].command, 'pytest -q');
  assert.match(C.parseChecksFile('{oops').error, /not valid JSON/);
  assert.match(C.parseChecksFile('{"x":1}').error, /needs a "checks" list/);
  assert.match(C.parseChecksFile('{"checks":[]}').error, /no usable checks/);
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, command: `echo ${i}` }));
  assert.equal(C.parseChecksFile(JSON.stringify(many)).checks.length, C.MAX_CHECKS);
});

test('serializeChecks round-trips', () => {
  const checks = [{ name: 'tests', command: 'npm test', timeoutSec: 300 }, { name: 'slow', command: 'cargo test', timeoutSec: 900 }];
  const text = C.serializeChecks(checks);
  assert.doesNotMatch(text, /"timeoutSec": 300/);
  assert.deepEqual(C.parseChecksFile(text).checks, checks);
});

test('detectChecks finds the runner for npm, Python, Rust and Go projects', () => {
  assert.deepEqual(C.detectChecks({ entries: ['package.json'], pkg: { scripts: { test: 'node --test', lint: 'eslint .' } } }), [{ name: 'tests', command: 'npm test' }, { name: 'lint', command: 'npm run lint' }]);
  assert.deepEqual(C.detectChecks({ entries: ['package.json'], pkg: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }), []);
  assert.deepEqual(C.detectChecks({ entries: ['pyproject.toml', 'tests', 'calc.py'] }), [{ name: 'tests', command: 'python -m pytest -q' }]);
  assert.deepEqual(C.detectChecks({ entries: ['pyproject.toml'], pyproject: '[tool.pytest.ini_options]\n' }), [{ name: 'tests', command: 'python -m pytest -q' }]);
  assert.deepEqual(C.detectChecks({ entries: ['Cargo.toml', 'src'] }), [{ name: 'tests', command: 'cargo test' }]);
  assert.deepEqual(C.detectChecks({ entries: ['go.mod'] }), [{ name: 'tests', command: 'go test ./...' }]);
  assert.deepEqual(C.detectChecks({ entries: ['main.py'] }), []);
});

test('compareRuns: regressions win over fixes', () => {
  const before = [{ name: 'tests', ok: true }, { name: 'lint', ok: false }];
  assert.equal(C.compareRuns(before, [{ name: 'tests', ok: true }, { name: 'lint', ok: false }]).verdict, 'same');
  const better = C.compareRuns(before, [{ name: 'tests', ok: true }, { name: 'lint', ok: true }]);
  assert.equal(better.verdict, 'better');
  assert.deepEqual(better.fixed.map((r) => r.name), ['lint']);
  const mixed = C.compareRuns(before, [{ name: 'tests', ok: false }, { name: 'lint', ok: true }]);
  assert.equal(mixed.verdict, 'worse');
  assert.deepEqual(mixed.regressed.map((r) => r.name), ['tests']);
  assert.equal(C.compareRuns(before, [{ name: 'new', ok: false }]).verdict, 'same', 'checks missing from the baseline are not judged');
  assert.equal(C.statusLine(before), 'tests ✓, lint ✗');
});

test('fixPrompt carries the failing output and forbids weakening the tests', () => {
  const p = C.fixPrompt([{ name: 'tests', command: 'npm test', output: 'x'.repeat(3000) + '\nAssertionError: 2 !== 3' }]);
  assert.match(p, /^<system-reminder>/);
  assert.match(p, /"tests" \(`npm test`\) passed before this task and fails now/);
  assert.match(p, /AssertionError: 2 !== 3/);
  assert.match(p, /Do not weaken, skip or delete/);
  assert.ok(p.length < 2200);
});

test('rollbackPlan restores, removes created files, and skips anything edited since', () => {
  const before = new Map([['a.js', 'A0'], ['new.js', null], ['b.js', 'B0'], ['gone.js', 'G0'], ['same.js', 'S0']]);
  const wrote = new Map([['a.js', 'A1'], ['new.js', 'N1'], ['b.js', 'B1'], ['gone.js', null], ['same.js', 'S0']]);
  const current = new Map([['a.js', 'A1'], ['new.js', 'N1'], ['b.js', 'B1-user-edit'], ['gone.js', null], ['same.js', 'S0']]);
  const plan = C.rollbackPlan(before, wrote, current);
  assert.deepEqual(plan.restore, [{ path: 'a.js', content: 'A0' }, { path: 'gone.js', content: 'G0' }]);
  assert.deepEqual(plan.remove, ['new.js']);
  assert.deepEqual(plan.skipped, ['b.js']);
});

test('failingTests reads pytest, unittest, TAP, spec, go and cargo output', () => {
  assert.deepEqual([...C.failingTests('FAILED tests/test_a.py::test_x - AssertionError\n1 failed')], ['tests/test_a.py::test_x']);
  assert.deepEqual([...C.failingTests('FAIL: test_y (pkg.test_m.T)\n----')], ['pkg.test_m.T.test_y']);
  assert.deepEqual([...C.failingTests("    not ok 2 - subtracts\n      ---\n      failureType: 'testCodeFailure'\nnot ok 1 - math\n  ---\n  type: 'suite'\n  failureType: 'subtestsFailed'")], ['subtracts'], 'a suite failing only through its tests is skipped');
  assert.deepEqual([...C.failingTests('▶ math\n  ✔ adds (0.6ms)\n  ✖ subtracts (0.6ms)\n✖ math (2.8ms)\n\n✖ failing tests:\n\n✖ subtracts (0.6ms)')], ['subtracts']);
  assert.deepEqual([...C.failingTests('--- FAIL: TestSum (0.00s)\ntest util::tests::adds ... FAILED')], ['TestSum', 'util::tests::adds']);
  assert.equal(C.failingTests('all good').size, 0);
  assert.equal(C.testKey('tests/a.py::C::test_x[1]'), 'test_x');
  assert.equal(C.testKey('pkg.T.test_y'), 'test_y');
  assert.equal(C.testKey('TestSum/case_1'), 'TestSum');
  assert.equal(C.testKey('adds two numbers'), 'adds two numbers');
});

test('compareRuns with isNew: the task\'s own new tests are pending, broken old ones regress', () => {
  const before = new Map([['tests/test_calc.py', 'def test_add():\n    assert add(1, 2) == 3\n']]);
  const wrote = new Map([['tests/test_calc.py', 'def test_add():\n    assert add(1, 2) == 3\ndef test_total_lines():\n    assert total([]) == 0\n'], ['calc.py', 'def add(a, b): return a + b\n']]);
  const isNew = C.newTestMatcher(before, wrote);
  assert.equal(isNew('tests/test_calc.py::test_total_lines'), true);
  assert.equal(isNew('tests/test_calc.py::test_add'), false);
  const base = [{ name: 'tests', ok: true, output: '1 passed' }];
  const pending = C.compareRuns(base, [{ name: 'tests', ok: false, output: 'FAILED tests/test_calc.py::test_total_lines - NameError\n1 failed, 1 passed' }], isNew);
  assert.equal(pending.verdict, 'pending');
  assert.deepEqual(pending.pending[0].newTests, ['tests/test_calc.py::test_total_lines']);
  const worse = C.compareRuns(base, [{ name: 'tests', ok: false, output: 'FAILED tests/test_calc.py::test_add - x\nFAILED tests/test_calc.py::test_total_lines - y' }], isNew);
  assert.equal(worse.verdict, 'worse');
  assert.deepEqual(worse.regressed[0].broke, ['tests/test_calc.py::test_add']);
  assert.match(C.fixPrompt(worse.regressed), /has tests that passed before this task and fail now: tests\/test_calc.py::test_add/);
  assert.equal(C.compareRuns(base, [{ name: 'tests', ok: false, output: 'Segmentation fault' }], isNew).verdict, 'worse', 'unrecognized output is still a regression');
  // Already failing before: more broken existing tests regress; the old failure alone does not.
  const failing = [{ name: 'tests', ok: false, output: 'FAILED tests/test_calc.py::test_old - x' }];
  assert.equal(C.compareRuns(failing, [{ name: 'tests', ok: false, output: 'FAILED tests/test_calc.py::test_old - x' }], isNew).verdict, 'same');
  assert.equal(C.compareRuns(failing, [{ name: 'tests', ok: false, output: 'FAILED tests/test_calc.py::test_old - x\nFAILED tests/test_calc.py::test_add - y' }], isNew).verdict, 'worse');
  assert.match(C.pendingPrompt(pending.pending), /tests you added in this task do not pass yet[\s\S]*test_total_lines/);
});
