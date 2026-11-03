// Small-model hardening smoke test (ideas from Strata, github.com/Niko1221/Strata):
//  1. the model writes its tool call INSIDE its thinking and answers nothing — the app runs it;
//  2. the model garbles a tool name ("Write-File") — the app repairs it;
//  3. the model's thinking loops — the app aborts the stream, pushes it to act, and the task
//     finishes instead of burning the step.
// Run under a display: xvfb-run -a npm run test:e2e:hardening
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`HARDENING SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=HARDENING smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-hard-'));
const frame = (res, e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
const end = (res, finish) => {
  frame(res, { choices: [{ delta: {}, finish_reason: finish }] });
  res.write('data: [DONE]\n\n');
  res.end();
};

let turns = 0;
const bodies = [];
let loopStreamCut = false;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"hard-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const n = ++turns;
    bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (n === 1) {
      // The call lives in the thinking; the answer is empty.
      frame(res, { choices: [{ delta: { reasoning_content: 'I will create the file now.\n\n<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "rescued\\n"}}\n</tool_call>' }, finish_reason: null }] });
      return end(res, 'stop');
    }
    if (n === 2) {
      frame(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'h2', type: 'function', function: { name: 'Write-File', arguments: JSON.stringify({ path: 'b.txt', content: 'repaired\n' }) } }] }, finish_reason: null }] });
      return end(res, 'tool_calls');
    }
    if (n === 3) {
      // Thinking in circles: the same verification pass, streamed until the client gives up.
      let i = 0;
      res.on('close', () => { if (i < 600) loopStreamCut = true; });
      const tick = () => {
        if (res.writableEnded || res.destroyed) return;
        if (i >= 600) return end(res, 'stop');
        frame(res, { choices: [{ delta: { reasoning_content: `Wait, let me double check that a.txt and b.txt really exist before I answer, just to be sure. ` }, finish_reason: null }] });
        i++;
        setTimeout(tick, 2);
      };
      return tick();
    }
    frame(res, { choices: [{ delta: { content: body.includes('repeating itself in circles') ? 'All done: a.txt and b.txt exist.' : 'loop reminder missing' }, finish_reason: null }] });
    return end(res, 'stop');
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
    document.querySelector('#s-model').value = 'hard-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'make a.txt and b.txt';
    document.querySelector('#btn-send').onclick();
  });

  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('All done')), null, { timeout: 45_000 })
    .catch(() => fail('the task never finished'));

  const a = path.join(ws, 'a.txt');
  if (!fs.existsSync(a) || !fs.readFileSync(a, 'utf8').includes('rescued')) fail('the tool call written inside the thinking was never run');
  if (!fs.existsSync(path.join(ws, 'b.txt'))) fail('the garbled tool name "Write-File" was not repaired');
  if (!loopStreamCut) fail('the looping thinking was streamed to the end instead of being cut off');
  if (turns !== 4) fail(`expected 4 model turns (rescue, repair, loop, finish), saw ${turns}`);
  const story = await win.evaluate(() => ({
    notices: (state.conv.display || []).filter((d) => d.t === 'notice').map((d) => d.text),
    log: (state.conv.log || []).filter((e) => e.kind === 'notice').map((e) => e.text),
    aborted: (state.conv.log || []).filter((e) => e.kind === 'response' && e.aborted),
    report: DebugLog.render({ conv: state.conv, settings: state.settings, appInfo: state.appInfo, nodeHealth: {}, mcp: [], systemPrompt: '' })
  }));
  if (story.aborted.length !== 1 || story.aborted[0].by !== 'loop') fail(`the loop abort should be logged as the loop watch's: ${JSON.stringify(story.aborted)}`);
  if (!/STOPPED by the reasoning-loop watch[\s\S]*last thinking: …/.test(story.report) || /the user clicked Stop/.test(story.report)) fail('the debug report mislabels the loop abort as a user Stop');
  if (!story.notices.some((t) => /going in circles/.test(t))) fail(`no loop notice; notices: ${JSON.stringify(story.notices)}`);
  if (!story.log.some((t) => /rescued 1 tool call/.test(t))) fail('the rescue is missing from the debug log');
  if (!story.log.some((t) => /repaired tool name "Write-File" → write_file/.test(t))) fail('the name repair is missing from the debug log');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
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
console.log(`hardening smoke ok: call rescued from the thinking, "Write-File" repaired, looping thinking cut off and the task finished (${turns} turns)`);
