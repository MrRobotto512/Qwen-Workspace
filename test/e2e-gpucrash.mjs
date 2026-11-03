// GPU crash recovery smoke test (a field report: "CUDA error: an illegal memory access was
// encountered" ended the task, and a paid review pass ran on the half-done work right after):
//  1. the model runner crashes: the step is retried; it crashes again: the next step runs on the
//     planner, and the task finishes;
//  2. it keeps crashing everywhere: the task stops with what helps, and no review pass runs.
// Run under a display: xvfb-run -a npm run test:e2e:gpucrash
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`GPUCRASH SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=GPUCRASH smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gpu-'));
const CRASH = { error: { message: 'an error was encountered while running the model: CUDA error: an illegal memory access was encountered' } };
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
let phase = 1;
let mainPosts = 0;
let reviews = 0;
const helperModels = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"gpu-mock"},{"id":"helper-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    const crash = () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CRASH));
    };
    if (/reviewing another developer's change/.test(String(b.messages?.[0]?.content || ''))) {
      reviews++;
      return sse(res, say('NO FINDINGS'));
    }
    if (b.model === 'helper-mock') {
      helperModels.push(phase);
      if (phase === 2) return crash();
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'h1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'game.js', content: 'console.log(1)\n' }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    mainPosts++;
    if (phase === 2) return crash();
    if (mainPosts <= 2) return crash();
    sse(res, say('Saved game.js.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'gpu-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = true;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (b) => {
    state.settings = await api.setSettings({ heavy: { enabled: true, provider: 'openai', baseUrl: b, apiKey: 'k', model: 'helper-mock' }, reviewPass: true, consultFreely: false });
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1. crash, retry, crash, planner takes the step, task finishes
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'write game.js'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Saved game.js.')), null, { timeout: 40_000 });
  const n1 = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!n1.some((t) => /The model server crashed on This PC — retrying/.test(t))) fail(`no retry notice: ${n1.join(' | ')}`);
  if (!n1.some((t) => /crashed again on This PC — running the next step on helper-mock/.test(t))) fail(`no hand-off notice: ${n1.join(' | ')}`);
  if (!fs.existsSync(path.join(ws, 'game.js'))) fail('the planner step did not run');
  if (await win.evaluate(() => state.conv.display.some((d) => d.t === 'error'))) fail('the recovered task should show no error');
  await win.waitForFunction(() => !state.conv.reviewBusy, null, { timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  if (reviews !== 1) fail(`the finished task should get its review pass (${reviews})`);

  // 2. crashes everywhere: stop with advice, no review pass
  phase = 2;
  const before = reviews;
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'edit game.js again'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => state.conv.display.some((d) => d.t === 'error'), null, { timeout: 40_000 });
  const err = await win.evaluate(() => state.conv.display.find((d) => d.t === 'error').text);
  if (!/CUDA error: an illegal memory access/.test(err) || !/update the server .*GPU driver/.test(err) || !/Context window/.test(err)) fail(`crash advice: ${err}`);
  await new Promise((r) => setTimeout(r, 2500));
  if (reviews !== before) fail('no review pass may run after a task that ended in an error');
  if (!helperModels.includes(2)) fail('the second task should have tried the planner before giving up');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ heavy: { enabled: false, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash' }, skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('gpucrash smoke ok: crash retried, second crash handed to the planner and the task finished (reviewed); crashes everywhere stopped with advice and no review pass');
