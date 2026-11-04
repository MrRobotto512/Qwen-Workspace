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

test('a page is judged by its own steps, in the shapes models write', () => {
  // The benchmark field report: the planner's counter page returned {pass, steps: [{name, pass, detail}]}.
  const counter = { pass: true, steps: [{ name: 'starts at 0', pass: true, detail: '0' }, { name: 'plus adds one', pass: true, detail: '0 → 1' }, { name: 'minus subtracts one', pass: true, detail: '1 → 0' }] };
  const j = S.judge(counter, { game: false });
  assert.ok(j.ok && j.passed, j.text);
  assert.match(j.text, /^Self-test \(measured by the page itself\): every step passed \(3\)/);
  assert.match(j.text, /✓ plus adds one: 0 → 1/);
  const bad = S.judge({ steps: [{ id: 'plus', ok: true }, { title: 'minus', status: 'fail', message: 'still 1' }] }, { game: false });
  assert.ok(!bad.passed);
  assert.match(bad.text, /1 of 2 steps failed \(minus\) — it is not done/);
  assert.match(bad.text, /✗ minus: still 1/);
  assert.ok(S.judge([{ test: 'renders', success: true }], { game: false }).passed, 'a bare array of steps');
  assert.ok(!S.judge({ steps: [{ pass: true }] }, { game: false }).ok, 'steps without names show nothing');
  // As a game, the same report is still missing move/act/hud.
  assert.match(S.judge(counter).text, /3 of 6 steps failed \(move, act, hud\)/);
  // A report that names a core step is a game's, whatever the caller thought.
  assert.match(S.judge({ steps: [{ name: 'move', pass: true }] }, { game: false }).text, /measured by the game itself[\s\S]*✗ act/);
  // The game shape still reads as before.
  assert.ok(S.judge({ version: 1, steps: [{ step: 'move', passed: true }, { step: 'act', passed: true }, { step: 'hud', passed: true }] }).passed);
  assert.ok(!S.judge({ steps: [{ step: 'move', passed: 'true' }, { step: 'act', passed: true }, { step: 'hud', passed: true }] }).passed, 'a string is not a measured true');
});

test('which requests are games', () => {
  for (const t of ['make a 3D endless runner', 'Subway Surfers clone', 'a snake game in one html file', 'add a high score', 'the player should jump']) assert.ok(S.looksLikeGame(t), t);
  for (const t of ['Make counter.html with plus and minus buttons', 'a bar chart of sales on a canvas', 'a drawing app', 'fix the login form']) assert.ok(!S.looksLikeGame(t), t);
});
