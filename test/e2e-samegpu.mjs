// Same-GPU ⚡ hint smoke test: with "This PC" itself marked ⚡ and plan-first on, the plan runs on
// the PC's stronger model and every hand-off swaps two models on one GPU (a field report shows
// 7–18 s reloads each way). QWS says so once per conversation, with the better setups.
// Run under a display: xvfb-run -a npm run test:e2e:samegpu
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`SAMEGPU SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=SAMEGPU smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-sg-'));
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const models = [];
const node = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'qwen3-coder:30b', size: 18e9 }] });
  if (req.method === 'GET') return json(res, { models: [] });
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url !== '/api/chat') return json(res, {});
    const b = JSON.parse(body);
    models.push(b.model);
    const hasTool = b.messages.some((m) => m.role === 'tool');
    let msg;
    if (b.model === 'qwen3-coder:30b') msg = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Create hello.py printing hi', status: 'in_progress' }, { content: 'Run python hello.py', status: 'pending' }] } } }] };
    else if (!b.messages.some((m) => m.role === 'tool' && /Wrote|Created/.test(m.content))) msg = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'hello.py', content: 'print("hi")\n' } } }] };
    else msg = { role: 'assistant', content: 'Done.' };
    void hasTool;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: msg, done: false }) + '\n');
    res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10 }) + '\n');
    res.end();
  });
});
await new Promise((r) => node.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${node.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-model').value = 'qwen3:8b';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-planFirst').checked = true;
    document.querySelector('#s-planWith').value = 'node';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: true }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'make hello.py'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Done.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished'));
  if (models[0] !== 'qwen3-coder:30b') fail(`the plan should run on this PC's stronger model, ran on ${models[0]}`);
  if (!fs.existsSync(path.join(ws, 'hello.py'))) fail('the everyday model did not execute the plan');
  const notes = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  const hint = notes.filter((t) => /^Your ⚡ node is this same PC, so each hand-off swaps qwen3-coder:30b and qwen3:8b on one GPU/.test(t));
  if (hint.length !== 1) fail(`expected the same-GPU hint once, saw ${hint.length}: ${JSON.stringify(notes)}`);
  else if (!/Plan with → Planner model/.test(hint[0])) fail('the hint does not name the better setups');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ ollamaNodes: [], provider: 'custom', planFirst: false, skillWriter: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  node.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('samegpu smoke ok: ⚡ on this same PC planned on qwen3-coder:30b, and the swap hint appeared once with the better setups');
