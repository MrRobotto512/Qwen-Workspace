'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/selftest.js');

test('every core step plus the added ones must pass', () => {
  const ok = S.judge({ version: 1, steps: [{ step: 'move', passed: true, detail: 'lane 1 → 2' }, { step: 'act', passed: true, detail: 'jumped' }, { step: 'hud', passed: true, detail: 'score drawn' }] });
  assert.equal(ok.passed, true);
  assert.match(ok.text, /every step passed/);
  const bad = S.judge(JSON.stringify({ version: 1, steps: [{ step: 'Move', passed: true }, { step: 'act', passed: true }, { step: 'hud', passed: true }, { step: 'spawn', passed: false, detail: '0 coins inside the view' }] }));
  assert.equal(bad.passed, false);
  assert.match(bad.text, /1 of 4 steps failed \(spawn\)/);
  assert.match(bad.text, /✗ spawn: 0 coins inside the view/);
});

test('a missing core step fails as not tested; "passed" must be true, not truthy', () => {
  const j = S.judge({ version: 1, steps: [{ step: 'move', passed: 'yes' }, { step: 'act', passed: true }] });
  assert.equal(j.passed, false);
  assert.deepEqual(j.steps.map((s) => [s.step, s.passed]), [['move', false], ['act', true], ['hud', false]]);
  assert.match(j.text, /hud: not tested/);
});

test('unreadable and future reports are refused', () => {
  assert.equal(S.judge('not json').ok, false);
  assert.equal(S.judge({ nope: 1 }).ok, false);
  assert.equal(S.judge(null).ok, false);
  assert.match(S.judge({ version: 9, steps: [] }).text, /version 9/);
});

test('the contracts name the report shape and the system line names both kinds', () => {
  assert.match(S.WEB_CONTRACT, /window\.selfTest = async/);
  assert.match(S.DESKTOP_CONTRACT, /--self-test <file\.json>/);
  assert.match(S.SYSTEM_LINE, /window\.selfTest\(\).*--self-test/);
  assert.doesNotThrow(() => JSON.parse(S.REPORT));
});
