'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/freecloud.js');

const OR = { data: [
  { id: 'openai/gpt-oss-120b:free', name: 'gpt-oss-120b (free)', context_length: 131072, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice', 'reasoning'], architecture: { input_modalities: ['text'] } },
  { id: 'meta-llama/llama-4-scout:free', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'some/chat-only:free', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] } },
  { id: 'anthropic/claude-opus', context_length: 200000, pricing: { prompt: '0.000015', completion: '0.000075' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'openrouter/free', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }
] };

test('OpenRouter: free, tools and images come from the model list', () => {
  const m = F.parseCatalog('openrouter', OR);
  const by = Object.fromEntries(m.map((x) => [x.id, x]));
  assert.deepEqual([by['openai/gpt-oss-120b:free'].free, by['openai/gpt-oss-120b:free'].tools, by['openai/gpt-oss-120b:free'].vision], [true, true, false]);
  assert.equal(by['meta-llama/llama-4-scout:free'].vision, true);
  assert.equal(by['some/chat-only:free'].tools, false);
  assert.equal(by['anthropic/claude-opus'].free, false);
  const free = F.rank(m, { freeOnly: true }).map((x) => x.id);
  assert.equal(free.includes('anthropic/claude-opus'), false);
  assert.equal(free.at(-1), 'some/chat-only:free', 'a model that cannot call tools goes last');
  assert.equal(F.optionLabel(by['openai/gpt-oss-120b:free']), 'free · tools · 131K');
  assert.equal(F.optionLabel(by['some/chat-only:free']), 'free · no tools · 8K');
  assert.match(F.summary('openrouter', m, { freeOnly: true }), /4 free models, 3 can call tools/);
});

test('Groq: chat models only, capabilities from the name', () => {
  const m = F.parseCatalog('groq', { data: [
    { id: 'openai/gpt-oss-120b', context_window: 131072, active: true },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', context_window: 131072 },
    { id: 'whisper-large-v3', context_window: 448 },
    { id: 'old-model', active: false }
  ] });
  assert.deepEqual(m.map((x) => x.id), ['openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct']);
  assert.equal(m[0].tools, true);
  assert.equal(m[1].vision, true);
  assert.equal(F.parseCatalog('gemini', {}), null);
});

test('rate limits are explained: OpenRouter per day, Groq per minute and per day', () => {
  const or = F.rateLimitInfo('HTTP 429 from https://openrouter.ai/api/v1: {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1793836800000"}}}}');
  assert.equal(or.scope, 'day');
  assert.equal(or.resetAt, 1793836800000);
  assert.match(or.message, /50 requests a day .*\$10 of OpenRouter credits/);
  const g = F.rateLimitInfo('HTTP 429 from https://api.groq.com/openai/v1: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2400. Please try again in 10.5s. Need more tokens?","type":"tokens","code":"rate_limit_exceeded"}}');
  assert.equal(g.scope, 'minute');
  assert.equal(g.waitMs, 10500);
  const gd = F.rateLimitInfo('HTTP 429: Rate limit reached for model `x` on requests per day (RPD): Limit 1000, Used 1000. Please try again in 2m30.5s.');
  assert.equal(gd.scope, 'day');
  assert.equal(gd.waitMs, 150500);
  assert.equal(F.rateLimitInfo('HTTP 500 internal'), null);
  assert.equal(F.parseDuration('450ms'), 450);
  assert.equal(F.parseDuration('1h2m'), 3720000);
});

test('a refused tool call is recognised, with what the model wrote', () => {
  const t = F.toolUseFailed('HTTP 400 from https://api.groq.com/openai/v1: {"error":{"message":"Failed to call a function. Please adjust your prompt.","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"<function=write_file>{\\"path\\": \\"a.txt\\"</function>"}}');
  assert.match(t.generation, /<function=write_file>\{"path": "a.txt"/);
  assert.equal(F.toolUseFailed('HTTP 400 bad request'), null);
});

test('every sign-up link is https and names what is free', () => {
  for (const [k, v] of Object.entries(F.SIGNUP)) {
    assert.match(v.url, /^https:\/\//, k);
    assert.ok(v.note.length > 30, k);
  }
  assert.match(F.SIGNUP.groq.url, /console\.groq\.com/);
  assert.match(F.SIGNUP.openrouter.url, /openrouter\.ai\/keys/);
});
