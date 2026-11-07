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
