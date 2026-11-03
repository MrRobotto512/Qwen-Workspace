// "Consult the planner whenever unsure" smoke test:
//  1. on: consult_planner is described as for whenever unsure, the system prompt says the planner
//     is on call, a failed command nudges toward it; the consultation is answered and its tokens
//     go on the cost meter;
//  2. with the monthly budget reached, a consultation asks first — "Stay local" means the planner
//     is not called and the agent is told to go on alone;
//  3. off: the old "sparingly" wording, no prompt line.
// Run under a display: xvfb-run -a npm run test:e2e:consult
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CONSULT SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CONSULT smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cons-'));
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
const say = (t, usage) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }];
const mock = (handler) => http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => handler(JSON.parse(body), res));
});
let plannerCalls = 0;
const planner = mock((b, res) => { plannerCalls++; sse(res, say('Exit code 2 is the script signalling bad input; pass --input.', { prompt_tokens: 900, completion_tokens: 40 })); });
const localBodies = [];
let seq = 0;
const local = mock((b, res) => {
  localBodies.push(b);
  const task = [...b.messages].reverse().find((m) => m.role === 'user' && !String(m.content).startsWith('<system-reminder>'))?.content || '';
  const tools = b.messages.filter((m) => m.role === 'tool');
  const last = tools.at(-1)?.content || '';
  if (/task A/.test(task)) {
    if (!tools.length) return sse(res, call(`a${++seq}`, 'run_command', { command: 'node -e "process.exit(2)"' }));
    if (/^Exit code: 2/.test(last)) return sse(res, call(`a${++seq}`, 'consult_planner', { question: 'Why does my script exit 2?\nnode -e "process.exit(2)"' }));
    return sse(res, say(`Done A. ${last.slice(0, 80)}`));
  }
  if (/task B/.test(task)) {
    if (!tools.length) return sse(res, call(`b${++seq}`, 'consult_planner', { question: 'Should I use a class here?' }));
    return sse(res, say(`Done B. ${last.slice(0, 60)}`));
  }
  sse(res, say('Done C.'));
});
await Promise.all([new Promise((r) => planner.listen(0, '127.0.0.1', r)), new Promise((r) => local.listen(0, '127.0.0.1', r))]);
const plannerBase = `http://127.0.0.1:${planner.address().port}/v1`;
const localBase = `http://127.0.0.1:${local.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const configure = (freely) => win.evaluate(([l, p, f]) => {
  openSettings();
  document.querySelector('#s-provider').value = 'custom';
  document.querySelector('#s-baseUrl').value = l;
  document.querySelector('#s-apiKey').value = '';
  document.querySelector('#s-model').value = 'local-mock';
  document.querySelector('#s-agentMode').checked = true;
  document.querySelector('#s-approvalMode').value = 'auto';
  document.querySelector('#s-planFirst').checked = false;
  document.querySelector('#s-heavy-enabled').checked = true;
  document.querySelector('#s-heavy-provider').value = 'openai';
  document.querySelector('#s-heavy-baseUrl').value = p;
  document.querySelector('#s-heavy-apiKey').value = 'test-key';
  document.querySelector('#s-heavy-model').value = 'planner-mock';
  document.querySelector('#s-consultFreely').checked = f;
  document.querySelector('#s-reviewPass').checked = false;
  document.querySelector('#s-lessonsEnabled').checked = false;
  document.querySelector('#s-skillWriter').checked = false;
  settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
  return document.querySelector('#s-save').onclick();
}, [localBase, plannerBase, freely]);
const run = async (prompt, until, during) => {
  await win.evaluate((t) => { newChat(); document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, prompt);
  if (during) await during();
  await win.waitForFunction((u) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(u)), until, { timeout: 30_000 })
    .catch(() => fail(`no reply "${until}"`));
};
const consultDesc = (b) => (b?.tools || []).find((t) => t.function.name === 'consult_planner')?.function.description || '';
const toolOf = (b, name) => {
  const id = (b?.messages || []).flatMap((m) => m.tool_calls || []).find((tc) => tc.function.name === name)?.id;
  return (b?.messages || []).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content || '';
};

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1. consult freely
  await configure(true);
  await run('task A', 'Done A.');
  const first = localBodies[0];
  if (!/whenever you are unsure/.test(consultDesc(first))) fail(`consult_planner should be described as for whenever unsure: ${consultDesc(first).slice(0, 120)}`);
  if (!/planner model \(.*planner-mock.*\) is on call/.test(String(first?.messages?.[0]?.content))) fail('the system prompt does not say the planner is on call');
  const ran = toolOf(localBodies.at(-1), 'run_command');
  if (!/ask consult_planner \(paste this error\)/.test(ran)) fail(`a failed command should nudge toward the planner: ${ran.slice(0, 200)}`);
  const advice = toolOf(localBodies.at(-1), 'consult_planner');
  if (!/<planner_advice model="planner-mock">[\s\S]*pass --input/.test(advice)) fail(`the consultation was not answered: ${advice.slice(0, 200)}`);
  if (plannerCalls !== 1) fail(`expected 1 planner call, saw ${plannerCalls}`);
  const spent = await win.evaluate(() => state.settings.spend?.models?.['planner-mock']?.in || 0);
  if (!(spent >= 900)) fail(`the consultation's tokens are not on the cost meter (${spent})`);

  // 2. budget reached → ask first; "Stay local" keeps the planner out
  await win.evaluate(async () => {
    const month = state.settings.spend?.month;
    state.settings = await api.setSettings({ prices: { 'planner-mock': { in: 100, out: 100 } }, monthlyCapUSD: 1, spend: { ...state.settings.spend, month, models: { 'planner-mock': { in: 2_000_000, out: 0 } } } });
  });
  const before = plannerCalls;
  await run('task B', 'Done B.', async () => {
    await win.waitForFunction(() => [...document.querySelectorAll('.msg.error')].some((m) => /reached your .* budget/.test(m.textContent)), null, { timeout: 15_000 })
      .catch(() => fail('no budget card for a consultation over the cap'));
    await win.evaluate(() => [...document.querySelectorAll('.msg.error button')].find((b) => b.textContent.trim() === 'Stay local')?.click());
  });
  if (plannerCalls !== before) fail('the planner was called although the user chose to stay local');
  const refused = toolOf(localBodies.at(-1), 'consult_planner');
  if (!/monthly cloud budget is reached/.test(refused)) fail(`the agent was not told why: ${refused.slice(0, 160)}`);

  // 3. off → the old wording
  await configure(false);
  await run('task C', 'Done C.');
  const off = localBodies.at(-1);
  if (!/Use it sparingly/.test(consultDesc(off))) fail('with the option off, consult_planner should say "sparingly"');
  if (/is on call/.test(String(off?.messages?.[0]?.content))) fail('with the option off, the prompt line should be gone');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ consultFreely: false, heavy: { enabled: false }, prices: {}, monthlyCapUSD: 0, skillWriter: true }); }).catch(() => {});
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
console.log('consult smoke ok: "whenever unsure" wording + prompt line + failed-command nudge, consultation answered and costed, budget card kept the planner out, off restores "sparingly"');
