'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Worker } = require('node:worker_threads');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'program-worker.js'), 'utf8');

// Runs a program the way main.js does (eval mode, so it also works from inside an asar), with
// `answer(name, args)` standing in for the renderer's tool pipeline. Resolves with
// { done, calls, logs, worker } once the worker reports, or after `settleMs` with done = null.
function run(code, { toolNames = ['read_file'], answer = async () => 'ok', settleMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(SOURCE, { eval: true, workerData: { runId: 'p1', code, toolNames } });
    const logs = [];
    const calls = [];
    let done = null;
    const timer = setTimeout(() => resolve({ done, calls, logs, worker }), settleMs);
    worker.on('message', async (m) => {
      if (m.type === 'log') logs.push(m.line);
      else if (m.type === 'call') {
        calls.push(m);
        try {
          worker.postMessage({ type: 'answer', callId: m.callId, result: await answer(m.name, m.args), failed: false });
        } catch (e) {
          worker.postMessage({ type: 'answer', callId: m.callId, result: String(e.message || e), failed: true });
        }
      } else if (m.type === 'done') {
        done = m;
        clearTimeout(timer);
        resolve({ done, calls, logs, worker });
      }
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      resolve({ done: { ok: false, error: String(e) }, calls, logs, worker });
    });
  });
}

test('program worker: tool calls round-trip through the parent; logs and the return value come back', async () => {
  const r = await run(`
    const a = await tools.read_file({ path: 'a.txt' });
    const b = await tools.read_file({ path: 'b.txt' });
    console.log('read', a.length + b.length, { ok: true });
    return { total: a + b };
  `, { answer: async (name, args) => `<${name}:${args.path}>` });
  await r.worker.terminate();
  assert.equal(r.done?.ok, true, JSON.stringify(r.done));
  assert.deepEqual(r.calls.map((c) => [c.callId, c.name, c.args]), [['p1:1', 'read_file', { path: 'a.txt' }], ['p1:2', 'read_file', { path: 'b.txt' }]]);
  assert.deepEqual(r.logs, [`read ${'<read_file:a.txt>'.length * 2} {"ok":true}`]);
  assert.equal(r.done.calls, 2);
  assert.equal(r.done.value, JSON.stringify({ total: '<read_file:a.txt><read_file:b.txt>' }));
});

test('program worker: a failed tool call rejects inside the program and can be caught', async () => {
  const r = await run("try { await tools.read_file({ path: 'x' }); return 'no'; } catch (e) { return 'caught: ' + e; }", { answer: async () => { throw new Error('Error: not found'); } });
  await r.worker.terminate();
  assert.equal(r.done?.ok, true, JSON.stringify(r.done));
  assert.equal(r.done.value, 'caught: Error: not found');
});

test('program worker: the sandbox has no require, process, fetch or dynamic code', async () => {
  const r = await run(`
    const kinds = [typeof require, typeof process, typeof fetch];
    let evalWorks = true;
    try { eval('1'); } catch { evalWorks = false; }
    let fnWorks = true;
    try { new Function('return 1')(); } catch { fnWorks = false; }
    return kinds.join(',') + '|' + evalWorks + '|' + fnWorks;
  `);
  await r.worker.terminate();
  assert.equal(r.done?.ok, true, JSON.stringify(r.done));
  assert.equal(r.done.value, 'undefined,undefined,undefined|false|false');
});

// The reason the worker exists: vm's timeout covers synchronous code only, so a program that
// spins after an await used to block the main process forever. In a worker it can be killed.
test('program worker: a program that spins after an await never finishes on its own but can be terminated at once', async () => {
  const t0 = Date.now();
  const r = await run('await sleep(10); for (;;) {}', { settleMs: 800 });
  assert.equal(r.done, null, 'the spin must not report done');
  const t1 = Date.now();
  await r.worker.terminate();
  const took = Date.now() - t1;
  assert.ok(took < 2000, `terminate() took ${took}ms`);
  assert.ok(Date.now() - t0 < 5000);
});

test('program worker: a 51st tool call is refused', async () => {
  const r = await run("let n = 0; try { for (let i = 0; i < 60; i++) { await tools.read_file({ path: String(i) }); n++; } } catch (e) { return n + ' then ' + e; }");
  await r.worker.terminate();
  assert.equal(r.done?.ok, true, JSON.stringify(r.done));
  assert.equal(r.done.value, '50 then Too many tool calls (max 50 per program).');
});

test('program worker: a syntax error is reported as a failed program, not a crash', async () => {
  const r = await run('return (');
  await r.worker.terminate();
  assert.equal(r.done?.ok, false);
  assert.match(String(r.done.error), /unexpected|syntax|token/i);
});
