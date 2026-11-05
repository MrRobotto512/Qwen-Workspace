// Step progress + plan-rewrite smoke test, from a field report where a slow local model looked
// "stuck" and a vague ⚡ plan went down to the small model anyway.
//  1. The ⚡ node writes a vague plan; asked to rewrite, it runs a command instead — that call is
//     REFUSED (nothing runs), it is asked again for the plan only, and the concrete plan lands.
//  2. While the local model reads its prompt (2.5s of silence) the status line says
//     "Reading the prompt (~N tokens) (slow:7b) · 0:02"; while it thinks, "Thinking · ~N tokens ·
//     X tok/s"; the debug log records Ollama's prompt time, speed and output tokens.
//  3. /api/ps shows a GPU spill → the context window is set to 14336 on its own (no button),
//     and the next request asks Ollama for num_ctx 14336.
// Run under a display: xvfb-run -a npm run test:e2e:progress
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PROGRESS SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PROGRESS smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-prog-'));
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const line = (res, o) => res.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });

// ⚡ node: vague plan → a command instead of a rewrite → a concrete plan.
let hpChats = 0;
const hpBodies = [];
const hp = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'qwen3-coder:30b' }] });
  if (req.method !== 'POST' || req.url !== '/api/chat') return json(res, {}, 404);
  const body = await readBody(req);
  hpChats++;
  hpBodies.push(body);
  const call = hpChats === 1
    ? { name: 'todo_write', arguments: { todos: [{ content: 'Verify Python', status: 'in_progress' }, { content: 'Design calculator UI', status: 'pending' }, { content: 'Implement logic', status: 'pending' }] } }
    : hpChats === 2
      ? { name: 'run_command', arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"' } }
      : { name: 'todo_write', arguments: { todos: [{ content: 'Create calc.py with the four operations', status: 'in_progress' }, { content: 'Run python calc.py to verify', status: 'pending' }] } };
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  line(res, { message: { role: 'assistant', content: '', tool_calls: [{ function: call }] }, done: false });
  line(res, { done: true, done_reason: 'stop', prompt_eval_count: 90 });
  res.end();
});

// This PC: slow to read the prompt, then thinks at ~10 tok/s; spilling onto the CPU.
let localChats = 0;
const localBodies = [];
const local = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'slow:7b', size: 9e9 }] });
  if (req.method === 'GET' && req.url === '/api/ps') return json(res, { models: [{ name: 'slow:7b', size: 15e9, size_vram: 12e9, context_length: 32768 }] });
  if (req.method !== 'POST' || req.url !== '/api/chat') return json(res, {}, 404);
  const body = await readBody(req);
  const n = ++localChats;
  localBodies.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  if (n === 1) {
    await sleep(2500); // "reading the prompt": Ollama streams nothing
    for (let i = 0; i < 25; i++) {
      line(res, { message: { role: 'assistant', content: '', thinking: `step ${i} ` }, done: false });
      await sleep(100);
    }
    line(res, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'calc.py', content: 'print(1 + 1)\n' } } }] }, done: false });
    line(res, { done: true, done_reason: 'stop', prompt_eval_count: 900, prompt_eval_duration: 2.4e9, eval_count: 26, eval_duration: 2.5e9, load_duration: 1e7 });
  } else {
    line(res, { message: { role: 'assistant', content: n === 2 ? 'Built per the plan.' : 'Again done.' }, done: false });
    line(res, { done: true, done_reason: 'stop', prompt_eval_count: 950, eval_count: 4 });
  }
  res.end();
});

