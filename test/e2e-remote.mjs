// Remote sessions smoke test: the app pairs with itself. The test talks to the host API
// like another device would (401 on a bad code, start a task, read the transcript, continue
// it, stop), and the viewer UI lists the device and renders the remote transcript.
// Run under a display: xvfb-run -a npm run test:e2e:remote
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`REMOTE SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=REMOTE smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-remote-'));
const madeFile = path.join(ws, 'remote-made.txt');
const TOKEN = 'QW-E2E8-TEST-CODE';
const PORT = 18000 + Math.floor(Math.random() * 2000);

// Scripted model: first agent turn writes a file, any later turn answers with text.
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!body.includes('"role":"tool"')) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'remote-made.txt', content: 'made remotely\n' }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    return sse(res, [
      { choices: [{ delta: { content: 'Remote task finished.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelBase = `http://127.0.0.1:${model.address().port}/v1`;

const hostBase = `http://127.0.0.1:${PORT}`;
const qw = async (p, { method = 'GET', token = TOKEN, body } = {}) => {
  const res = await fetch(hostBase + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((baseUrl) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = baseUrl;
    document.querySelector('#s-model').value = 'mock-model';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-heavy-enabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true })); // no stale node routing
    return document.querySelector('#s-save').onclick();
  }, modelBase);
  await win.evaluate(async ([port, token]) => {
    state.settings = await api.setSettings({
      remoteAccess: { enabled: true, port, token },
      devices: [{ id: 'self', name: 'Self', url: `http://127.0.0.1:${port}`, token }]
    });
  }, [PORT, TOKEN]);
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);

  // --- host API: auth and info ---
  if ((await qw('/qw/ping', { token: 'QW-WRONG-CODE-0000' })).status !== 401) fail('a wrong pairing code was not rejected');
  const ping = await qw('/qw/ping');
  if (ping.status !== 200 || ping.data.app !== 'qwen-workspace') fail(`ping failed: ${JSON.stringify(ping)}`);

  // --- start a task from "another device" and watch it really run ---
  const start = await qw('/qw/conversations', { method: 'POST', body: { text: 'make the remote file' } });
  if (start.status !== 202 || !start.data.id) fail(`starting a remote task failed: ${JSON.stringify(start)}`);
  const convId = start.data.id;
  let deadline = Date.now() + 30_000;
  while (!fs.existsSync(madeFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(madeFile)) fail('the remotely started task never wrote the file');

  deadline = Date.now() + 20_000;
  let conv = null;
  while (Date.now() < deadline) {
    const r = await qw(`/qw/conversations/${convId}`);
    if (r.status === 200 && r.data.status === 'done') {
      conv = r.data;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  if (!conv) fail('the remote conversation never reached done');
  else {
    if (!JSON.stringify(conv.display).includes('Remote task finished.')) fail('the transcript is missing the final answer');
    if (conv.history !== undefined) fail('raw history leaked over the remote API');
  }

  // --- continue it from the device ---
  const more = await qw(`/qw/conversations/${convId}/message`, { method: 'POST', body: { text: 'and again' } });
  if (more.status !== 202) fail(`continuing remotely failed: ${JSON.stringify(more)}`);
  deadline = Date.now() + 20_000;
  let grew = false;
  while (Date.now() < deadline && !grew) {
    const r = await qw(`/qw/conversations/${convId}`);
    grew = r.status === 200 && (r.data.display || []).filter((d) => d.t === 'user').length >= 2 && r.data.status === 'done';
    if (!grew) await new Promise((r2) => setTimeout(r2, 400));
  }
  if (!grew) fail('the continued run never finished');
  if ((await qw(`/qw/conversations/${convId}/stop`, { method: 'POST', body: {} })).status !== 202) fail('stop was not accepted');
  if ((await qw('/qw/conversations')).data.every((c) => c.id !== convId)) fail('the conversation list is missing the remote task');

  // --- viewer UI: the device section lists it; the viewer renders the transcript ---
  await win.evaluate(() => showView('history'));
  await win.waitForFunction(() => document.querySelectorAll('#remote-history .remote-conv').length > 0, null, { timeout: 15_000 })
    .catch(() => fail('the History panel never listed the paired device’s conversations'));
  await win.evaluate((id) => {
    const d = (state.settings.devices || [])[0];
    openRemoteViewer(d, id, 'remote task');
  }, convId);
  await win.waitForFunction(() => document.querySelectorAll('#remote-log .msg').length >= 2, null, { timeout: 15_000 })
    .catch(() => fail('the remote viewer never rendered the transcript'));
  const viewerText = await win.evaluate(() => document.querySelector('#remote-log').textContent);
  if (!viewerText.includes('Remote task finished.')) fail('the viewer transcript is missing the final answer');
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
  model.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('remote smoke ok: 401 on bad code, task started/continued/stopped over the API, viewer listed and rendered it');
