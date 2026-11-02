// Parallel subagents smoke test (an idea from Hermes Agent's delegate_task), on two scripted
// Ollama nodes:
//  1. The parent (on This PC = node A) calls delegate_tasks with two subtasks.
//  2. One child runs on node A, the other on node B, AT THE SAME TIME (both children's first
//     requests arrive before either is answered); children get the subagent instructions and no
//     ask_user tool.
//  3. The parent's next request carries only the two summaries — not the children's tool chatter —
//     and both files land, in the parent's change list too.
// Run under a display: xvfb-run -a npm run test:e2e:subagents
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`SUBAGENTS SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=SUBAGENTS smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-sub-'));
const MODEL = 'fake-model:latest';
const SECRET_A = 'alpha-content-9137';
const SECRET_B = 'beta-content-5521';

const ndjson = (res, lines) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const l of lines) res.write(JSON.stringify(l) + '\n');
  res.end();
};
const done = { done: true, done_reason: 'stop', prompt_eval_count: 50 };
const say = (t) => [{ message: { role: 'assistant', content: t }, done: false }, done];
const tool = (name, args) => [{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }, done];

// Gate: the first request of each child is held until both have arrived, which only happens
// if the two children really run in parallel (a sequential runner would deadlock → timeout).
const firstSeen = { a: null, b: null };
let release;
const bothArrived = new Promise((r) => (release = r));
const log = []; // { node, who, body }

function chatHandler(nodeName) {
  return async (res, body) => {
    const b = JSON.parse(body);
    const sys = String(b.messages?.[0]?.content || '');
    const user = b.messages.find((m) => m.role === 'user')?.content || '';
    const toolsSent = (b.tools || []).map((t) => t.function.name);
    const toolResults = b.messages.filter((m) => m.role === 'tool').length;
    if (sys.includes('<subagent>')) {
      const which = /a\.txt/.test(user) ? 'a' : 'b';
      log.push({ node: nodeName, who: `child-${which}`, toolsSent });
      if (!toolResults) {
        firstSeen[which] = nodeName;
        if (firstSeen.a && firstSeen.b) release();
        await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 8000))]);
        return ndjson(res, tool('write_file', { path: `${which}.txt`, content: which === 'a' ? SECRET_A : SECRET_B }));
      }
      return ndjson(res, say(`Wrote ${which}.txt with the requested line.`));
    }
    log.push({ node: nodeName, who: 'parent', body: b, toolsSent });
    if (!toolResults) {
      return ndjson(res, tool('delegate_tasks', { tasks: [
        { task: 'Create a.txt with the alpha line.', context: 'Only touch a.txt.' },
        { task: 'Create b.txt with the beta line.', context: 'Only touch b.txt.' }
      ] }));
    }
    return ndjson(res, say('Both files are in place.'));
  };
}

function makeNode(name) {
  const handler = chatHandler(name);
  const server = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/api/version') return json({ version: '0.40.13' });
    if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: MODEL }] });
    if (req.method === 'GET') return json({ models: [] });
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => handler(res, body));
      return;
    }
    json({});
  });
  return server;
}
const A = makeNode('A');
const B = makeNode('B');
await Promise.all([new Promise((r) => A.listen(0, '127.0.0.1', r)), new Promise((r) => B.listen(0, '127.0.0.1', r))]);
const baseA = `http://127.0.0.1:${A.address().port}`;
const baseB = `http://127.0.0.1:${B.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(([a, b, model]) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = a;
    document.querySelector('#s-model').value = model;
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-subagents').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    document.querySelector('#node-new-name').value = 'Shop PC';
    document.querySelector('#node-new-url').value = b;
    document.querySelector('#node-add-btn').onclick();
    return document.querySelector('#s-save').onclick();
  }, [baseA, baseB, MODEL]);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  await win.evaluate(() => { document.querySelector('#prompt').value = 'make a.txt and b.txt'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Both files are in place.')), null, { timeout: 45_000 })
    .catch(() => fail('the parent task never finished'));

  // 1–2: delegation offered to the parent, children in parallel on different nodes
  const parentFirst = log.find((l) => l.who === 'parent');
  if (!parentFirst?.toolsSent.includes('delegate_tasks')) fail('delegate_tasks was not offered with two nodes enabled');
  if (!firstSeen.a || !firstSeen.b) fail(`a child never ran: ${JSON.stringify(firstSeen)}`);
  else if (firstSeen.a === firstSeen.b) fail(`both children ran on node ${firstSeen.a}; they should be spread over A and B`);
  const childReqs = log.filter((l) => l.who.startsWith('child'));
  if (childReqs.some((l) => l.toolsSent.includes('ask_user') || l.toolsSent.includes('delegate_tasks'))) fail('a subagent was offered ask_user or delegate_tasks');

  // 3: the parent sees summaries only
  const parentAfter = log.filter((l) => l.who === 'parent').at(-1)?.body;
  const toolMsg = parentAfter?.messages?.filter((m) => m.role === 'tool').at(-1)?.content || '';
  if (!/2 of 2 subtasks finished/.test(toolMsg)) fail(`delegate result: ${toolMsg.slice(0, 200)}`);
  if (!/Wrote a\.txt/.test(toolMsg) || !/Wrote b\.txt/.test(toolMsg)) fail('the summaries did not come back');
  if (!/Files changed: a\.txt/.test(toolMsg) || !/Files changed: b\.txt/.test(toolMsg)) fail('the changed files were not reported');
  if (toolMsg.includes(SECRET_A) || toolMsg.includes(SECRET_B)) fail('child tool chatter (file contents) leaked into the parent');
  if (fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') !== SECRET_A || fs.readFileSync(path.join(ws, 'b.txt'), 'utf8') !== SECRET_B) fail('the subagents did not write their files');
  const st = await win.evaluate(() => ({
    changes: [...state.conv.changes.keys()].sort(),
    kids: [...state.convs.values()].filter((x) => x.parentId === state.conv.id).map((x) => x.status),
    card: document.querySelector('.subagent-card')?.textContent || ''
  }));
  if (JSON.stringify(st.changes) !== '["a.txt","b.txt"]') fail(`parent change list: ${JSON.stringify(st.changes)}`);
  if (st.kids.length !== 2 || st.kids.some((s) => s !== 'done')) fail(`children: ${JSON.stringify(st.kids)}`);
  if (!/2 subagents working in parallel/.test(st.card) || (st.card.match(/done/g) || []).length < 2) fail(`status card: ${st.card}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ ollamaNodes: [], provider: 'custom', skillWriter: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  A.close();
  B.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`subagents smoke ok: delegate_tasks offered with 2 nodes, children ran in parallel on ${firstSeen.a} and ${firstSeen.b}, parent got summaries only, both files written and tracked`);
