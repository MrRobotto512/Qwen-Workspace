const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/renderer/models.js');

const REQUIRED = ['id', 'name', 'sizeGB', 'kvKB', 'rank', 'agent', 'note', 'nativeCtx'];

test('every catalog entry carries the fields the Models window renders', () => {
  for (const m of M.MODEL_CATALOG) {
    for (const k of REQUIRED) assert.ok(m[k] !== undefined && m[k] !== '', `${m.id || '?'} is missing ${k}`);
    assert.ok(m.sizeGB > 0 && m.kvKB > 0 && m.nativeCtx >= 32768, `${m.id} has nonsense numbers`);
  }
});

test('the Gemma 4 family is in the catalog; tool-less Gemma generations are not', () => {
  for (const id of ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b']) {
    assert.ok(M.catalogEntryFor(id), `${id} missing from the catalog`);
  }
  // Agent mode needs native tool calling, which Ollama's gemma3/gemma2/gemma templates
  // refuse with HTTP 400 — a catalog entry for them would recommend a broken agent model.
  assert.ok(!M.MODEL_CATALOG.some((m) => /^gemma[123]?[:.]/.test(m.id)), 'a pre-Gemma-4 model crept into the catalog');
  assert.strictEqual(M.catalogEntryFor('gemma4:26b').moe, true);
  assert.strictEqual(M.catalogEntryFor('gemma4:31b').moe, undefined);
});

test('qwen3-coder:30b stays the top-ranked recommendation on a big GPU', () => {
  const specs = { gpu: { name: 'RTX 5090', vramGB: 32 }, gpus: [], ramGB: 64, threads: 24 };
  const { recommended } = M.recommendModels(specs);
  assert.strictEqual(recommended.id, 'qwen3-coder:30b');
});

test('Gemma 4 long context is native — no YaRN build needed or offered', () => {
  const specs = { gpu: { name: 'RTX 6000', vramGB: 48 }, gpus: [], ramGB: 128, threads: 32 };
  const plan = M.planLongContext(M.catalogEntryFor('gemma4:26b'), specs);
  assert.ok(plan, 'gemma4:26b should appear in the long-context view');
  assert.strictEqual(plan.maxCtx, 262144);
  assert.strictEqual(plan.needsYarn, false);
  assert.ok(plan.ctx > 32768);
});

test('catalog stays ordered by rank so the list reads strongest-first', () => {
  const ranks = M.MODEL_CATALOG.map((m) => m.rank);
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] <= ranks[i - 1], `rank order breaks at ${M.MODEL_CATALOG[i].id}`);
});
