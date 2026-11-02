// Claude Code launcher smoke test: a fake `claude` binary on PATH satisfies the CLI check, a
// scripted Ollama node (version 0.20.0, qwen3-coder:30b installed) is the target, and the
// flow — node menu → model menu → confirm toast — must produce a terminal launch command that
// points ANTHROPIC_BASE_URL at the node and runs `claude --model` with the strongest model.
// Run under a display: xvfb-run -a npm run test:e2e:claudecode
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CLAUDECODE SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CLAUDECODE smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cc-'));
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cc-bin-'));
fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\nexit 0\n');
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

// The node: new enough for the Anthropic API, two models installed (one catalog, one not).
const node = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"version":"0.20.0"}');
  }
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'mystery:1b' }, { name: 'qwen3-coder:30b' }] }));
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((r) => node.listen(0, '127.0.0.1', r));
const nodeBase = `http://127.0.0.1:${node.address().port}`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const clickMenuItem = async (label) => {
  const ok = await win.waitForFunction((want) => {
    const item = [...document.querySelectorAll('#ctx-menu .mi')].find((m) => m.textContent.includes(want));
    if (!item) return false;
    item.click();
    return true;
  }, label, { timeout: 10_000 }).catch(() => null);
  if (!ok) fail(`the menu item "${label}" never appeared`);
};

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  await win.evaluate(async ([dir, base]) => {
    state.settings = await api.setSettings({
      ollamaNodes: [
        { id: 'this-pc', enabled: true },
        { id: 'node-cc', name: 'Big PC', baseUrl: base, enabled: true }
      ]
    });
    await openWorkspace(dir);
    // Capture the launch instead of opening a real terminal.
    window.__ccCmd = null;
    ccRun = (cmd) => { window.__ccCmd = cmd; return Promise.resolve({ code: 0 }); };
    claudeCodeFlow(null);
  }, [ws, nodeBase]);

  // Node menu: only Big PC qualifies (This PC points at nothing), and its row shows the version.
  await clickMenuItem('Big PC');
  // Model menu: the catalog model outranks the unknown one and comes first.
  const first = await win.waitForFunction(() => document.querySelector('#ctx-menu .mi')?.textContent || null, null, { timeout: 10_000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!first || !first.includes('qwen3-coder:30b')) fail(`the strongest model should lead the menu, saw "${first}"`);
  await clickMenuItem('qwen3-coder:30b');
  // Confirm toast.
  await win.waitForFunction(() => {
    const t = document.querySelector('#toasts .toast[data-key="cc"]');
    if (!t) return false;
    const b = [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Open terminal');
    if (!b) return false;
    b.click();
    return true;
  }, null, { timeout: 10_000 }).catch(() => fail('the confirm toast never appeared'));

  await win.waitForFunction(() => window.__ccCmd, null, { timeout: 10_000 }).catch(() => fail('the launch command was never built'));
  const cmd = await win.evaluate(() => window.__ccCmd);
  if (cmd) {
    if (!cmd.includes(`ANTHROPIC_BASE_URL=${nodeBase}`)) fail(`the command does not point at the node: ${cmd}`);
    if (!cmd.includes('ANTHROPIC_AUTH_TOKEN=ollama')) fail(`the placeholder token is missing: ${cmd}`);
    if (!cmd.includes('claude --model qwen3-coder:30b')) fail(`the model flag is missing: ${cmd}`);
    if (!cmd.includes(ws)) fail(`the workspace dir is missing: ${cmd}`);
  }
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  // Leave settings pristine for whatever suite runs next.
  await win.evaluate(async () => {
    state.settings = await api.setSettings({ ollamaNodes: [] });
    syncNodeRouting();
  }).catch(() => {});
  // Teardown watchdog: every assertion has already run by this point, so a hung
  // app.close() (a rare Playwright/Electron teardown wedge) must not eat the result.
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  node.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('claudecode smoke ok: CLI detected, node picked by health+version, strongest model first, launch command wired to the node');
