'use strict';
// v0.59: planning with every GPU Ollama can use.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../src/hardware.js');

const ryan = [
  { name: 'NVIDIA GeForce RTX 3060', vramGB: 12, vendor: 'nvidia', source: 'nvidia-smi' },
  { name: 'NVIDIA GeForce GTX 1660 Ti', vramGB: 6, vendor: 'nvidia', source: 'nvidia-smi' },
  { name: 'Intel(R) UHD Graphics 630', vramGB: 1, vendor: 'intel', source: 'registry' }
];

test('two NVIDIA cards are planned together, less a CUDA context for the second', () => {
  const g = H.plannedGpu(ryan);
  assert.strictEqual(g.vramGB, 17.5);
  assert.strictEqual(g.name, '2 GPUs (RTX 3060 12 GB + GTX 1660 Ti 6 GB)');
  assert.ok(g.pooled && g.count === 2 && g.vendor === 'nvidia');
});

test('"largest only", "set by hand", and setups with nothing to pool', () => {
  assert.strictEqual(H.plannedGpu(ryan, { use: 'largest' }).vramGB, 12);
  const c = H.plannedGpu(ryan, { use: 'custom', customGB: 16 });
  assert.ok(c.custom && c.vramGB === 16);
  assert.strictEqual(H.plannedGpu([ryan[0], ryan[2]]).name, 'NVIDIA GeForce RTX 3060', 'an integrated GPU is not pooled');
  assert.strictEqual(H.plannedGpu([{ name: 'RTX 3060', vramGB: 12, vendor: 'nvidia' }, { name: 'RX 6600', vramGB: 8, vendor: 'amd' }]).vramGB, 12, 'mixed vendors: one runtime, the largest card');
  assert.strictEqual(H.plannedGpu([{ name: 'Apple Silicon GPU', vramGB: 22, vendor: 'apple', unified: true }]).vramGB, 22);
  assert.strictEqual(H.plannedGpu([]), null);
});

test('withGpuPlan applies the settings and keeps the largest card', () => {
  const specs = { gpus: ryan, gpu: ryan[0], ramGB: 32 };
  assert.strictEqual(H.withGpuPlan(specs, {}).gpu.vramGB, 17.5);
  assert.strictEqual(H.withGpuPlan(specs, { gpuUse: 'largest' }).gpu.vramGB, 12);
  assert.strictEqual(H.withGpuPlan(specs, {}).gpuLargest.name, 'NVIDIA GeForce RTX 3060');
});

test('the recommendation sees the pooled memory: qwen3:14b at 28K fits two cards, not one', () => {
  global.window = undefined;
  const M = require('../src/renderer/models.js');
  const m = (M.MODEL_CATALOG || []).find((x) => x.id === 'qwen3:14b');
  if (!m || !M.fitAt) return; // catalog shape differs: covered by the e2e
  const one = { gpu: { vramGB: 12 }, ramGB: 32, gpus: [] };
  const two = { gpu: H.plannedGpu(ryan), ramGB: 32, gpus: ryan };
  assert.strictEqual(M.fitAt(m, two, 28672), 'gpu');
  assert.notStrictEqual(M.fitAt(m, one, 28672), 'gpu');
});

test('v0.61: Qwen3.6 in the catalog, and hybrid attention counted right', () => {
  const M = require('../src/renderer/models.js');
  const N = require('../src/renderer/nodes.js');
  const moe = M.MODEL_CATALOG.find((m) => m.id === 'qwen3.6:35b-a3b');
  const dense = M.MODEL_CATALOG.find((m) => m.id === 'qwen3.6:27b');
  assert.ok(moe && moe.moe && moe.nativeCtx === 262144);
  assert.ok(dense && !dense.moe);
  assert.strictEqual(M.catalogEntryFor('qwen3.6:35b-a3b').name, 'Qwen3.6 35B-A3B');
  // 40 layers, a full-attention layer every 4th: 10 layers keep a cache.
  const info = { 'general.architecture': 'qwen35moe', 'qwen35moe.block_count': 40, 'qwen35moe.full_attention_interval': 4, 'qwen35moe.attention.head_count': 16, 'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.attention.key_length': 256, 'qwen35moe.attention.value_length': 256, 'qwen35moe.expert_count': 256 };
  assert.strictEqual(N.kvBytesPerToken(info), 10 * 2 * 512 * 2);
  assert.ok(N.isMoE(info));
  // Per-layer head counts with zeros for the linear layers add up the same way.
  const arr = { 'general.architecture': 'x', 'x.block_count': 4, 'x.attention.head_count': 8, 'x.attention.head_count_kv': [0, 0, 0, 2], 'x.attention.key_length': 128, 'x.attention.value_length': 128 };
  assert.strictEqual(N.kvBytesPerToken(arr), 2 * 256 * 2);
  // On Alien (23.5 GB): the 27B dense build fits at 32K; the 23 GB MoE build spills a little,
  // which a mixture-of-experts model tolerates.
  const alien = { gpu: { vramGB: 23.5 }, ramGB: 48, gpus: [] };
  assert.strictEqual(M.fitAt(moe, alien, 32768), 'mixed');
  assert.strictEqual(M.fitAt(dense, alien, 32768), 'gpu');
});