await Promise.all([new Promise((r) => hp.listen(0, '127.0.0.1', r)), new Promise((r) => local.listen(0, '127.0.0.1', r))]);
const hpBase = `http://127.0.0.1:${hp.address().port}`;
const localBase = `http://127.0.0.1:${local.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const finished = (text, timeout = 45_000) => win.waitForFunction((t) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(t)), text, { timeout });

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(([a, h]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-model').value = 'slow:7b';
    document.querySelector('#s-contextLength').value = '32768';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-planFirst').checked = true;
    document.querySelector('#s-planWith').value = 'node'; // not left over from another test
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    settingsNodes.push({ id: 'node-hp', name: 'Alien', baseUrl: h, enabled: true, highPerf: true });
    return document.querySelector('#s-save').onclick();
  }, [localBase, hpBase]);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => {
    window.__acts = [];
    window.__sampler = setInterval(() => { const a = state.conv.activity; if (a && window.__acts.at(-1) !== a) window.__acts.push(a); }, 150);
    document.querySelector('#prompt').value = 'build me a calculator app';
    document.querySelector('#btn-send').onclick();
  });
  await finished('Built per the plan.').catch(() => fail('the task never finished'));

  // 1. plan rewrite
  if (hpChats !== 3) fail(`expected 3 planning chats (vague, command instead of plan, concrete), saw ${hpChats}`);
  if (fs.existsSync(path.join(ws, 'ran.txt'))) fail('the planning turn\'s run_command was executed; it must be refused');
  if (!hpBodies[2]?.includes('this is the planning turn')) fail('the refused call did not tell the planner why');
  if (!hpBodies[2]?.includes('You did not write a plan')) fail('the missing plan was not asked for again');
  const st = await win.evaluate(() => ({ todos: state.conv.todos.map((t) => t.content), notices: state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text), log: state.conv.log, acts: window.__acts }));
  if (st.todos[0] !== 'Create calc.py with the four operations') fail(`the concrete plan did not land: ${JSON.stringify(st.todos)}`);
  if (!st.notices.includes('No plan came back — asking again for the plan only.')) fail(`no "asking again" notice: ${JSON.stringify(st.notices)}`);
  if (!JSON.stringify(localBodies[0]).includes('You are the everyday model now')) fail('the everyday model did not get the handoff');

  // 2. live progress + timings
  if (!st.acts.some((a) => /^Reading the prompt \(~[\d.]+K? tokens\) \(slow:7b\) · 0:0[12]$/.test(a))) fail(`no "Reading the prompt" status: ${JSON.stringify(st.acts.slice(0, 12))}`);
  if (!st.acts.some((a) => /^Thinking · ~\d+ tokens · [\d.]+ tok\/s · 0:0\d$/.test(a))) fail(`no "Thinking" status with speed: ${JSON.stringify(st.acts.slice(0, 20))}`);
  const slowResp = st.log.find((e) => e.kind === 'response' && e.promptMs === 2400);
  if (!slowResp || slowResp.completionTokens !== 26 || slowResp.genTokPerSec !== 10.4 || !(slowResp.firstMs >= 2400)) fail(`the debug log lacks the step's timings: ${JSON.stringify(slowResp || st.log.filter((e) => e.kind === 'response'))}`);

  // 3. Fit to GPU, on its own: the spill seen after the step sets the window for the next request
  const spill = st.notices.find((t) => /slow:7b was running partly on the CPU/.test(t)) || '';
  if (!/only 12 of 15 GB \(80%\) fit in GPU memory .* Context window set to 14336 so all of it fits from the next step/.test(spill)) fail(`spill notice: ${spill || JSON.stringify(st.notices)}`);
  if (await win.evaluate(() => [...document.querySelectorAll('#toasts button')].some((x) => /^Fit to GPU \(/.test(x.textContent.trim())))) fail('a "Fit to GPU" button was offered although the window was fitted on its own');
  await win.waitForFunction(() => state.settings.contextLength === 14336, null, { timeout: 5000 }).catch(() => fail('the fit did not set the context window'));
  await win.evaluate(() => { document.querySelector('#prompt').value = 'again'; document.querySelector('#btn-send').onclick(); });
  await finished('Again done.').catch(() => fail('the second task never finished'));
  const ctx = localBodies.at(-1)?.options?.num_ctx;
  if (ctx !== 14336) fail(`the next request should ask for num_ctx 14336, got ${ctx}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => {
    clearInterval(window.__sampler);
    state.settings = await api.setSettings({ ollamaNodes: [], provider: 'custom', planFirst: false, contextLength: 32768, skillWriter: true });
  }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  hp.close();
  local.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('progress smoke ok: planning-turn command refused and the plan asked for again (3 ⚡ chats), "Reading the prompt" → "Thinking · tok/s" shown live, timings logged, the spill fitted the window to 14336 for the next request');
