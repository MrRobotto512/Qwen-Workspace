// Test-built-GUI-apps smoke test. A tiny Electron "Counter Fixture" app lives in the project:
// an Add button that counts into count.txt and a text box that saves into typed.txt on Enter.
// A scripted vision-named model drives test_app:
//  1. launch → the window is found, a screenshot of just that window reaches the model as an image;
//  2. launch with actions → two clicks on Add (count.txt = 2), click the box, type "hi", Enter
//     (typed.txt = hi); only the newest screenshot rides along;
//  3. an app that exits on startup is reported as a crash;
//  and no fixture window is left running afterwards.
// On Linux it needs xdotool (clicks) and a window manager (Chromium lists windows through the
// WM; bare Xvfb has none) — the test starts openbox. CI installs both.
// Run: xvfb-run -a npm run test:e2e:guiapp
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`GUIAPP SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=GUIAPP smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const have = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
let wm = null;
if (process.platform === 'linux') {
  const missing = ['xdotool', 'openbox'].filter((b) => !have(b));
  if (missing.length) {
    console.error(`GUIAPP SMOKE FAIL: missing ${missing.join(' and ')} (sudo apt-get install -y ${missing.join(' ')})`);
    process.exit(1);
  }
  wm = spawn('openbox', [], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
}
const electronBin = createRequire(import.meta.url)('electron');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gui-'));
const appDir = path.join(ws, 'app');
fs.mkdirSync(appDir);
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'counter-fixture', main: 'main.js' }));
const PAGE = `<title>Counter Fixture</title><body style="margin:0;background:#fff;font-family:sans-serif">
<button id=b style="position:absolute;left:20px;top:20px;width:120px;height:60px;font-size:20px">Add</button>
<div id=n style="position:absolute;left:170px;top:30px;font-size:32px">0</div>
<input id=t style="position:absolute;left:20px;top:150px;width:200px;height:30px;font-size:16px">
<script>
const fs = require('fs'), path = require('path');
let n = 0;
document.getElementById('b').onclick = () => { n++; document.getElementById('n').textContent = n; fs.writeFileSync(path.join(process.env.FIXTURE_DIR, 'count.txt'), String(n)); };
document.getElementById('t').onkeydown = (e) => { if (e.key === 'Enter') fs.writeFileSync(path.join(process.env.FIXTURE_DIR, 'typed.txt'), e.target.value); };
</script></body>`;
fs.writeFileSync(path.join(appDir, 'main.js'), `const { app, BrowserWindow, Menu } = require('electron');
process.env.FIXTURE_DIR = __dirname;
Menu.setApplicationMenu(null); // no menu bar: page coordinates = window coordinates
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 320, height: 240, x: 60, y: 60, title: 'Counter Fixture', webPreferences: { nodeIntegration: true, contextIsolation: false } });
  w.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(PAGE)}));
});
app.on('window-all-closed', () => app.quit());
`);
const launch = `"${electronBin}" --no-sandbox --user-data-dir="${path.join(ws, 'ud')}" app`;

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const call = (id, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'test_app', arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const SCRIPT = [
  () => call('g1', { command: launch, window_title: 'Counter Fixture', wait_seconds: 20 }),
  // Like a model would: click coordinates come from the first screenshot's reported size.
  () => {
    const m = /attached \((\d+)×(\d+) px\)/.exec(lastTool(bodies[1])) || [0, 320, 240];
    const k = Number(m[1]) / 320;
    const pt = (x, y) => [Math.round(x * k), Math.round(y * k)];
    clicks = [pt(80, 50), pt(80, 50), pt(60, 165)];
    return call('g2', { command: launch, window_title: 'Counter Fixture', wait_seconds: 20, actions: [{ click: clicks[0] }, { click: clicks[1] }, { click: clicks[2] }, { type: 'hi' }, { key: 'Enter' }] });
  },
  () => call('g3', { command: 'node -e "console.error(\'boom: missing module\'); process.exit(3)"', wait_seconds: 5 }),
  () => [{ choices: [{ delta: { content: 'Tested the app.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
let clicks = [];
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"gemma4-mock"}]}');
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

const images = (b) => (b?.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []));
const lastTool = (b) => (b?.messages || []).filter((m) => m.role === 'tool').at(-1)?.content || '';

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'gemma4-mock';
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
  await win.evaluate(() => { document.querySelector('#prompt').value = 'test the counter app'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Tested the app.')), null, { timeout: 120_000 })
    .catch(() => fail('the task never finished'));

  // 1. plain launch: window found, screenshot sent as an image
  const t1 = lastTool(bodies[1]);
  if (!/Window "Counter Fixture" appeared after/.test(t1)) fail(`launch 1: ${t1.slice(0, 300)}`);
  if (!/still running at the end of the test/.test(t1)) fail('launch 1: the app should have been running');
  const shot1 = /attached \((\d+)×(\d+) px\)/.exec(t1);
  if (!shot1) fail(`launch 1 sent no screenshot: ${t1.slice(0, 300)}`);
  if (images(bodies[1]).length !== 1) fail(`request 2 should carry exactly one screenshot, had ${images(bodies[1]).length}`);
  else if (!images(bodies[1])[0].image_url.url.startsWith('data:image/png;base64,iVBOR')) fail('the screenshot is not a PNG');

  // 2. actions: clicks and typing landed
  const t2 = lastTool(bodies[2]);
  const said = `Actions: ${clicks.map(([x, y]) => `clicked (${x}, ${y})`).join('; ')}; typed "hi"; pressed enter.`;
  if (!t2.includes(said)) fail(`launch 2 actions: expected "${said}" in ${t2.slice(0, 400)}`);
  if (/Stopped early/.test(t2)) fail(`actions stopped early: ${t2.slice(0, 400)}`);
  const count = fs.existsSync(path.join(appDir, 'count.txt')) ? fs.readFileSync(path.join(appDir, 'count.txt'), 'utf8') : '(none)';
  if (count !== '2') fail(`two clicks on Add should count 2, got ${count}`);
  const typed = fs.existsSync(path.join(appDir, 'typed.txt')) ? fs.readFileSync(path.join(appDir, 'typed.txt'), 'utf8') : '(none)';
  if (typed !== 'hi') fail(`typing "hi" + Enter should save "hi", got ${typed}`);
  if (images(bodies[2]).length !== 1) fail(`request 3 should carry only the newest screenshot, had ${images(bodies[2]).length}`);
  if (!JSON.stringify(bodies[2]).includes('A screenshot was attached here earlier')) fail('the older screenshot should become a note');

  // 3. crash on startup
  const t3 = lastTool(bodies[3]);
  if (!/exited \(exit code 3\) before any window appeared/.test(t3) || !/boom: missing module/.test(t3)) fail(`crash report: ${t3.slice(0, 300)}`);

  // UI + cleanup
  const shots = await win.evaluate(() => document.querySelectorAll('.step-shot').length);
  if (shots < 2) fail(`the tool rows should show the screenshots, saw ${shots}`);
  let left = '';
  try {
    left = execFileSync('xdotool', ['search', '--name', 'Counter Fixture'], { encoding: 'utf8' }).trim();
  } catch {
    left = ''; // xdotool exits 1 when nothing matches
  }
  if (left) fail(`the fixture app was left running (windows: ${left})`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ provider: 'custom', skillWriter: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  server.close();
  wm?.kill();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('guiapp smoke ok: window found and screenshot sent to the vision model, clicks counted 2 and typing saved "hi", a startup crash reported, nothing left running');
