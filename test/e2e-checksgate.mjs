// Checks gate smoke test (an idea from Strata's test-gated attempts).
// The project's "test" is `node test.js`, which passes only while value.txt says "good".
//  1. /checks detects `npm test` from package.json; Save writes .qwen/checks.json and allows it.
//  2. A task breaks the check → the agent gets the failure back for one fix try → still broken →
//     rollback card → Roll back restores value.txt (and leaves a file edited since alone).
//  3. With the check failing beforehand, a task that fixes it → "Checks improved".
//  4. A checks.json changed outside QWS is not run until allowed again (trust card).
// Run under a display: xvfb-run -a npm run test:e2e:checksgate
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CHECKSGATE SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CHECKSGATE smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gate-'));
const at = (p) => path.join(ws, p);
fs.writeFileSync(at('package.json'), JSON.stringify({ name: 'gate-fixture', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
fs.writeFileSync(at('test.js'), "const v = require('fs').readFileSync('value.txt', 'utf8').trim();\nif (v !== 'good') { console.error(`expected good, got ${v}`); process.exit(1); }\nconsole.log('ok');\n");
fs.writeFileSync(at('value.txt'), 'good\n');
fs.writeFileSync(at('notes.txt'), 'n0\n');

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const text = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const write = (id, p, content) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
// Scripted turns, in order.
const SCRIPT = [
  () => write('t1', 'value.txt', 'bad\n'),
  () => write('t2', 'notes.txt', 'n1\n'),
  () => text('Changed the value.'),
  () => write('t3', 'value.txt', 'worse\n'), // the "fix" attempt
  () => text('Tried to fix it.'),
  () => write('t4', 'value.txt', 'good\n'), // part 3
  () => text('Fixed the value.'),
  () => text('Nothing to change.') // part 4
];
let turn = 0;
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"gate-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    bodies.push(body);
    const step = SCRIPT[turn++] || (() => text('Done.'));
    sse(res, step());
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const notices = () => win.evaluate(() => (state.conv.display || []).filter((d) => d.t === 'notice').map((d) => d.text));
const waitNotice = (re, what, timeout = 30_000) => win.waitForFunction((src) => (state.conv.display || []).some((d) => d.t === 'notice' && new RegExp(src).test(d.text)), re.source, { timeout })
  .catch(() => fail(`no notice: ${what}`));
const sendText = (t) => win.evaluate((x) => { document.querySelector('#prompt').value = x; document.querySelector('#btn-send').onclick(); }, t);
const clickIn = (sel, label) => win.evaluate(([s, l]) => {
  const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === l);
  b?.click();
  return !!b;
}, [sel, label]);
const idle = () => win.waitForFunction(() => !state.conv.busy, null, { timeout: 60_000 });

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
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
    document.querySelector('#s-checksGate').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  // This test's model rewrites files without reading them; the checks gate is what is tested here.
  await win.evaluate(async () => { state.settings = await api.setSettings({ readBeforeWrite: false }); });
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // --- 1. /checks → setup card → Save
  await sendText('/checks');
  await win.waitForSelector('.checks-setup-card', { timeout: 10_000 }).catch(() => fail('no checks setup card'));
  const setup = await win.evaluate(() => document.querySelector('.checks-setup-card pre')?.textContent || '');
  if (setup !== 'tests: npm test') fail(`detected checks: ${JSON.stringify(setup)}`);
  await clickIn('.checks-setup-card', 'Save checks');
  await waitNotice(/Checks saved to \.qwen\/checks\.json: npm test/, 'checks saved');
  if (!fs.existsSync(at('.qwen/checks.json'))) fail('.qwen/checks.json was not written');
  if (turn !== 0) fail('/checks must not reach the model');

  // --- 2. regression → fix try → rollback
  await sendText('change the value');
  await win.waitForSelector('.rollback-card', { timeout: 60_000 }).catch(() => fail('no rollback card after a failed fix attempt'));
  await idle();
  const n2 = await notices();
  if (!n2.some((t) => t === 'Checks before the task: tests ✓.')) fail(`no baseline notice: ${JSON.stringify(n2)}`);
  if (!n2.some((t) => /^Checks got worse: tests passed before this task and fails now/.test(t))) fail('no regression notice');
  if (!n2.some((t) => /^Still failing after the fix attempt: tests ✗/.test(t))) fail('no still-failing notice');
  if (!bodies[3]?.includes('Your changes broke checks') || !bodies[3]?.includes('expected good, got bad')) fail('the fix attempt did not get the failing output');
  if (fs.readFileSync(at('value.txt'), 'utf8') !== 'worse\n') fail('value.txt should still hold the failed fix before rollback');
  fs.writeFileSync(at('notes.txt'), 'user edit\n'); // edited after the task: must survive the rollback
  await clickIn('.rollback-card', 'Roll back');
  await waitNotice(/^Rolled back 1 file from the task that broke tests; left notes\.txt alone \(edited since\)/, 'rollback done');
  if (fs.readFileSync(at('value.txt'), 'utf8') !== 'good\n') fail(`value.txt not restored: ${fs.readFileSync(at('value.txt'), 'utf8')}`);
  if (fs.readFileSync(at('notes.txt'), 'utf8') !== 'user edit\n') fail('the rollback overwrote a file edited since the task');

  // --- 3. failing beforehand → task fixes it → improved
  // Break it the way a user editing in QWS would (value.txt is open in a tab after the rollback).
  await win.evaluate(async () => { await api.write('value.txt', 'bad\n'); syncOpenTab('value.txt', 'bad\n'); });
  await sendText('fix the value');
  await waitNotice(/^Checks improved: tests now passes — changes kept \(tests ✓\)/, 'checks improved');
  await idle();
  const n3 = await notices();
  if (!n3.some((t) => t === 'Checks before the task: tests ✗.')) fail('part 3 baseline should be failing');
  if (await win.evaluate(() => document.querySelectorAll('.rollback-card').length)) fail('an improvement must not offer a rollback');

  // --- 4. checks.json changed outside QWS → not run until allowed
  fs.writeFileSync(at('.qwen/checks.json'), JSON.stringify({ checks: [{ name: 'tests', command: 'node test.js' }, { name: 'evil', command: 'node -e "process.exit(0)"' }] }));
  await win.evaluate(() => newChat());
  await sendText('anything to change?');
  await win.waitForSelector('.checks-trust-card', { timeout: 15_000 }).catch(() => fail('a changed checks.json did not ask for trust'));
  await idle();
  const n4 = await notices();
  if (n4.some((t) => /^Checks before the task/.test(t))) fail('untrusted checks ran');
  await clickIn('.checks-trust-card', 'Allow checks');
  await win.waitForFunction(() => Object.values(state.settings.checksApproved || {}).some((t) => t.includes('evil')), null, { timeout: 5000 })
    .catch(() => fail('Allow did not record the new checks file'));
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ checksApproved: {}, skillWriter: true, readBeforeWrite: true }); }).catch(() => {});
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
console.log('checksgate smoke ok: /checks detected npm test, a regression got one fix try then rolled back (edited file kept), a fix reported "improved", a changed checks.json waited for trust');
