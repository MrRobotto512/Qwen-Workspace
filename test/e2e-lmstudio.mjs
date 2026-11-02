// LM Studio node smoke test (from LM Studio's API docs). A scripted LM Studio server — it answers
// Ollama's URLs with an error, as LM Studio does, and lists models on GET /api/v1/models:
//  1. added in Settings, Test detects it as LM Studio; the draft button's "Auto" picks a draft;
//  2. a task with model "qwen3:14b" is routed there as provider lmstudio, model "qwen/qwen3-14b",
//     ttl 300 (the node's 5m keep-alive), draft_model "qwen/qwen3-1.7b", usage in the stream;
//  3. the debug log records LM Studio's speed and how many draft tokens were kept.
// Run under a display: xvfb-run -a npm run test:e2e:lmstudio
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`LMSTUDIO SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=LMSTUDIO smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-lms-'));
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const MODELS = [
  { type: 'llm', key: 'qwen/qwen3-14b', params_string: '14B', size_bytes: 9e9, max_context_length: 40960, capabilities: { vision: false, trained_for_tool_use: true }, loaded_instances: [{ id: 'qwen/qwen3-14b' }] },
  { type: 'llm', key: 'qwen/qwen3-4b', params_string: '4B', size_bytes: 2.5e9, capabilities: { trained_for_tool_use: true }, loaded_instances: [] },
  { type: 'llm', key: 'qwen/qwen3-1.7b', params_string: '1.7B', size_bytes: 1.1e9, capabilities: { trained_for_tool_use: true }, loaded_instances: [] },
  { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', size_bytes: 8e7 }
];
const chats = [];
const lms = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') return json(res, { models: MODELS });
  if (req.method === 'GET' && req.url === '/v1/models') return json(res, { data: MODELS.map((m) => ({ id: m.key })) });
  if (req.method === 'GET') return json(res, { error: `Unexpected endpoint or method. (GET ${req.url})` }); // LM Studio's answer to /api/tags, /api/version
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url !== '/v1/chat/completions') return json(res, { error: 'Unexpected endpoint' });
    const b = JSON.parse(body);
    chats.push(b);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!b.messages.some((m) => m.role === 'tool')) {
      w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'l1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'from LM Studio\n' }) } }] }, finish_reason: null }] });
      w({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      w({ choices: [{ delta: { content: 'Wrote it on LM Studio.' }, finish_reason: null }] });
      w({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 6 }, stats: { tokens_per_second: 42.5, time_to_first_token: 0.31, draft_model: 'qwen/qwen3-1.7b', total_draft_tokens_count: 100, accepted_draft_tokens_count: 62 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => lms.listen(0, '127.0.0.1', r));
const lmsBase = `http://127.0.0.1:${lms.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  // 1. add the node in Settings, Test detects LM Studio, Auto draft from the menu
  await win.evaluate((u) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = 'http://127.0.0.1:9'; // This PC: off below
    document.querySelector('#s-model').value = 'qwen3:14b';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-subagents').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: false, highPerf: false }));
    document.querySelector('#node-new-name').value = 'Mac (LM Studio)';
    document.querySelector('#node-new-url').value = u;
    document.querySelector('#node-add-btn').onclick();
  }, lmsBase);
  await win.evaluate(() => [...[...document.querySelectorAll('#nodes-list .mcp-item')].find((r) => r.textContent.includes('Mac (LM Studio)')).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test').click());
  await win.waitForFunction(() => [...document.querySelectorAll('#nodes-list .mcp-item')].some((r) => r.textContent.includes('Mac (LM Studio)') && r.textContent.includes('LM Studio ·')), null, { timeout: 10_000 })
    .catch(() => fail('Test did not detect the node as LM Studio'));
  await win.evaluate(() => {
    const r = [...document.querySelectorAll('#nodes-list .mcp-item')].find((x) => x.textContent.includes('Mac (LM Studio)'));
    [...r.querySelectorAll('button')].find((b) => /Speculative decoding/.test(b.title)).click();
  });
  await win.waitForFunction(() => [...document.querySelectorAll('#ctx-menu .mi')].some((m) => m.textContent.startsWith('Auto')), null, { timeout: 10_000 })
    .catch(() => fail('the draft-model menu did not open'));
  const autoDetail = await win.evaluate(() => [...document.querySelectorAll('#ctx-menu .mi')].find((m) => m.textContent.startsWith('Auto'))?.title || '');
  if (autoDetail !== 'now: qwen/qwen3-1.7b') fail(`Auto should suggest qwen/qwen3-1.7b, said "${autoDetail}"`);
  await win.evaluate(() => [...document.querySelectorAll('#ctx-menu .mi')].find((m) => m.textContent.startsWith('Auto')).click());
  await win.evaluate(() => document.querySelector('#s-save').onclick());
  const saved = await win.evaluate(() => state.settings.ollamaNodes.find((n) => n.name === 'Mac (LM Studio)'));
  if (saved?.kind !== 'lmstudio' || saved?.draftModel !== 'auto') fail(`saved node: ${JSON.stringify(saved)}`);

  // 2. a task routed to the LM Studio node
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'write hello.txt'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Wrote it on LM Studio.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished on the LM Studio node'));
  const first = chats[0];
  if (!first) fail('LM Studio never got a chat request');
  else {
    if (first.model !== 'qwen/qwen3-14b') fail(`model sent: ${first.model}`);
    if (first.ttl !== 300) fail(`ttl sent: ${first.ttl}`);
    if (first.draft_model !== 'qwen/qwen3-1.7b') fail(`draft_model sent: ${first.draft_model}`);
    if (!first.stream_options?.include_usage) fail('usage was not requested in the stream');
    if (!first.tools?.some((t) => t.function.name === 'write_file')) fail('tools were not sent');
  }
  if (fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') !== 'from LM Studio\n') fail('the tool call did not run');

  // 3. LM Studio's stats in the debug log
  const resp = await win.evaluate(() => state.conv.log.filter((e) => e.kind === 'response').at(-1));
  if (resp?.genTokPerSec !== 42.5 || resp?.draftModel !== 'qwen/qwen3-1.7b' || resp?.draftAccepted !== 62 || resp?.promptMs !== 310) fail(`debug log stats: ${JSON.stringify(resp)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ ollamaNodes: [], provider: 'custom', skillWriter: true, subagents: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  lms.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('lmstudio smoke ok: node detected as LM Studio, Auto draft = qwen/qwen3-1.7b, task routed with model key + ttl 300 + draft_model, stats (42.5 tok/s, 62% drafts kept) logged');
