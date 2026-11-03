// Prove-it checks smoke test (ideas from storytold/craft-anything):
//  1. a canvas game with window.selfTest(): test_app runs it and a failing step fails the test;
//  2. a blank page fails test_app;
//  3. compare_with a reference URL: the build is pictured at 1440, 768 and 390 px and scored;
//  4. run_command closes input (a command waiting on stdin gets end-of-file at once) and turns
//     off git's pager and prompts;
//  5. a desktop game's --self-test <file> report is read back.
// Run under a display: xvfb-run -a npm run test:e2e:provecheck
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PROVECHECK SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PROVECHECK smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-prove-'));
const GAME = `<!doctype html><html><head><title>Runner</title></head><body style="margin:0;background:#123">
<canvas id="c" width="800" height="600"></canvas>
<script>
const g = document.getElementById('c').getContext('2d');
const state = { lane: 1, y: 0, score: 0, coins: [] };
function draw() { g.fillStyle = '#123'; g.fillRect(0, 0, 800, 600); g.fillStyle = '#e33'; g.fillRect(300 + state.lane * 60, 400 - state.y, 50, 80); g.fillStyle = '#fff'; g.font = '24px sans-serif'; g.fillText('Score ' + state.score, 20, 40); }
draw();
addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') state.lane = Math.min(2, state.lane + 1); if (e.key === ' ') state.y = 60; draw(); });
window.selfTest = async () => {
  const lane0 = state.lane; dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  const y0 = state.y; dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
  return { version: 1, steps: [
    { step: 'move', passed: state.lane !== lane0, detail: 'lane ' + lane0 + ' -> ' + state.lane },
    { step: 'act', passed: state.y > y0, detail: 'jumped to ' + state.y },
    { step: 'hud', passed: true, detail: 'score drawn' },
    { step: 'spawn', passed: state.coins.length > 0, detail: state.coins.length + ' coins in view' }
  ] };
};
</script></body></html>`;
const SITE = '<!doctype html><html><head><title>Site</title><style>body{margin:0;font-family:sans-serif}header{background:#2563eb;color:#fff;padding:24px}main{display:flex;flex-wrap:wrap;gap:16px;padding:24px}main div{background:#f59e0b;height:160px;flex:1 1 220px}</style></head><body><header><h1>Plans</h1></header><main><div></div><div></div><div></div></main></body></html>';
fs.writeFileSync(path.join(ws, 'selftest-game.js'), `const i = process.argv.indexOf('--self-test'); require('fs').writeFileSync(process.argv[i + 1], JSON.stringify({ version: 1, steps: [{ step: 'move', passed: true, detail: 'x 0 -> 4' }, { step: 'act', passed: true, detail: 'shot' }, { step: 'hud', passed: false, detail: 'health bar missing' }] }));`);

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
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
let base = '';
const STEPS = () => [
  ['write_file', { path: 'game.html', content: GAME }],
  ['test_app', { command: 'game.html' }],
  ['write_file', { path: 'blank.html', content: '<!doctype html><html><body style="margin:0;background:#fff"></body></html>' }],
  ['test_app', { command: 'blank.html' }],
  ['write_file', { path: 'site.html', content: SITE }],
  ['test_app', { command: 'site.html', compare_with: `${base.replace(/\/v1$/, '')}/ref.html` }],
  ['run_command', { command: 'node -e "process.stdin.resume(); process.stdin.on(\'end\', () => { console.log(\'got EOF\'); process.exit(3); })"' }],
  ['run_command', { command: 'node -e "console.log(\'pager=\' + process.env.GIT_PAGER + \' prompt=\' + process.env.GIT_TERMINAL_PROMPT)"' }]
];
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    if (req.url === '/ref.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(SITE);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"prove-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    bodies.push(b);
    const done = b.messages.filter((m) => m.role === 'tool').length;
    const steps = STEPS();
    if (done < steps.length) return sse(res, call(`p${done}`, ...steps[done]));
    sse(res, say('All checks ran.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const toolResults = (b) => (b?.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'prove-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
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
  const t0 = Date.now();
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'build the runner and check it'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('All checks ran.')), null, { timeout: 150_000 });
  const r = toolResults(bodies.at(-1));

  if (!/Self-test \(measured by the game itself\): 1 of 4 steps failed \(spawn\)/.test(r[1] || '')) fail(`game self-test: ${(r[1] || '').slice(0, 600)}`);
  if (!/✓ move: lane 1 -> 2/.test(r[1] || '') || !/✗ spawn: 0 coins in view/.test(r[1] || '')) fail(`self-test lines: ${(r[1] || '').slice(0, 600)}`);
  if (/Blank screen/.test(r[1] || '')) fail('the game page is not blank');
  if (!/^Blank screen|\nBlank screen: the screenshot is one flat colour/.test(r[3] || '')) fail(`blank page: ${(r[3] || '').slice(0, 400)}`);
  const like = [...(r[5] || '').matchAll(/At (\d+)px wide it looks about (\d+)% like the reference/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (JSON.stringify(like.map((l) => l[0])) !== '[1440,768,390]') fail(`likeness widths: ${(r[5] || '').slice(-600)}`);
  if (!like.every((l) => l[1] >= 90)) fail(`the same page should look alike: ${JSON.stringify(like)}`);
  if (!/got EOF/.test(r[6] || '') || !/Exit code: 3/.test(r[6] || '')) fail(`stdin was not closed: ${(r[6] || '').slice(0, 300)}`);
  if (!/pager=cat prompt=0/.test(r[7] || '')) fail(`pager/prompt env: ${(r[7] || '').slice(0, 300)}`);
  const metas = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'assistant').flatMap((d) => (d.steps || []).map((s) => s.meta)).filter(Boolean));
  if (!metas.includes('self-test failed') || !metas.includes('blank screen')) fail(`step labels: ${metas.join(', ')}`);
  if (!/window\.selfTest\(\)/.test(String(bodies[0].messages[0].content))) fail('the system prompt lacks the self-test rule');

  // 5. a desktop game's own report
  const d = await win.evaluate(() => api.guiSelfTest({ command: 'node selftest-game.js', seconds: 20 }));
  const j = await win.evaluate((rep) => SelfTest.judge(rep), d.report);
  if (!d.report || j.passed || !/✗ hud: health bar missing/.test(j.text)) fail(`desktop self-test: ${JSON.stringify(d).slice(0, 300)} → ${j.text}`);
  console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ describeScreens: true, skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('provecheck smoke ok: game self-test ran and its failing step failed the test, blank page failed, likeness scored at 1440/768/390, stdin closed and pager/prompts off, desktop --self-test report read');
