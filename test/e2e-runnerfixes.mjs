// Field-report fixes smoke test (a 14B model building a browser game for two hours):
//  1. edit_file whose old_text has 4 spaces of indentation the file lacks → applied (re-indented);
//  2. after a FAILED edit, reading the same file again is allowed (the repeat guard refused it);
//  3. a write that puts other-script letters inside identifiers ("MeshStandard材料") is flagged;
//  4. test_app on "start game/index.html" loads the page in a hidden window: the console error
//     ("animate is not defined") comes back with a screenshot; a second call clicks a button,
//     clicks a text box, types, and presses Left and "a" — the page's own logs prove each landed.
// Run under a display: xvfb-run -a npm run test:e2e:runnerfixes
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`RUNNERFIXES SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=RUNNERFIXES smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-run-'));
const game = path.join(ws, 'game');
fs.mkdirSync(game);
fs.writeFileSync(path.join(game, 'style.css'), '.overlay {\n    position: absolute;\n    pointer-events: none;\n}\n');
fs.writeFileSync(path.join(game, 'index.html'), `<!DOCTYPE html><html><head><title>Lane Runner</title><link rel="stylesheet" href="style.css"></head>
<body style="margin:0;background:#123">
<button id="b" style="position:absolute;left:20px;top:20px;width:120px;height:50px">Start</button>
<input id="t" style="position:absolute;left:20px;top:100px;width:200px;height:30px">
<script src="main.js"></script></body></html>`);
fs.writeFileSync(path.join(game, 'main.js'), `console.log('ready');
document.getElementById('b').onclick = () => console.log('clicked start');
document.getElementById('t').oninput = (e) => console.log('typed:' + e.target.value);
window.addEventListener('keydown', (e) => { if (e.target.id !== 't') console.log('key:' + e.key); });
function startGame() { animate(); }
setTimeout(startGame, 50);
`);

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
let shotW = 1024;
const SCRIPT = [
  () => call('r1', 'read_file', { path: 'game/style.css' }),
  () => call('e1', 'edit_file', { path: 'game/style.css', old_text: 'nothing like this', new_text: 'x' }),
  () => call('r2', 'read_file', { path: 'game/style.css' }),
  () => call('e2', 'edit_file', { path: 'game/style.css', old_text: '    .overlay {\n        position: absolute;\n        pointer-events: none;\n    }', new_text: '    .overlay {\n        position: absolute;\n    }' }),
  () => call('w1', 'write_file', { path: 'game/extra.js', content: 'const m = new THREE.MeshStandard材料({});\nconsole.log(high身);\n' }),
  () => call('t1', 'test_app', { command: 'start game/index.html' }),
  () => {
    const m = /attached \((\d+)×(\d+) px\)/.exec(lastTool(bodies.at(-1), 't1'));
    shotW = Number(m?.[1]) || 1024;
    const k = shotW / 1024;
    const pt = (x, y) => [Math.round(x * k), Math.round(y * k)];
    return call('t2', 'test_app', { command: 'game/index.html', actions: [{ click: pt(80, 45) }, { key: 'left' }, { key: 'a' }, { click: pt(100, 115) }, { type: 'hi' }] });
  },
  () => [{ choices: [{ delta: { content: 'Found the animate bug.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
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
    sse(res, (SCRIPT[turn++] || SCRIPT[7])());
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
    document.querySelector('#s-model').value = 'gemma4-mock';
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
  await win.evaluate(() => { document.querySelector('#prompt').value = 'fix and run the game'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Found the animate bug.')), null, { timeout: 60_000 })
    .catch(() => fail('the task never finished'));
  const tr = (id) => bodies.map((b) => lastTool(b, id)).find(Boolean) || '';

  // 2. re-read after a failed edit
  if (!/^Error: old_text was not found/.test(tr('e1'))) fail(`the bogus edit should fail: ${tr('e1').slice(0, 120)}`);
  if (/You already ran this exact call/.test(tr('r2')) || !/pointer-events/.test(tr('r2'))) fail(`re-reading after a failed edit was refused: ${tr('r2').slice(0, 160)}`);
  // 1. indentation-tolerant edit
  if (!/ignoring indentation/.test(tr('e2'))) fail(`the mis-indented edit was not applied: ${tr('e2').slice(0, 200)}`);
  const css = fs.readFileSync(path.join(game, 'style.css'), 'utf8');
  if (css !== '.overlay {\n    position: absolute;\n}\n') fail(`style.css after the loose edit: ${JSON.stringify(css)}`);
  // 3. glitch warning
  if (!/Warning: this write put characters from another language inside code: `MeshStandard材料`, `high身`/.test(tr('w1'))) fail(`no glitch warning: ${tr('w1').slice(0, 200)}`);
  // 4. web page testing
  const t1 = tr('t1');
  if (!/^Page "Lane Runner" loaded/.test(t1)) fail(`page not loaded: ${t1.slice(0, 200)}`);
  if (!/Console errors \(1\)[\s\S]*animate is not defined \(main\.js:5\)/.test(t1)) fail(`the console error did not come back: ${t1.slice(0, 400)}`);
  if (!/ready/.test(t1)) fail('console output missing');
  if (!/screenshot of the page is attached/.test(t1)) fail('no screenshot for the vision model');
  const imgs = (bodies[6]?.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []));
  if (imgs.length !== 1) fail(`the page screenshot should reach the model, saw ${imgs.length}`);
  const t2 = tr('t2');
  for (const want of ['clicked start', 'key:ArrowLeft', 'key:a', 'typed:hi']) if (!t2.includes(want)) fail(`action not seen by the page: ${want} — ${t2.slice(0, 500)}`);
  const winCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  if (winCount !== 1) fail(`the hidden test window was not closed (${winCount} windows)`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ skillWriter: true, checksGate: true }); }).catch(() => {});
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
console.log('runnerfixes smoke ok: mis-indented edit applied, re-read after a failed edit allowed, glitch identifiers flagged, page console error + screenshot returned, clicks/keys/typing reached the page');
