// Test before done (v0.57), from a benchmark run without a planner where qwen3:8b wrote wc.js,
// stats.js and runner.html and stopped without running any of them:
//  1. a CLI script written and not run: finishing asks for a run on an example, once; running it
//     clears the gate and the task finishes;
//  2. a page written and never tested: asked twice, then the task ends with an "untested" note;
//  3. a user who said "don't run it" is not overruled.
// Run under a display: xvfb-run -a npm run test:e2e:testgate
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`TESTGATE SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=TESTGATE smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-testgate-'));
fs.writeFileSync(path.join(ws, 'sample.txt'), 'one two\nthree\n');

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
const text = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const WC = "const t = require('fs').readFileSync(process.argv[2], 'utf8');\nconst lines = t.split('\\n').filter((l, i, a) => i < a.length - 1 || l).length;\nconsole.log(lines, t.split(/\\s+/).filter(Boolean).length, t.length);\n";
const BAD_PAGE = '<!DOCTYPE html><html><body><p id="x">hi</p><script>startGame();</script></body></html>';
const GOOD_PAGE = '<!DOCTYPE html><html><body><p id="x">hi</p><script>document.getElementById("x").textContent = "ready";</script></body></html>';
const reminders = (b) => (b.messages || []).filter((m) => m.role === 'user' && /have not run (it|them) since/.test(String(m.content))).length;
let scene = 1;
let step = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"gate-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    bodies.push({ scene, b });
    const n = step++;
    if (scene === 1) {
      if (n === 0) return sse(res, call('w1', 'write_file', { path: 'wc.js', content: WC }));
      if (n === 1) return sse(res, text('wc.js is written.'));
      if (n === 2) return sse(res, call('c1', 'run_command', { command: 'node wc.js sample.txt' }));
      return sse(res, text('Ran it: 2 3 14, which matches the sample.'));
    }
    if (scene === 2) {
      if (n === 0) return sse(res, call('w2', 'write_file', { path: 'page.html', content: '<!DOCTYPE html><p id="x">hi</p>' }));
      return sse(res, text('page.html is done.'));
    }
    if (scene === 3) {
      if (n === 0) return sse(res, call('w3', 'write_file', { path: 'tool.js', content: 'console.log(process.argv[2]);\n' }));
      return sse(res, text('Wrote tool.js as asked, not run.'));
    }
    if (scene === 4) {
      // a failing test does not end the task; after the fix, a passing test does
      if (n === 0) return sse(res, call('w4', 'write_file', { path: 'game.html', content: BAD_PAGE }));
      if (n === 1) return sse(res, call('t4', 'test_app', { command: 'game.html' }));
      if (n === 2) return sse(res, text('game.html is done.'));
      if (n === 3) return sse(res, call('r4', 'read_file', { path: 'game.html' }));
      if (n === 4) return sse(res, call('w5', 'write_file', { path: 'game.html', content: GOOD_PAGE }));
      if (n === 5) return sse(res, call('t5', 'test_app', { command: 'game.html' }));
      return sse(res, text('game.html works now: the test passed.'));
    }
    if (scene === 5) {
      // a JSON file left broken is fixed before finishing
      if (n === 0) return sse(res, call('r6', 'read_file', { path: 'config.json' }));
      if (n === 1) return sse(res, call('e6', 'edit_file', { path: 'config.json', old_text: "'name': \"shop\",", new_text: '"name": "shop",' }));
      if (n === 2) return sse(res, text('Fixed config.json.'));
      if (n === 3) return sse(res, call('w6', 'write_file', { path: 'config.json', content: '{\n  "name": "shop",\n  "port": 8080\n}\n' }));
      return sse(res, text('config.json parses now.'));
    }
    // scene 6: an unrelated failing command after a passing test does not block the finish
    if (n === 0) return sse(res, call('w7', 'write_file', { path: 'hello.js', content: 'console.log("hello " + process.argv[2]);\n' }));
    if (n === 1) return sse(res, call('c7', 'run_command', { command: 'node hello.js you' }));
    if (n === 2) return sse(res, call('c8', 'run_command', { command: 'node -e "process.exit(3)"' }));
    return sse(res, text('hello.js prints hello you.'));
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
const run = async (prompt, done) => {
  await win.evaluate((p) => { newChat(); document.querySelector('#prompt').value = p; document.querySelector('#btn-send').onclick(); }, prompt);
  await win.waitForFunction((d) => !state.conv.busy && [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(d)), done, { timeout: 60_000 })
    .catch(() => fail(`scene ${scene} never finished`));
  return win.evaluate(() => (state.conv.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
};

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  saved = await win.evaluate(() => api.getSettings());
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'gate-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    document.querySelector('#s-checksGate').checked = false;
    document.querySelector('#s-testBeforeDone').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1. CLI written, asked to test once, runs it, finishes
  const n1 = await run('make wc.js that counts lines, words and characters', 'matches the sample');
  const s1 = bodies.filter((x) => x.scene === 1).map((x) => x.b);
  const asked = s1[2]?.messages?.find((m) => m.role === 'user' && /have not run it since/.test(String(m.content)))?.content || '';
  if (!/You changed wc\.js but have not run it since[\s\S]*node wc\.js <example input>[\s\S]*work out the right answer/.test(asked)) fail(`no test reminder for wc.js: ${String(asked).slice(0, 300)}`);
  if (reminders(s1.at(-1)) !== 1) fail(`scene 1 should ask once, asked ${reminders(s1.at(-1))} times`);
  if (!n1.some((t) => /wc\.js changed but not run yet — asking Qwen to test before finishing/.test(t))) fail(`no notice in scene 1: ${n1.join(' | ')}`);
  if (s1.length !== 4) fail(`scene 1 should take 4 requests, took ${s1.length}`);

  // 2. page never tested: asked twice, then ends as untested
  scene = 2;
  step = 0;
  const n2 = await run('make page.html', 'page.html is done.');
  const s2 = bodies.filter((x) => x.scene === 2).map((x) => x.b);
  if (s2.length !== 4) fail(`scene 2 should take 4 requests (write, done, done, done), took ${s2.length}`);
  if (!(s2.at(-1)?.messages || []).some((m) => /call test_app with "page\.html"/.test(String(m.content)))) fail('the page reminder should name test_app');
  if (!n2.some((t) => /Finished without running the changes to page\.html — they are untested\./.test(t))) fail(`no untested note: ${n2.join(' | ')}`);

  // 3. "don't run it"
  scene = 3;
  step = 0;
  await run("write tool.js that prints its first argument, but don't run it", 'not run.');
  const s3 = bodies.filter((x) => x.scene === 3).map((x) => x.b);
  if (s3.length !== 2) fail(`scene 3 should not be pushed back: ${s3.length} requests`);
  // 4. a failing test blocks the finish until it passes
  scene = 4;
  step = 0;
  const n4 = await run('make game.html', 'the test passed.');
  const s4 = bodies.filter((x) => x.scene === 4).map((x) => x.b);
  const failAsk = (s4[3]?.messages || []).find((m) => m.role === 'user' && /Your last test failed/.test(String(m.content)))?.content || '';
  if (!/Your last test failed — test_app game\.html: .*startGame is not defined/.test(failAsk)) fail(`no failing-test reminder: ${String(failAsk).slice(0, 300)}`);
  if (!n4.some((t) => /The last test failed \(test_app game\.html\) — asking Qwen to fix it before finishing/.test(t))) fail(`no failing-test notice: ${n4.join(' | ')}`);
  if (s4.length !== 7) fail(`scene 4 should take 7 requests, took ${s4.length}`);
  if (n4.some((t) => /Finished with a failing test/.test(t))) fail('scene 4 ended with a failing test');

  // 5. a JSON file still broken is fixed before finishing
  scene = 5;
  step = 0;
  fs.writeFileSync(path.join(ws, 'config.json'), "{\n  'name': \"shop\",\n  \"port\": 8080,\n}\n");
  const n5 = await run('config.json is broken, fix it', 'parses now.');
  const s5 = bodies.filter((x) => x.scene === 5).map((x) => x.b);
  const brokenAsk = (s5[3]?.messages || []).find((m) => m.role === 'user' && /still has a syntax error/.test(String(m.content)))?.content || '';
  if (!/config\.json still has a syntax error[\s\S]*config\.json line \d+:/.test(brokenAsk)) fail(`no broken-file reminder: ${String(brokenAsk).slice(0, 300)}`);
  if (!n5.some((t) => /config\.json still has a syntax error — asking Qwen to fix it before finishing/.test(t))) fail(`no broken-file notice: ${n5.join(' | ')}`);
  try {
    JSON.parse(fs.readFileSync(path.join(ws, 'config.json'), 'utf8'));
  } catch (e) {
    fail(`config.json still broken: ${e.message}`);
  }
  if (s5.length !== 5) fail(`scene 5 should take 5 requests, took ${s5.length}`);

  // 6. an unrelated failing command does not count as a failed test
  scene = 6;
  step = 0;
  const n6 = await run('make hello.js', 'prints hello you.');
  const s6 = bodies.filter((x) => x.scene === 6).map((x) => x.b);
  if (s6.length !== 4) fail(`scene 6 should not be pushed back: ${s6.length} requests`);
  if (n6.some((t) => /last test failed|Finished with a failing test/.test(t))) fail(`an unrelated command blocked the finish: ${n6.join(' | ')}`);
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
console.log('testgate smoke ok: an unrun CLI script was tested after one reminder, an untested page was asked twice then marked untested, "don\'t run it" was respected, a failing test blocked the finish until it passed, a broken JSON file was fixed before finishing, an unrelated failing command did not block');
