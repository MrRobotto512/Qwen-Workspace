// Review-pass smoke test: a scripted local model writes a buggy file; the scripted planner
// reviews the diff and returns one concrete finding; "Fix with Qwen" hands it to the local
// model, which rewrites the file; the automatic round-2 review returns NO FINDINGS.
// Run under a display: xvfb-run -a npm run test:e2e:review
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`REVIEW SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=REVIEW smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-review-'));
const target = path.join(ws, 'buggy.js');

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const toolTurn = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const textTurn = (t) => [
  { choices: [{ delta: { content: t }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }
];

// The local model.
const local = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const toolResults = (body.match(/"role":"tool"/g) || []).length;
    const hasFindings = body.includes('Review findings on your recent changes');
    if (toolResults === 0) return sse(res, toolTurn('c1', 'write_file', { path: 'buggy.js', content: 'let i = 0;\nwhile (i <= 10) { work(); }\n' }));
    if (hasFindings && toolResults === 1) return sse(res, toolTurn('c2', 'write_file', { path: 'buggy.js', content: 'let i = 0;\nwhile (i < 10) { work(); i++; }\n' }));
    if (hasFindings) return sse(res, textTurn('Fixed the findings.'));
    return sse(res, textTurn('App built.'));
  });
});

// The planner: round 1 returns one finding, round 2 says the change is sound.
let reviews = 0;
const planner = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!body.includes('senior engineer reviewing')) return sse(res, textTurn('(planner got a non-review request)'));
    reviews++;
    if (reviews === 1) {
      return sse(res, textTurn('FINDING\nfile: buggy.js\nline: 2\nissue: The loop never increments i, so it spins forever on first run.\nfix: Use i < 10 as the condition and increment i inside the loop.'));
    }
    return sse(res, textTurn('NO FINDINGS'));
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
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(([a, b]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-esc-failstreak').checked = false;
    document.querySelector('#s-reviewPass').checked = true;
    document.querySelector('#s-heavy-enabled').checked = true;
    document.querySelector('#s-heavy-provider').value = 'openai';
    document.querySelector('#s-heavy-baseUrl').value = b;
    document.querySelector('#s-heavy-apiKey').value = 'test-key';
    document.querySelector('#s-heavy-model').value = 'planner-mock';
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true })); // no stale node routing
    return document.querySelector('#s-save').onclick();
  }, [localBase, plannerBase]);
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'build the app';
    document.querySelector('#btn-send').onclick();
  });

  // Round 1: the findings card appears with the planner's concrete finding.
  await win.waitForFunction(() => document.querySelector('.review-card'), null, { timeout: 30_000 })
    .catch(() => fail('the review findings card never appeared'));
  const cardText = await win.evaluate(() => document.querySelector('.review-card')?.textContent || '');
  if (!cardText.includes('buggy.js:2') || !cardText.includes('never increments')) fail(`the card is missing the finding: ${cardText.slice(0, 200)}`);

  // Hand the fix to the local model; it rewrites the file; round 2 reviews clean.
  await win.evaluate(() => [...document.querySelectorAll('.review-card button')].find((b) => b.textContent.trim() === 'Fix with Qwen').click());
  await win.waitForFunction(
    () => (state.conv?.display || []).some((d) => d.t === 'notice' && /no findings/i.test(d.text)),
    null,
    { timeout: 30_000 }
  ).catch(() => fail('the round-2 "no findings" notice never appeared'));

  const fixed = fs.readFileSync(target, 'utf8');
  if (!fixed.includes('i < 10') || !fixed.includes('i++')) fail(`the fix never landed on disk:\n${fixed}`);
  if (reviews !== 2) fail(`expected exactly 2 review requests to the planner, saw ${reviews}`);
  const spend = await win.evaluate(() => state.conv?.spend || {});
  if (!spend['planner-mock']) fail('review usage was not recorded on the cost meter');
  const rounds = await win.evaluate(() => state.conv?.reviewRounds);
  if (rounds !== 2) fail(`expected reviewRounds 2, saw ${rounds}`);
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
  local.close();
  planner.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`review smoke ok: finding card → local fix on disk → round-2 clean (${reviews} planner reviews, spend recorded)`);
