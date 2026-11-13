'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Strata = require('../src/renderer/strata.js');
const Nodes = require('../src/renderer/nodes.js');

test('parseServer: Strata by its /health, context and images', () => {
  const h = Strata.parseServer({
    health: { status: 'ok', service: 'strata', model: 'qwen3.8-flash-next', max_context: 65536, images: true, loaded: true },
    models: { object: 'list', data: [{ id: 'qwen3.8-flash-next', meta: { n_ctx: 65536 }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] }
  });
  assert.equal(h.kind, 'openai');
  assert.equal(h.server, 'Strata');
  assert.deepEqual(h.models, ['qwen3.8-flash-next']);
  assert.equal(h.maxContext, 65536);
  assert.equal(h.vision, true);
});

test('parseServer: an image model is not a chat model; a loading Strata still names its model', () => {
  const h = Strata.parseServer({
    health: { service: 'strata', model: 'qwen3.6-35b-a3b', max_context: 32768, loaded: false },
    models: { data: [{ id: 'flux', architecture: { output_modalities: ['image'] } }] }
  });
  assert.deepEqual(h.models, ['qwen3.6-35b-a3b']);
  assert.equal(h.loaded, false);
});

test('parseServer: llama.cpp by /props, vLLM by max_model_len, null for a non-list', () => {
  const ll = Strata.parseServer({ models: { data: [{ id: 'model.gguf' }] }, props: { default_generation_settings: { n_ctx: 16384 } } });
  assert.equal(ll.server, 'llama.cpp');
  assert.equal(ll.maxContext, 16384);
  const v = Strata.parseServer({ models: { data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 40960 }] } });
  assert.equal(v.server, 'vLLM');
  assert.equal(v.maxContext, 40960);
  assert.equal(Strata.parseServer({ models: { error: 'nope' } }), null);
  assert.equal(Strata.parseServer({}), null);
});

test('fits: Alien (48 GB RAM, 24 GB of cards) gets Flash-Next IQ2_XS first, never IQ3', () => {
  const list = Strata.fits({ ramGB: 48, vramGB: 23.5 });
  assert.equal(list[0].model, 'IQ2_XS');
  assert.ok(list.some((m) => m.model === 'Q2_0'));
  assert.ok(!list.some((m) => /^IQ3/.test(m.model)));
  assert.ok(list.some((m) => m.family === 'coder'));
});

test('fits: 32 GB RAM gets only Qwen3.6 Q4; 16 GB gets nothing; a small card rules out Flash-Next', () => {
  assert.deepEqual(Strata.fits({ ramGB: 32, vramGB: 12 }).map((m) => m.model), ['UD-Q4_K_XL']);
  assert.deepEqual(Strata.fits({ ramGB: 16, vramGB: 12 }), []);
  assert.ok(Strata.fits({ ramGB: 64, vramGB: 8 }).every((m) => m.family === 'qwen36'));
  assert.equal(Strata.fits({ ramGB: 64, vramGB: 24 })[0].model, 'IQ3_S');
});

test('launchCommand and keyEnvName', () => {
  const m = Strata.MODELS.find((x) => x.model === 'IQ2_XS');
  assert.equal(Strata.launchCommand(m), 'strata launch --family qwen --model IQ2_XS');
  assert.equal(Strata.launchCommand(m, { lan: true }), 'strata launch --family qwen --model IQ2_XS --access lan --port 8080');
  assert.equal(Strata.keyEnvName('STRATA_API_KEY'), 'STRATA_API_KEY');
  assert.equal(Strata.keyEnvName(' MY_KEY2 '), 'MY_KEY2');
  assert.equal(Strata.keyEnvName('sk-123abc'), null);
  assert.equal(Strata.keyEnvName('PATH; rm'), null);
  assert.match(Strata.keyNeeded(), /STRATA_API_KEY/);
  assert.match(Strata.keyNeeded(), /never stores/);
});

