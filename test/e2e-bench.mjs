// Benchmark smoke test: the quick set (3 tasks) runs twice against a mock model.
//  1. right answers: each task runs in its own fresh folder, hidden checks run after the agent
//     finishes (page probes click and read the page; the JS task's hidden test runs with node),
//     3/3 pass, and the run is saved;
//  2. wrong answers: 0/3, and each task is marked "broke" against the saved run;
//  3. approvals come back to what they were, and so does the open folder.
// Run under a display: xvfb-run -a npm run test:e2e:bench
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`BENCH SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=BENCH smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bench-home-'));
let phase = 1;
const RIGHT = {
  counter: ['counter.html', '<!doctype html><html><body><span id="count">0</span><button id="plus">+</button><button id="minus">-</button><script>let n=0;const c=document.getElementById("count");plus.onclick=()=>{c.textContent=++n};minus.onclick=()=>{c.textContent=--n};</script></body></html>'],
  hello: ['index.html', '<!DOCTYPE html><html><head><title>Hello</title></head><body><p id="out"></p><script>document.getElementById("out").textContent="Hello, world!";</script></body></html>'],
  stats: ['stats.js', 'function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }\nfunction median(xs) { const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }\nmodule.exports = { mean, median };\n']
};
const WRONG = {
  counter: ['counter.html', '<!doctype html><html><body><span id="count">5</span><button id="plus">+</button><button id="minus">-</button></body></html>'],
  hello: ['index.html', '<!DOCTYPE html><html><body><p>Hello, world!</p></body></html>'],
  stats: ['stats.js', 'function mean(xs) { return 0; }\nfunction median(xs) { return 0; }\nmodule.exports = { mean, median };\n']
};
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"bench-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    const ask = String(b.messages.find((m) => m.role === 'user')?.content || '');
    const done = b.messages.some((m) => m.role === 'tool');
    if (done) return sse(res, [{ choices: [{ delta: { content: 'Done.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const set = phase === 1 ? RIGHT : WRONG;
    const [p, content] = /counter\.html/.test(ask) ? set.counter : /index\.html shows nothing/.test(ask) ? set.hello : set.stats;
    sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content }) } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const runOnce = async () => {
  const before = await win.evaluate(() => (window.__benchStarts = 0));
  void before;
  // Count starts, so a finished earlier run's results are never read as this run's.
  await win.evaluate(() => {
    if (!window.__benchWrapped) {
      window.__benchWrapped = true;
      const orig = renderBenchmark;
      renderBenchmark = (...a) => { if (bench.running && bench.results.length === 0) window.__benchStarted = true; return orig(...a); };
    }
    window.__benchStarted = false;
    openSettings();
    document.querySelector('#bench-set').value = 'quick';
    setTimeout(() => document.querySelector('#bench-run-btn').click(), 0);
  });
  await win.waitForFunction(() => window.__benchStarted === true, null, { timeout: 20_000 });
  await win.waitForFunction(() => !bench.running && bench.results.length === 3, null, { timeout: 120_000 });
  return win.evaluate(() => bench.results.map((r) => ({ id: r.id, passed: r.passed, skipped: !!r.skipped, checks: r.checks })));
};

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'bench-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'edits';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-describeScreens').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  const r1 = await runOnce();
  if (r1.some((r) => r.skipped)) fail(`a quick task was skipped: ${JSON.stringify(r1)}`);
  if (!r1.every((r) => r.passed)) fail(`right answers should pass: ${JSON.stringify(r1)}`);
  const saved = await win.evaluate(() => api.benchLast());
  if (!saved || saved.results?.length !== 3) fail('the run was not saved');

  phase = 2;
  const r2 = await runOnce();
  if (r2.some((r) => r.passed)) fail(`wrong answers should fail: ${JSON.stringify(r2)}`);
  const why = r2.map((r) => (r.checks || []).map((c) => c.detail).join('; '));
  if (!/count shows "6"|count shows/.test(why[0])) fail(`counter failure reason: ${why[0]}`);
  if (!/#out is missing/.test(why[1])) fail(`hello failure reason: ${why[1]}`);
  if (!/exit [1-9]/.test(why[2])) fail(`stats failure reason: ${why[2]}`);
  const table = await win.evaluate(() => document.querySelector('#bench-results').textContent);
  if ((table.match(/▼ broke/g) || []).length !== 3) fail(`each task should show "broke" against the last run: ${table.slice(0, 400)}`);
  if (!/0\/3 passed .*last run: 3\/3 passed/.test(table)) fail(`summary line: ${table.slice(0, 200)}`);
  const after = await win.evaluate(() => ({ mode: state.settings.approvalMode, root: state.ws?.root }));
  if (after.mode !== 'edits') fail(`approvals should come back to "edits": ${after.mode}`);
  if (after.root !== ws) fail(`the open folder should come back: ${after.root}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ approvalMode: 'auto', describeScreens: true, skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('bench smoke ok: quick set 3/3 with right answers (page probes and a hidden node test), 0/3 with wrong ones and each marked "broke" against the saved run, approvals and the open folder restored');
