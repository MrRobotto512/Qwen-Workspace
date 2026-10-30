const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const R = require('../src/remote.js');

function fakeDeps(overrides = {}) {
  return {
    token: () => 'QW-TEST-CODE-1234',
    info: () => ({ app: 'qwen-workspace', version: '0.17.0', device: 'test-pc', platform: 'linux', workspace: '/proj' }),
    listConvs: () => [
      { id: 'a1', title: 'Old', updatedAt: 1, workspace: '/proj', status: 'done' },
      { id: 'b2', title: 'New', updatedAt: 2, workspace: '/proj', status: 'running' }
    ],
    loadConv: (id) => (id === 'a1' ? { id: 'a1', title: 'Old', display: [{ t: 'user', text: 'hi' }], history: [{ role: 'system', content: 'SECRET PROMPT' }], todos: [] } : null),
    startConversation: async ({ text }) => ({ ok: true, id: 'new1', got: text }),
    sendMessage: async (id, { text }) => (id === 'a1' ? { ok: true, id, got: text } : { ok: false, code: 404, error: 'nope' }),
    stop: async (id) => ({ ok: true, id }),
    ...overrides
  };
}

async function withServer(deps, fn) {
  const server = http.createServer(R.createHandler(deps));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', token = 'QW-TEST-CODE-1234', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

test('rejects a missing or wrong pairing code on every route', async () => {
  await withServer(fakeDeps(), async (call) => {
    assert.strictEqual((await call('/qw/ping', { token: 'WRONG' })).status, 401);
    assert.strictEqual((await call('/qw/conversations', { token: '' })).status, 401);
    assert.strictEqual((await call('/qw/conversations/a1/message', { method: 'POST', token: 'QW-TEST-CODE-123X', body: { text: 'x' } })).status, 401);
  });
});

test('ping, list and get answer with the viewer-safe shapes', async () => {
  await withServer(fakeDeps(), async (call) => {
    const ping = await call('/qw/ping');
    assert.strictEqual(ping.status, 200);
    assert.strictEqual(ping.data.device, 'test-pc');
    const list = await call('/qw/conversations');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.data.map((c) => c.id), ['b2', 'a1']); // newest first
    const one = await call('/qw/conversations/a1');
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.data.display.length, 1);
    assert.strictEqual(one.data.history, undefined, 'raw model history must not leave the host');
    assert.ok(!JSON.stringify(one.data).includes('SECRET PROMPT'));
    assert.strictEqual((await call('/qw/conversations/zz')).status, 404);
  });
});

test('message, start and stop route to the deps and map errors to HTTP codes', async () => {
  await withServer(fakeDeps(), async (call) => {
    const start = await call('/qw/conversations', { method: 'POST', body: { text: 'build it' } });
    assert.strictEqual(start.status, 202);
    assert.strictEqual(start.data.got, 'build it');
    const msg = await call('/qw/conversations/a1/message', { method: 'POST', body: { text: 'continue' } });
    assert.strictEqual(msg.status, 202);
    const missing = await call('/qw/conversations/zz/message', { method: 'POST', body: { text: 'x' } });
    assert.strictEqual(missing.status, 404);
    const empty = await call('/qw/conversations/a1/message', { method: 'POST', body: {} });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual((await call('/qw/conversations/a1/stop', { method: 'POST', body: {} })).status, 202);
    assert.strictEqual((await call('/qw/nonsense')).status, 404);
  });
});

test('makeToken produces distinct, readable codes and tokenOk compares safely', () => {
  const a = R.makeToken();
  const b = R.makeToken();
  assert.match(a, /^QW-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notStrictEqual(a, b);
  assert.ok(R.tokenOk(`Bearer ${a}`, a));
  assert.ok(!R.tokenOk(`Bearer ${a}`, b));
  assert.ok(!R.tokenOk('', a));
  assert.ok(!R.tokenOk(`Bearer ${a}x`, a));
  assert.ok(!R.tokenOk(`Bearer ${a}`, ''));
});
