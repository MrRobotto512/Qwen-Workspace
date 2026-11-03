// Cloud model ladder smoke test, against a scripted Gemini (OpenAI-compatible) server that lists
// gemini-3.1-pro-preview > gemini-2.5-pro > gemini-2.5-flash:
//  1. consult_planner with the planner on "auto": 3.1-pro HANGS → after the first-token cutoff
//     (2s here) it counts as busy and the very same consultation is answered by 2.5-pro;
//  2. the main model on "auto": 3.1-pro is resting, so the task starts on 2.5-pro; 2.5-pro answers
//     503 → "busy — moving to the next model now" → 2.5-flash; the rest ends → back to 3.1-pro;
//  3. the cost meter charges the models that actually answered.
// Run under a display: xvfb-run -a npm run test:e2e:ladder
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`LADDER SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=LADDER smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-lad-'));
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const usage = { prompt_tokens: 500, completion_tokens: 20 };
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage }];
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }
];
const busy503 = (res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}'); };

// mode: 'consult' (part 1) or 'task' (part 2)
let mode = 'consult';
const gem = [];
let hold = null; // a response held back until the test releases it
const gemini = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-embedding-001'].map((id) => ({ id })) }));
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    gem.push({ model: b.model, at: Date.now(), mode });
    if (mode === 'consult') {
      if (b.model === 'gemini-3.1-pro-preview') return; // hangs: never answers
      return sse(res, say(`Advice from ${b.model}.`));
    }
    // task on the main model
    const tools = b.messages.filter((m) => m.role === 'tool');
    if (b.model === 'gemini-2.5-pro') return busy503(res);
    if (b.model === 'gemini-2.5-flash') { hold = () => sse(res, call(`f${gem.length}`, 'write_file', { path: 'a.txt', content: 'ladder\n' })); return; }
    if (b.model === 'gemini-3.1-pro-preview' && tools.length) return sse(res, say('Finished on the top model.'));
    return sse(res, say(`unexpected ${b.model}`));
  });
});
const localBodies = [];
const local = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"local-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    localBodies.push(b);
    const done = b.messages.some((m) => m.role === 'tool');
    sse(res, done ? say(`Done: ${b.messages.filter((m) => m.role === 'tool').at(-1).content.slice(0, 80)}`) : call('c1', 'consult_planner', { question: 'How should I structure this?' }));
  });
});
await Promise.all([new Promise((r) => gemini.listen(0, '127.0.0.1', r)), new Promise((r) => local.listen(0, '127.0.0.1', r))]);
const gemBase = `http://127.0.0.1:${gemini.address().port}/v1`;
const localBase = `http://127.0.0.1:${local.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const notices = () => win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(([l, g]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = l;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'local-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-heavy-enabled').checked = true;
    document.querySelector('#s-heavy-provider').value = 'gemini';
    document.querySelector('#s-heavy-baseUrl').value = g;
    document.querySelector('#s-heavy-apiKey').value = 'test-key';
    document.querySelector('#s-heavy-model').value = 'auto';
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, [localBase, gemBase]);
  await win.evaluate(async () => { state.settings = await api.setSettings({ cloudFirstTokenSec: 2 }); });
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // 1. consult on "auto": 3.1-pro hangs → cutoff → 2.5-pro answers the same consultation
  const t0 = Date.now();
  await win.evaluate(() => { document.querySelector('#prompt').value = 'plan it'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Done:')), null, { timeout: 30_000 })
    .catch(() => fail('the consult task never finished'));
  const order1 = gem.filter((g) => g.mode === 'consult').map((g) => g.model);
  if (order1.join(',') !== 'gemini-3.1-pro-preview,gemini-2.5-pro') fail(`consult ladder order: ${order1.join(', ')}`);
  const gap = gem[1] ? gem[1].at - gem[0].at : 0;
  if (gap < 1800 || gap > 6000) fail(`the hung model should be dropped after the 2s cutoff, then the next tried at once (gap ${gap} ms)`);
  const adv = localBodies.at(-1)?.messages.find((m) => m.role === 'tool')?.content || '';
  if (!/<planner_advice model="gemini-2\.5-pro">[\s\S]*Advice from gemini-2\.5-pro/.test(adv)) fail(`advice: ${adv.slice(0, 200)}`);
  if (Date.now() - t0 > 20_000) fail('the consultation took too long');
  const spend1 = await win.evaluate(() => Object.keys(state.conv.spend || {}));
  if (!spend1.includes('gemini-2.5-pro') || spend1.includes('auto')) fail(`the cost meter should charge gemini-2.5-pro, not "auto": ${spend1}`);

  // 2. main model on "auto": 3.1-pro still resting → 2.5-pro (503) → 2.5-flash → back to 3.1-pro
  mode = 'task';
  await win.evaluate(([g]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'gemini';
    document.querySelector('#s-baseUrl').value = g;
    document.querySelector('#s-apiKey').value = 'test-key';
    document.querySelector('#s-model').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    return document.querySelector('#s-save').onclick();
  }, [gemBase]);
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'write a.txt'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => true, null, { timeout: 1000 });
  for (let i = 0; i < 100 && !hold; i++) await new Promise((r) => setTimeout(r, 100));
  if (!hold) fail('the task never reached gemini-2.5-flash');
  else {
    await win.evaluate(() => cloudCool.clear()); // the five-minute rest is over
    hold();
  }
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Finished on the top model.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished back on the top model'));
  const order2 = gem.filter((g) => g.mode === 'task').map((g) => g.model);
  if (order2.join(',') !== 'gemini-2.5-pro,gemini-2.5-flash,gemini-3.1-pro-preview') fail(`task ladder order: ${order2.join(', ')}`);
  if (gem.filter((g) => g.mode === 'task')[1].at - gem.filter((g) => g.mode === 'task')[0].at > 3000) fail('a 503 should move on at once, not wait 8 seconds');
  const n2 = await notices();
  if (!n2.some((t) => /^Using gemini-2\.5-pro, the best Gemini model available\./.test(t))) fail(`no "Using" note: ${JSON.stringify(n2)}`);
  if (!n2.some((t) => /^gemini-2\.5-pro is busy — moving to the next model now; QWS tries gemini-2\.5-pro again in 5 minutes\./.test(t))) fail('no busy note');
  if (!n2.some((t) => t === 'gemini-3.1-pro-preview is free again — back to it.')) fail(`no climb-back note: ${JSON.stringify(n2)}`);
  if (!fs.existsSync(path.join(ws, 'a.txt'))) fail('the step on gemini-2.5-flash did not run');
  const spend2 = await win.evaluate(() => Object.keys(state.conv.spend || {}).sort());
  if (spend2.join(',') !== 'gemini-2.5-flash,gemini-3.1-pro-preview') fail(`task spend went to: ${spend2}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ provider: 'custom', cloudFirstTokenSec: 0, heavy: { enabled: false }, skillWriter: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  gemini.closeAllConnections?.();
  gemini.close();
  local.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('ladder smoke ok: hung 3.1-pro dropped after the cutoff and 2.5-pro answered; a 503 moved on at once; QWS climbed back to 3.1-pro after the rest; spend charged the models that answered');