test('isLocalProvider: an OpenAI-compatible node is local and free', () => {
  assert.ok(Strata.isLocalProvider('openai-local'));
  assert.ok(Strata.isLocalProvider('ollama'));
  assert.ok(!Strata.isLocalProvider('openrouter'));
});

test('normalizeNodes keeps an openai node and a valid key variable, drops a bad one', () => {
  const nodes = Nodes.normalizeNodes({
    baseUrl: 'http://localhost:11434',
    ollamaNodes: [
      { id: 'alien', name: 'Alien', baseUrl: 'http://192.168.1.20:8080', kind: 'openai', keyEnv: 'STRATA_API_KEY' },
      { id: 'b', name: 'B', baseUrl: 'http://192.168.1.21:8080', kind: 'openai', keyEnv: 'sk-secret' }
    ]
  });
  assert.equal(nodes[1].kind, 'openai');
  assert.equal(nodes[1].keyEnv, 'STRATA_API_KEY');
  assert.equal(nodes[2].keyEnv, undefined);
});

test('nodeOverride: an openai node runs its own model with its context and key variable', () => {
  const node = { id: 'alien', baseUrl: 'http://192.168.1.20:8080', kind: 'openai', keyEnv: 'STRATA_API_KEY' };
  const health = { up: true, kind: 'openai', models: ['qwen3.8-flash-next'], maxContext: 65536 };
  const o = Nodes.nodeOverride(node, health, 'qwen3:8b');
  assert.equal(o.provider, 'openai-local');
  assert.equal(o.baseUrl, 'http://192.168.1.20:8080/v1');
  assert.equal(o.model, 'qwen3.8-flash-next');
  assert.equal(o.nodeCtx, 65536);
  assert.equal(o.keyEnv, 'STRATA_API_KEY');
  assert.equal(o.apiKey, '');
  // A URL already ending in /v1 is not doubled.
  assert.equal(Nodes.nodeOverride({ ...node, baseUrl: 'http://x:8080/v1' }, health, 'm').baseUrl, 'http://x:8080/v1');
});

test('pickHighPerf: a Strata node with Flash-Next outranks the Ollama models (prefix match)', () => {
  const MODEL_CATALOG = [{ id: 'qwen3-coder:30b', rank: 10 }, { id: 'qwen3:8b', rank: 4 }];
  const nodes = [{ id: 'alien', enabled: true, highPerf: true, kind: 'openai', baseUrl: 'http://a:8080' }];
  const health = { alien: { up: true, kind: 'openai', models: ['qwen3.8-flash-next-iq2_xs'] } };
  const pick = Nodes.pickHighPerf(nodes, health, 'qwen3:8b', [...MODEL_CATALOG, ...Strata.CATALOG]);
  assert.equal(pick.model, 'qwen3.8-flash-next-iq2_xs');
  assert.equal(pick.kind, 'openai');
  // An unknown model on the server is no upgrade.
  assert.equal(Nodes.pickHighPerf(nodes, { alien: { up: true, kind: 'openai', models: ['mystery'] } }, 'qwen3:8b', Strata.CATALOG), null);
});

test('nodeHasModel: loose names match on an openai node', () => {
  assert.ok(Nodes.nodeHasModel({ up: true, kind: 'openai', models: ['qwen3.6-35b-a3b'] }, 'qwen3.6:35b-a3b'));
  assert.ok(!Nodes.nodeHasModel({ up: true, models: ['qwen3.6-35b-a3b'] }, 'qwen3.6:35b-a3b'));
});

test('damagedAdvice for an OpenAI-compatible node names Strata, not Ollama', () => {
  const t = Nodes.damagedAdvice('qwen3.8-flash-next', 'Alien', 'openai-local');
  assert.match(t, /strata/i);
  assert.doesNotMatch(t, /ollama pull/);
});

test('describe: the status line', () => {
  assert.equal(Strata.describe({ up: true, server: 'Strata', maxContext: 65536, vision: true }), 'Strata · context 64K · reads images');
  assert.equal(Strata.describe({ up: false }), '');
});
