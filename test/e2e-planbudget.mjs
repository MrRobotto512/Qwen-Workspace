// Planning budget and edit-loop smoke test — the qwen3:8b + Opus field report, replayed:
//  1. the planning turn gets a 16,000-token reply budget; a reply cut off at the limit with
//     nothing in it is retried with a "be briefer" note instead of being called an approved plan;
//  2. the plan and every executor turn are told the file the user named (subwaysurfer.html);
//  3. a pretty-printed old_text for a one-line file matches with whitespace ignored;
//  4. the same failed edit is answered with the file's text, then refused;
//  5. a planner that sends back nothing three times never yields "the plan above is approved".
// Run under a display: xvfb-run -a npm run test:e2e:planbudget
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PLANBUDGET SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PLANBUDGET smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-planbudget-'));
const ONE_LINE = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Runner</title><style>body{margin:0}canvas{display:block}</style></head><body></body></html>';
const PRETTY_OLD = '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <title>Runner</title>\n  <style>\n    body{margin:0}canvas{display:block}\n  </style>\n</head>\n<body>\n  \n</body>\n</html>';
const NEW = '<!DOCTYPE html>\n<html><head><title>Runner</title></head><body><canvas id="c"></canvas><script>/* game */</script></body></html>';
const D = (s) => `${s} Use the names given here, keep the values exactly, connect it to the earlier steps, and finish with the check in the step title before moving on.`;
const PLAN = {
  todos: [
    { content: 'subwaysurfer.html: page skeleton with a canvas — done when test_app shows no errors', status: 'in_progress', details: D('Write subwaysurfer.html with a <canvas id="c"> filling the window and one inline <script>.') },
    { content: 'subwaysurfer.html: scene, track and player — done when the self-test step move passes', status: 'pending', details: D('Add the Three.js scene, three lanes at x = -2, 0, 2, and a player box that eases between lanes.') }
  ]
};
const OVERVIEW = 'Approach: everything lives in subwaysurfer.html, one inline module script. The scene has three lanes at x = -2, 0 and 2; the player is a box that eases between lanes and jumps with velocity 8 and gravity 20. Obstacles and coins are pooled and recycled 60 units ahead. A window.selfTest() plays the core loop.';

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const call = (id, name, args, text = '') => [
  ...(text ? [{ choices: [{ delta: { content: text }, finish_reason: null }] }] : []),
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
let phase = 1;
const planBodies = [];
const execBodies = [];
const STEPS = [
  ['write_file', { path: 'subwaysurfer.html', content: ONE_LINE }],
  ['edit_file', { path: 'subwaysurfer.html', old_text: PRETTY_OLD, new_text: NEW }],
  ['edit_file', { path: 'subwaysurfer.html', old_text: '<div id="hud">\n  score\n</div>', new_text: 'x' }],
  ['edit_file', { path: 'subwaysurfer.html', old_text: '<div id="hud">\n  score\n</div>', new_text: 'x' }],
  ['edit_file', { path: 'subwaysurfer.html', old_text: '<div id="hud">\n  score\n</div>', new_text: 'x' }]
];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"exec-mock"},{"id":"planner-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    const planning = b.model === 'planner-mock' && JSON.stringify(b.messages).includes('You are the planning model') && !b.messages.some((m) => m.role === 'tool');
    if (planning) {
      planBodies.push({ phase, b });
      const n = planBodies.filter((p) => p.phase === phase).length;
      if (phase === 1 && n === 1) return sse(res, [{ choices: [{ delta: {}, finish_reason: 'length' }] }]); // cut off, nothing said
      if (phase === 1) return sse(res, call('p1', 'todo_write', PLAN, OVERVIEW));
      return sse(res, [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]); // phase 2: nothing at all
    }
    execBodies.push({ phase, b });
    if (phase === 2) return sse(res, say('Planned myself.'));
    const done = b.messages.filter((m) => m.role === 'tool').length - 1; // the planner's todo_write is the first
    if (done < STEPS.length) return sse(res, call(`e${done}`, ...STEPS[done]));
    sse(res, say('Skeleton written.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
let saved = null;
const toolResults = (b) => (b?.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'exec-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  saved = await win.evaluate(() => ({ heavy: state.settings.heavy, architect: state.settings.architect, planFirst: state.settings.planFirst, planWith: state.settings.planWith, consultFreely: state.settings.consultFreely, maxResponseTokens: state.settings.maxResponseTokens }));
  await win.evaluate(async (b) => {
    state.settings = await api.setSettings({ heavy: { enabled: true, provider: 'openai', baseUrl: b, apiKey: 'k', model: 'planner-mock' }, planFirst: true, planWith: 'planner', architect: false, consultFreely: false, maxResponseTokens: 4096 });
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1-4
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'make subwaysurfer.html\nBuild a 3D endless runner with Three.js.'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Skeleton written.')), null, { timeout: 60_000 });
  const p1 = planBodies.filter((p) => p.phase === 1);
  if (p1.length !== 2) fail(`expected 2 planning requests (cut off, then the plan), got ${p1.length}`);
  if (!p1.every((p) => p.b.max_tokens === 16000)) fail(`planning budget: ${p1.map((p) => p.b.max_tokens).join(', ')}`);
  const firstPlan = JSON.stringify(p1[0].b.messages);
  if (!firstPlan.includes('The user named subwaysurfer.html: the plan uses exactly these file names')) fail('the planner was not told the named file');
  if (!JSON.stringify(p1[1]?.b.messages || []).includes('Your previous reply was cut off before it finished')) fail('the retry did not say the reply was cut off');
  const notes = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((n) => /reply was cut off at the length limit .* retrying with room for 16,000 tokens/.test(n))) fail(`no cut-off notice: ${notes.join(' | ')}`);
  const emptyTurns = await win.evaluate(() => state.conv.history.filter((m) => m.role === 'assistant' && !String(m.content || '').trim() && !m.tool_calls?.length).length);
  if (emptyTurns) fail(`${emptyTurns} empty assistant turn(s) stayed in history`);
  const ex = execBodies.filter((e) => e.phase === 1);
  if (!JSON.stringify(ex[0].b.messages).includes('Files the user named: subwaysurfer.html')) fail('the executor was not told the named file');
  if (ex.some((e) => e.b.model === 'exec-mock' && (e.b.max_tokens || 0) > 4096)) fail('the executor should keep the normal reply cap');
  const n1b = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!n1b.some((n) => /Steps keep failing/.test(n))) fail('two failed edits in a row should count as failing steps');
  const r = toolResults(ex.at(-1).b).slice(1);
  if (process.env.DEBUG_E2E) console.log(JSON.stringify(r, null, 1).slice(0, 3000));
  if (!/ignoring all spaces and line breaks/.test(r[1] || '')) fail(`pretty old_text on a one-line file: ${(r[1] || '').slice(0, 200)}`);
  if (fs.readFileSync(path.join(ws, 'subwaysurfer.html'), 'utf8') !== NEW) fail('the blind edit did not land');
  if (!/^Error: old_text was not found .*Here is the file:/s.test(r[2] || '')) fail(`first miss should show the file: ${(r[2] || '').slice(0, 200)}`);
  if (!/the same edit failed before/.test(r[3] || '') || !/rewrite it whole with write_file/.test(r[3] || '')) fail(`second miss: ${(r[3] || '').slice(0, 200)}`);
  if (!/^Error: refused — this exact edit of subwaysurfer\.html has failed 2 times/.test(r[4] || '')) fail(`third miss should be refused: ${(r[4] || '').slice(0, 200)}`);
  if (!(r[4] || '').includes(NEW)) fail('the refusal should carry the file text');

  // 5. a planner that answers nothing
  phase = 2;
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'make game.html'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Planned myself.')), null, { timeout: 60_000 });
  const p2 = planBodies.filter((p) => p.phase === 2).length;
  if (p2 !== 3) fail(`a silent planner should get 3 tries, got ${p2}`);
  const h2 = await win.evaluate(() => JSON.stringify(state.conv.history));
  if (h2.includes('The plan above is approved')) fail('no plan may be called approved');
  if (!h2.includes('No plan was written')) fail('the executor should be told there is no plan');
  const n2 = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!n2.some((n) => /No plan came back after three tries/.test(n))) fail(`no-plan notice: ${n2.join(' | ')}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
  if (process.env.DEBUG_E2E) console.log(JSON.stringify(await win.evaluate(() => ({ notes: state.conv.display.filter((d) => d.t === 'notice' || d.t === 'error').map((d) => d.text), last: state.conv.history.slice(-3) })).catch((x) => String(x))).slice(0, 3000), planBodies.map((p) => p.phase), execBodies.map((p) => p.phase));
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Put back every setting this test changed: later tests share this settings file.
  await win.evaluate(async (old) => { state.settings = await api.setSettings({ ...(old || {}), skillWriter: true, lessonsEnabled: true }); }, saved).catch(() => {});
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
console.log('planbudget smoke ok: planning got 16K tokens, a cut-off empty plan was retried (never "approved"), the named file reached planner and executor, a pretty old_text matched a one-line file, repeated failed edits got the file then a refusal, a silent planner fell back to self-planning');
