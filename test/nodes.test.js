const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/renderer/nodes.js');

test('normalizeNodes migrates the single baseUrl into This PC', () => {
  const nodes = N.normalizeNodes({ baseUrl: 'http://localhost:11434/v1', keepAlive: '-1' });
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].id, 'this-pc');
  assert.strictEqual(nodes[0].name, 'This PC');
  assert.strictEqual(nodes[0].baseUrl, 'http://localhost:11434/v1');
  assert.strictEqual(nodes[0].enabled, true);
  assert.strictEqual(nodes[0].keepAlive, '-1');
});

test('normalizeNodes keeps This PC first and mirrors settings, remotes follow', () => {
  const s = {
    baseUrl: 'http://localhost:11434/v1',
    keepAlive: '-1',
    ollamaNodes: [
      { id: 'node-shop', name: 'Shop PC', baseUrl: 'http://192.168.1.50:11434/', keepAlive: '5m' },
      { id: 'this-pc', enabled: false, baseUrl: 'http://stale-should-be-ignored' }
    ]
  };
  const nodes = N.normalizeNodes(s);
  assert.strictEqual(nodes[0].id, 'this-pc');
  assert.strictEqual(nodes[0].baseUrl, 'http://localhost:11434/v1'); // mirrors settings, never the saved copy
  assert.strictEqual(nodes[0].enabled, false); // but the enabled flag is remembered
  assert.deepStrictEqual(
    nodes[1],
    { id: 'node-shop', name: 'Shop PC', baseUrl: 'http://192.168.1.50:11434', enabled: true, keepAlive: '5m' }
  );
});

test('normalizeNodes survives junk in the saved list', () => {
  const s = { baseUrl: 'http://localhost:11434', ollamaNodes: [null, 42, {}, { baseUrl: '  ' }, { baseUrl: 'http://a:1' }] };
  const nodes = N.normalizeNodes(s);
  assert.strictEqual(nodes.length, 2);
  assert.strictEqual(nodes[1].baseUrl, 'http://a:1');
  assert.strictEqual(nodes[1].name, 'a:1'); // name falls back to the host
  assert.ok(nodes[1].id.startsWith('node-'));
});

test('multiNode is false only when the enabled set is exactly This PC', () => {
  assert.strictEqual(N.multiNode({ baseUrl: 'http://localhost:11434' }), false);
  assert.strictEqual(
    N.multiNode({ baseUrl: 'http://x', ollamaNodes: [{ id: 'n', baseUrl: 'http://y', enabled: false }] }),
    false
  );
  assert.strictEqual(N.multiNode({ baseUrl: 'http://x', ollamaNodes: [{ id: 'n', baseUrl: 'http://y' }] }), true);
  // This PC disabled with one remote enabled means "run on the other machine" — must route.
  assert.strictEqual(
    N.multiNode({ baseUrl: 'http://x', ollamaNodes: [{ id: 'this-pc', enabled: false }, { id: 'n', baseUrl: 'http://y', enabled: true }] }),
    true
  );
  // Everything disabled: nothing to route to; fall back to plain behavior.
  assert.strictEqual(
    N.multiNode({ baseUrl: 'http://x', ollamaNodes: [{ id: 'this-pc', enabled: false }, { id: 'n', baseUrl: 'http://y', enabled: false }] }),
    false
  );
});

test('sameModel treats a missing tag as :latest', () => {
  assert.ok(N.sameModel('qwen2.5-coder:7b', 'qwen2.5-coder:7b'));
  assert.ok(N.sameModel('nomic-embed-text', 'nomic-embed-text:latest'));
  assert.ok(!N.sameModel('qwen2.5-coder:7b', 'qwen2.5-coder:14b'));
  assert.ok(!N.sameModel('', ''));
});

const twoNodes = [
  { id: 'this-pc', name: 'This PC', baseUrl: 'http://localhost:11434', enabled: true },
  { id: 'shop', name: 'Shop PC', baseUrl: 'http://shop:11434', enabled: true }
];

test('pickNode prefers the first healthy node that has the model', () => {
  const health = {
    'this-pc': { up: true, models: ['llama3:8b'] },
    shop: { up: true, models: ['qwen2.5-coder:7b'] }
  };
  assert.strictEqual(N.pickNode(twoNodes, health, 'qwen2.5-coder:7b').id, 'shop');
  assert.strictEqual(N.pickNode(twoNodes, health, 'llama3:8b').id, 'this-pc');
});

test('pickNode falls back to the first healthy node when none has the model', () => {
  const health = { 'this-pc': { up: false }, shop: { up: true, models: [] } };
  assert.strictEqual(N.pickNode(twoNodes, health, 'missing:1b').id, 'shop');
});

test('pickNode falls back to the first enabled node when nothing is healthy', () => {
  const health = { 'this-pc': { up: false }, shop: { up: false } };
  assert.strictEqual(N.pickNode(twoNodes, health, 'any').id, 'this-pc');
});

test('pickNode honors exclusions and disabled nodes', () => {
  const health = { 'this-pc': { up: true, models: ['m:1'] }, shop: { up: true, models: ['m:1'] } };
  assert.strictEqual(N.pickNode(twoNodes, health, 'm:1', new Set(['this-pc'])).id, 'shop');
  const oneOff = [{ ...twoNodes[0], enabled: false }, twoNodes[1]];
  assert.strictEqual(N.pickNode(oneOff, health, 'm:1').id, 'shop');
  assert.strictEqual(N.pickNode(twoNodes, health, 'm:1', new Set(['this-pc', 'shop'])), null);
});

test('nextNode only moves to a healthy node', () => {
  const health = { 'this-pc': { up: false }, shop: { up: true, models: ['m:1'] } };
  assert.strictEqual(N.nextNode(twoNodes, health, 'm:1', new Set(['this-pc'])).id, 'shop');
  const allDown = { 'this-pc': { up: false }, shop: { up: false } };
  assert.strictEqual(N.nextNode(twoNodes, allDown, 'm:1', new Set(['this-pc'])), null);
});

test('isConnectionError separates unreachable servers from server errors', () => {
  assert.ok(N.isConnectionError('Could not connect to http://localhost:11434. Is Ollama / LM Studio running? (ECONNREFUSED)'));
  assert.ok(N.isConnectionError('fetch failed'));
  assert.ok(N.isConnectionError('terminated: other side closed (UND_ERR_SOCKET)'));
  assert.ok(!N.isConnectionError('HTTP 503 from http://x: model is overloaded'));
  assert.ok(!N.isConnectionError('HTTP 404 from http://x: model "gone" not found'));
  assert.ok(!N.isConnectionError(''));
});

test('summarize counts enabled nodes that are up', () => {
  const health = { 'this-pc': { up: true, models: ['a', 'b'] }, shop: { up: false } };
  const s = N.summarize(twoNodes, health);
  assert.strictEqual(s.up, 1);
  assert.strictEqual(s.total, 2);
  assert.match(s.detail, /This PC: up, 2 models/);
  assert.match(s.detail, /Shop PC: down/);
});
