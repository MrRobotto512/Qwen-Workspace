// Two-node failover test: two scripted Ollama servers stand in for the home and shop PCs.
// Node A serves the first agent step (a real tool call), then dies; the loop must retry,
// notice A is gone, move to node B, and finish the task there — with a transcript note.
// Run under a display: xvfb-run -a npm run test:e2e:nodes
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`NODES SMOKE FAIL: ${msg}`);
  // On GitHub Actions, surface the reason as an annotation: readable from the checks
  // API even when the raw logs are not.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=NODES smoke::${String(msg).replace(/\n/g, " ").slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-nodes-'));
const madeFile = path.join(ws, 'step1.txt');

// ---- scripted Ollama servers (native /api/chat NDJSON) ----
const MODEL = 'fake-model:latest';
const counts = { aChats: 0, bChats: 0 };

function makeNode(name, onChat) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"version":"0.5.0"}');
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: MODEL }] }));
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => onChat(res, body));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const kill = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };
  return { server, kill, name };
}

const ndjson = (res, lines) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const l of lines) res.write(JSON.stringify(l) + '\n');
  res.end();
};

// Node A: one tool-call turn; the next chat gets its socket destroyed mid-request and the
// whole server dies with it (the "shop PC switched off" moment), so the retry is refused too.
const nodeA = makeNode('A', (res) => {
  counts.aChats++;
  if (counts.aChats > 1) {
    nodeA.kill();
    return;
  }
  ndjson(res, [
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'step1.txt', content: 'written via node A\n' } } }] } },
    { done: true, done_reason: 'stop', prompt_eval_count: 50 }
  ]);
});

// Node B: always answers with the finishing turn.
const nodeB = makeNode('B', (res) => {
  counts.bChats++;
  ndjson(res, [
    { message: { role: 'assistant', content: 'Finished on the shop node.' } },
    { done: true, done_reason: 'stop', prompt_eval_count: 60 }
  ]);
});

await Promise.all([
  new Promise((r) => nodeA.server.listen(0, '127.0.0.1', r)),
  new Promise((r) => nodeB.server.listen(0, '127.0.0.1', r))
]);
const baseA = `http://127.0.0.1:${nodeA.server.address().port}`;
const baseB = `http://127.0.0.1:${nodeB.server.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  // Configure both nodes through the real Settings UI, including the add-node form.
  await win.evaluate(([a, b, model]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-model').value = model;
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#node-new-name').value = 'Shop PC';
    document.querySelector('#node-new-url').value = b;
    document.querySelector('#node-add-btn').onclick();
    return document.querySelector('#s-save').onclick();
  }, [baseA, baseB, MODEL]);

  // The status pill should wake up once two nodes are enabled.
  await win.waitForFunction(() => !document.querySelector('#sb-nodes').classList.contains('hidden'), null, { timeout: 10_000 })
    .catch(() => fail('the node status pill never appeared'));

  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'do the two-step task';
    document.querySelector('#btn-send').onclick();
  });

  // Step 1 runs on node A and writes the file.
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(madeFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(madeFile)) fail('node A never executed the first tool call');

  // Node A is dead now; the loop must retry, move to B, and finish there.
  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Finished on the shop node.')),
    null,
    { timeout: 45_000 }
  ).catch(() => fail('the task never finished on node B'));

  const notes = await win.evaluate(() => (state.conv?.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((t) => /moving to Shop PC/i.test(t))) fail(`no "moving to Shop PC" transcript note; notices were: ${JSON.stringify(notes)}`);

  // --- remote-only: This PC disabled, one remote enabled must route (the Mac-at-work case).
  // Node A (this-pc's address) is dead, so any fallback to the plain baseUrl would fail here.
  const bBefore = counts.bChats;
  await win.evaluate(async (bURL) => {
    state.settings = await api.setSettings({ ollamaNodes: [{ id: 'this-pc', enabled: false }, { id: 'node-b', name: 'Shop PC', baseUrl: bURL, enabled: true }] });
    syncNodeRouting();
    newChat();
    document.querySelector('#prompt').value = 'finish the job remotely';
    document.querySelector('#btn-send').onclick();
  }, baseB);
  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Finished on the shop node.')),
    null,
    { timeout: 30_000 }
  ).catch(() => fail('remote-only routing: the task never ran on the enabled remote node'));
  if (counts.bChats <= bBefore) fail('remote-only routing: node B never received the request');

  // Leave settings pristine for whatever test runs next: a saved remote-only node config
  // would silently redirect other suites' model requests to a dead port.
  await win.evaluate(async () => {
    state.settings = await api.setSettings({ ollamaNodes: [] });
    syncNodeRouting();
  });
  if (counts.aChats !== 2) fail(`expected 2 chats on node A (tool turn + the killed one), saw ${counts.aChats}`);
  if (counts.bChats < 1) fail('node B never served a chat');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Teardown watchdog: every assertion has already run by this point, so a hung
  // app.close() (a rare Playwright/Electron teardown wedge) must not eat the result.
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  nodeA.kill();
  nodeB.kill();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`nodes smoke ok: step 1 on node A (${counts.aChats} chat), A killed, task moved to node B (${counts.bChats} chat) with a transcript note`);
