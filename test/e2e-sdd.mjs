// Spec-driven skills smoke test (ideas from fpapleux/sdd-skill):
//  1. "/sdd status" runs the installed project skill: its instructions ride along with the
//     message, the folder placeholder is replaced with .qwen/skills/sdd, and the script runs;
//  2. stop rule: the same command failing the same way gets "name the root cause", then the
//     last-try warning, then "stop and report", and a fourth run is refused (with a notice);
//  3. model per job: a "strong" subtask runs on the planner model (paid → a card asks first),
//     and its summary comes back marked strong;
//  4. checks gate: a test the task itself added that does not pass yet is "pending" — the agent
//     gets one try to finish it, and there is no rollback card.
// Run under a display: xvfb-run -a npm run test:e2e:sdd
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`SDD SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=SDD smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-sdd-'));
const at = (p) => path.join(ws, p);
fs.mkdirSync(at('.qwen/skills/sdd/scripts'), { recursive: true });
fs.writeFileSync(at('.qwen/skills/sdd/SKILL.md'), '---\nname: sdd\ndescription: Spec-driven development. Use when the user invokes /sdd.\n---\n\n# SDD\n\n**SDD** means `python3 <skill folder>/scripts/sdd.py`. Run `SDD status` first.\n');
fs.writeFileSync(at('.qwen/skills/sdd/scripts/sdd.py'), 'import sys\nprint("sdd " + " ".join(sys.argv[1:]) + ": no active change")\n');
fs.mkdirSync(at('test'));
fs.writeFileSync(at('test/old.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\ntest('old behaviour', () => assert.equal(1 + 1, 2));\n");

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
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }];
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
const planner = mock((b, res) => { plannerBodies.push(b); sse(res, say('Spec reviewed by the planner: REQ-1 needs a failure scenario.')); });
const localBodies = [];
let seq = 0;
const FAIL_CMD = 'node -e "console.error(\'Error: config.json not found\'); process.exit(1)"';
const local = mock((b, res) => {
  localBodies.push(b);
  const task = String(b.messages.find((m) => m.role === 'user')?.content || '');
  const users = b.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
  const tools = b.messages.filter((m) => m.role === 'tool');
  const last = String(tools.at(-1)?.content || '');
  if (task.startsWith('/sdd status')) {
    if (!tools.length) return sse(res, call(`s${++seq}`, 'run_command', { command: 'python3 .qwen/skills/sdd/scripts/sdd.py status' }));
    return sse(res, say(`Done S. ${last.slice(0, 80)}`));
  }
  if (/^task F/.test(task)) {
    if (/^Not run: this command has failed/.test(last)) return sse(res, say('Done F. Reporting: config.json is missing.'));
    return sse(res, call(`f${++seq}`, 'run_command', { command: FAIL_CMD }));
  }
  if (/^task T/.test(task)) {
    if (!tools.length) return sse(res, call(`t${++seq}`, 'delegate_tasks', { tasks: [{ task: 'Review the spec in spec.md with fresh eyes', tier: 'strong' }] }));
    return sse(res, say('Done T.'));
  }
  if (/^task N/.test(task)) {
    if (users.some((u) => /tests you added in this task do not pass yet/.test(u))) {
      if (!/total\.js/.test(JSON.stringify(b.messages.slice(-3)))) return sse(res, call(`n${++seq}`, 'write_file', { path: 'total.js', content: 'module.exports = () => 3;\n' }));
      return sse(res, say('Done N.'));
    }
    if (!tools.length) {
      return sse(res, call(`n${++seq}`, 'write_file', {
        path: 'test/new.test.js',
        content: "const test = require('node:test');\nconst assert = require('node:assert');\nconst total = () => { try { return require('../total.js')(); } catch { return 0; } };\ntest('totals three lines', () => assert.equal(total(), 3));\n"
      }));
    }
    return sse(res, say('Wrote the test first.'));
  }
  sse(res, say('Done.'));
});
await Promise.all([new Promise((r) => planner.listen(0, '127.0.0.1', r)), new Promise((r) => local.listen(0, '127.0.0.1', r))]);
const plannerBase = `http://127.0.0.1:${planner.address().port}/v1`;
const localBase = `http://127.0.0.1:${local.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const configure = (heavy) => win.evaluate(([l, p, h]) => {
  openSettings();
  document.querySelector('#s-provider').value = 'custom';
  document.querySelector('#s-baseUrl').value = l;
  document.querySelector('#s-apiKey').value = '';
  document.querySelector('#s-model').value = 'local-mock';
  document.querySelector('#s-agentMode').checked = true;
  document.querySelector('#s-approvalMode').value = 'auto';
  document.querySelector('#s-planFirst').checked = false;
  document.querySelector('#s-heavy-enabled').checked = h;
  document.querySelector('#s-heavy-provider').value = 'openai';
  document.querySelector('#s-heavy-baseUrl').value = p;
  document.querySelector('#s-heavy-apiKey').value = 'test-key';
  document.querySelector('#s-heavy-model').value = 'planner-mock';
  document.querySelector('#s-consultFreely').checked = false;
  document.querySelector('#s-stopRule').checked = true;
  document.querySelector('#s-subagents').checked = true;
  document.querySelector('#s-checksGate').checked = true;
  document.querySelector('#s-reviewPass').checked = false;
  document.querySelector('#s-lessonsEnabled').checked = false;
  document.querySelector('#s-skillWriter').checked = false;
  settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
  return document.querySelector('#s-save').onclick();
}, [localBase, plannerBase, heavy]);
const run = async (prompt, until, during) => {
  await win.evaluate((t) => { newChat(); document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, prompt);
  if (during) await during();
  await win.waitForFunction((u) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(u)), until, { timeout: 40_000 })
    .catch(() => fail(`no reply "${until}"`));
};
const toolResults = (b, name) => {
  const ids = new Set((b?.messages || []).flatMap((m) => m.tool_calls || []).filter((tc) => tc.function.name === name).map((tc) => tc.id));
  return (b?.messages || []).filter((m) => m.role === 'tool' && ids.has(m.tool_call_id)).map((m) => String(m.content));
};
const notices = () => win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);
  await configure(false);

  // 1. /sdd status runs the skill
  await run('/sdd status', 'Done S.');
  const s1 = localBodies.find((b) => String(b.messages.find((m) => m.role === 'user')?.content).startsWith('/sdd status'));
  const msg = String(s1?.messages.find((m) => m.role === 'user')?.content || '');
  if (!/The user invoked the "sdd" skill with: status/.test(msg)) fail(`the skill was not invoked: ${msg.slice(0, 200)}`);
  if (!/<skill name="sdd" folder="\.qwen\/skills\/sdd">/.test(msg)) fail('the skill block does not carry its folder');
  if (!/python3 \.qwen\/skills\/sdd\/scripts\/sdd\.py/.test(msg) || /<skill folder>/.test(msg)) fail('the folder placeholder was not replaced');
  const ranSdd = toolResults(localBodies.at(-1), 'run_command')[0] || '';
  if (!/sdd status: no active change/.test(ranSdd)) fail(`the skill's script did not run: ${ranSdd.slice(0, 200)}`);
  const shown = await win.evaluate(() => state.conv.display.find((d) => d.t === 'user')?.text || '');
  if (shown.trim() !== '/sdd status') fail(`the chat should show what was typed, not the skill text: ${shown.slice(0, 80)}`);
  const used = await notices();
  if (!used.some((t) => /Skills used: sdd/.test(t))) fail(`no skills-used line: ${used.join(' | ').slice(0, 300)}`);

  // 2. stop rule
  await run('task F: start the server', 'Done F.');
  const fBody = localBodies.at(-1);
  const sysF = String(fBody?.messages?.[0]?.content || '');
  if (!/After two failed fixes for the same problem, stop and report/.test(sysF)) fail('the system prompt lacks the stop rule');
  const runs = toolResults(fBody, 'run_command');
  if (runs.length !== 4) fail(`expected 4 run_command results (3 runs + 1 refusal), saw ${runs.length}`);
  if (!/name its root cause in one sentence/.test(runs[0] || '')) fail(`first failure should ask for the root cause: ${(runs[0] || '').slice(-200)}`);
  if (!/failed the same way twice/.test(runs[1] || '')) fail(`second failure should warn it is the last try: ${(runs[1] || '').slice(-200)}`);
  if (!/Stop now: do not try another fix/.test(runs[2] || '')) fail(`third failure should say stop: ${(runs[2] || '').slice(-200)}`);
  if (!/^Not run: this command has failed after two planned fixes/.test(runs[3] || '')) fail(`fourth run should be refused: ${(runs[3] || '').slice(0, 200)}`);
  const fNotes = await notices();
  if (!fNotes.some((t) => /^Stop rule: .* failed the same way 3 times/.test(t))) fail(`no stop-rule notice: ${fNotes.join(' | ').slice(0, 300)}`);

  // 3. a strong subtask runs on the planner, after the paid-run card
  await configure(true);
  await run('task T: review my spec', 'Done T.', async () => {
    await win.waitForFunction(() => !!document.querySelector('.strong-subagent-card'), null, { timeout: 15_000 }).catch(() => fail('no card before a paid strong subtask'));
    const label = await win.evaluate(() => document.querySelector('.strong-subagent-card')?.textContent || '');
    if (!/planner-mock \(cloud — this uses your paid API\)/.test(label)) fail(`card text: ${label}`);
    await win.evaluate(() => [...document.querySelectorAll('.strong-subagent-card button')].find((x) => /^Use /.test(x.textContent.trim()))?.click());
  });
  if (plannerBodies.length < 1) fail('the strong subtask never reached the planner');
  else {
    const p = plannerBodies[0];
    if (p.model !== 'planner-mock') fail(`planner got model ${p.model}`);
    if (!/You are a subagent/.test(String(p.messages?.[0]?.content))) fail('the planner request is not the subagent run');
    if (!/Review the spec in spec\.md/.test(JSON.stringify(p.messages))) fail('the planner did not get the subtask');
  }
  const tParent = localBodies.at(-1);
  const delegDesc = (tParent?.tools || []).find((t) => t.function.name === 'delegate_tasks')?.function;
  if (!delegDesc || !/"strong"/.test(delegDesc.description) || !delegDesc.parameters.properties.tasks.items.properties.tier) fail('delegate_tasks is not offered with tiers on one machine + planner');
  const dres = toolResults(tParent, 'delegate_tasks')[0] || '';
  if (!/Subtask 1 \(on planner-mock, strong\)/.test(dres) || !/Spec reviewed by the planner/.test(dres)) fail(`delegate result: ${dres.slice(0, 300)}`);

  // 4. checks gate: the task's own new test is pending, not a regression
  const checksText = JSON.stringify({ checks: [{ name: 'tests', command: 'node --test' }] }, null, 2) + '\n';
  fs.mkdirSync(at('.qwen'), { recursive: true });
  fs.writeFileSync(at('.qwen/checks.json'), checksText);
  await win.evaluate(async ([root, text]) => { state.settings = await api.setSettings({ checksApproved: { [root]: text } }); }, [await win.evaluate(() => state.ws.root), checksText]);
  await run('task N: add a total() helper, test first', 'Done N.');
  await win.waitForFunction(() => state.conv.display.some((d) => d.t === 'notice' && /Checks after the (task|fix)/.test(d.text) && /no regressions|improved|still don't pass/.test(d.text)), null, { timeout: 60_000 }).catch(() => {});
  const nNotes = await notices();
  if (!nNotes.some((t) => /^New tests from this task don't pass yet \(totals three lines\) — nothing that passed before broke/.test(t))) fail(`no pending notice: ${nNotes.join(' | ').slice(0, 400)}`);
  if (nNotes.some((t) => /Checks got worse/.test(t))) fail('the new test was treated as a regression');
  if (!nNotes.some((t) => /no regressions/.test(t))) fail(`after the fix the checks should pass: ${nNotes.join(' | ').slice(0, 400)}`);
  if (await win.evaluate(() => !!document.querySelector('.rollback-card'))) fail('a rollback card appeared for a pending test');
  if (!fs.existsSync(at('total.js'))) fail('the agent did not get the pending prompt to finish the test');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ heavy: { enabled: false }, checksApproved: {}, skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('sdd smoke ok: /sdd ran the skill with its folder and script, stop rule warned → stopped → refused, strong subtask ran on the planner after the card, a new failing test was pending (one finish try, no rollback)');
