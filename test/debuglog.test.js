const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/renderer/debuglog.js');

test('redactSettings masks every secret-looking key, deep, and keeps the rest', () => {
  const s = {
    provider: 'gemini',
    apiKey: 'sk-top-secret-123',
    searchApiKey: 'brave-key',
    searxngUrl: 'http://localhost:8080',
    heavy: { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-xyz', model: 'claude-opus-5-5' },
    mcpServers: [{ name: 'rea', token: 'tok-1', command: 'npx rea' }],
    monthlyCapUSD: 20
  };
  const r = D.redactSettings(s);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('sk-top-secret-123'));
  assert.ok(!dump.includes('brave-key'));
  assert.ok(!dump.includes('sk-ant-xyz'));
  assert.ok(!dump.includes('tok-1'));
  assert.strictEqual(r.apiKey, '•••redacted•••');
  assert.strictEqual(r.heavy.apiKey, '•••redacted•••');
  assert.strictEqual(r.heavy.model, 'claude-opus-5-5'); // non-secrets survive
  assert.strictEqual(r.mcpServers[0].command, 'npx rea');
  assert.strictEqual(r.monthlyCapUSD, 20);
  assert.strictEqual(r.apiKeyEmpty ?? D.redactSettings({ apiKey: '' }).apiKey, ''); // empty stays visibly empty
});

test('add appends events and caps the log', () => {
  const c = {};
  for (let i = 0; i < D.LOG_CAP + 50; i++) D.add(c, 'notice', { text: `n${i}` });
  assert.strictEqual(c.log.length, D.LOG_CAP);
  assert.strictEqual(c.log[c.log.length - 1].text, `n${D.LOG_CAP + 49}`);
  assert.ok(c.log[0].text !== 'n0'); // oldest dropped
  assert.ok(typeof c.log[0].at === 'number');
});

test('render produces a complete, redacted markdown report', () => {
  const conv = {
    id: 'c1',
    title: 'Fix the build',
    mode: 'agent',
    status: 'error',
    createdAt: Date.now() - 60_000,
    compactions: 1,
    usage: { promptTokens: 9000, contextLength: 32768 },
    log: [
      { at: Date.now() - 50_000, kind: 'request', step: 0, model: 'qwen2.5-coder:7b', provider: 'ollama' },
      { at: Date.now() - 49_000, kind: 'response', ok: true, finishReason: 'tool_calls', chars: 0, toolCalls: 1 },
      { at: Date.now() - 48_000, kind: 'tool', name: 'run_command', meta: 'exit 1', failed: true, ms: 1800 },
      { at: Date.now() - 40_000, kind: 'notice', text: 'qwen is overloaded — retrying in 8 seconds.' },
      { at: Date.now() - 30_000, kind: 'escalate', reason: 'Qwen seems stuck', interventions: 1 },
      { at: Date.now() - 20_000, kind: 'error', text: 'HTTP 503 from http://x' }
    ],
    history: [
      { role: 'system', content: 'You are Qwen working in the user\'s project.' },
      { role: 'user', content: 'build it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'run_command', arguments: '{"command":"make"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'Exit code: 1\n' + 'x'.repeat(5000) }
    ]
  };
  const settings = { provider: 'ollama', model: 'qwen2.5-coder:7b', apiKey: 'sk-never-show' };
  const md = D.render({ conv, settings, appInfo: { version: '0.16.0', platform: 'win32' }, nodeHealth: { byId: { 'this-pc': { up: true, models: ['a'] } } }, mcp: [{ id: 'rea', status: 'error', error: 'spawn npx ENOENT' }] });
  assert.ok(md.includes('# Debug report — Fix the build'));
  assert.ok(md.includes('0.16.0'));
  assert.ok(!md.includes('sk-never-show'), 'api key leaked into the report');
  assert.ok(md.includes('You are Qwen working'));
  assert.ok(md.includes('CALL run_command'));
  assert.ok(md.includes('truncated for the report'), 'long tool output was not truncated');
  assert.ok(md.includes('intervention #1: Qwen seems stuck'));
  assert.ok(md.includes('MODEL ERROR') === false); // the 503 was an error event, not a response
  assert.ok(md.includes('✖'));
  assert.ok(md.includes('rea=error (spawn npx ENOENT)'));
  assert.ok(md.includes('this-pc=up (1 models)'));
});

test('render survives an empty conversation', () => {
  const md = D.render({ conv: { id: 'x', history: [], log: [] }, settings: {}, appInfo: null });
  assert.ok(md.includes('no events recorded'));
});
