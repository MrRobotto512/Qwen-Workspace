// Craft Anything setup smoke test. A local stand-in release (QWS_CRAFT_RELEASE_BASE) serves
// SHA256SUMS.txt and a tarball whose craft-anything-cli is a fixture MCP server:
//  1. "Set up Craft Anything" downloads it, checks the checksum, unpacks it and adds the server;
//  2. a tampered download is refused;
//  3. the agent calls one of its tools and the result arrives wrapped as untrusted content,
//     with the inspection rule in the system prompt.
// Run under a display: xvfb-run -a npm run test:e2e:craft
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const fail = (msg) => {
  console.error(`CRAFT SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CRAFT smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};
if (process.platform !== 'linux') {
  console.log('craft smoke skipped: the stand-in release is a Linux tarball');
  process.exit(0);
}

const VERSION = '0.3.0';
const ASSET = `craft-anything-${VERSION}-linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.tar.gz`;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-craft-'));
const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-craft-rel-'));
const pkg = path.join(rel, `craft-anything-${VERSION}`);
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, 'craft-anything-cli'), `#!/bin/sh\nexec node ${JSON.stringify(path.resolve('test/fixtures/mcp-craft-server.cjs'))} "$@"\n`, { mode: 0o755 });
execFileSync('tar', ['-czf', path.join(rel, ASSET), '-C', rel, `craft-anything-${VERSION}`]);
const tarball = fs.readFileSync(path.join(rel, ASSET));
let tamper = false;
const sums = () => `${crypto.createHash('sha256').update(tarball).digest('hex')}  ${ASSET}\n`;

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    if (req.url === '/rel/SHA256SUMS.txt') return res.end(sums());
    if (req.url === `/rel/${ASSET}`) return res.end(tamper ? Buffer.concat([tarball, Buffer.from('x')]) : tarball);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"craft-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    bodies.push(b);
    const done = b.messages.filter((m) => m.role === 'tool').length;
    if (!done) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'mcp__craft_anything__core_file_identify', arguments: '{"path":"game.exe"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    }
    sse(res, [{ choices: [{ delta: { content: 'It is a PE32+ executable.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const root = `http://127.0.0.1:${server.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', QWS_CRAFT_RELEASE_BASE: `${root}/rel` } });
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
    document.querySelector('#s-model').value = 'craft-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, `${root}/v1`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ mcpServers: [], mcpProjectOff: {} }); state.mcp = await api.mcpReconnect(); });

  // 2. tampered first: refused, nothing added
  tamper = true;
  const bad = await win.evaluate(() => api.craftSetup());
  if (bad.ok || !/did not match the release's checksum/.test(bad.message || '')) fail(`a tampered download must be refused: ${JSON.stringify(bad)}`);
  tamper = false;

  // 1. the real button
  await win.evaluate(() => { openSettings(); document.querySelector('#craft-setup-btn').click(); });
  await win.waitForFunction(() => /Added the "Craft Anything" MCP server/.test(document.querySelector('#craft-setup-result')?.textContent || '') || /bad/.test(document.querySelector('#craft-setup-result')?.className || ''), null, { timeout: 30_000 });
  const res = await win.evaluate(() => document.querySelector('#craft-setup-result').textContent);
  if (!/checked it against SHA256SUMS\.txt/.test(res)) fail(`setup result: ${res}`);
  const cfg = await win.evaluate(() => state.settings.mcpServers.find((c) => c.name === 'Craft Anything'));
  if (!cfg || cfg.untrustedResults !== true || cfg.args.join(' ') !== 'mcp --all-tools') fail(`server entry: ${JSON.stringify(cfg)}`);
  await win.waitForFunction(() => state.mcp.some((s) => s.id === 'craft_anything' && s.status === 'ready'), null, { timeout: 20_000 })
    .catch(async () => fail(`the Craft Anything server never connected: ${JSON.stringify(await win.evaluate(() => state.mcp))}`));
  await win.evaluate(() => { document.querySelector('#s-close')?.click(); });

  // 3. its result reaches the model wrapped
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);
  await win.evaluate(() => { newChat(); document.querySelector('#prompt').value = 'what is game.exe?'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('PE32+ executable.')), null, { timeout: 30_000 });
  const t = String(bodies.at(-1).messages.find((m) => m.role === 'tool')?.content || '');
  if (!/^<web_content source="craft_anything">/.test(t)) fail(`the result is not wrapped as untrusted: ${t.slice(0, 200)}`);
  if ((t.match(/<\/web_content>/g) || []).length !== 1) fail('the result closed the wrapper early');
  if (!/Results from inspection tools \(Craft Anything\)/.test(String(bodies[0].messages[0].content))) fail('the system prompt lacks the inspection rule');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ mcpServers: [], skillWriter: true, lessonsEnabled: true }); await api.mcpReconnect(); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(rel, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('craft smoke ok: tampered download refused, setup checked the checksum, unpacked and added the server, its result arrived wrapped as untrusted with the inspection rule');
