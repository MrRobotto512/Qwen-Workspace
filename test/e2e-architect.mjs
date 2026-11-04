// Architect mode + Anthropic prompt caching smoke test. The planner is a mock of Anthropic's
// Messages API (SSE events, cache usage); the everyday model is an OpenAI-style mock:
//  1. plan-first plans on the planner (16K budget, planning tools only);
//  2. the plan is for a new file, so the planner — as architect — writes it (32K budget, only
//     write/read/list tools), and the everyday model is told to test and fix, not rewrite;
//  3. every Claude request marks the system prompt, the last tool and the newest message for
//     caching, and the cost meter bills cache writes at 1.25x and reads at 0.1x.
// Run under a display: xvfb-run -a npm run test:e2e:architect
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`ARCHITECT SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=ARCHITECT smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-arch-'));
const GAME = '<!doctype html><html><head><title>Runner</title></head><body style="margin:0;background:#124"><canvas id="c" width="400" height="300"></canvas><script>const g=document.getElementById("c").getContext("2d");g.fillStyle="#e33";g.fillRect(100,100,80,80);const st={lane:1,y:0};addEventListener("keydown",(e)=>{if(e.key==="ArrowRight")st.lane=2;if(e.key===" ")st.y=2;});window.selfTest=async()=>{dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight"}));dispatchEvent(new KeyboardEvent("keydown",{key:" "}));return{version:1,steps:[{step:"move",passed:st.lane===2,detail:"lane 1 -> "+st.lane},{step:"act",passed:st.y>0,detail:"y "+st.y},{step:"hud",passed:true,detail:"drawn"}]};};</script></body></html>';
const D = (s) => `${s} Use the names given, keep the exact values, connect it to the earlier steps and finish with the check named in the step.`;
const PLAN = { todos: [
  { content: 'runner.html: canvas, player box and lane switching — done when the self-test move step passes', status: 'in_progress', details: D('Draw the player as a red square on a canvas 400x300; ArrowRight moves it to lane 2.') },
  { content: 'runner.html: jump with space and window.selfTest() — done when every self-test step passes', status: 'pending', details: D('Space sets y to 2; window.selfTest() presses ArrowRight and Space and reports move, act and hud.') },
  // Notes are not architect work (v0.53): QWEN.md must not be among the files it writes.
  { content: 'QWEN.md: record how to run and test runner.html — done when the file lists the test_app call', status: 'pending', details: D('Write a short QWEN.md: the page is runner.html, test it with test_app runner.html, the self-test steps are move, act and hud.') }
] };
const OVERVIEW = 'Approach: one file, runner.html, with an inline script that draws on a 400x300 canvas. The player is a red square in one of three lanes; ArrowRight moves it right and Space jumps. window.selfTest() presses those keys and reads the game state to report move, act and hud. Pitfall: measure state, never hard-code passed: true.';

const claude = [];
const execBodies = [];
const anth = (res, { text, tool }, usage) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  ev({ type: 'message_start', message: { usage } });
  let i = 0;
  if (text) {
    ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } });
    i++;
  }
  if (tool) {
    ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${claude.length}`, name: tool.name } });
    ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
  }
  ev({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 50 } });
  ev({ type: 'message_stop' });
  res.end();
};
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(req.url.startsWith('/anthropic') ? '{"data":[{"id":"claude-opus-5-5"}]}' : '{"data":[{"id":"exec-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    if (req.url.startsWith('/anthropic')) {
      claude.push({ b, key: req.headers['x-api-key'] });
      // First call writes the cache, later ones read it.
      const usage = claude.length === 1 ? { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } : { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 };
      if (claude.length === 1) return anth(res, { text: OVERVIEW, tool: { name: 'todo_write', input: PLAN } }, usage);
      if (claude.length === 2) return anth(res, { tool: { name: 'write_file', input: { path: 'runner.html', content: GAME } } }, usage);
      return anth(res, { text: 'ok' }, usage);
    }
    execBodies.push(b);
    const done = b.messages.filter((m) => m.role === 'tool').length;
    if (done <= 2) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x1', type: 'function', function: { name: 'test_app', arguments: '{"command":"runner.html"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    sse(res, [{ choices: [{ delta: { content: 'Tested: every self-test step passes.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const root = `http://127.0.0.1:${server.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
let saved = null;

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
    document.querySelector('#s-describeScreens').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, `${root}/v1`);
  saved = await win.evaluate(() => ({ heavy: state.settings.heavy, planFirst: state.settings.planFirst, planWith: state.settings.planWith, architect: state.settings.architect, promptCache: state.settings.promptCache, consultFreely: state.settings.consultFreely, spend: state.settings.spend }));
  await win.evaluate(async (b) => {
    state.settings = await api.setSettings({ heavy: { enabled: true, provider: 'anthropic', baseUrl: b, apiKey: 'sk-test', model: 'claude-opus-5-5' }, planFirst: true, planWith: 'planner', architect: true, promptCache: true, consultFreely: false, maxResponseTokens: 4096, spend: {} });
  }, `${root}/anthropic`);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'make runner.html: a tiny 3-lane runner'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Tested: every self-test step passes.')), null, { timeout: 60_000 });

  if (claude.length !== 2) fail(`expected 2 Claude calls (plan, architect), got ${claude.length}`);
  const [plan, arch] = claude.map((x) => x.b);
  if (plan?.max_tokens !== 16000 || arch?.max_tokens !== 32000) fail(`budgets: plan ${plan?.max_tokens}, architect ${arch?.max_tokens}`);
  const toolNames = (b) => (b?.tools || []).map((t) => t.name).sort().join(',');
  if (toolNames(plan) !== 'ask_user,todo_write') fail(`planning tools: ${toolNames(plan)}`);
  if (toolNames(arch) !== 'list_files,read_file,write_file') fail(`architect tools: ${toolNames(arch)}`);
  if (!JSON.stringify(arch?.messages || []).includes('complete, working first version of runner.html')) fail('the architect was not asked to write runner.html');
  for (const [name, b] of [['plan', plan], ['architect', arch]]) {
    if (!Array.isArray(b?.system) || !b.system[0]?.cache_control) fail(`${name}: the system prompt is not cacheable`);
    if (!b?.tools?.at(-1)?.cache_control) fail(`${name}: the last tool is not cacheable`);
    const last = b?.messages?.at(-1);
    if (!Array.isArray(last?.content) || !last.content.at(-1)?.cache_control) fail(`${name}: the newest message is not cacheable`);
  }
  if (fs.readFileSync(path.join(ws, 'runner.html'), 'utf8') !== GAME) fail('the architect\'s file was not written');
  const firstExec = JSON.stringify(execBodies[0]?.messages || []);
  if (!firstExec.includes('The architect (claude-opus-5-5) wrote the first version of runner.html') || !firstExec.includes('Do not rewrite these files')) fail('the everyday model did not get the test-and-fix handoff');
  const testResult = String(execBodies.at(-1).messages.filter((m) => m.role === 'tool').at(-1)?.content || '');
  if (!/every step passed/.test(testResult)) fail(`the architect's game should pass its self-test: ${testResult.slice(0, 300)}`);
  const notes = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((n) => /Architect: claude-opus-5-5 writes the first version of runner\.html;/.test(n))) fail(`no architect notice: ${notes.join(' | ')}`);
  // Billed input: (100 + 2000*1.25) for the write, (100 + 2000*0.1) for the read = 2600 + 300.
  const billed = await win.evaluate(() => state.conv.spend?.['claude-opus-5-5']?.in);
  if (billed !== 2900) fail(`billed input tokens should be 2900, got ${billed}`);
  const report = await win.evaluate(() => DebugLog.render ? null : null);
  void report;
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async (old) => { state.settings = await api.setSettings({ ...(old || {}), skillWriter: true, lessonsEnabled: true, describeScreens: true }); }, saved).catch(() => {});
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
console.log('architect smoke ok: planned on Claude (16K, planning tools), the architect wrote runner.html (32K, write tools only), the everyday model tested and did not rewrite it, every Claude request was cacheable, cache writes/reads billed at 1.25x/0.1x');
