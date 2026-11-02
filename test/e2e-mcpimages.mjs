// MCP images smoke test (from gimp-mcp, whose agent loop verifies each edit with an image).
// A real stdio MCP server (test/fixtures/mcp-image-server.cjs) returns a caption + a PNG:
//  1. a vision-named model calls it → the next request carries the PNG as an image part, the tool
//     result says "[image 1: image/png]", and the tool row shows the picture;
//  2. a text-only model calls it → no image is sent, and the result says the model can't see it.
// Run under a display: xvfb-run -a npm run test:e2e:mcpimages
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`MCPIMAGES SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=MCPIMAGES smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-mcpimg-'));
const fixture = path.resolve('test/fixtures/mcp-image-server.cjs');
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const snap = (id) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'mcp__snap__get_state_snapshot', arguments: '{"max_size":256}' } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];
const bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"gemma4-mock"},{"id":"plain-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    bodies.push(b);
    const hasTool = b.messages.some((m) => m.role === 'tool');
    sse(res, hasTool ? say(`Seen by ${b.model}.`) : snap(`s${bodies.length}`));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const configure = (model) => win.evaluate(([b, m]) => {
  openSettings();
  document.querySelector('#s-provider').value = 'custom';
  document.querySelector('#s-baseUrl').value = b;
  document.querySelector('#s-apiKey').value = '';
  document.querySelector('#s-model').value = m;
  document.querySelector('#s-agentMode').checked = true;
  document.querySelector('#s-approvalMode').value = 'auto';
  document.querySelector('#s-heavy-enabled').checked = false;
  document.querySelector('#s-reviewPass').checked = false;
  document.querySelector('#s-planFirst').checked = false;
  document.querySelector('#s-lessonsEnabled').checked = false;
  document.querySelector('#s-skillWriter').checked = false;
  settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
  return document.querySelector('#s-save').onclick();
}, [base, model]);
const run = async (prompt, until) => {
  await win.evaluate((t) => { newChat(); document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, prompt);
  await win.waitForFunction((u) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(u)), until, { timeout: 30_000 })
    .catch(() => fail(`no reply "${until}"`));
};
const lastTool = (b) => b.messages.filter((m) => m.role === 'tool').at(-1)?.content || '';
const imageParts = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await configure('gemma4-mock');
  await win.evaluate(async (f) => {
    state.settings = await api.setSettings({ mcpServers: [{ name: 'snap', command: 'node', args: [f], enabled: true }], mcpProjectOff: {} });
    state.mcp = await api.mcpReconnect();
    renderMcpStatus();
  }, fixture);
  await win.waitForFunction(() => state.mcp.some((s) => s.id === 'snap' && s.status === 'ready' && s.tools.length === 1), null, { timeout: 20_000 })
    .catch(async () => fail(`the fixture MCP server never connected: ${JSON.stringify(await win.evaluate(() => state.mcp))}`));
  await win.evaluate(async (dir) => { await openWorkspace(dir); }, ws);

  // 1. vision model sees it
  await run('show me the image', 'Seen by gemma4-mock.');
  const v = bodies.find((b) => b.model === 'gemma4-mock' && b.messages.some((m) => m.role === 'tool'));
  if (!v) fail('the vision model never got the tool result');
  else {
    if (!lastTool(v).includes('Snapshot of image 0') || !lastTool(v).includes('[image 1: image/png]')) fail(`tool result: ${lastTool(v).slice(0, 200)}`);
    const parts = imageParts(v);
    if (parts.length !== 1 || parts[0].image_url.url !== `data:image/png;base64,${RED}`) fail(`the MCP image did not reach the model: ${JSON.stringify(parts).slice(0, 160)}`);
  }
  if (!(await win.evaluate(() => document.querySelectorAll('.step-shot').length))) fail('the tool row does not show the image');

  // 2. text-only model is told instead
  await configure('plain-mock');
  await run('show me the image again', 'Seen by plain-mock.');
  const t = bodies.find((b) => b.model === 'plain-mock' && b.messages.some((m) => m.role === 'tool'));
  if (!t) fail('the text model never got the tool result');
  else {
    if (imageParts(t).length) fail('an image was sent to a text-only model');
    if (!/does not look able to see images/.test(lastTool(t))) fail(`the text model was not told about the image: ${lastTool(t).slice(0, 200)}`);
  }
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ mcpServers: [], skillWriter: true }); await api.mcpReconnect(); }).catch(() => {});
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
console.log('mcpimages smoke ok: a real MCP server\'s PNG reached the vision model as an image part and showed in the tool row; the text-only model was told instead');
