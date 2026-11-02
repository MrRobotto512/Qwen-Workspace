// Screenshot smoke test (an idea from Hermes Agent's vision input).
//  1. A PNG pasted into the message box becomes a chip; sending it reaches an OpenAI-compatible
//     server as an image_url part, and a non-vision model name draws a hint.
//  2. A later message with a new screenshot keeps only that one; the old one becomes a note.
//  3. On Ollama's native API the screenshot rides in the message's `images` field.
// Run under a display: xvfb-run -a npm run test:e2e:vision
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`VISION SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=VISION smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vision-'));
// 1x1 PNGs (red, then blue), so the test can tell which screenshot reached the model.
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const openaiBodies = [];
const openai = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"plain-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    openaiBodies.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Seen ${openaiBodies.length}.` }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});
const ollamaBodies = [];
const ollama = http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && req.url === '/api/version') return json({ version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: 'gemma4:e4b' }] });
  if (req.method === 'GET') return json({ models: [] });
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    ollamaBodies.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Ollama saw it.' }, done: false }) + '\n');
    res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 30 }) + '\n');
    res.end();
  });
});
await Promise.all([new Promise((r) => openai.listen(0, '127.0.0.1', r)), new Promise((r) => ollama.listen(0, '127.0.0.1', r))]);
const openaiBase = `http://127.0.0.1:${openai.address().port}/v1`;
const ollamaBase = `http://127.0.0.1:${ollama.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

const configure = (provider, b, model) => win.evaluate(([p, url, m]) => {
  openSettings();
  document.querySelector('#s-provider').value = p;
  document.querySelector('#s-baseUrl').value = url;
  document.querySelector('#s-apiKey').value = '';
  document.querySelector('#s-model').value = m;
  document.querySelector('#s-agentMode').checked = false; // plain chat: one request per message
  document.querySelector('#s-heavy-enabled').checked = false;
  document.querySelector('#s-reviewPass').checked = false;
  document.querySelector('#s-planFirst').checked = false;
  document.querySelector('#s-lessonsEnabled').checked = false;
  settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
  return document.querySelector('#s-save').onclick();
}, [provider, b, model]);
// A real paste event through the message box's own handler.
const paste = (b64) => win.evaluate((data) => {
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
  document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, b64);
const send = async (text, until) => {
  await win.evaluate((t) => { document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, text);
  await win.waitForFunction((u) => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes(u)), until, { timeout: 20_000 })
    .catch(() => fail(`no reply "${until}"`));
};
const images = (body) => (body?.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await configure('custom', openaiBase, 'plain-mock');
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // --- 1. paste → chip → image_url part, plus the non-vision hint
  await paste(RED);
  await win.waitForFunction(() => document.querySelectorAll('#context-chips .image-chip').length === 1, null, { timeout: 5000 })
    .catch(() => fail('the pasted screenshot did not become a chip'));
  const hint = await win.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /may not see images/.test(t.textContent)));
  if (!hint) fail('a non-vision model name should draw the vision hint');
  await send('what is wrong in this screenshot?', 'Seen 1.');
  if (await win.evaluate(() => document.querySelectorAll('#context-chips .image-chip').length)) fail('the chip should clear once sent');
  const first = images(openaiBodies[0]);
  if (first.length !== 1 || first[0] !== `data:image/png;base64,${RED}`) fail(`turn 1 should carry the red screenshot, got ${JSON.stringify(first).slice(0, 120)}`);

  // --- 2. a new screenshot replaces the old one in later requests
  await paste(BLUE);
  await send('and this one?', 'Seen 2.');
  const second = images(openaiBodies[1]);
  if (second.length !== 1 || !second[0].endsWith(BLUE)) fail(`turn 2 should carry only the blue screenshot, got ${second.length}`);
  if (!JSON.stringify(openaiBodies[1]).includes('A screenshot was attached here earlier')) fail('the older screenshot should become a note');

  // --- 3. Ollama native API: the `images` field
  await configure('ollama', ollamaBase, 'gemma4:e4b');
  await win.evaluate(() => newChat());
  await paste(RED);
  await send('describe it', 'Ollama saw it.');
  const om = (ollamaBodies[0]?.messages || []).find((m) => m.role === 'user');
  if (!om?.images || om.images[0] !== RED) fail(`Ollama should get the screenshot in images[], got ${JSON.stringify(om?.images)?.slice(0, 80)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ provider: 'custom', agentMode: true }); }).catch(() => {});
  const watchdog = setTimeout(() => {
    console.error('app.close() hung; forcing exit with the recorded result');
    process.exit(process.exitCode || 0);
  }, 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
  openai.close();
  ollama.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('vision smoke ok: pasted screenshot sent as image_url, older one reduced to a note, Ollama got images[], non-vision hint shown');
