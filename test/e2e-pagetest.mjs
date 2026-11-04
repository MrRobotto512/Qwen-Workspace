// A working page is not called broken (a benchmark field report: the planner's counter page had
// a window.selfTest() returning {pass, steps: [{name, pass, detail}]}; test_app judged it as a game
// — "3 of 3 steps failed (move, act, hud)" — and its pixel check said the page "looks empty",
// so QWS escalated twice and the planner went looking for a browser):
//  1. an edit whose new text equals the old one says "Nothing changed" and writes nothing;
//  2. test_app on the counter page reads the page's own steps: every step passed, no failure;
//  3. no "looks empty" pixel line for a plain page, and no "Steps keep failing" push-back.
// Run under a display: xvfb-run -a npm run test:e2e:pagetest
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PAGETEST SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PAGETEST smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-page-'));
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Counter</title>
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f4f8; font-family: sans-serif; }
    #count { font-size: 96px; }
    button { width: 72px; height: 72px; font-size: 40px; background: #3b6cf6; color: #fff; border: none; border-radius: 12px; }
  </style>
</head>
<body>
  <main><div id="count">0</div><button id="minus" type="button">&minus;</button><button id="plus" type="button">+</button></main>
  <script>
    let count = 0;
    const countEl = document.getElementById('count');
    function render() { countEl.textContent = String(count); }
    document.getElementById('plus').addEventListener('click', () => { count += 1; render(); });
    document.getElementById('minus').addEventListener('click', () => { count -= 1; render(); });
    window.selfTest = function () {
      const steps = [];
      const check = (name, want) => { const got = countEl.textContent.trim(); steps.push({ name, pass: got === want, detail: 'shows ' + got }); };
      check('starts at 0', '0');
      document.getElementById('plus').click(); check('plus adds one', '1');
      document.getElementById('minus').click(); check('minus subtracts one', '0');
      return { pass: steps.every((s) => s.pass), steps };
    };
  </script>
</body>
</html>
`;

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const lastTool = (b, id) => b?.messages?.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content || '';
const SCRIPT = [
  () => call('w1', 'write_file', { path: 'counter.html', content: PAGE }),
  () => call('e1', 'edit_file', { path: 'counter.html', old_text: '#count { font-size: 96px; }', new_text: '#count { font-size: 96px; }' }),
  () => call('t1', 'test_app', { command: 'counter.html' }),
  () => [{ choices: [{ delta: { content: 'The counter page passes its self-test.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"page-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    bodies.push(JSON.parse(body));
    sse(res, (SCRIPT[turn++] || SCRIPT[3])());
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
let saved = null;

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  saved = await win.evaluate(() => api.getSettings());
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'page-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-checksGate').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async () => { state.settings = await api.setSettings({ describeScreens: false }); });
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'Make counter.html: a number in #count starting at 0, a "+" button #plus that adds one and a "−" button #minus that subtracts one.'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('passes its self-test')), null, { timeout: 60_000 })
    .catch(() => fail(`the task never finished (${bodies.length} requests)`));
  const tr = (id) => bodies.map((b) => lastTool(b, id)).find(Boolean) || '';

  const e1 = tr('e1');
  if (!/^Nothing changed: new_text is the same as the text already in counter\.html/.test(e1)) fail(`the identical edit should say nothing changed: ${e1.slice(0, 200)}`);
  if (fs.readFileSync(path.join(ws, 'counter.html'), 'utf8') !== PAGE) fail('the no-op edit changed the file');

  const t1 = tr('t1');
  if (!/Self-test \(measured by the page itself\): every step passed \(3\)/.test(t1)) fail(`the page's own self-test was not read: ${t1.slice(0, 600)}`);
  if (/move|not tested/.test(t1)) fail(`the counter page was judged as a game: ${t1.slice(0, 600)}`);
  if (/looks empty|empty background/.test(t1)) fail(`a plain page got the "looks empty" pixel line: ${t1.slice(0, 600)}`);
  const meta = await win.evaluate(() => [...document.querySelectorAll('.tool-row, .step')].map((r) => r.textContent).join(' | '));
  if (!/self-test passed/.test(meta)) fail(`the test_app row should read "self-test passed": ${meta.slice(0, 400)}`);
  if (!/no change/.test(meta)) fail(`the edit row should read "no change": ${meta.slice(0, 400)}`);
  const pushback = bodies.flatMap((b) => b.messages || []).some((m) => m.role === 'user' && /Steps keep failing/.test(String(m.content)));
  if (pushback) fail('QWS pushed back with "Steps keep failing" on a working page');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  if (saved) await win.evaluate(async (s) => { state.settings = await api.setSettings(s); }, saved).catch(() => {});
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
console.log('pagetest smoke ok: an identical edit wrote nothing, the counter page passed its own self-test, no "looks empty" line and no push-back');
