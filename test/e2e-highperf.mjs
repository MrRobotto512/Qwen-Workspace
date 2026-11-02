// High-performance node smoke test: a scripted "local model" runs the same failing command
// twice; the fail-streak trigger escalates — but instead of the paid planner, the stuck step
// must run on the high-performance node's strongest installed model (a scripted Ollama server
// claiming qwen3-coder:30b). The planner is configured and must NOT be called.
// Run under a display: xvfb-run -a npm run test:e2e:highperf
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`HIGHPERF SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=HIGHPERF smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-hp-'));

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const toolCallTurn = (id, command) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

// The local model: issues the same failing command on every turn, never finishing.
let localRequests = 0;
const local = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    localRequests++;
    sse(res, toolCallTurn(`c${localRequests}`, 'exit 7'));
  });
});

// The high-performance node: a native-Ollama server whose tags list a top catalog model.
// The escalated step must land here, with that model and the node's 5m default keep_alive.
// Its first turn runs a failing command — the baton rule says the node, not the small model,
// must get the follow-up turn that deals with that failure.
let hpChats = 0;
const hpBodies = [];
const hpNode = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"version":"0.5.0"}');
  }
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }, { name: 'qwen2.5-coder:1.5b' }] }));
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hpChats++;
      hpBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (hpChats === 1) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'exit 3' } } }] } }) + '\n');
      } else if (hpChats === 2) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'Big node finished the job.' } }) + '\n');
      } else {
        // The rescue-lessons request at task end; NONE keeps the e2e free of the approval card.
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'NONE' } }) + '\n');
      }
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 80 }) + '\n');
      return res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('{}');
});

// The planner: configured and reachable, but with the high-perf node up it must stay unused.
let plannerRequests = 0;
const planner = http.createServer((req, res) => {
  plannerRequests++;
  res.writeHead(500);
  res.end('{"error":"the planner should not have been called"}');
});

await Promise.all([
  new Promise((r) => local.listen(0, '127.0.0.1', r)),
  new Promise((r) => hpNode.listen(0, '127.0.0.1', r)),
  new Promise((r) => planner.listen(0, '127.0.0.1', r))
]);
const localBase = `http://127.0.0.1:${local.address().port}/v1`;
const hpBase = `http://127.0.0.1:${hpNode.address().port}`;
const plannerBase = `http://127.0.0.1:${planner.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  // Configure through the real Settings UI, including the add-node form and the ⚡ toggle.
  await win.evaluate(([a, hp, b]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = true;
    document.querySelector('#s-heavy-provider').value = 'anthropic';
    document.querySelector('#s-heavy-baseUrl').value = b;
    document.querySelector('#s-heavy-apiKey').value = 'test-key';
    document.querySelector('#s-heavy-model').value = 'planner-mock';
    document.querySelector('#s-esc-failstreak').checked = true;
    document.querySelector('#s-esc-failstreak-n').value = '2';
    // Lessons stay ON: a rescued task must send its lessons request to the ⚡ node too.
    if (document.querySelector('#s-lessonsEnabled')) document.querySelector('#s-lessonsEnabled').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    document.querySelector('#node-new-name').value = 'Big PC';
    document.querySelector('#node-new-url').value = hp;
    document.querySelector('#node-add-btn').onclick();
    // The new row's ⚡ button marks it high-performance.
    const rows = [...document.querySelectorAll('#nodes-list .mcp-item')];
    rows[rows.length - 1].querySelector('.hp-btn').click();
    return document.querySelector('#s-save').onclick();
  }, [localBase, hpBase, plannerBase]);

  const saved = await win.evaluate(() => state.settings.ollamaNodes);
  if (!saved.some((n) => n.highPerf && n.name === 'Big PC')) fail(`the high-perf flag did not save: ${JSON.stringify(saved)}`);

  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'build the project';
    document.querySelector('#btn-send').onclick();
  });

  // Two failing local turns → fail streak → the escalated step lands on the big node.
  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Big node finished the job.')),
    null,
    { timeout: 45_000 }
  ).catch(() => fail('the high-performance node turn never rendered'));

  const notes = await win.evaluate(() => (state.conv?.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((t) => /failed 2 times in a row — running the next step on a stronger model/.test(t))) {
    fail(`the fail-streak note is missing or names the wrong target; notices were: ${JSON.stringify(notes)}`);
  }
  if (!notes.some((t) => /Running this step on qwen3-coder:30b on Big PC/.test(t))) {
    fail(`the step note naming the node is missing; notices were: ${JSON.stringify(notes)}`);
  }
  if (localRequests !== 2) fail(`expected exactly 2 local model requests before escalation, saw ${localRequests}`);
  // Three node chats: the failing command turn, the follow-up the baton rule keeps on the
  // node, and the rescue-lessons request at task end (the node is the teacher, for free).
  const lessonsDeadline = Date.now() + 20_000;
  while (hpChats < 3 && Date.now() < lessonsDeadline) await new Promise((r) => setTimeout(r, 300));
  if (hpChats !== 3) fail(`expected 3 chats on the high-perf node (fail + follow-up + rescue lessons), saw ${hpChats}`);
  if (hpChats === 3) {
    if (!hpBodies[2].includes('needed rescuing')) fail('the rescue-lessons prompt never reached the node');
    if (!hpBodies[2].includes('command failed: exit 7')) fail('the rescue digest is missing the failed command');
    if (JSON.parse(hpBodies[2]).model !== 'qwen3-coder:30b') fail('the lessons request should run on the node’s strongest model');
  }
  if (plannerRequests !== 0) fail(`the planner was called ${plannerRequests} time(s) — the whole point is that it should not be`);
  const hpReq = JSON.parse(hpBodies[0] || '{}');
  if (hpReq.model !== 'qwen3-coder:30b') fail(`the escalated step asked the node for "${hpReq.model}", not its strongest model`);
  if (hpReq.keep_alive !== '5m') fail(`the escalated step should carry the node's 5m default keep_alive, saw ${JSON.stringify(hpReq.keep_alive)}`);
  // The free tier must not touch the cost meter.
  const spend = await win.evaluate(() => state.conv?.spend || {});
  if (Object.keys(spend).length) fail(`the high-perf step recorded cloud spend: ${JSON.stringify(spend)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Leave settings pristine for whatever suite runs next.
  await win.evaluate(async () => {
    state.settings = await api.setSettings({ ollamaNodes: [], heavy: { enabled: false }, escalation: {} });
    syncNodeRouting();
  }).catch(() => {});
  // Teardown watchdog: every assertion has already run by this point, so a hung
  // app.close() (a rare Playwright/Electron teardown wedge) must not eat the result.
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  local.close();
  hpNode.close();
  planner.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`highperf smoke ok: ${localRequests} failing local turns, escalated to the node (${hpChats} chats incl. baton follow-up + rescue lessons, qwen3-coder:30b), planner untouched (${plannerRequests} requests)`);
