// check_api smoke test (the idea from XR Blocks' MCP search_api: verify a symbol before using it).
// In a Python project, a scripted model:
//  1. runs code with a wrong import → the failed command's result carries the check_api tip;
//  2. calls check_api → the real Python answers that email.message has no Header and that it
//     lives in email.header; the typo os.path.joinn gets "Did you mean: join?";
//  3. the project's own main.py never ran (the project folder is not on the import path).
// Run under a display: xvfb-run -a npm run test:e2e:checkapi
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CHECKAPI SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CHECKAPI smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-capi-'));
fs.writeFileSync(path.join(ws, 'main.py'), "open('RAN.txt', 'w').write('project code ran')\n");
const PY = process.platform === 'win32' ? 'python' : 'python3';
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
const SCRIPT = [
  () => call('c1', 'run_command', { command: `${PY} -c "from email.message import Header"` }),
  () => call('c2', 'check_api', { names: ['email.message.Header', 'os.path.joinn', 'json.dumps', 'main.anything'] }),
  () => [{ choices: [{ delta: { content: 'Header comes from email.header.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"capi-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    bodies.push(JSON.parse(body));
    sse(res, (SCRIPT[turn++] || SCRIPT[2])());
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const toolResult = (b, id) => b?.messages?.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content || '';

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'capi-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'fix the email import'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Header comes from email.header.')), null, { timeout: 45_000 })
    .catch(() => fail('the task never finished'));

  if (!bodies[0]?.tools?.some((t) => t.function.name === 'check_api')) fail('check_api is not offered to the model');
  if (!JSON.stringify(bodies[0]?.messages?.[0]?.content || '').includes('check_api')) fail('the system prompt does not mention check_api');
  const ran = toolResult(bodies[1], 'c1');
  if (!/ImportError/.test(ran) || !/Tip: this looks like a wrong or made-up API name — check_api/.test(ran)) fail(`the failed import did not get the tip: ${ran.slice(0, 300)}`);
  const chk = toolResult(bodies[2], 'c2');
  if (!/✗ email\.message\.Header — email\.message has no "Header"\. It exists as: email\.header\.Header/.test(chk)) fail(`check_api did not relocate Header: ${chk.slice(0, 400)}`);
  if (!/✗ os\.path\.joinn — os\.path has no "joinn"\. Did you mean: join\?/.test(chk)) fail('check_api did not suggest join');
  if (!/✓ json\.dumps — function/.test(chk)) fail('check_api did not confirm json.dumps');
  if (!/✗ main\.anything — "main" is not installed/.test(chk)) fail('the project module should not be importable');
  if (fs.existsSync(path.join(ws, 'RAN.txt'))) fail('check_api ran the project\'s own code');
  const row = await win.evaluate(() => [...document.querySelectorAll('.step')].map((s) => s.textContent).find((t) => /Check API/.test(t)) || '');
  if (!/1 not found|not found/.test(row)) fail(`tool row: ${row.slice(0, 200)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ skillWriter: true }); }).catch(() => {});
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
console.log('checkapi smoke ok: failed import got the check_api tip, check_api found email.header.Header and suggested join, the project\'s own code never ran');
