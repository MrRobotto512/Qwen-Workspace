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

test('a used-up quota is told apart from busy, and rests until it resets', () => {
  const free = 'HTTP 429 from https://generativelanguage.googleapis.com/v1beta/openai: [{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, model: gemini-3.1-pro. Please retry in 33.5s.","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}]';
  const q = L.quotaInfo(free);
  assert.equal(q.freeTier, true);
  assert.equal(q.daily, true);
  assert.equal(q.retryMs, 33500);
  const now = Date.UTC(2026, 10, 3, 17, 0, 0); // 09:00 in Los Angeles (PST)
  assert.equal(L.msToPacificMidnight(now), 15 * 3600_000);
  assert.deepEqual(L.restFor(free, now, false).why, 'quota-day');
  assert.equal(L.restFor(free, now, false).ms, 15 * 3600_000);
  const minute = 'HTTP 429: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric: generate_content_paid_tier_input_token_count, limit: 2000000 per minute. Please retry in 12s."}}';
  assert.equal(L.restFor(minute, now, false).why, 'quota');
  assert.equal(L.restFor(minute, now, false).ms, 60_000, 'at least a minute');
  assert.equal(L.quotaInfo('HTTP 503: The model is overloaded. Please try again later.'), null);
  assert.equal(L.quotaInfo('HTTP 429: rate_limit_error'), null, 'a plain rate limit stays "busy"');
  assert.equal(L.restFor('HTTP 503 overloaded', now, false).why, 'busy');
  assert.equal(L.restFor('HTTP 404', now, true).why, 'dead');
  assert.equal(L.quotaInfo('HTTP 429: {"error":{"message":"Quota exceeded for metric: free_tier_requests, limit: 0, model: gemini-3.1-pro-preview","status":"RESOURCE_EXHAUSTED"}}').none, true);
  const cool = new Map();
  L.rest(cool, 'm', 1000, false, 5000);
  assert.equal(cool.get('m'), 6000, 'rest takes an explicit length');
});
