// Commands that leave a server running do not hang (a benchmark run: `start /b python -m
// http.server … & timeout /t 2 & curl …` sat for the full 2 minutes after curl answered):
//  1. a server started in the background with `&`, then curl: the command returns in seconds
//     with curl's answer and a note that the server is still running; the terminal shows
//     "● 1 running · Stop";
//  2. a server started in the foreground (`python3 -m http.server`): moved to the background
//     once it has gone quiet, and it still answers;
//  3. one started with its output sent to /dev/null is listed too;
//  4. Stop in the terminal header stops all three, and the ports go dead.
// Run under a display: xvfb-run -a npm run test:e2e:bgserver
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`BGSERVER SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=BGSERVER smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const answers = (port) => new Promise((r) => { const q = http.get(`http://127.0.0.1:${port}/page.html`, (res) => { res.resume(); r(res.statusCode); }); q.on('error', () => r(0)); q.setTimeout(2000, () => { q.destroy(); r(0); }); });

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bg-'));
fs.writeFileSync(path.join(ws, 'page.html'), '<!DOCTYPE html><p>hi</p>');
const p1 = await freePort();
const p2 = await freePort();
const p3 = await freePort();

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
  // The server keeps the command's output open (as `start /b` did on Windows): before v0.52
  // this sat until the 2-minute timeout.
  () => call('c1', 'run_command', { command: `python3 -m http.server ${p1} --bind 127.0.0.1 & sleep 1.5; python3 -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:${p1}/page.html').status)"` }),
  // Output sent elsewhere: the command returns by itself, and the server is still listed.
  () => call('c3', 'run_command', { command: `python3 -m http.server ${p3} --bind 127.0.0.1 >/dev/null 2>&1 &` }),
  () => call('c2', 'run_command', { command: `python3 -m http.server ${p2} --bind 127.0.0.1` }),
  () => [{ choices: [{ delta: { content: 'Both servers are up.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"bg-mock"}]}');
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
    document.querySelector('#s-model').value = 'bg-mock';
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
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  const t0 = Date.now();
  await win.evaluate(() => { document.querySelector('#prompt').value = 'start the servers'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Both servers are up.')), null, { timeout: 90_000 })
    .catch(async () => fail(`the task never finished (${bodies.length} requests); terminal: ${(await win.evaluate(() => document.querySelector('#term-out')?.textContent || '')).slice(-600)} chat: ${(await win.evaluate(() => document.querySelector('#messages')?.innerText || '')).slice(-600)}`));
  const secs = (Date.now() - t0) / 1000;
  const tr = (id) => bodies.map((b) => lastTool(b, id)).find(Boolean) || '';

  const c1 = tr('c1');
  if (!/^Exit code: 0\n[\s\S]*\b200\b/.test(c1)) fail(`the background-server command should return curl's 200: ${c1.slice(0, 300)}`);
  if (!/a program it started is still running in the background/.test(c1)) fail(`no background note on the first command: ${c1.slice(0, 400)}`);
  if (!/still running in the background/.test(tr('c3'))) fail(`the redirected background server was not noticed: ${tr('c3').slice(0, 300)}`);
  const c2 = tr('c2');
  if (!/This command is a server, so once it was up QWS moved it to the background/.test(c2)) fail(`the foreground server was not moved aside: ${c2.slice(0, 400)}`);
  if (secs > 40) fail(`the two commands took ${Math.round(secs)}s — something still waited for a server to exit`);
  if ((await answers(p1)) !== 200) fail('the first server is not running after its command returned');
  if ((await answers(p2)) !== 200) fail('the second server is not running after it was moved aside');
  if ((await answers(p3)) !== 200) fail('the third server is not running');

  const btn = await win.evaluate(() => ({ text: document.querySelector('#btn-term-bg')?.textContent, hidden: document.querySelector('#btn-term-bg')?.classList.contains('hidden') }));
  if (btn.hidden || !/● 3 running · Stop/.test(btn.text || '')) fail(`the terminal should show "● 3 running · Stop": ${JSON.stringify(btn)}`);
  await win.evaluate(() => document.querySelector('#btn-term-bg').click());
  await win.waitForFunction(() => document.querySelector('#btn-term-bg')?.classList.contains('hidden'), null, { timeout: 10_000 }).catch(() => fail('the Stop button did not clear'));
  await new Promise((r) => setTimeout(r, 800));
  if ((await answers(p1)) !== 0) fail('the first server still answers after Stop');
  if ((await answers(p2)) !== 0) fail('the second server still answers after Stop');
  if ((await answers(p3)) !== 0) fail('the third server still answers after Stop');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  if (saved) await win.evaluate(async (s) => { state.settings = await api.setSettings(s); }, saved).catch(() => {});
  await win.evaluate(() => api.stopBackground()).catch(() => {});
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
console.log('bgserver smoke ok: a backgrounded server returned with curl\'s answer, a foreground server moved aside, a redirected one was listed, all kept serving, Stop ended all three');
