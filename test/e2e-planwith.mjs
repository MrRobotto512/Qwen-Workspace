// "Plan with" smoke test: plan-first can use the planner (cloud) model instead of a ⚡ node.
//  1. Plan with "⚡ node, else planner" and no ⚡ node → the planner writes the plan (planning tools
//     only, the plan-first reminder, its tokens on the cost meter); the everyday model executes it.
//  2. Plan with "⚡ node" and no ⚡ node → no planning turn at all (today's behavior).
// Run under a display: xvfb-run -a npm run test:e2e:planwith
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PLANWITH SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PLANWITH smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-pw-'));
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const call = (id, name, args, usage) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], ...(usage ? { usage } : {}) }
];
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const mock = (handler) => http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => handler(JSON.parse(body), res));
});
const plannerBodies = [];
const planner = mock((b, res) => {
  plannerBodies.push(b);
  sse(res, call('p1', 'todo_write', { todos: [{ content: 'Create calc.py with add()', status: 'in_progress', details: 'Write calc.py with def add(a, b): return a + b, and under if __name__ == "__main__": print(add(1, 1)). Keep it to plain Python; no imports are needed for this step.' }, { content: 'Run python calc.py', status: 'pending', details: 'Run python calc.py from the project root. Done when it prints 2 and exits with code 0; if python is missing, install it with install_app and run it again.' }] }, { prompt_tokens: 1200, completion_tokens: 80 }));
});
const localBodies = [];
const local = mock((b, res) => {
  localBodies.push(b);
  const toolDone = b.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'l1');
  if (!toolDone && b.messages.some((m) => /written by the planning model/.test(String(m.content)))) return sse(res, call('l1', 'write_file', { path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' }));
  sse(res, say(toolDone ? 'Done per the plan.' : 'Answered directly.'));
});
await Promise.all([new Promise((r) => planner.listen(0, '127.0.0.1', r)), new Promise((r) => local.listen(0, '127.0.0.1', r))]);
const plannerBase = `http://127.0.0.1:${planner.address().port}/v1`;
const localBase = `http://127.0.0.1:${local.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const configure = (planWith) => win.evaluate(([l, p, pw]) => {
  openSettings();
  document.querySelector('#s-provider').value = 'custom';
  document.querySelector('#s-baseUrl').value = l;
  document.querySelector('#s-apiKey').value = '';
  document.querySelector('#s-model').value = 'local-mock';
  document.querySelector('#s-agentMode').checked = true;
  document.querySelector('#s-approvalMode').value = 'auto';
  document.querySelector('#s-planFirst').checked = true;
  document.querySelector('#s-planWith').value = pw;
  document.querySelector('#s-heavy-enabled').checked = true;
  document.querySelector('#s-heavy-provider').value = 'openai';
  document.querySelector('#s-heavy-baseUrl').value = p;
  document.querySelector('#s-heavy-apiKey').value = 'test-key';
  document.querySelector('#s-heavy-model').value = 'planner-mock';
  document.querySelector('#s-reviewPass').checked = false;
  document.querySelector('#s-lessonsEnabled').checked = false;
  document.querySelector('#s-skillWriter').checked = false;
  settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
  return document.querySelector('#s-save').onclick();
}, [localBase, plannerBase, planWith]);
const run = async (prompt, until) => {
  await win.evaluate((t) => { newChat(); document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, prompt);
  await win.waitForFunction((u) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(u)), until, { timeout: 30_000 })
    .catch(() => fail(`no reply "${until}"`));
};

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1. "⚡ node, else planner" with no ⚡ node → the planner plans
  await configure('auto');
  if ((await win.evaluate(() => state.settings.planWith)) !== 'auto') fail('Plan with was not saved');
  await run('build a calculator', 'Done per the plan.');
  if (plannerBodies.length !== 1) fail(`expected 1 planning request on the planner, saw ${plannerBodies.length}`);
  else {
    const tools = (plannerBodies[0].tools || []).map((t) => t.function.name).sort().join(',');
    if (tools !== 'ask_user,todo_write') fail(`the planner's turn should only get planning tools, got ${tools}`);
    if (!JSON.stringify(plannerBodies[0].messages).includes('You are the planning model for this task')) fail('the plan-first reminder did not reach the planner');
    if (plannerBodies[0].model !== 'planner-mock') fail(`planning used ${plannerBodies[0].model}`);
  }
  if (!fs.existsSync(path.join(ws, 'calc.py'))) fail('the everyday model did not execute the plan');
  const st = await win.evaluate(() => ({ notices: state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text), todos: state.conv.todos.map((t) => t.content), spend: state.conv.spend }));
  if (!st.notices.some((t) => /^Planning on .*planner-mock/.test(t))) fail(`no "Planning on" notice: ${JSON.stringify(st.notices)}`);
  if (st.todos[0] !== 'Create calc.py with add()') fail(`plan not recorded: ${JSON.stringify(st.todos)}`);
  if (!st.spend?.['planner-mock']?.in) fail(`the planner's tokens were not put on the cost meter: ${JSON.stringify(st.spend)}`);

  // 2. "⚡ node" with no ⚡ node → no planning turn
  await configure('node');
  const before = plannerBodies.length;
  await run('what is 2+2', 'Answered directly.');
  if (plannerBodies.length !== before) fail('with Plan with = ⚡ node and no node, the planner should not be asked');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ planFirst: false, planWith: 'node', heavy: { enabled: false }, skillWriter: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  planner.close();
  local.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('planwith smoke ok: with no ⚡ node, "⚡ node, else planner" planned on the planner (planning tools only, cost recorded) and the everyday model executed it; "⚡ node" alone skipped planning');
