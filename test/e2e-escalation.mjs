// Escalation smoke test: a scripted "local model" runs the same failing build command twice;
// the fail-streak trigger must hand the next step to a second scripted "planner" server,
// post the transcript note, and the planner's answer must finish the task.
// Run under a display: xvfb-run -a npm run test:e2e:escalation
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`ESCALATION SMOKE FAIL: ${msg}`);
  // On GitHub Actions, surface the reason as an annotation: readable from the checks
  // API even when the raw logs are not.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=ESCALATION smoke::${String(msg).replace(/\n/g, " ").slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-esc-'));

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const toolCallTurn = (id, command) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

// The local model: issues the same failing command on every turn, never finishing.
let localRequests = 0;
const local = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    localRequests++;
    sse(res, toolCallTurn(`c${localRequests}`, 'exit 7'));
  });
});

// The planner speaks Anthropic's native Messages API, so this test also proves the
// streamAnthropic adapter: auth headers, the history translation (the failed run_command
// turns must arrive as tool_use/tool_result blocks), SSE parsing and usage reporting.
let plannerRequests = 0;
let plannerSawKey = '';
let plannerSawToolResult = false;
const planner = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    plannerRequests++;
    plannerSawKey = req.headers['x-api-key'] || '';
    if (body.includes('"tool_result"') && body.includes('"tool_use"')) plannerSawToolResult = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const e of [
      { type: 'message_start', message: { usage: { input_tokens: 1200 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Planner finished the job.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' }
    ]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
});

await Promise.all([
  new Promise((r) => local.listen(0, '127.0.0.1', r)),
  new Promise((r) => planner.listen(0, '127.0.0.1', r))
]);
const localBase = `http://127.0.0.1:${local.address().port}/v1`;
const plannerBase = `http://127.0.0.1:${planner.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  await win.evaluate(([a, b]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = true;
    document.querySelector('#s-heavy-provider').value = 'anthropic';
    document.querySelector('#s-heavy-baseUrl').value = b;
    document.querySelector('#s-heavy-apiKey').value = 'test-key';
    document.querySelector('#s-heavy-model').value = 'planner-mock';
    document.querySelector('#s-esc-failstreak').checked = true;
    document.querySelector('#s-esc-failstreak-n').value = '2';
    if (document.querySelector('#s-lessonsEnabled')) document.querySelector('#s-lessonsEnabled').checked = false; // keep the request count deterministic
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true })); // no stale node routing
    return document.querySelector('#s-save').onclick();
  }, [localBase, plannerBase]);

  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'build the project';
    document.querySelector('#btn-send').onclick();
  });

  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Planner finished the job.')),
    null,
    { timeout: 45_000 }
  ).catch(() => fail('the planner turn never rendered'));

  const notes = await win.evaluate(() => (state.conv?.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((t) => /failed 2 times in a row — running the next step on planner-mock/.test(t))) {
    fail(`the fail-streak escalation note is missing; notices were: ${JSON.stringify(notes)}`);
  }
  if (localRequests !== 2) fail(`expected exactly 2 local model requests before escalation, saw ${localRequests}`);
  if (plannerRequests < 1) fail('the planner server never got a request');
  if (plannerSawKey !== 'test-key') fail(`the Anthropic adapter did not send x-api-key (saw "${plannerSawKey}")`);
  if (!plannerSawToolResult) fail('the Anthropic request body is missing tool_use/tool_result blocks for the earlier commands');

  // The planner reported usage; with no price table the conversation records tokens.
  const spend = await win.evaluate(() => state.conv?.spend || {});
  if (!spend['planner-mock'] || spend['planner-mock'].in !== 1200) fail(`planner usage was not recorded: ${JSON.stringify(spend)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Teardown watchdog: every assertion has already run by this point, so a hung
  // app.close() (a rare Playwright/Electron teardown wedge) must not eat the result.
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  local.close();
  planner.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`escalation smoke ok: ${localRequests} failing local turns, escalated to the planner (${plannerRequests} request), note posted, usage recorded`);
