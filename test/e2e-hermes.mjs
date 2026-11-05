// The five ports from Hermes Agent (v0.54), in the real app:
//  1. a tool call whose JSON has a raw line break inside a string is repaired and runs;
//  2. write_file on an existing file the task has not read is refused; after read_file it runs;
//  3. an edit that breaks app.js's syntax, and a write of broken JSON, say so and count as failed;
//  4. a 3,000-line command output keeps its start and its end, and the full text is saved in
//     .qwen/output/ (with a .gitignore); old results are shortened to one line before summarizing;
//  5. a request to a cloud provider has secrets replaced by placeholders, and the placeholder
//     turns back into the real value when a file is written.
// Run under a display: xvfb-run -a npm run test:e2e:hermes
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`HERMES SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=HERMES smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-hermes-'));
fs.writeFileSync(path.join(ws, 'seed.js'), '// written by the user\nconst keep = 1;\n');
const SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789';

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
// `raw` is the arguments text exactly as the model wrote it.
const callRaw = (id, name, raw) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const call = (id, name, args) => callRaw(id, name, JSON.stringify(args));
const lastTool = (b, id) => b?.messages?.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content || '';
const longCmd = `node -e "for (let i = 1; i <= 3000; i++) console.log('line ' + i); console.log('FINAL ERROR: 2 tests failed')"`;
const SCRIPT = [
  () => callRaw('w1', 'write_file', '{"path": "app.js", "content": "let a = 1;\nconsole.log(a);\n"}'),
  () => call('w2', 'write_file', { path: 'seed.js', content: 'const replaced = true;\n' }),
  () => call('r1', 'read_file', { path: 'seed.js' }),
  () => call('w3', 'write_file', { path: 'seed.js', content: '// written by the user\nconst keep = 2;\n' }),
  () => call('e1', 'edit_file', { path: 'app.js', old_text: 'let a = 1;', new_text: 'let a = ;' }),
  () => call('w4', 'write_file', { path: 'data.json', content: '{\n  "a": 1,\n}\n' }),
  () => call('w5', 'write_file', { path: 'calc.py', content: 'def add(a, b:\n    return a + b\n' }),
  () => call('c1', 'run_command', { command: longCmd, timeout_seconds: 60 }),
  () => [{ choices: [{ delta: { content: 'Checked all five.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
];
let turn = 0;
const bodies = [];
const cloudBodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"hermes-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    if (b.model === 'cloud-mock') {
      cloudBodies.push(body);
      return sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    }
    bodies.push(b);
    sse(res, (SCRIPT[turn++] || SCRIPT[8])());
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

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  saved = await win.evaluate(() => api.getSettings());
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'hermes-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-checksGate').checked = false;
    document.querySelector('#s-readBeforeWrite').checked = true;
    document.querySelector('#s-syntaxCheck').checked = true;
    document.querySelector('#s-redactSecrets').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async () => { state.settings = await api.setSettings({ contextLength: 32768, escalation: { failStreak: false } }); });
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'exercise the file tools'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Checked all five.')), null, { timeout: 120_000 })
    .catch(() => fail(`the task never finished (${bodies.length} requests)`));
  const tr = (id) => bodies.map((b) => lastTool(b, id)).find(Boolean) || '';

  // 1. repaired arguments
  if (!/^Created app\.js/.test(tr('w1'))) fail(`the call with a raw line break did not run: ${tr('w1').slice(0, 200)}`);
  if (fs.readFileSync(path.join(ws, 'app.js'), 'utf8') !== 'let a = ;\nconsole.log(a);\n') fail(`app.js: ${JSON.stringify(fs.readFileSync(path.join(ws, 'app.js'), 'utf8'))}`);
  const replayed = bodies[1]?.messages?.find((m) => m.tool_calls?.[0]?.id === 'w1')?.tool_calls[0].function.arguments || '';
  try {
    JSON.parse(replayed);
  } catch {
    fail(`the repaired arguments were not stored as valid JSON: ${replayed.slice(0, 120)}`);
  }
  // 2. read before overwrite
  if (!/^Not written: seed\.js already exists \(2 lines\) and you have not read it in this task/.test(tr('w2'))) fail(`the unread overwrite was not refused: ${tr('w2').slice(0, 200)}`);
  if (!/^Edited seed\.js/.test(tr('w3'))) fail(`the overwrite after reading failed: ${tr('w3').slice(0, 200)}`);
  if (!fs.readFileSync(path.join(ws, 'seed.js'), 'utf8').includes('keep = 2')) fail('seed.js was not rewritten after the read');
  // 3. syntax check
  // The broken line is quoted, and a 3-line file left broken by an edit is asked for whole.
  if (!/Syntax check: app\.js line 1: SyntaxError: Unexpected token ';'\. Line 1 is: let a = ; This change introduced it — fix it now.*app\.js is small \(2 lines\): rewrite it whole with write_file[^]*It is now:\nlet a = ;\nconsole\.log\(a\);/.test(tr('e1'))) fail(`no syntax error for the broken edit: ${tr('e1').slice(0, 300)}`);
  if (!/Syntax check: data\.json line \d+:/.test(tr('w4'))) fail(`no syntax error for broken JSON: ${tr('w4').slice(0, 300)}`);
  if (!/Syntax check: calc\.py line \d+: SyntaxError/.test(tr('w5'))) fail(`no syntax error for broken Python: ${tr('w5').slice(0, 300)}`);
  if (/Syntax check/.test(tr('w1')) || /Syntax check/.test(tr('w3'))) fail('a clean write reported a syntax error');
  // 4. long output
  const c1 = tr('c1');
  if (!/^Exit code: 0\nline 1\n/.test(c1)) fail(`the start of the long output is missing: ${c1.slice(0, 100)}`);
  if (!/FINAL ERROR: 2 tests failed/.test(c1)) fail('the end of the long output was cut off');
  if (!/cut from the middle/.test(c1)) fail('no cut marker');
  const saved1 = /saved in (\.qwen\/output\/[^:]+\.txt)/.exec(c1)?.[1];
  if (!saved1) fail(`no saved-output note: ${c1.slice(-400)}`);
  else {
    const full = fs.readFileSync(path.join(ws, saved1), 'utf8');
    if (!full.includes('line 1500\n') || !full.includes('FINAL ERROR')) fail('the saved output is not the full text');
    if (fs.readFileSync(path.join(ws, '.qwen/output/.gitignore'), 'utf8').trim() !== '*') fail('.qwen/output has no .gitignore');
  }
  // 4b. pruning before compaction (run directly on a conversation)
  const pruned = await win.evaluate(() => {
    const c = createConv();
    const big = 'Exit code: 1\n' + 'x'.repeat(5000);
    c.history = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 6; i++) {
      c.history.push({ role: 'assistant', content: '', tool_calls: [{ id: `p${i}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `npm test ${i}` }) } }] });
      c.history.push({ role: 'tool', tool_call_id: `p${i}`, content: big + i });
    }
    const changed = pruneOldResults(c, 8192);
    return { changed, first: c.history[2].content, last: c.history[12].content.length, n: c.history.length };
  });
  if (!pruned.changed || !/^\[Earlier result of run_command npm test 0: exit 1/.test(pruned.first) || pruned.last < 5000 || pruned.n !== 13) fail(`pruning: ${JSON.stringify(pruned).slice(0, 300)}`);
  // 5. secrets hidden from a cloud provider, restored for writes
  const red = await win.evaluate(async ({ b, secret }) => api.chatStream(`red${Date.now()}`, { override: { provider: 'openrouter', baseUrl: b, apiKey: 'mock-key-0000', model: 'cloud-mock' }, messages: [{ role: 'user', content: `config has OPENAI_API_KEY=${secret} in it` }] }), { b: base, secret: SECRET });
  const sent = cloudBodies.at(-1) || '';
  if (!sent) fail(`the cloud request never arrived: ${JSON.stringify(red).slice(0, 200)}`);
  if (sent.includes(SECRET)) fail('the secret reached the cloud model');
  if (!/«redacted secret #\d+ \(sk-…\)»/.test(sent)) fail(`no placeholder in the cloud request: ${sent.slice(0, 300)}`);
  if (red.redacted !== 1) fail(`the result should count 1 hidden secret: ${red.redacted}`);
  const n = /«redacted secret #(\d+)/.exec(sent)?.[1];
  const back = await win.evaluate((t) => api.restoreSecrets(t), `OPENAI_API_KEY=«redacted secret #${n} (sk-…)»`);
  if (back.text !== `OPENAI_API_KEY=${SECRET}`) fail(`the placeholder did not turn back into the secret: ${JSON.stringify(back)}`);
  const local = bodies.flatMap((b) => b.messages || []).some((m) => String(m.content || '').includes('«redacted'));
  if (local) fail('a request to this PC was redacted');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  if (saved) await win.evaluate(async (s) => { state.settings = await api.setSettings(s); }, saved).catch(() => {});
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
console.log('hermes smoke ok: broken JSON repaired, unread overwrite refused then allowed, syntax errors caught, long output kept head+tail and saved, old results pruned, secrets hidden from the cloud and restored for writes');
