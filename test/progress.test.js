'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/renderer/progress.js');
const N = require('../src/renderer/nodes.js');

test('clock and token formatting', () => {
  assert.equal(P.fmtClock(0), '0:00');
  assert.equal(P.fmtClock(102_400), '1:42');
  assert.equal(P.fmtClock(3_725_000), '1:02:05');
  assert.equal(P.fmtTokens(840), '840');
  assert.equal(P.fmtTokens(5291), '5.3K');
});

test('estimateTokens counts text, tool calls and images', () => {
  assert.equal(P.estimateTokens([{ role: 'user', content: 'x'.repeat(400) }]), 100);
  assert.equal(P.estimateTokens([{ role: 'user', content: 'abcd', images: [{}, {}] }]), 1601);
  assert.ok(P.estimateTokens([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: '{"command":"dir"}' } }] }]) > 5);
});

test('statusLine: reading the prompt, then thinking with speed, slow hint only with a spill', () => {
  const t0 = 1_000_000;
  assert.equal(P.statusLine({ startedAt: t0, tokens: 0, phase: 'prompt', promptTokens: 5291, model: 'qwen3:14b' }, t0 + 102_000), 'Reading the prompt (~5.3K tokens) (qwen3:14b) · 1:42');
  const thinking = { startedAt: t0, firstAt: t0 + 60_000, tokens: 400, phase: 'thinking' };
  assert.equal(P.statusLine(thinking, t0 + 160_000), 'Thinking · ~400 tokens · 4.0 tok/s · 2:40');
  assert.equal(P.statusLine({ ...thinking, spill: { pct: 69 } }, t0 + 160_000), 'Thinking · ~400 tokens · 4.0 tok/s · slow: the model is partly on the CPU · 2:40');
  assert.equal(P.statusLine({ startedAt: t0, firstAt: t0 + 1000, tokens: 300, phase: 'writing' }, t0 + 11_000), 'Writing · ~300 tokens · 30 tok/s · 0:11');
  assert.equal(P.statusLine({ startedAt: t0, firstAt: t0 + 1000, tokens: 1, phase: 'tool' }, t0 + 1200), 'Writing a tool call · ~1 tokens · 0:01');
});

test('ollamaStats and timingText describe where the time went', () => {
  const s = P.ollamaStats({ prompt_eval_count: 5047, prompt_eval_duration: 84_200_000_000, eval_count: 312, eval_duration: 97_500_000_000, load_duration: 12_000_000 });
  assert.deepEqual(s, { promptTokens: 5047, completionTokens: 312, promptMs: 84200, loadMs: 12, genTokPerSec: 3.2 });
  assert.equal(P.timingText({ ...s, ms: 182_000 }), ' · prompt 84.2s · 3.2 tok/s · total 182.0s');
  assert.equal(P.timingText({ firstMs: 2500, ms: 9000 }), ' · first token 2.5s · total 9.0s');
  assert.equal(P.timingText({ loadMs: 15_000, promptMs: 1000 }), ' · load 15.0s · prompt 1.0s');
  assert.deepEqual(P.ollamaStats(null), {});
});

test('fitContext: the largest context that fits the GPU, or none', () => {
  const GB = 1e9;
  // 9 GB of weights, 32K context → 15 GB loaded, 12 GB on the GPU: KV ≈ 183 KB/token.
  const fit = N.fitContext({ size: 15 * GB, size_vram: 12 * GB, file_size: 9 * GB }, 32768);
  assert.ok(fit.ctx >= 8192 && fit.ctx < 32768 && fit.ctx % 1024 === 0, JSON.stringify(fit));
  // The field report: qwen3:14b, 14.9 GB loaded, 10.3 on the GPU — not even 4K fits.
  assert.deepEqual(N.fitContext({ size: 14.9 * GB, size_vram: 10.3 * GB, file_size: 9.3 * GB }, 32768), { tooSmall: true });
  assert.equal(N.fitContext({ size: 10 * GB, size_vram: 10 * GB, file_size: 9 * GB }, 8192), null, 'already fits');
  assert.equal(N.fitContext({ size: 10 * GB, size_vram: 5 * GB }, 8192), null, 'no file size: cannot tell');
});
