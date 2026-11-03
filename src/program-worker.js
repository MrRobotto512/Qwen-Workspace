'use strict';
// One model-written tool program (run_program), run in a worker thread so the main process can
// stop it at any moment with worker.terminate(). vm's own timeout only covers synchronous code:
// a program that looped after its first `await` used to run on the main process's event loop
// with nothing able to interrupt it, freezing the whole app. The sandbox itself is unchanged:
// no require/process/network in scope, no dynamic code generation (codeGeneration strings:false),
// null-prototype host bridges only, and string-only values across the boundary (promises and
// errors the program sees are created in its own realm). Every tools.* call is still executed by
// the renderer through the normal tool pipeline — approvals included; main.js relays the messages.
//
// To the parent: { type: 'call', callId, name, args } for each tools.* call, { type: 'log', line }
// for each console.log, and one { type: 'done', ok, calls, value | error } at the end.
// From the parent: { type: 'answer', callId, result, failed }.
const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');

const MAX_CALLS = 50;
const { runId, code, toolNames } = workerData;
const pending = new Map(); // callId -> { resolve, reject } (sandbox-realm functions)
let calls = 0;
let dead = false;

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
// Factories compiled inside the sandbox realm, so the program only ever sees its own realm's
// promises and functions; host intrinsics never cross the boundary.
const makeWrap = vm.runInContext('(hostCall) => (args) => new Promise((resolve, reject) => { hostCall(JSON.stringify(args ?? {}), resolve, reject); })', ctx);
const tools = vm.runInContext('Object.create(null)', ctx);
for (const name of (toolNames || []).slice(0, 64)) {
  const hostCall = (argsJson, resolve, reject) => {
    if (dead) return reject('The program has ended.');
    if (++calls > MAX_CALLS) {
      dead = true;
      return reject(`Too many tool calls (max ${MAX_CALLS} per program).`);
    }
    const callId = `${runId}:${calls}`;
    pending.set(callId, { resolve, reject });
    let args = {};
    try {
      args = JSON.parse(argsJson);
    } catch {
      /* empty args */
    }
    parentPort.postMessage({ type: 'call', callId, name, args });
  };
  Object.setPrototypeOf(hostCall, null);
  tools[name] = makeWrap(hostCall);
}
const hostLog = (line) => parentPort.postMessage({ type: 'log', line: String(line).slice(0, 2000) });
Object.setPrototypeOf(hostLog, null);
const hostSleep = (argsJson, resolve) => {
  let ms = 0;
  try {
    ms = Number(JSON.parse(argsJson).ms) || 0;
  } catch {
    /* 0 */
  }
  setTimeout(() => resolve(''), Math.min(Math.max(ms, 0), 30_000));
};
Object.setPrototypeOf(hostSleep, null);
const setup = vm.runInContext(`(tools, log, sleepTool) => {
  globalThis.tools = tools;
  const c = Object.create(null);
  c.log = (...a) => log(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
  c.error = c.warn = c.info = c.log;
  globalThis.console = c;
  globalThis.sleep = (ms) => sleepTool({ ms });
}`, ctx);
setup(tools, hostLog, makeWrap(hostSleep));

parentPort.on('message', (m) => {
  if (!m || m.type !== 'answer') return;
  const p = pending.get(m.callId);
  pending.delete(m.callId);
  if (p) (m.failed ? p.reject : p.resolve)(String(m.result ?? ''));
});

(async () => {
  try {
    const script = new vm.Script(`(async () => {\n${String(code)}\n})()`, { filename: 'tool-program.js' });
    const value = await script.runInContext(ctx, { timeout: 30_000 });
    let str = '';
    try {
      str = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      str = String(value);
    }
    parentPort.postMessage({ type: 'done', ok: true, calls, value: String(str).slice(0, 8000) });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, calls, error: String((err && err.message) || err).slice(0, 2000) });
  } finally {
    dead = true;
  }
})();
