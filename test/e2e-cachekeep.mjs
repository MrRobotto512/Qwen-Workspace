// Prompt-cache keeping smoke test (v0.64, ideas from Strata). A scripted Ollama 0.24 node
// ("Alien", keep-alive 5m) serves a qwen3-8b-shaped model whose loaded size shows a full-size
// (f16) KV cache, and reports how much of each prompt came from its cache:
//  1. a two-step task runs there: the requests keep the model 30m (not 5m) and send the same
//     tool list on both steps, although the semantic index becomes ready between them;
//  2. after the task the node gets its own 5m back, at the task's window (no reload);
//  3. the debug log has the reused-prompt figure; the KV-cache advice offers the setx command
//     and the node is recorded as f16; Settings shows the Ollama-version advice for 0.24.
// Run under a display: xvfb-run -a npm run test:e2e:cachekeep
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CACHEKEEP SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CACHEKEEP smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-ck-'));
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const GiB = 1024 ** 3;
const FILE = 5.2 * GiB;
const PER = 36 * 8 * 256 * 2; // f16 KV bytes per token
const INFO = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128 };
const chats = [];
const generates = [];
const node = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.24.0' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'kv:8b', size: FILE }] });
  if (req.method === 'GET' && req.url === '/api/ps') {
    const ctx = chats.at(-1)?.options?.num_ctx || 32768;
    const size = FILE + ctx * PER + 0.5 * GiB;
    return json(res, { models: [{ name: 'kv:8b', size, size_vram: size, context_length: ctx }] });
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    if (req.url === '/api/show') return json(res, { model_info: INFO });
    if (req.url === '/api/generate') {
      generates.push(b);
      return json(res, { model: b.model, done: true, done_reason: 'load' });
    }
    if (req.url !== '/api/chat') return json(res, {});
    chats.push(b);
    const n = chats.length;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (n === 1) res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.txt', content: 'one\n' } } }] }, done: false }) + '\n');
      else res.write(JSON.stringify({ message: { role: 'assistant', content: 'Wrote a.txt.' }, done: false }) + '\n');
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 1000 * n, prompt_eval_cached_count: n === 1 ? 0 : 950, eval_count: 5 }) + '\n');
      res.end();
    }, n === 1 ? 1500 : 10);
  });
});
await new Promise((r) => node.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${node.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

let saved = null;
try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  saved = await win.evaluate(() => JSON.parse(JSON.stringify({ fitToGpuAuto: state.settings.fitToGpuAuto, ollamaNodes: state.settings.ollamaNodes || [], contextLength: state.settings.contextLength })));
  await win.evaluate((u) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = 'http://127.0.0.1:9'; // This PC: off below
    document.querySelector('#s-model').value = 'kv:8b';
    document.querySelector('#s-contextLength').value = '32768';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-subagents').checked = false;
    document.querySelector('#s-testBeforeDone').checked = false;
    document.querySelector('#s-fitToGpuAuto').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: false, highPerf: false }));
    document.querySelector('#node-new-name').value = 'Alien';
    document.querySelector('#node-new-url').value = u;
    document.querySelector('#node-new-keep').value = '5m';
    document.querySelector('#node-add-btn').onclick();
  }, base);
  await win.waitForFunction(() => settingsNodes.some((n) => n.name === 'Alien'), null, { timeout: 10_000 }).catch(() => fail('the node was not added'));
  await win.evaluate(async () => { await document.querySelector('#s-save').onclick(); state.semReady = false; state.settings = await api.setSettings({ kvAdviceDismissed: {}, nodeKvType: {} }); });

  // 1. the task
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); state.semReady = false; }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'write a.txt'; document.querySelector('#btn-send').onclick(); });
  // While step 1 is answering, the semantic index finishes.
  for (let i = 0; i < 50 && !chats.length; i++) await new Promise((r) => setTimeout(r, 100));
  await win.evaluate(() => { state.semReady = true; });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Wrote a.txt.')), null, { timeout: 30_000 })
    .catch(() => fail('the task did not finish'));
  if (chats.length < 2) fail(`expected 2 chat requests, got ${chats.length}`);
  else {
    if (chats[0].keep_alive !== '30m' || chats[1].keep_alive !== '30m') fail(`keep_alive during the task: ${chats[0].keep_alive}, ${chats[1].keep_alive}`);
    const names = (b) => (b.tools || []).map((t) => t.function.name).join(',');
    if (names(chats[0]) !== names(chats[1])) fail(`the tool list changed between steps:\n${names(chats[0])}\n${names(chats[1])}`);
    if (names(chats[1]).includes('semantic_search')) fail('semantic_search was added mid-task');
    if (!names(chats[0]).includes('tool_search')) fail('tool_search should stay in the list');
  }

  // 2. the node's own keep-alive back, at the task's window
  for (let i = 0; i < 50 && !generates.some((g) => g.keep_alive === '5m'); i++) await new Promise((r) => setTimeout(r, 100));
  const back = generates.find((g) => g.keep_alive === '5m');
  if (!back) fail(`the node did not get its keep-alive back: ${JSON.stringify(generates)}`);
  else if (back.options?.num_ctx !== 32768) fail(`the keep-alive request would reload the model: ${JSON.stringify(back)}`);

  // 3. reuse figure, KV advice, version advice
  const resp = await win.evaluate(() => state.conv.log.filter((e) => e.kind === 'response').map((e) => e.cachedTokens));
  if (resp.at(-1) !== 950) fail(`cached tokens in the debug log: ${JSON.stringify(resp)}`);
  const report = await win.evaluate(() => DebugLog.render({ conv: state.conv, settings: state.settings, appInfo: state.appInfo, nodeHealth: state.nodeHealth, mcp: [], systemPrompt: '' }));
  if (report && !/950 of the prompt reused/.test(report)) fail('the debug report does not show the reused figure');
  await win.waitForFunction((u) => state.settings.nodeKvType?.[u] === 'f16', base, { timeout: 10_000 })
    .catch(async () => fail(`KV type not recorded: ${JSON.stringify(await win.evaluate(() => state.settings.nodeKvType))}`));
  await win.waitForFunction(() => /setx OLLAMA_KV_CACHE_TYPE q8_0/.test(document.body.textContent), null, { timeout: 10_000 })
    .catch(() => fail('the KV-cache advice was not shown'));
  const notices = await win.evaluate(() => state.conv.log.filter((e) => e.kind === 'notice').map((e) => e.text));
  if (notices.some((t) => /prompt start .* changed/.test(t))) fail(`the prompt start changed mid-task: ${notices.join(' | ')}`);
  await win.evaluate(async () => { await refreshNodeHealth(true); openSettings(); });
  await win.waitForFunction(() => /older than 0\.30\.0/.test(document.querySelector('#nodes-list')?.textContent || ''), null, { timeout: 10_000 })
    .catch(async () => fail(`no Ollama-version advice: ${await win.evaluate(() => document.querySelector('#nodes-list')?.textContent)}`));
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async (s) => {
    state.settings = await api.setSettings({ ollamaNodes: s?.ollamaNodes || [], provider: 'custom', fitToGpuAuto: s?.fitToGpuAuto !== false, contextLength: s?.contextLength || 32768, skillWriter: true, subagents: true, testBeforeDone: true, nodeKvType: {}, kvAdviceDismissed: {} });
  }, saved).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  node.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('cachekeep smoke ok: model kept 30m during the task and 5m given back at the same window, tool list unchanged across steps, 950 tokens reused logged, f16 KV detected with the setx advice, Ollama 0.24 flagged');
