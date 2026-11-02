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
    { id: 'node-shop', name: 'Shop PC', baseUrl: 'http://192.168.1.50:11434', enabled: true, highPerf: false, keepAlive: '5m' }
  );
});

test('remote nodes default to the 5m keep-alive so they free VRAM when idle', () => {
  const s = {
    baseUrl: 'http://localhost:11434',
    keepAlive: '-1', // the global pin-forever must NOT leak onto remote machines
    ollamaNodes: [
      { id: 'node-shop', name: 'Shop PC', baseUrl: 'http://192.168.1.50:11434' },
      { id: 'node-attic', name: 'Attic', baseUrl: 'http://192.168.1.60:11434', keepAlive: '30m' },
      { id: 'node-blank', name: 'Blank', baseUrl: 'http://192.168.1.70:11434', keepAlive: '   ' }
    ]
  };
  const nodes = N.normalizeNodes(s);
  assert.strictEqual(nodes[0].keepAlive, '-1'); // This PC still follows the Model section
  assert.strictEqual(nodes[1].keepAlive, N.REMOTE_KEEP_DEFAULT);
  assert.strictEqual(N.REMOTE_KEEP_DEFAULT, '5m');
  assert.strictEqual(nodes[2].keepAlive, '30m'); // an explicit value still wins
  assert.strictEqual(nodes[3].keepAlive, '5m'); // whitespace counts as unset
});

test('normalizeNodes remembers the high-performance flag, This PC included', () => {
  const s = {
    baseUrl: 'http://localhost:11434',
    ollamaNodes: [
      { id: 'this-pc', enabled: true, highPerf: true },
      { id: 'node-shop', name: 'Shop PC', baseUrl: 'http://192.168.1.50:11434', highPerf: true },
      { id: 'node-attic', name: 'Attic', baseUrl: 'http://192.168.1.60:11434' }
    ]
  };
  const nodes = N.normalizeNodes(s);
  assert.strictEqual(nodes[0].highPerf, true);
  assert.strictEqual(nodes[1].highPerf, true);
  assert.strictEqual(nodes[2].highPerf, false);
  assert.strictEqual(N.normalizeNodes({ baseUrl: 'http://x:1' })[0].highPerf, false); // default off
});

const HP_CATALOG = [
  { id: 'qwen3-coder:30b', rank: 10 },
  { id: 'qwen2.5-coder:14b', rank: 6.5 },
  { id: 'qwen2.5-coder:7b', rank: 4.5 },
  { id: 'qwen2.5-coder:1.5b', rank: 0 }
];

test('pickHighPerf picks the strongest installed catalog model that outranks the current one', () => {
  const nodes = [
    { id: 'this-pc', name: 'This PC', enabled: true, highPerf: false },
    { id: 'a', name: 'Shop PC', enabled: true, highPerf: true, baseUrl: 'http://a:1' },
    { id: 'b', name: 'Attic', enabled: true, highPerf: true, baseUrl: 'http://b:1' }
  ];
  const health = {
    'this-pc': { up: true, models: ['qwen3-coder:30b'] }, // not flagged → never picked
    a: { up: true, models: ['qwen2.5-coder:14b', 'other:1b'] },
    b: { up: true, models: ['qwen3-coder:30b'] }
  };
  const pick = N.pickHighPerf(nodes, health, 'qwen2.5-coder:7b', HP_CATALOG);
  assert.strictEqual(pick.node.id, 'b');
  assert.strictEqual(pick.model, 'qwen3-coder:30b');
  // With the strongest node empty, the next-best eligible node wins.
  const pick2 = N.pickHighPerf(nodes, { ...health, b: { up: true, models: [] } }, 'qwen2.5-coder:7b', HP_CATALOG);
  assert.strictEqual(pick2.node.id, 'a');
  assert.strictEqual(pick2.model, 'qwen2.5-coder:14b');
});

