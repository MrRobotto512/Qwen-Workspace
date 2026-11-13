// OpenAI-compatible node smoke test (v0.63, Strata). A scripted Strata server — it answers
// Ollama's and LM Studio's URLs with 404, names itself on GET /health and lists its one model on
// GET /v1/models, and it wants an API key:
//  1. added in Settings without the key: Test says the key is needed and shows the key box;
//  2. QWS started again with STRATA_API_KEY in its environment: Test detects "Strata · context
//     64K", the Strata guide lists the models that fit 48 GB with their launch commands;
//  3. a task with everyday model "qwen3:8b" runs on the node as provider openai-local with the
//     server's own model, the key from the environment (never in settings), and the context
//     meter uses the server's 64K window.
// Run under a display: xvfb-run -a npm run test:e2e:strata
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`STRATA SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=STRATA smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const KEY = 'strata-test-key-7f3a';
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-strata-'));
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const chats = [];
const strata = http.createServer((req, res) => {
  const authed = req.headers.authorization === `Bearer ${KEY}`;
  if (req.method === 'GET' && req.url === '/health') return json(res, { status: 'ok', max_context: 65536, model: 'qwen3.8-flash-next', images: false, api_key: true, loaded: true, service: 'strata' });
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/props')) {
    if (!authed) return json(res, { error: { message: 'missing or wrong API key' } }, 401);
    if (req.url === '/props') return json(res, { model_alias: 'qwen3.8-flash-next' });
    return json(res, { object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', status: { value: 'loaded' }, meta: { n_ctx: 65536 }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  }
  if (req.method === 'GET') return json(res, { error: { message: 'not found' } }, 404);
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url !== '/v1/chat/completions') return json(res, { error: 'not found' }, 404);
    if (!authed) return json(res, { error: { message: 'missing or wrong API key' } }, 401);
    const b = JSON.parse(body);
    chats.push({ body: b, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!b.messages.some((m) => m.role === 'tool')) {
      w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 's1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'from Strata\n' }) } }] }, finish_reason: null }] });
      w({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      w({ choices: [{ delta: { content: 'Wrote it on Strata.' }, finish_reason: null }] });
      w({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 5 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => strata.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${strata.address().port}`;

