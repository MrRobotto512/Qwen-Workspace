// Past-chat search + personal memory smoke test (ideas from Hermes Agent).
//  1. A past conversation in ANOTHER project holds a PyInstaller fix; the scripted model calls
//     search_history and the result carries that fix back.
//  2. The model calls remember; an approval card appears even in Full auto (personal memory is
//     outside the project); approved, the fact lands in USER.md.
//  3. A brand-new conversation's system prompt carries the fact in <user_memory>.
// Run under a display: xvfb-run -a npm run test:e2e:memory
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`MEMORY SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=MEMORY smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-mem-'));
const FACT = 'Ryan builds Windows desktop apps with Python and PySide6';
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

let turns = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"mem-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const n = ++turns;
    bodies.push(body);
    if (n === 1) return sse(res, call('m1', 'search_history', { query: 'pyinstaller onefile spec' }));
    if (n === 2) return sse(res, call('m2', 'remember', { fact: FACT }));
    return sse(res, [{ choices: [{ delta: { content: 'Found the old fix and noted your setup.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'mem-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);

  // A past conversation in another project, saved through the real store.
  await win.evaluate(async () => {
    await api.userMemorySet('');
    await api.convSave({
      id: 'cpastfixture01', title: 'Package the calculator', workspace: 'E:\\Old Project', createdAt: 1, updatedAt: Date.now() - 86400000,
      status: 'done', model: 'x', mode: 'agent', history: [], changes: [], notes: [], spend: {}, log: [], todos: [],
      display: [{ t: 'user', text: 'make calc.exe with pyinstaller' }, { t: 'assistant', content: 'The spec had onefile=True, which is not an EXE kwarg; removed it and the one-file build works.' }]
    });
  });
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  await win.evaluate(() => {
    window.__cards = 0;
    window.__approver = setInterval(() => {
      for (const bar of document.querySelectorAll('.step-approval')) {
        const btn = [...bar.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run');
        if (btn && !bar.dataset.seen) { bar.dataset.seen = '1'; window.__cards++; btn.click(); }
      }
    }, 100);
    document.querySelector('#prompt').value = 'package this like we did before, and note how I work';
    document.querySelector('#btn-send').onclick();
  });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Found the old fix')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished'));

  if (!bodies[1]?.includes('onefile=True')) fail('search_history did not bring the old PyInstaller fix back to the model');
  if (!bodies[1]?.includes('cpastfixture01')) fail('the search result is missing the conversation id to read it by');
  const st = await win.evaluate(async () => {
    clearInterval(window.__approver);
    const mem = await api.userMemoryGet();
    newChat();
    state.conv.sysPrompt = null;
    return { cards: window.__cards, mem, sys: systemPrompt(state.conv) };
  });
  if (st.cards !== 1) fail(`remember must ask even in Full auto: expected 1 approval card, saw ${st.cards}`);
  if (!st.mem.includes(FACT)) fail(`the fact never reached USER.md: ${JSON.stringify(st.mem)}`);
  if (!/<user_memory>[\s\S]*PySide6/.test(st.sys)) fail('a new conversation does not carry the personal memory');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { await api.userMemorySet(''); await api.convDelete?.('cpastfixture01'); }).catch(() => {});
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
console.log('memory smoke ok: search_history found the old fix in another project, remember asked in Full auto and saved to USER.md, a new conversation carries it');
