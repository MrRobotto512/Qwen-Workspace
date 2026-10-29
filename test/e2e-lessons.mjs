// Lessons smoke test: a scripted model fails a build, fixes it, finishes — then the lessons
// proposal must appear as the diff card. Rejecting leaves QWEN.md untouched; approving a
// second run writes it; a third run's identical lessons dedupe away to no card at all.
// Run under a display: xvfb-run -a npm run test:e2e:lessons
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`LESSONS SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-les-'));
const qwenMd = path.join(ws, 'QWEN.md');

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const textTurn = (text) => [
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
];
const toolTurn = (id, command) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

let lessonsRequests = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (body.includes('QWEN.md notes')) {
      lessonsRequests++;
      return sse(res, textTurn('- Build with `echo build ok`; plain `exit 7` is the broken legacy script\n- The build must run from the project root'));
    }
    const toolResults = (body.match(/"role":"tool"/g) || []).length;
    if (toolResults === 0) return sse(res, toolTurn('c1', 'exit 7'));
    if (toolResults === 1) return sse(res, toolTurn('c2', 'echo build ok'));
    return sse(res, textTurn('Fixed the build.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const runTask = async (prompt) => {
  await win.evaluate((p) => {
    document.querySelector('#prompt').value = p;
    document.querySelector('#btn-send').onclick();
  }, prompt);
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Fixed the build.')), null, { timeout: 30_000 });
};
const waitCard = () => win.waitForFunction(() => document.querySelector('.lessons-card'), null, { timeout: 20_000 });

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((baseUrl) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = baseUrl;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'mock-model';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-lessonsEnabled').checked = true;
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-esc-failstreak').checked = false;
    document.querySelector('#s-esc-bigplan').checked = false;
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);

  // --- task 1: failed-then-fixed build -> the proposal appears; Reject changes nothing ---
  await runTask('fix the build');
  await waitCard().catch(() => fail('the lessons card never appeared after a failed-then-fixed build'));
  await win.evaluate(() => [...document.querySelectorAll('.lessons-card button')].find((b) => b.textContent.includes('Reject')).click());
  await new Promise((r) => setTimeout(r, 600));
  if (fs.existsSync(qwenMd)) fail('QWEN.md was written even though the proposal was rejected');

  // --- task 2: approve -> QWEN.md gets the Lessons section ---
  await win.evaluate(() => newChat());
  await runTask('fix the build again');
  await waitCard().catch(() => fail('the lessons card never appeared on the second task'));
  await win.evaluate(() => [...document.querySelectorAll('.lessons-card button')].find((b) => b.textContent.includes('Add to QWEN.md')).click());
  // Poll for the content, not bare existence: writeFile creates the file an instant
  // before the bytes land, and reading in that window sees it empty.
  const deadline = Date.now() + 10_000;
  let md = '';
  while (Date.now() < deadline) {
    md = fs.existsSync(qwenMd) ? fs.readFileSync(qwenMd, 'utf8') : '';
    if (md.includes('## Lessons')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!md.includes('## Lessons')) fail(`QWEN.md has no Lessons section after approving:\n${md}`);
  if (!md.includes('echo build ok') || !md.includes('project root')) fail(`approved lessons are missing from QWEN.md:\n${md}`);

  // --- task 3: the same lessons dedupe away -> no card, file unchanged ---
  await win.evaluate(() => newChat());
  await runTask('fix the build a third time');
  await new Promise((r) => setTimeout(r, 4000));
  if (await win.evaluate(() => !!document.querySelector('.lessons-card'))) fail('a lessons card appeared although every lesson was already in QWEN.md');
  if (fs.readFileSync(qwenMd, 'utf8') !== md) fail('QWEN.md changed without an approval');
  if (lessonsRequests < 3) fail(`expected a lessons request per task, saw ${lessonsRequests}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`lessons smoke ok: card after failed-then-fixed build, reject untouched, approve wrote the section, repeats deduped (${lessonsRequests} lessons calls)`);
