// Honest finish smoke test — the subway-surfer field report, replayed:
//  1. a text-only model tests a page that draws nothing: test_app tells it plainly that
//     "no console errors" is not "looks right", the pixel check flags the flat picture, and a
//     vision model (the planner, a Gemini on a mock server) describes the screenshot;
//  2. the first Gemini answers 429 free-tier quota: QWS explains it once (a subscription does not
//     raise API limits) and the next model in the ladder does the look;
//  3. the model posts its summary with `echo "PROJECT COMPLETED"`: the echo is not run;
//  4. it posts the same summary again with an unchanged todo_write: the task ends right there;
//  5. compaction keeps the user's own words in the summary.
// Run under a display: xvfb-run -a npm run test:e2e:honesty
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`HONESTY SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=HONESTY smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-honest-'));
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
const SUMMARY = "I've successfully completed the 3D endless runner game. The implementation includes all requested features and is fully playable: three-lane movement, jumping and sliding, procedural obstacles, coin collection, increasing difficulty and score tracking. The previous issue where coins and obstacles weren't visible has been resolved.";
const PLAN = [{ content: 'Build the runner game in game.html', status: 'completed' }];
const STEPS = [
  () => call('h0', 'todo_write', { todos: PLAN }),
  () => call('h1', 'write_file', { path: 'game.html', content: '<!doctype html><html><head><title>Runner</title></head><body style="margin:0;background:#000"><canvas id="c" width="800" height="600"></canvas></body></html>' }),
  () => call('h2', 'test_app', { command: 'game.html' }),
  () => call('h3', 'run_command', { command: 'echo "PROJECT COMPLETED" && echo "All requirements fulfilled" && dir /b' }, SUMMARY),
  () => call('h4', 'todo_write', { todos: PLAN }, SUMMARY)
];
const mainBodies = [];
const looks = [];
// Shaped like Gemini's: the per-day quota id sits in `details`, past the first 600 characters.
const QUOTA = JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, model: gemini-3-pro-preview\nPlease retry in 30s.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] }, { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model: 'gemini-3-pro-preview' }, quotaValue: '50' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } }]);
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"honest-mock"},{"id":"gemini-3-pro-preview"},{"id":"gemini-2.5-flash"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    const first = b.messages?.[0];
    const text = JSON.stringify(first?.content ?? '');
    if (/A coding agent that cannot see images/.test(text)) {
      looks.push({ model: b.model, image: /image_url|data:image\/png;base64/.test(JSON.stringify(b.messages)) });
      if (looks.length === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(QUOTA);
      }
      return sse(res, say('The page is completely black: no road, no player, no coins and no obstacles are visible.\nMatches the request: no — nothing is drawn.'));
    }
    if (/compress coding-agent transcripts/.test(text)) return sse(res, say('<goal>A 3D runner game.</goal>\n<state>Game is fully playable.</state>'));
    mainBodies.push(b);
    const done = b.messages.filter((m) => m.role === 'tool').length;
    if (done < STEPS.length) return sse(res, STEPS[done]());
    sse(res, say('unexpected extra step'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const toolResults = (b) => (b?.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'honest-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (b) => {
    state.settings = await api.setSettings({ heavy: { enabled: true, provider: 'gemini', baseUrl: b, apiKey: 'test-key', model: 'gemini-3-pro-preview' }, describeScreens: true, mcpServers: [] });
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'I still cannot see coins or obstacles in the runner game — fix it'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => state.conv && !state.conv.busy && state.conv.history.length > 4, null, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 1500)); // nothing more may be requested

  if (mainBodies.length !== STEPS.length) fail(`expected ${STEPS.length} model requests (the repeat ends the task), got ${mainBodies.length}`);
  const r = toolResults(mainBodies.at(-1));
  const t = r[2] || '';
  if (!/No console errors/.test(t)) fail(`test_app result: ${t.slice(0, 200)}`);
  if (!/"No console errors" only means nothing crashed/.test(t)) fail(`the text-only model was not told what "no errors" means: ${t.slice(0, 400)}`);
  if (!/Pixel check: the screenshot is 100% one colour/.test(t)) fail(`no pixel check for the black page: ${t.slice(0, 600)}`);
  if (!/described by gemini-2\.5-flash/.test(t) || !/completely black/.test(t)) fail(`the vision description is missing: ${t.slice(-500)}`);
  if (looks.length !== 2 || looks[0].model !== 'gemini-3-pro-preview' || looks[1].model === 'gemini-3-pro-preview') fail(`looks: ${JSON.stringify(looks)}`);
  if (!looks.every((l) => l.image)) fail('the look request carried no screenshot');
  if (!String(r[3]).startsWith(await win.evaluate(() => Honesty.NOOP_RESULT))) fail(`the echo should not run: ${r[3]}`);
  const notices = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notices.some((n) => /free tier/.test(n) && /Google AI Plus, Pro or Ultra subscription covers the Gemini app, not the API/.test(n))) fail(`no quota explanation: ${notices.join(' | ')}`);
  if (notices.filter((n) => /free tier/.test(n)).length !== 1) fail('the quota explanation should appear once');
  if (!notices.some((n) => /kept re-confirming it — ended the task here/.test(n))) fail(`no end notice: ${notices.join(' | ')}`);
  const last = await win.evaluate(() => state.conv.history.at(-1));
  if (last.role !== 'assistant' || last.tool_calls || !/successfully completed/.test(last.content)) fail(`the summary should be the final answer: ${JSON.stringify(last).slice(0, 200)}`);
  const why = await win.evaluate(() => cloudWhy.get('gemini-3-pro-preview'));
  if (why !== 'quota-day') fail(`the quota-hit model should rest until the daily reset: ${why}`);

  // 5. compaction keeps the user's own words
  const ok = await win.evaluate(async () => compactConversation(state.conv, { manual: true }));
  if (!ok) fail('compaction did not run');
  const head = await win.evaluate(() => String(state.conv.history[0].content));
  if (!/<user_messages>[\s\S]*I still cannot see coins or obstacles in the runner game/.test(head)) fail(`the user's words were not kept: ${head.slice(0, 400)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ heavy: { enabled: false, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash' }, skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('honesty smoke ok: blind model told "no errors" is not "looks right", pixel check flagged the black page, quota-hit Gemini explained once and the next model described the screenshot, echo not run, repeated summary ended the task, compaction kept the user\'s words');
