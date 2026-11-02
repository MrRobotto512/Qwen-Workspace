// Steering smoke test: messages typed while Qwen works used to be dropped silently. Now they
// queue and reach the model at its next step. Two cases: a steer during a tool turn redirects
// the work (b.txt instead of a.txt), and a steer during the FINAL reply keeps the task alive
// instead of vanishing when the loop ends.
// Run under a display: xvfb-run -a npm run test:e2e:steer
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`STEER SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=STEER smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-steer-'));
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const writeTurn = (id, file) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: `${file}\n` }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const textTurn = (t) => [
  { choices: [{ delta: { content: t }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
];

// Every reply is delayed so the test can steer while a request is in flight.
let requests = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  // Only chat completions are numbered turns; the app also lists models (GET /models).
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"steer-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const n = ++requests;
    bodies.push(body);
    setTimeout(() => {
      if (n === 1) return sse(res, writeTurn('c1', 'a.txt'));
      if (n === 2) return sse(res, writeTurn('c2', body.includes('actually name it b.txt') ? 'b.txt' : 'wrong.txt'));
      if (n === 3) return sse(res, textTurn('Done with b.txt.'));
      if (n === 4) return sse(res, textTurn('hi'));
      if (n === 5) return sse(res, textTurn(body.includes('and also say bye') ? 'bye' : 'steer lost'));
      return sse(res, textTurn('extra'));
    }, 1500);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const waitFor = async (pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  fail(`timed out waiting for ${what}`);
  return false;
};
const type = (text) => win.evaluate((t) => {
  document.querySelector('#prompt').value = t;
  document.querySelector('#btn-send').onclick();
}, text);
const rendered = (t) => win.evaluate((x) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(x)), t);

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'steer-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // Case 1: steer during a tool turn.
  await type('make a.txt');
  await waitFor(async () => requests >= 1, 10_000, 'the first request');
  // The send button must stay usable while Qwen works.
  if (await win.evaluate(() => document.querySelector('#btn-send').classList.contains('hidden'))) fail('the send button is hidden while Qwen works');
  await type('actually name it b.txt');
  const queued = await win.evaluate(() => document.querySelectorAll('.msg.user.queued').length);
  if (queued !== 1) fail(`the steering message should show as waiting, saw ${queued} queued bubbles`);
  await waitFor(() => rendered('Done with b.txt.'), 20_000, 'the steered task to finish');
  if (!fs.existsSync(path.join(ws, 'b.txt'))) fail('the steer never redirected the work: b.txt is missing');
  if (fs.existsSync(path.join(ws, 'wrong.txt'))) fail('request 2 went out without the steering message');
  if (!bodies[1]?.includes('while you were working')) fail('the steering message lacks its priority reminder');
  if (await win.evaluate(() => document.querySelectorAll('.msg.user.queued').length)) fail('a drained message still shows as waiting');

  // Case 2: steer while the FINAL reply streams — the task must continue, not drop it.
  await waitFor(async () => !(await win.evaluate(() => state.conv.busy)), 5_000, 'the first task to end');
  await type('say hi');
  await waitFor(async () => requests >= 4, 10_000, 'the hi request');
  await type('and also say bye');
  await waitFor(() => rendered('bye'), 20_000, 'the late steer to be answered');
  if (await rendered('steer lost')) fail('the late steering message never reached the model');
  if (requests !== 5) {
    // What each request ended with — the last user/tool message tells the story of a miss.
    const tails = bodies.map((b, i) => {
      const msgs = JSON.parse(b).messages || [];
      const last = msgs[msgs.length - 1] || {};
      return `#${i + 1} ${last.role}: ${String(last.content || '').slice(0, 60).replace(/\n/g, ' ')}`;
    }).join(' | ');
    fail(`expected 5 requests in all, saw ${requests}; ${tails}`);
  }
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`steer smoke ok: mid-tool steer redirected the work (b.txt), late steer during the final reply kept the task going (${requests} requests)`);
