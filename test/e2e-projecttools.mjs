// Per-project tools smoke test.
//  1. Safe commands (ported from Strata's gate): in Ask mode a read-only `ls -la` runs with no
//     approval card, while `node -e …` still asks.
//  2. Per-project MCP toggles: a server switched off for this project vanishes from what Qwen
//     sees (system prompt listing, status pill) and its tools refuse here, while staying
//     configured for other projects.
// Run under a display: xvfb-run -a npm run test:e2e:projecttools
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`PROJECTTOOLS SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=PROJECTTOOLS smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-ptools-'));
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const cmdTurn = (id, command) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

let turns = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"pt-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const n = ++turns;
    if (n === 1) return sse(res, cmdTurn('p1', 'ls -la'));
    if (n === 2) return sse(res, cmdTurn('p2', 'node -e "console.log(41 + 1)"'));
    return sse(res, [{ choices: [{ delta: { content: 'Listed and ran.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
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
    document.querySelector('#s-model').value = 'pt-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'ask';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // --- 1. Safe commands in Ask mode: click Run on every card, recording what asked.
  await win.evaluate(() => {
    window.__asked = [];
    window.__approver = setInterval(() => {
      for (const bar of document.querySelectorAll('.step-approval')) {
        const btn = [...bar.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run');
        if (btn && !bar.dataset.seen) {
          bar.dataset.seen = '1';
          window.__asked.push(bar.closest('.step')?.textContent || bar.textContent);
          btn.click();
        }
      }
    }, 100);
    document.querySelector('#prompt').value = 'list the folder and compute 42';
    document.querySelector('#btn-send').onclick();
  });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Listed and ran.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished'));
  const asked = await win.evaluate(() => { clearInterval(window.__approver); return window.__asked; });
  if (asked.length !== 1) fail(`expected exactly 1 approval card (for node -e), saw ${asked.length}: ${JSON.stringify(asked).slice(0, 300)}`);
  else if (!/node/.test(asked[0]) || /ls -la/.test(asked[0])) fail(`the wrong command asked: ${asked[0].slice(0, 200)}`);

  // --- 2. Per-project MCP toggle, against a stand-in server (no real MCP process needed).
  const mcp = await win.evaluate(async () => {
    state.settings = await api.setSettings({ mcpServers: [{ name: 'REA', command: 'npx', args: ['-y', 'rea-agents', 'mcp'], enabled: true }], mcpProjectOff: {} });
    state.mcp = [{ id: 'rea', status: 'ready', tools: Array.from({ length: 70 }, (_, i) => ({ name: `mcp__rea__tool_${i}`, rawName: `tool_${i}`, description: `Reverse-engineering tool ${i}.`, parameters: { type: 'object', properties: {} } })) }];
    const c = state.conv;
    c.sysPrompt = null;
    const before = systemPrompt(c).includes('mcp__rea__*');
    renderMcpStatus();
    const pillBefore = document.querySelector('#sb-mcp')?.textContent || '';
    await toggleServerHere('REA');
    c.sysPrompt = null;
    const after = systemPrompt(c).includes('mcp__rea__*');
    const pillAfter = document.querySelector('#sb-mcp')?.textContent || '';
    const refused = await executeTool(c, { function: { name: 'mcp__rea__tool_1', arguments: '{}' } }, { setBody() {}, requestApproval: async () => true });
    const stillConfigured = (state.settings.mcpServers || []).some((s) => s.name === 'REA' && s.enabled !== false);
    const offMap = state.settings.mcpProjectOff;
    await toggleServerHere('REA'); // back on
    c.sysPrompt = null;
    const restored = systemPrompt(c).includes('mcp__rea__*');
    state.mcp = [];
    state.settings = await api.setSettings({ mcpServers: [], mcpProjectOff: {} });
    return { before, after, pillBefore, pillAfter, refused: refused.result, stillConfigured, offMap, restored };
  });
  if (!mcp.before) fail('the stand-in MCP server was not listed to begin with');
  if (mcp.after) fail('the server switched off for this project is still in the system prompt');
  if (!/off here/.test(mcp.pillAfter)) fail(`the status pill doesn't say the server is off here: "${mcp.pillAfter}"`);
  if (!/switched off for this project/.test(mcp.refused)) fail(`an off server's tool still ran: ${mcp.refused}`);
  if (!mcp.stillConfigured) fail('switching a server off for one project disabled it everywhere');
  if (!Object.values(mcp.offMap || {}).some((ids) => ids.includes('rea'))) fail(`the per-project switch was not saved: ${JSON.stringify(mcp.offMap)}`);
  if (!mcp.restored) fail('switching the server back on did not bring its tools back');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ approvalMode: 'auto' }); }).catch(() => {});
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
console.log('projecttools smoke ok: read-only ls ran without a card in Ask mode, node -e asked; MCP server off for this project vanished from the prompt and refused, stayed configured globally');
