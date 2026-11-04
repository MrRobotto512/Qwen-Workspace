// v0.56, from a Full benchmark run:
//  1. fixing a file that was already broken, one error at a time, is not "this change introduced
//     it": the step is not failed, and what is left is reported as information;
//  2. a model whose file is damaged ("data is not within the file bounds, model is corrupted or
//     incomplete") stops the task at once with "ollama rm … then ollama pull …", no retries.
// Run under a display: xvfb-run -a npm run test:e2e:modelfix
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`MODELFIX SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=MODELFIX smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-modelfix-'));
fs.writeFileSync(path.join(ws, 'config.json'), "{\n  'name': \"shop\",\n  \"port\": 8080\n  \"debug\": true\n}\n");

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
  () => call('r1', 'read_file', { path: 'config.json' }),
  () => call('e1', 'edit_file', { path: 'config.json', old_text: "'name': \"shop\",", new_text: '"name": "shop",' }),
  () => call('e2', 'edit_file', { path: 'config.json', old_text: '"port": 8080\n', new_text: '"port": 8080,\n' }),
  () => [{ choices: [{ delta: { content: 'config.json is valid now.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
let damaged = false;
let damagedRequests = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"fix-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (damaged) {
      damagedRequests++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: "llama runner process has terminated: error loading model: tensor 'blk.0.attn_q.weight' data is not within the file bounds, model is corrupted or incomplete" }));
    }
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
    document.querySelector('#s-model').value = 'fix-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-checksGate').checked = false;
    document.querySelector('#s-syntaxCheck').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'config.json has syntax errors, fix it'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('valid now')), null, { timeout: 60_000 })
    .catch(() => fail(`the repair never finished (${bodies.length} requests)`));
  const tr = (id) => bodies.map((b) => lastTool(b, id)).find(Boolean) || '';
  // 1. already broken: informational, not failed
  const e1 = tr('e1');
  if (!/Syntax check: config\.json still has a syntax error at line \d+: .+ The file was already broken before this change; fix that next\./.test(e1)) fail(`the partial fix should be told what is left: ${e1.slice(0, 300)}`);
  if (/This change introduced it/.test(e1)) fail('the partial fix was blamed for an old error');
  if (/Syntax check/.test(tr('e2'))) fail(`the last fix should come back clean: ${tr('e2').slice(0, 200)}`);
  const failedRows = await win.evaluate(() => (state.conv.log || []).filter((e) => e.kind === 'tool' && e.name === 'edit_file' && e.failed).length);
  if (failedRows) fail(`${failedRows} edit(s) counted as failed`);
  try {
    JSON.parse(fs.readFileSync(path.join(ws, 'config.json'), 'utf8'));
  } catch (e) {
    fail(`config.json is still broken: ${e.message}`);
  }
  // 2. a damaged model file
  damaged = true;
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'say hi'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => !state.conv.busy && [...document.querySelectorAll('.msg.error')].some((e) => /ollama pull/.test(e.textContent)), null, { timeout: 60_000 })
    .catch(() => fail('no damaged-model message'));
  const msg = await win.evaluate(() => [...document.querySelectorAll('.msg.error')].map((e) => e.textContent).join(' | '));
  if (!/fix-mock could not be loaded on This PC: its model file looks damaged or incomplete[\s\S]*"ollama rm fix-mock" and then "ollama pull fix-mock"/.test(msg)) fail(`the advice: ${msg.slice(0, 400)}`);
  if (damagedRequests !== 1) fail(`a damaged model should not be retried: ${damagedRequests} requests`);
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
console.log('modelfix smoke ok: a file that was already broken was not blamed on the edit, a damaged model stopped at once with "ollama rm / ollama pull"');