test('pickHighPerf returns null when nothing would be an upgrade', () => {
  const nodes = [{ id: 'a', name: 'Shop PC', enabled: true, highPerf: true, baseUrl: 'http://a:1' }];
  // Same model as the one already running: no upgrade.
  assert.strictEqual(N.pickHighPerf(nodes, { a: { up: true, models: ['qwen3-coder:30b'] } }, 'qwen3-coder:30b', HP_CATALOG), null);
  // Node down.
  assert.strictEqual(N.pickHighPerf(nodes, { a: { up: false } }, 'qwen2.5-coder:7b', HP_CATALOG), null);
  // Node disabled.
  assert.strictEqual(N.pickHighPerf([{ ...nodes[0], enabled: false }], { a: { up: true, models: ['qwen3-coder:30b'] } }, 'qwen2.5-coder:7b', HP_CATALOG), null);
  // Unknown current model: only a solidly strong pick (rank >= 6) qualifies — a small model
  // on the node must not masquerade as the heavy tier.
  assert.strictEqual(N.pickHighPerf(nodes, { a: { up: true, models: ['qwen2.5-coder:1.5b', 'qwen2.5-coder:7b'] } }, 'mystery-model', HP_CATALOG), null);
  const ok = N.pickHighPerf(nodes, { a: { up: true, models: ['qwen2.5-coder:14b'] } }, 'mystery-model', HP_CATALOG);
  assert.strictEqual(ok.model, 'qwen2.5-coder:14b');
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

test('spillInfo flags a model partly in system RAM, not one that fits', () => {
  const ps = [
    { name: 'qwen2.5-coder:7b', size: 6_000_000_000, size_vram: 6_000_000_000 },
    { name: 'qwen3-coder:30b', size: 20_000_000_000, size_vram: 11_000_000_000 }
  ];
  assert.strictEqual(N.spillInfo(ps, 'qwen2.5-coder:7b'), null);
  assert.deepStrictEqual(N.spillInfo(ps, 'qwen3-coder:30b'), { gpuGB: 11, totalGB: 20, pct: 55 });
  assert.strictEqual(N.spillInfo(ps, 'gemma4:26b'), null); // not loaded
  assert.strictEqual(N.spillInfo([], 'x'), null);
});

test('probeVerdict grades the answer and the call arguments, not just a reply', () => {
  const good = N.probeVerdict('pong', { tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }] });
  assert.strictEqual(good.ok, true);
  const wrongCity = N.probeVerdict('Pong.', { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Lyon"}' } }] });
  assert.strictEqual(wrongCity.ok, false);
  assert.ok(/not the city/.test(wrongCity.tool.detail));
  const textOnly = N.probeVerdict('pong', { content: '<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>' });
  assert.strictEqual(textOnly.tool.textOnly, true);
  const words = N.probeVerdict('Sure! The word is: ping', { content: 'It is sunny in Paris.' });
  assert.strictEqual(words.prompt.ok, false);
  assert.ok(/did not call the tool/.test(words.tool.detail));
});

test('LM Studio nodes: loose model names, ttl, draft pick, and the per-request override', () => {
  const N = require('../src/renderer/nodes.js');
  assert.equal(N.looseModelKey('qwen3:14b'), N.looseModelKey('qwen/qwen3-14b'));
  assert.equal(N.looseModelKey('qwen2.5-coder:7b'), N.looseModelKey('lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF'));
  assert.notEqual(N.looseModelKey('qwen3:14b'), N.looseModelKey('qwen3:8b'));
  assert.equal(N.lmModelFor('qwen3:14b', ['qwen/qwen3-8b', 'qwen/qwen3-14b']), 'qwen/qwen3-14b');
  assert.equal(N.lmModelFor('qwen3:14b', ['qwen/qwen3-8b'], 'qwen/qwen3-8b'), 'qwen/qwen3-8b', 'a pinned node model wins');
  assert.equal(N.lmModelFor('llama3', ['qwen/qwen3-8b']), null);
  assert.deepEqual(['5m', '1h', '45s', '300', '-1', '0', '', 'soon'].map(N.ttlSeconds), [300, 3600, 45, 300, null, null, null, null]);
  const lm = [
    { key: 'qwen/qwen3-14b', params: '14B' }, { key: 'qwen/qwen3-4b', params: '4B' }, { key: 'qwen/qwen3-1.7b', params: '1.7B' },
    { key: 'qwen/qwen3-0.6b', params: '0.6B' }, { key: 'llama-3.2-1b-instruct', params: '1B' }, { key: 'text-embedding-nomic', type: 'embedding', params: '0.1B' }
  ];
  assert.equal(N.suggestDraft('qwen/qwen3-14b', lm), 'qwen/qwen3-1.7b', 'largest same-family model at most a quarter of the size');
  assert.equal(N.suggestDraft('qwen/qwen3-4b', lm), 'qwen/qwen3-0.6b');
  assert.equal(N.suggestDraft('llama-3.2-1b-instruct', lm), null);
  // a node health with LM Studio models: the loose match counts as "has the model"
  const h = { up: true, kind: 'lmstudio', models: lm.map((m) => m.key), lmModels: lm };
  assert.equal(N.nodeHasModel(h, 'qwen3:14b'), true);
  assert.equal(N.nodeHasModel({ ...h, kind: 'ollama' }, 'qwen3:14b'), false, 'Ollama nodes keep exact matching');
  const node = { id: 'node-lm', baseUrl: 'http://10.0.0.5:1234', keepAlive: '5m', kind: 'lmstudio', draftModel: 'auto' };
  assert.deepEqual(N.nodeOverride(node, h, 'qwen3:14b'), { provider: 'lmstudio', baseUrl: 'http://10.0.0.5:1234/v1', apiKey: '', model: 'qwen/qwen3-14b', ttl: 300, draftModel: 'qwen/qwen3-1.7b' });
  assert.equal(N.nodeOverride({ ...node, draftModel: 'missing/model' }, h, 'qwen3:14b').draftModel, undefined, 'a draft model the node does not have is dropped');
  assert.equal(N.nodeOverride({ id: 'this-pc', baseUrl: 'http://localhost:11434' }, { up: true, kind: 'ollama' }, 'x'), null);
  assert.deepEqual(N.nodeOverride({ id: 'node-b', baseUrl: 'http://b:11434', keepAlive: '5m' }, { up: true, kind: 'ollama' }, 'x'), { baseUrl: 'http://b:11434', keepAlive: '5m' });
  assert.equal(N.normalizeNodes({ ollamaNodes: [{ id: 'node-lm', baseUrl: 'http://10.0.0.5:1234', kind: 'lmstudio', draftModel: 'auto' }] })[1].kind, 'lmstudio');
  // ⚡ pick on an LM Studio node keeps the node's own model key
  const cat = [{ id: 'qwen3:14b', rank: 7 }, { id: 'qwen2.5-coder:7b', rank: 5 }];
  const pick = N.pickHighPerf([{ id: 'node-lm', enabled: true, highPerf: true }], { 'node-lm': h }, 'qwen2.5-coder:7b', cat);
  assert.equal(pick.model, 'qwen/qwen3-14b');
  assert.equal(pick.kind, 'lmstudio');
});
