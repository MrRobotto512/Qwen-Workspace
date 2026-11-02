// GPU-fit prediction smoke test (LM Studio's "estimate before loading" idea, for Ollama).
// A scripted Ollama reports a qwen3:14b-shaped model (40 layers, 8 KV heads, 128-dim heads,
// 9.3 GB file); this machine's GPU is known to hold 12 GB. With a 32K context window:
//  1. while the first (slow) step is still running, a heads-up says it needs ~15.2 GB and
//     offers "Fit to GPU (N)"; the spill warning after the step does not repeat it;
//  2. Fit to GPU sets the context window, and the next request asks for num_ctx N.
// Run under a display: xvfb-run -a npm run test:e2e:gpufit
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`GPUFIT SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=GPUFIT smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-fit-'));
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const INFO = { 'general.architecture': 'qwen3', 'qwen3.block_count': 40, 'qwen3.attention.head_count': 40, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128 };
const bodies = [];
let shows = 0;
const node = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'fit:14b', size: 9.3e9 }] });
  if (req.method === 'GET' && req.url === '/api/ps') return json(res, { models: [{ name: 'fit:14b', size: 15.2e9, size_vram: 11.4e9, context_length: 32768 }] });
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url === '/api/show') {
      shows++;
      return json(res, { model_info: INFO });
    }
    if (req.url !== '/api/chat') return json(res, {}); // e.g. the warm-up /api/generate
    const b = JSON.parse(body || '{}');
    bodies.push(b);
    const n = bodies.length;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: n === 1 ? 'First done.' : 'Second done.' }, done: false }) + '\n');
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 3 }) + '\n');
      res.end();
    }, n === 1 ? 3000 : 10);
  });
});
await new Promise((r) => node.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${node.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const notices = () => win.evaluate(() => state.conv.display.filter((d) => d.t === 'notice').map((d) => d.text));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-model').value = 'fit:14b';
    document.querySelector('#s-contextLength').value = '32768';
    document.querySelector('#s-agentMode').checked = false;
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  // What a spill on this machine taught QWS earlier: its GPU holds 12 GB.
  await win.evaluate(async (b) => { state.settings = await api.setSettings({ nodeVram: { [b]: 12e9 } }); }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => { document.querySelector('#prompt').value = 'hello'; document.querySelector('#btn-send').onclick(); });

  // 1. the heads-up arrives while the step still runs
  await win.waitForFunction(() => state.conv.busy && state.conv.display.some((d) => d.t === 'notice' && /^Heads-up: fit:14b/.test(d.text)), null, { timeout: 2500 })
    .catch(() => fail('no heads-up while the first step was still running'));
  const heads = (await notices()).find((t) => /^Heads-up/.test(t)) || '';
  const m = /needs about ([\d.]+) GB, but this PC's GPU has about 12 GB .* Fit to GPU sets "Context window" to (\d+)/.exec(heads);
  if (!m || m[1] !== '15.2') fail(`heads-up text: ${heads}`);
  const fitCtx = Number(m?.[2]);
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('First done.')), null, { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 800));
  const after = await notices();
  if (after.some((t) => /is running partly on the CPU/.test(t))) fail('the spill warning repeated the heads-up');
  if (shows !== 1) fail(`expected one /api/show lookup, saw ${shows}`);

  // 2. Fit to GPU takes effect on the next request
  const clicked = await win.evaluate((n) => {
    const b = [...document.querySelectorAll('#toasts button')].find((x) => x.textContent.trim() === `Fit to GPU (${n})`);
    b?.click();
    return !!b;
  }, fitCtx);
  if (!clicked) fail(`no "Fit to GPU (${fitCtx})" button`);
  await win.waitForFunction((n) => state.settings.contextLength === n, fitCtx, { timeout: 5000 }).catch(() => fail('Fit to GPU did not set the context window'));
  await win.evaluate(() => { document.querySelector('#prompt').value = 'again'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Second done.')), null, { timeout: 15_000 });
  if (bodies.at(-1)?.options?.num_ctx !== fitCtx) fail(`next request num_ctx ${bodies.at(-1)?.options?.num_ctx}, expected ${fitCtx}`);
  console.log(`  (predicted 15.2 GB at 32K; Fit to GPU → ${fitCtx})`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ provider: 'custom', contextLength: 32768, nodeVram: {}, agentMode: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  node.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('gpufit smoke ok: heads-up before the slow first step finished (needs ~15.2 GB of 12), no duplicate spill warning, Fit to GPU set num_ctx on the next request');
