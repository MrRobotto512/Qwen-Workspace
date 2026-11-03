'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/renderer/failstreak.js');

test('signature ignores case, spacing and a trailing 2>&1', () => {
  assert.equal(F.signature('cmd', '  NPM   test 2>&1 '), F.signature('cmd', 'npm test'));
  assert.notEqual(F.signature('cmd', 'npm test'), F.signature('app', 'npm test'));
});

test('probes (grep with no hits, empty output) are not failures', () => {
  assert.equal(F.isProbe('grep -rn foo src', ''), true);
  assert.equal(F.isProbe('rg TODO', 'x'), true);
  assert.equal(F.isProbe('python main.py', ''), true);
  assert.equal(F.isProbe('python main.py', 'Traceback'), false);
});

test('fingerprint ignores numbers but sees a different error', () => {
  const a = 'FAILED tests/test_a.py::test_x - AssertionError: 3 != 4\n1 failed in 0.12s';
  const b = 'FAILED tests/test_a.py::test_x - AssertionError: 5 != 4\n1 failed in 0.31s';
  const c = 'FAILED tests/test_a.py::test_y - KeyError\n1 failed in 0.2s';
  assert.equal(F.fingerprint(a), F.fingerprint(b));
  assert.notEqual(F.fingerprint(a), F.fingerprint(c));
});

test('the same failure: analyze, last try, stop, then refuse', () => {
  const s = new Map();
  const sig = F.signature('cmd', 'npm test');
  const out = 'Error: Cannot find module ./x';
  assert.equal(F.record(s, sig, false, out).level, 'analyze');
  assert.match(F.record(s, sig, false, out).note, /failed the same way twice[\s\S]*stop/);
  assert.equal(F.blocked(s, sig), false);
  const st = F.record(s, sig, false, out);
  assert.equal(st.level, 'stop');
  assert.match(st.note, /Stop now[\s\S]*root cause you suspect/);
  assert.equal(F.blocked(s, sig), true);
});

test('a different error starts over; success clears it', () => {
  const s = new Map();
  const sig = F.signature('cmd', 'pytest -q');
  F.record(s, sig, false, 'FAILED t.py::a - x\nFAILED t.py::b - y');
  F.record(s, sig, false, 'FAILED t.py::a - x\nFAILED t.py::b - y');
  assert.equal(F.record(s, sig, false, 'FAILED t.py::b - y').level, 'analyze', 'one failing test fewer is progress');
  F.record(s, sig, true, '2 passed');
  assert.equal(s.has(sig), false);
  assert.equal(F.blocked(s, sig), false);
});

test('with the planner on call: consult first, one more try, then stop', () => {
  const s = new Map();
  const sig = F.signature('cmd', 'cargo build');
  const out = 'error[E0425]: cannot find value `x`';
  F.record(s, sig, false, out, { canConsult: true });
  F.record(s, sig, false, out, { canConsult: true });
  const st = F.record(s, sig, false, out, { canConsult: true });
  assert.equal(st.level, 'consult');
  assert.match(st.note, /consult_planner/);
  assert.equal(F.blocked(s, sig, { canConsult: true, consulted: false }), true, 'not without asking first');
  assert.equal(F.blocked(s, sig, { canConsult: true, consulted: true }), false, 'one try of its advice');
  assert.equal(F.record(s, sig, false, out, { canConsult: true, consulted: true }).level, 'stop');
  assert.equal(F.blocked(s, sig, { canConsult: true, consulted: true }), true);
});
