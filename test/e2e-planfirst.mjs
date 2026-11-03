// Plan-first smoke test: with the setting on, a task's first turn must run on the ⚡ node's
// strongest model, restricted to planning tools; the scripted plan lands as todos; and the
// everyday (scripted local) model executes it — writing the file the plan names.
// Run under a display: xvfb-run -a npm run test:e2e:planfirst
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PLANFIRST SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PLANFIRST smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-pf-'));
const madeFile = path.join(ws, 'calc.py');

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

// The everyday model: executes whatever plan is in its history.
let localRequests = 0;
const localBodies = [];
const local = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    localRequests++;
    localBodies.push(body);
    if (localRequests === 1) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'calc.py', content: 'print(1 + 1)\n' }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    return sse(res, [
      { choices: [{ delta: { content: 'Built per the plan.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
  });
});

// The ⚡ node: the first planning turn returns a vague plan (no files, no commands) — the app
// must bounce it back once — and the rewrite returns a concrete one the small model can run.
let hpChats = 0;
const hpBodies = [];
const hpNode = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"version":"0.20.0"}');
  }
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }));
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hpChats++;
      hpBodies.push(body);
      const todos = hpChats === 1
        ? [{ content: 'Set up the project structure', status: 'in_progress' }, { content: 'Implement the calculator logic', status: 'pending' }, { content: 'Test the application', status: 'pending' }]
        : [
            { content: 'Create calc.py with the four operations', status: 'in_progress', details: 'Write calc.py with def add(a, b), sub(a, b), mul(a, b) and div(a, b); div raises ZeroDivisionError with the message "cannot divide by zero" when b == 0. At the bottom, under if __name__ == "__main__":, print add(1, 1).' },
            { content: 'Run python calc.py to verify', status: 'pending', details: 'Run python calc.py from the project root. Done when it prints 2 and exits with code 0; if Python is missing, install it with install_app first and run again.' }
          ];
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: hpChats === 1 ? 'Plan recorded.' : 'Approach: one Python file, calc.py, holding four pure functions (add, sub, mul, div) so each can be checked on its own, with a tiny main block that prints one result. No packages are needed. Division by zero is the only pitfall: raise a clear error instead of returning inf. Concrete plan recorded.', tool_calls: [{ function: { name: 'todo_write', arguments: { todos } } }] } }) + '\n');
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 90 }) + '\n');
      return res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('{}');
});

await Promise.all([
  new Promise((r) => local.listen(0, '127.0.0.1', r)),
  new Promise((r) => hpNode.listen(0, '127.0.0.1', r))
]);
const localBase = `http://127.0.0.1:${local.address().port}/v1`;
const hpBase = `http://127.0.0.1:${hpNode.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  await win.evaluate(([a, hp]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-planFirst').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    if (document.querySelector('#s-lessonsEnabled')) document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    settingsNodes.push({ id: 'node-hp', name: 'Big PC', baseUrl: hp, enabled: true, highPerf: true });
    return document.querySelector('#s-save').onclick();
  }, [localBase, hpBase]);

  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'build me a calculator app';
    document.querySelector('#btn-send').onclick();
  });

  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Built per the plan.')),
    null,
    { timeout: 45_000 }
  ).catch(() => fail('the everyday model never finished executing the plan'));

  if (hpChats !== 2) fail(`expected 2 planning chats on the ⚡ node (vague plan + rewrite), saw ${hpChats}`);
  const hpReq = JSON.parse(hpBodies[0] || '{}');
  if (hpReq.model !== 'qwen3-coder:30b') fail(`the planning turn asked for "${hpReq.model}", not the node's strongest model`);
  if (!hpBodies[0].includes('planning model for this task')) fail('the planning reminder never reached the ⚡ node');
  for (const [i, b] of [hpBodies[0], hpBodies[1]].entries()) {
    const tools = (JSON.parse(b || '{}').tools || []).map((t) => t.function?.name).sort();
    if (tools.join(',') !== 'ask_user,todo_write') fail(`planning turn ${i + 1} should only get planning tools, saw: ${tools.join(', ')}`);
  }
  if (!hpBodies[1].includes('not executable')) fail('the vague-plan corrective reminder never reached the rewrite turn');
  if (localRequests !== 2) fail(`expected 2 everyday-model requests (execute + final), saw ${localRequests}`);
  if (!localBodies[0]?.includes('written by the planning model')) fail('the back-to-everyday reminder is missing from the execution request');
  if (!fs.existsSync(madeFile)) fail('the everyday model never wrote the file the plan named');
  const todos = await win.evaluate(() => (state.conv?.todos || []).map((t) => t.content));
  if (todos.length !== 2 || !todos[0].includes('calc.py')) fail(`the plan never landed as todos: ${JSON.stringify(todos)}`);
  // The everyday model gets the planner's approach and the current step's details every turn.
  const first = localBodies[0] || '';
  if (!first.includes("The planner's approach (follow it)") || !first.includes('four pure functions')) fail('the executor did not get the planner\'s approach');
  if (!first.includes('How to do it (from the plan)') || !first.includes('ZeroDivisionError')) fail('the executor did not get the current step\'s details');
  const kept = await win.evaluate(() => state.conv.todos.every((t) => t.details && t.details.length > 100));
  if (!kept) fail('step details were lost');
  const notes = await win.evaluate(() => (state.conv?.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((t) => /Planning on qwen3-coder:30b on Big PC/.test(t))) fail(`the planning notice is missing; notices were: ${JSON.stringify(notes)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Leave settings pristine for whatever suite runs next.
  await win.evaluate(async () => {
    state.settings = await api.setSettings({ ollamaNodes: [], planFirst: false });
    syncNodeRouting();
  }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  local.close();
  hpNode.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`planfirst smoke ok: vague plan bounced for a rewrite (${hpChats} planning chats, planning tools only), concrete plan landed as 2 todos, everyday model executed it (${localRequests} requests)`);
