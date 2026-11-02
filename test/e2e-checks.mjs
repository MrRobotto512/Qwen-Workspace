// Model checks + polish smoke test (ideas from Strata), against a scripted Ollama node:
//  1. per-model tool-call check: good:7b passes (pong + get_weather(Paris)), bad:1b fails;
//     results are remembered for the model menu;
//  2. GPU spill: /api/ps reports good:7b at 11 of 20 GB in VRAM — a transcript warning appears;
//  3. plain-English approvals: "pip install PySide6 pytest" asks as "Install the Python packages
//     PySide6 and pytest?" with the raw command under a closed Details (rejected here);
//  4. skills used: the task that loaded the "demo" skill ends with "Skills used: demo."
// Run under a display: xvfb-run -a npm run test:e2e:checks
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`CHECKS SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=CHECKS smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-checks-'));
fs.mkdirSync(path.join(ws, '.qwen', 'skills', 'demo'), { recursive: true });
fs.writeFileSync(path.join(ws, '.qwen', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill for the checks test\n---\nUse plain Python.\n');

let streamTurns = 0;
const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const ndjson = (res, lines) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const l of lines) res.write(JSON.stringify(l) + '\n');
  res.end();
};
const toolLine = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false });
const done = { done: true, done_reason: 'stop', prompt_eval_count: 40 };

const node = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/version') return json(res, { version: '0.40.13' });
  if (req.method === 'GET' && req.url === '/api/tags') return json(res, { models: [{ name: 'good:7b' }, { name: 'bad:1b' }] });
  if (req.method === 'GET' && req.url === '/api/ps') return json(res, { models: [{ name: 'good:7b', size: 20e9, size_vram: 11e9 }] });
  if (req.method !== 'POST') return json(res, {});
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    if (b.stream === false) {
      // The tool-call check (non-streaming).
      const good = b.model === 'good:7b';
      if (b.tools?.length) return json(res, { message: good ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }] } : { role: 'assistant', content: 'It is sunny in Paris.' } });
      return json(res, { message: { role: 'assistant', content: good ? 'pong' : 'ping' } });
    }
    const n = ++streamTurns;
    if (n === 1) return ndjson(res, [toolLine('load_skill', { name: 'demo' }), done]);
    if (n === 2) return ndjson(res, [toolLine('run_command', { command: 'pip install PySide6 pytest' }), done]);
    return ndjson(res, [{ message: { role: 'assistant', content: 'All set.' }, done: false }, done]);
  });
});
await new Promise((r) => node.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${node.address().port}`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  // --- 1. per-model tool-call check, through the same function the Settings row uses
  const probes = await win.evaluate(async (b) => {
    const sub = document.createElement('div');
    const nodeRow = { id: 'node-test', baseUrl: b };
    await runModelCheck(nodeRow, b, 'good:7b', sub);
    const goodLine = sub.textContent;
    await runModelCheck(nodeRow, b, 'bad:1b', sub);
    return { goodLine, badLine: sub.textContent, checks: state.settings.modelChecks };
  }, base);
  if (!/good:7b: tool calls OK/.test(probes.goodLine)) fail(`good:7b should pass the check: ${probes.goodLine}`);
  if (!/bad:1b: NOT reliable/.test(probes.badLine) || !/did not call the tool/.test(probes.badLine)) fail(`bad:1b should fail the check: ${probes.badLine}`);
  if (!probes.checks?.['node-test|good:7b']?.ok || probes.checks?.['node-test|bad:1b']?.ok !== false) fail(`check results were not remembered: ${JSON.stringify(probes.checks)}`);

  // --- 2–4. a task on the node: skill load, a pip install to approve, the final answer
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'ollama';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-model').value = 'good:7b';
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
  await win.evaluate(() => {
    window.__card = null;
    window.__rejecter = setInterval(() => {
      for (const bar of document.querySelectorAll('.step-approval')) {
        if (bar.dataset.seen) continue;
        bar.dataset.seen = '1';
        const det = bar.querySelector('details.cmd-details');
        window.__card = { q: bar.querySelector('.q')?.textContent || '', detailsOpen: det ? det.open : null, raw: det?.querySelector('.cmd')?.textContent || '' };
        [...bar.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Reject')?.click();
      }
    }, 100);
    document.querySelector('#prompt').value = 'set up the project';
    document.querySelector('#btn-send').onclick();
  });
  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('All set.')), null, { timeout: 30_000 })
    .catch(() => fail('the task never finished'));
  const st = await win.evaluate(() => {
    clearInterval(window.__rejecter);
    return { card: window.__card, notices: (state.conv.display || []).filter((d) => d.t === 'notice').map((d) => d.text) };
  });
  if (!st.card) fail('no approval card appeared for pip install');
  else {
    if (st.card.q !== 'Install the Python packages PySide6 and pytest?') fail(`the card is not in plain English: "${st.card.q}"`);
    if (st.card.detailsOpen !== false) fail('the raw command should sit under a closed Details for a routine command');
    if (st.card.raw !== 'pip install PySide6 pytest') fail(`Details lost the raw command: "${st.card.raw}"`);
  }
  if (!st.notices.some((t) => /good:7b is running partly on the CPU: only 11 of 20 GB \(55%\)/.test(t))) fail(`no GPU-spill warning; notices: ${JSON.stringify(st.notices)}`);
  if (!st.notices.some((t) => t === 'Skills used: demo.')) fail(`no skills-used line; notices: ${JSON.stringify(st.notices)}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await win.evaluate(async () => { state.settings = await api.setSettings({ approvalMode: 'auto', modelChecks: {}, provider: 'custom' }); }).catch(() => {});
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
console.log('checks smoke ok: good:7b passed / bad:1b failed the tool-call check, GPU spill warned (11/20 GB), pip install asked in plain English, "Skills used: demo." shown');