const launch = async (env) => {
  const full = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', ...env };
  if (!full.STRATA_API_KEY) delete full.STRATA_API_KEY;
  const a = await electron.launch({ args: ['.'], env: full });
  const w = await a.firstWindow();
  w.on('pageerror', (e) => errors.push(String(e)));
  w.on('dialog', (d) => d.accept().catch(() => {}));
  await w.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  return { app: a, win: w };
};
const close = async (app) => {
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
};
const NODE = 'Alien (Strata)';
const rowText = () => win.evaluate((n) => [...document.querySelectorAll('#nodes-list .mcp-item')].find((r) => r.textContent.includes(n))?.textContent || '', NODE);
const clickTest = () => win.evaluate((n) => [...[...document.querySelectorAll('#nodes-list .mcp-item')].find((r) => r.textContent.includes(n)).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test').click(), NODE);
const waitRow = (re, ms = 10_000) => win.waitForFunction(([n, src]) => new RegExp(src).test([...document.querySelectorAll('#nodes-list .mcp-item')].find((r) => r.textContent.includes(n))?.textContent || ''), [NODE, re.source], { timeout: ms });
const errors = [];

let app;
let win;
try {
  // 1. no key in the environment: Test says so and shows the key box
  ({ app, win } = await launch({ STRATA_API_KEY: '' }));
  await win.evaluate((u) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = 'http://127.0.0.1:9'; // This PC: off below
    document.querySelector('#s-model').value = 'qwen3:8b';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-subagents').checked = false;
    if (document.querySelector('#s-testBeforeDone')) document.querySelector('#s-testBeforeDone').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: false, highPerf: false }));
    document.querySelector('#node-new-name').value = 'Alien (Strata)';
    document.querySelector('#node-new-url').value = u;
    document.querySelector('#node-add-btn').onclick();
  }, base);
  await clickTest();
  await win.waitForFunction((n) => !![...document.querySelectorAll('#nodes-list .mcp-item')].find((r) => r.textContent.includes(n))?.querySelector('input[placeholder^="Key variable"]'), NODE, { timeout: 10_000 })
    .catch(() => fail('a server that wants a key did not get the key box'));
  await clickTest();
  await waitRow(/STRATA_API_KEY/).catch(async () => fail(`Test did not name the key variable: ${await rowText()}`));
  await win.evaluate(() => document.querySelector('#s-save').onclick());
  const saved = await win.evaluate(() => state.settings.ollamaNodes.find((n) => n.name === 'Alien (Strata)'));
  if (saved?.kind !== 'openai') fail(`saved node: ${JSON.stringify(saved)}`);
  await close(app);

  // 2. with the key in the environment: detected as Strata; the guide fits 48 GB
  ({ app, win } = await launch({ STRATA_API_KEY: KEY }));
  await win.evaluate(() => openSettings());
  await clickTest();
  await waitRow(/Strata · .*context 64K/).catch(async () => fail(`Test did not detect Strata: ${await rowText()}`));
  await win.evaluate(() => {
    document.querySelector('#strata-guide').open = true;
    const ram = document.querySelector('#strata-ram');
    const vram = document.querySelector('#strata-vram');
    ram.value = '48';
    vram.value = '23.5';
    ram.dispatchEvent(new Event('input'));
  });
  await win.waitForFunction(() => /IQ2_XS — best fit/.test(document.querySelector('#strata-fits')?.textContent || ''), null, { timeout: 5_000 })
    .catch(async () => fail(`the Strata guide for 48 GB: ${await win.evaluate(() => document.querySelector('#strata-fits')?.textContent)}`));
  const cmds = await win.evaluate(() => [...document.querySelectorAll('#strata-fits .strata-cmd')].map((c) => c.textContent));
  if (cmds[0] !== 'strata launch --family qwen --model IQ2_XS --access lan --port 8080') fail(`first command: ${cmds[0]}`);
  if (cmds.some((c) => /IQ3/.test(c))) fail('the guide offered an IQ3 size that does not fit 48 GB');
  await win.evaluate(() => document.querySelector('#s-save').onclick());

  // 3. a task runs on the node with the server's model and the key from the environment
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'write hello.txt'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Wrote it on Strata.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished on the Strata node'));
  const first = chats[0];
  if (!first) fail('Strata never got a chat request');
  else {
    if (first.body.model !== 'qwen3.8-flash-next') fail(`model sent: ${first.body.model}`);
    if (first.auth !== `Bearer ${KEY}`) fail('the key from the environment was not sent');
    if (!first.body.stream_options?.include_usage) fail('usage was not requested in the stream');
    if (!first.body.tools?.some((t) => t.function.name === 'write_file')) fail('tools were not sent');
    if ('ttl' in first.body || 'draft_model' in first.body || 'keep_alive' in first.body) fail(`LM Studio/Ollama fields were sent: ${Object.keys(first.body).join(', ')}`);
  }
  if (!fs.existsSync(path.join(ws, 'hello.txt')) || fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') !== 'from Strata\n') fail('the tool call did not run');
  const req = await win.evaluate(() => state.conv.log.filter((e) => e.kind === 'request').at(-1));
  if (req?.provider !== 'openai-local') fail(`debug log provider: ${req?.provider}`);
  const usage = await win.evaluate(() => state.conv.usage);
  if (usage?.contextLength !== 65536) fail(`context window from the server: ${JSON.stringify(usage)}`);
  const settingsFile = await win.evaluate(() => JSON.stringify(state.settings));
  if (settingsFile.includes(KEY)) fail('the API key ended up in settings');
  const spent = await win.evaluate(() => JSON.stringify(state.settings.spend || {}));
  if (/flash-next/.test(spent)) fail(`a local node was billed: ${spent}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  if (win) await win.evaluate(async () => { state.settings = await api.setSettings({ ollamaNodes: [], provider: 'custom', skillWriter: true, subagents: true, testBeforeDone: true }); }).catch(() => {});
  if (app) await close(app);
  strata.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('strata smoke ok: key asked for without it (never stored), detected as Strata with a 64K context, guide fits IQ2_XS on 48 GB, task ran on the server model with the env key and its window');
