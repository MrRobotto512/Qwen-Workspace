// Free cloud models smoke test (OpenRouter free models + Groq), against a mock server:
//  1. Settings shows a sign-up link and the free-tier note for Groq and OpenRouter, and the
//     "free models only" switch for OpenRouter;
//  2. Fetch models lists OpenRouter's free models with what each can do, and remembers which
//     see images;
//  3. a Groq task: a per-minute 429 is waited out, a refused (tool_use_failed) tool call is sent
//     back with a hint, and the task finishes;
//  4. an OpenRouter task whose stream carries only a daily-limit error stops with a plain
//     explanation; OpenRouter requests carry the attribution headers.
// Run under a display: xvfb-run -a npm run test:e2e:freecloud
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`FREECLOUD SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=FREECLOUD smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-free-'));
const OR_MODELS = { data: [
  { id: 'openai/gpt-oss-120b:free', context_length: 131072, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } },
  { id: 'meta-llama/llama-4-scout:free', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'paid/model', context_length: 200000, pricing: { prompt: '0.00001', completion: '0.00003' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }
] };
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
let groqPosts = 0;
const groqBodies = [];
const orHeaders = [];
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const server = http.createServer((req, res) => {
  const isOr = req.url.startsWith('/or/');
  if (isOr) orHeaders.push(req.headers);
  if (req.method !== 'POST') return json(res, 200, isOr ? OR_MODELS : { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072, active: true }, { id: 'whisper-large-v3', context_window: 448 }] });
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    if (isOr) {
      // A 200 whose stream only carries the daily free-model limit.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0' } } } })}\n\n`);
      return res.end();
    }
    groqPosts++;
    groqBodies.push(b);
    if (groqPosts === 1) return json(res, 429, { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 1.2s.', type: 'tokens', code: 'rate_limit_exceeded' } });
    if (groqPosts === 2) return json(res, 400, { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '<function=write_file>{"path": "notes.txt"</function>' } });
    const done = b.messages.filter((m) => m.role === 'tool').length;
    if (!done) return sse(res, call('g1', 'write_file', { path: 'notes.txt', content: 'hi' }));
    sse(res, say('Wrote notes.txt.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const root = `http://127.0.0.1:${server.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const setProvider = (p, base, model) => win.evaluate(({ p, base, model }) => {
  openSettings();
  const sel = document.querySelector('#s-provider');
  sel.value = p;
  sel.onchange({ target: sel });
  document.querySelector('#s-baseUrl').value = base;
  document.querySelector('#s-apiKey').value = 'test-key';
  if (model) document.querySelector('#s-model').value = model;
}, { p, base, model });

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  // 1. sign-up help
  await setProvider('groq', `${root}/groq`);
  const groqHelp = await win.evaluate(() => ({ text: document.querySelector('#s-key-help').textContent, link: document.querySelector('#s-key-help a')?.textContent, model: document.querySelector('#s-model').value, freeRow: !document.querySelector('#s-freeOnly-row').classList.contains('hidden') }));
  if (groqHelp.link !== 'Get a free Groq key ↗' || !/Free tier, no card needed/.test(groqHelp.text)) fail(`groq help: ${JSON.stringify(groqHelp)}`);
  if (groqHelp.model !== 'openai/gpt-oss-120b' || groqHelp.freeRow) fail(`groq preset: ${JSON.stringify(groqHelp)}`);
  await setProvider('openrouter', `${root}/or`);
  const orHelp = await win.evaluate(() => ({ link: document.querySelector('#s-key-help a')?.textContent, model: document.querySelector('#s-model').value, freeRow: !document.querySelector('#s-freeOnly-row').classList.contains('hidden') }));
  if (orHelp.link !== 'Get a free OpenRouter key ↗' || orHelp.model !== 'openrouter/free' || !orHelp.freeRow) fail(`openrouter help: ${JSON.stringify(orHelp)}`);

  // 2. the free-model list
  await win.evaluate(() => fetchModels());
  const list = await win.evaluate(() => ({ opts: [...document.querySelectorAll('#model-list option')].map((o) => [o.value, o.label]), out: document.querySelector('#s-test-result').textContent, vision: state.cloudCatalog?.['meta-llama/llama-4-scout:free']?.vision }));
  if (list.opts.some(([v]) => v === 'paid/model')) fail('free-only should hide paid models');
  if (!list.opts.some(([v, l]) => v === 'openai/gpt-oss-120b:free' && l === 'free · tools · 131K')) fail(`labels: ${JSON.stringify(list.opts)}`);
  if (!/2 free models, 2 can call tools/.test(list.out)) fail(`summary: ${list.out}`);
  if (list.vision !== true) fail('the catalog should remember which models see images');
  if (!orHeaders.some((h) => h['x-openrouter-title'] === 'Qwen Workspace' && /github\.com\/MrRobotto512/.test(h['http-referer'] || ''))) fail(`attribution headers: ${JSON.stringify(orHeaders.at(-1))}`);

  // 3. a Groq task through a rate limit and a refused tool call
  await setProvider('groq', `${root}/groq`, 'openai/gpt-oss-120b');
  await win.evaluate(() => {
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  });
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);
  const t0 = Date.now();
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'write notes.txt'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Wrote notes.txt.')), null, { timeout: 40_000 });
  const notes = await win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));
  if (!notes.some((n) => /Groq's free tier allows only a few thousand tokens a minute/.test(n))) fail(`no rate-limit explanation: ${notes.join(' | ')}`);
  if (!notes.some((n) => /rate limit — waiting \ds/.test(n))) fail(`no wait notice: ${notes.join(' | ')}`);
  if (Date.now() - t0 < 2500) fail('the per-minute limit was not waited out');
  if (!notes.some((n) => /refused a badly written tool call/.test(n))) fail(`no tool_use_failed notice: ${notes.join(' | ')}`);
  if (!JSON.stringify(groqBodies[2]?.messages || []).includes('<function=write_file>')) fail('the refused call was not shown back to the model');
  if (!fs.existsSync(path.join(ws, 'notes.txt'))) fail('the task did not finish its write');

  // 4. OpenRouter's daily limit, sent inside a 200 stream
  await setProvider('openrouter', `${root}/or`, 'openai/gpt-oss-120b:free');
  await win.evaluate(() => document.querySelector('#s-save').onclick());
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'hello'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => state.conv.display.some((d) => d.t === 'error'), null, { timeout: 20_000 });
  const err = await win.evaluate(() => state.conv.display.find((d) => d.t === 'error').text);
  if (!/50 requests a day/.test(err) || !/\$10 of OpenRouter credits/.test(err)) fail(`daily limit message: ${err}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', skillWriter: true, lessonsEnabled: true }); }).catch(() => {});
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
console.log('freecloud smoke ok: sign-up links and notes per provider, free-only list with capabilities, Groq per-minute limit waited out and a refused tool call retried, OpenRouter daily limit (sent mid-stream) explained, attribution headers sent');
