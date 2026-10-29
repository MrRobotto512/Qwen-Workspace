// Regression test for the conversation-bricking bug: a small model emits a text tool call
// whose arguments are a JSON *array* (ask_user([{…}])). Ollama's native API rejects any
// non-object arguments, and since history replays every call, one bad call used to 400
// every later request. The app must normalize the arguments so the next turn still works.
// Run under a display: xvfb-run -a npm run test:e2e:toolargs
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`TOOLARGS SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-args-'));
const MODEL = 'fake-model:latest';
let chats = 0;
let badArgs = null;

const ndjson = (res, lines) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const l of lines) res.write(JSON.stringify(l) + '\n');
  res.end();
};

// A scripted Ollama that enforces the real one's rule: tool_call arguments must be objects.
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"version":"0.5.0"}');
  }
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: MODEL }] }));
  }
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    chats++;
    const parsed = JSON.parse(body);
    for (const m of parsed.messages || []) {
      for (const tc of m.tool_calls || []) {
        const a = tc.function?.arguments;
        if (!a || typeof a !== 'object' || Array.isArray(a)) badArgs = JSON.stringify(a);
      }
    }
    if (badArgs) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Value looks like object, but can\'t find closing \'}\' symbol"}');
    }
    if (chats === 1) {
      // The 7B's classic: a *text* tool call with array-shaped arguments.
      return ndjson(res, [
        { message: { role: 'assistant', content: 'I will ask the user.\n<tool_call>\n{"name": "ask_user", "arguments": [{"question": "Which settings should change?"}]}\n</tool_call>' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 40 }
      ]);
    }
    return ndjson(res, [
      { message: { role: 'assistant', content: 'Recovered and finished.' } },
      { done: true, done_reason: 'stop', prompt_eval_count: 50 }
    ]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(([b, model]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-model').value = model;
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-heavy-enabled').checked = false;
    return document.querySelector('#s-save').onclick();
  }, [base, MODEL]);
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'diagnose it';
    document.querySelector('#btn-send').onclick();
  });

  // The malformed ask_user errors gracefully; what matters is that the NEXT request is
  // accepted (arguments normalized to an object) and the task finishes.
  await win.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Recovered and finished.')),
    null,
    { timeout: 30_000 }
  ).catch(() => fail(`the follow-up turn never completed — badArgs=${badArgs}, chats=${chats}`));
  if (badArgs) fail(`non-object tool arguments reached the Ollama API: ${badArgs}`);
  if (chats < 2) fail(`expected at least 2 chat requests, saw ${chats}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`toolargs smoke ok: array-shaped text tool call normalized, conversation survived (${chats} chats, no 400)`);
