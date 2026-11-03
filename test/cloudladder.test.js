'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/cloudladder.js');
const { modelAlternates } = require('../src/renderer/toolparse.js');

const LIVE = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-embedding-001', 'imagen-4'];

test('ladder: "auto" is the whole family best-first; a named model goes first', () => {
  assert.deepEqual(L.ladder('gemini', 'auto', LIVE, modelAlternates), ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.deepEqual(L.ladder('gemini', 'models/gemini-2.5-pro', LIVE, modelAlternates), ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.deepEqual(L.ladder('anthropic', 'auto', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], modelAlternates), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(L.ladder('custom', 'local-mock', [], modelAlternates), ['local-mock'], 'no ladder outside Gemini/Claude');
  assert.equal(L.familyOf('gemini', 'auto'), 'gemini');
  assert.equal(L.familyOf('openrouter', 'google/gemini-2.5-pro'), null);
  assert.equal(L.familyOf('ollama', 'qwen3:8b'), null);
});

test('busy models rest, the next one is picked at once, and the top comes back after the rest', () => {
  const cool = new Map();
  const ladder = L.ladder('gemini', 'auto', LIVE, modelAlternates);
  const t0 = 1_000_000;
  assert.equal(L.pick(ladder, cool, t0), 'gemini-3.1-pro-preview');
  L.rest(cool, 'gemini-3.1-pro-preview', t0, false);
  assert.equal(L.pick(ladder, cool, t0 + 1), 'gemini-2.5-pro', 'no wait: straight to the next model');
  L.rest(cool, 'gemini-2.5-pro', t0, true); // unavailable on this key
  assert.equal(L.pick(ladder, cool, t0 + 2), 'gemini-2.5-flash');
  assert.equal(L.pick(ladder, cool, t0 + L.COOL_BUSY_MS + 1), 'gemini-3.1-pro-preview', 'climbs back up after the rest');
  assert.equal(L.pick(ladder, cool, t0 + L.COOL_BUSY_MS + 1) === 'gemini-2.5-pro', false, 'a dead model stays out for a day');
  for (const m of ladder) L.rest(cool, m, t0 + 100, false);
  assert.equal(L.pick(ladder, cool, t0 + 200), null);
  assert.deepEqual(L.soonest(ladder, cool, t0 + 200), { model: 'gemini-3.1-pro-preview', waitMs: L.COOL_BUSY_MS - 100 });
});
