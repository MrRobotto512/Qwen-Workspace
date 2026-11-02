// Goal-mode smoke test: "/goal" sets a standing objective. The scripted local model lies
// ("Done!") without writing the file; the scripted judge reads the evidence, says CONTINUE,
// and the task resumes on its own — the model writes calc.py, the judge says DONE, the goal
// clears. This is the field failure goal mode exists for: small models declaring victory early.
// Run under a display: xvfb-run -a npm run test:e2e:goal
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`GOAL SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=GOAL smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-goal-'));
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const textTurn = (t) => [
  { choices: [{ delta: { content: t }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }
];
const modelsList = (res, id) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id }] }));
};

let localTurns = 0;
const localBodies = [];
const local = http.createServer((req, res) => {
  if (req.method !== 'POST') return modelsList(res, 'local-mock');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const n = ++localTurns;
    localBodies.push(body);
    if (n === 1) return sse(res, textTurn('Done! calc.py is ready.')); // the premature claim
    if (n === 2) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'calc.py', content: 'print(2 + 2)\n' }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    return sse(res, textTurn('Created calc.py.'));
  });
});

let judgeCalls = 0;
const judgeBodies = [];
const judge = http.createServer((req, res) => {
  if (req.method !== 'POST') return modelsList(res, 'judge-mock');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!body.includes('Judge by the evidence')) return sse(res, textTurn('(not a goal check)'));
    judgeBodies.push(body);
    judgeCalls++;
    // The judge decides from the evidence block, as instructed: calc.py in "Files changed".
    sse(res, textTurn(/Files changed: [^"]*calc\.py/.test(body) ? 'DONE: calc.py was written.' : 'CONTINUE: calc.py was never written — create it with write_file.'));
  });
});

await Promise.all([new Promise((r) => local.listen(0, '127.0.0.1', r)), new Promise((r) => judge.listen(0, '127.0.0.1', r))]);
const localBase = `http://127.0.0.1:${local.address().port}/v1`;
const judgeBase = `http://127.0.0.1:${judge.address().port}/v1`;

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
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-esc-failstreak').checked = false;
    document.querySelector('#s-heavy-enabled').checked = true;
    document.querySelector('#s-heavy-provider').value = 'openai';
    document.querySelector('#s-heavy-baseUrl').value = b;
    document.querySelector('#s-heavy-apiKey').value = 'test-key';
    document.querySelector('#s-heavy-model').value = 'judge-mock';
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, [localBase, judgeBase]);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  await win.evaluate(() => {
    document.querySelector('#prompt').value = '/goal create calc.py that prints 4';
    document.querySelector('#btn-send').onclick();
  });
  if (await win.evaluate(() => document.querySelector('#goal-bar').classList.contains('hidden'))) fail('the goal bar did not appear after /goal');

  await win.waitForFunction(
    () => (state.conv?.display || []).some((d) => d.t === 'notice' && /Goal achieved/.test(d.text)),
    null,
    { timeout: 45_000 }
  ).catch(() => fail('the goal was never reported achieved'));

  if (!fs.existsSync(path.join(ws, 'calc.py'))) fail('calc.py was never written — the premature "Done!" ended the task');
  if (judgeCalls !== 2) fail(`expected 2 goal checks (CONTINUE then DONE), saw ${judgeCalls}`);
  if (!localBodies[0]?.includes('create calc.py that prints 4')) fail('the goal text was not sent as the first instruction');
  if (!localBodies[1]?.includes('goal check 1/8')) fail('the continuation prompt never reached the local model');
  if (!judgeBodies[0]?.includes('Done! calc.py is ready.')) fail("the judge never saw the agent's claim");
  const st = await win.evaluate(() => ({
    goal: state.conv.goal,
    barHidden: document.querySelector('#goal-bar').classList.contains('hidden'),
    notices: (state.conv.display || []).filter((d) => d.t === 'notice').map((d) => d.text)
  }));
  if (st.goal) fail(`the goal should clear once achieved, still: ${JSON.stringify(st.goal)}`);
  if (!st.barHidden) fail('the goal bar should hide once the goal is achieved');
  if (!st.notices.some((t) => /Goal not met yet \(check 1\/8/.test(t))) fail(`no "not met yet" notice; notices: ${JSON.stringify(st.notices)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ heavy: { enabled: false } }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  local.close();
  judge.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`goal smoke ok: premature "Done!" caught by the judge, task resumed, calc.py written, goal achieved (${judgeCalls} checks, ${localTurns} local turns)`);
