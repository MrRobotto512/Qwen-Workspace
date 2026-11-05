// GPU-fit prediction smoke test (LM Studio's "estimate before loading" idea, for Ollama).
// A scripted Ollama reports a qwen3:14b-shaped model (40 layers, 8 KV heads, 128-dim heads,
// 9.3 GB file); this machine's GPU is known to hold 12 GB. With a 32K context window:
//  1. by default the app acts: before the first request goes out, the window is lowered to the
//     largest size that fits (9216), the transcript says so, the request asks for num_ctx 9216,
//     and no spill warning follows (the model then fits);
//  2. with "Fit the context window to the GPU on its own" off, the old path: a heads-up while
//     the slow first step runs, with a "Fit to GPU (N)" button that sets the window for the
//     next request.
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
  // What Ollama holds depends on the window the last request asked for: at 32K the model spills
  // (11.4 of 15.2 GB in VRAM); at a fitted window it is all in VRAM.
  if (req.method === 'GET' && req.url === '/api/ps') {
    const ctx = bodies.at(-1)?.options?.num_ctx || 32768;
    // Above the fitted window it spills (so with auto-fit off, the spill check after the slow
    // step really sees a spill, and must not repeat the heads-up).
    return json(res, { models: ctx > 9216 ? [{ name: 'fit:14b', size: 15.2e9, size_vram: 11.4e9, context_length: ctx }] : [{ name: 'fit:14b', size: 10.8e9, size_vram: 10.8e9, context_length: ctx }] });
  }
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
      res.write(JSON.stringify({ message: { role: 'assistant', content: n === 1 ? 'First done.' : n === 2 ? 'Second done.' : 'Third done.' }, done: false }) + '\n');
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 3 }) + '\n');
      res.end();
    }, n <= 2 ? 3000 : 10);
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

let userAuto = true;
try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  userAuto = await win.evaluate(() => state.settings.fitToGpuAuto !== false);
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

  // 1. on its own: the window is fitted before the first request goes out
  await win.evaluate(() => { document.querySelector('#prompt').value = 'hello'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('First done.')), null, { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 800));
  const auto = (await notices()).find((t) => /^fit:14b with a 32768-token context window/.test(t)) || '';
  const m1 = /needs about ([\d.]+) GB, but this PC's GPU has about 12 GB .* Context window set to (\d+) so all of it fits/.exec(auto);
  if (!m1 || m1[1] !== '15.2' || m1[2] !== '9216') fail(`auto-fit notice: ${auto || (await notices()).join(' | ')}`);
  if (bodies[0]?.options?.num_ctx !== 9216) fail(`the first request should already ask for num_ctx 9216, asked for ${bodies[0]?.options?.num_ctx}`);
  if (await win.evaluate(() => state.settings.contextLength) !== 9216) fail('the setting did not change');
  if ((await notices()).some((t) => /partly on the CPU/.test(t) && !/^fit:14b with a 32768/.test(t))) fail(`a spill warning followed the fit: ${(await notices()).join(' | ')}`);
  if (shows !== 1) fail(`expected one /api/show lookup, saw ${shows}`);

  // 2. switched off: the heads-up with the button, as before
  await win.evaluate(async () => { state.settings = await api.setSettings({ fitToGpuAuto: false, contextLength: 30720 }); newChat(); });
  await win.evaluate(() => { document.querySelector('#prompt').value = 'again'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => state.conv.busy && state.conv.display.some((d) => d.t === 'notice' && /^Heads-up: fit:14b/.test(d.text)), null, { timeout: 2500 })
    .catch(() => fail('no heads-up while the second task first step was still running'));
  const heads = (await notices()).find((t) => /^Heads-up/.test(t)) || '';
  const m = /needs about ([\d.]+) GB, but this PC's GPU has about 12 GB .* Fit to GPU sets "Context window" to (\d+)/.exec(heads);
  if (!m || m[1] !== '14.8') fail(`heads-up text: ${heads}`);
  const fitCtx = Number(m?.[2]);
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Second done.')), null, { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 800));
  if ((await notices()).some((t) => /is running partly on the CPU/.test(t))) fail('the spill warning repeated the heads-up');
  if (shows !== 2) fail(`expected two /api/show lookups, saw ${shows}`);
  const clicked = await win.evaluate((n) => {
    const b = [...document.querySelectorAll('#toasts button')].find((x) => x.textContent.trim() === `Fit to GPU (${n})`);
    b?.click();
    return !!b;
  }, fitCtx);
  if (!clicked) fail(`no "Fit to GPU (${fitCtx})" button`);
  await win.waitForFunction((n) => state.settings.contextLength === n, fitCtx, { timeout: 5000 }).catch(() => fail('Fit to GPU did not set the context window'));
  await win.evaluate(() => { document.querySelector('#prompt').value = 'third'; document.querySelector('#btn-send').onclick(); });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Third done.')), null, { timeout: 15_000 });
  if (bodies.at(-1)?.options?.num_ctx !== fitCtx) fail(`next request num_ctx ${bodies.at(-1)?.options?.num_ctx}, expected ${fitCtx}`);
  console.log(`  (auto: 15.2 GB at 32K → 9216 before the first request; by hand: heads-up at 30K, Fit to GPU → ${fitCtx})`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async (auto) => { state.settings = await api.setSettings({ provider: 'custom', contextLength: 32768, nodeVram: {}, agentMode: true, fitToGpuAuto: auto, fitAuto: null, fitAutoSkip: null }); }, userAuto).catch(() => {});
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
console.log('gpufit smoke ok: the window was fitted on its own before the first request (15.2 GB of 12 → 9216), and with that off the heads-up and its Fit to GPU button still work');
