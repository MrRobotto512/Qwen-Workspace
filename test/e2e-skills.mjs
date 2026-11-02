// Self-written skills smoke test (an idea from Hermes Agent's agent-managed skills + curator).
//  1. An 8-step task that worked → the teacher drafts a SKILL.md → a card; Save writes it to the
//     personal skills folder, marked as written by QWS.
//  2. A new conversation doing the same thing → the teacher's draft matches the saved skill, so
//     no second card.
//  3. A task that loads the skill → its use is counted, and no proposal (a skill already covered it).
//  4. The curator: 31 idle days → stale, 61 → archived (gone from the list), Restore brings it back;
//     Settings shows the "written by QWS" badge.
// Run under a display: xvfb-run -a npm run test:e2e:skills
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`SKILLS SMOKE FAIL: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=SKILLS smoke::${String(msg).replace(/\n/g, ' ').slice(0, 800)}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-skills-'));
const NAME = 'scaffold-numbered-notes';
const DRAFT = `---\nname: ${NAME}\ndescription: Scaffold a set of numbered note files in a project\n---\n# Scaffold numbered notes\n\n## Steps\n1. Write f1.txt through f8.txt with write_file, one per call.\n2. Confirm each write before the next.\n\n## Pitfalls\n- Do not batch them into one file.\n`;
const DAY = 86400000;

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const text = (t) => [{ choices: [{ delta: { content: t }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

let teacherCalls = 0;
let seq = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":[{"id":"skills-mock"}]}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const b = JSON.parse(body);
    const msgs = b.messages || [];
    if (String(msgs[0]?.content || '').includes('You write reusable skills')) {
      teacherCalls++;
      return sse(res, text(DRAFT));
    }
    // Stateless task script: from the last real user message, write f1..f8, then answer.
    let start = 0;
    msgs.forEach((m, i) => { if (m.role === 'user' && !String(m.content || '').startsWith('<system-reminder>')) start = i; });
    const ask = String(msgs[start]?.content || '');
    const after = msgs.slice(start + 1);
    const loaded = after.some((m) => (m.tool_calls || []).some((tc) => tc.function?.name === 'load_skill'));
    if (/use the skill/.test(ask) && !loaded) return sse(res, call(`s${++seq}`, 'load_skill', { name: NAME }));
    const writes = after.filter((m) => (m.tool_calls || []).some((tc) => tc.function?.name === 'write_file')).length;
    if (writes < 8) return sse(res, call(`w${++seq}`, 'write_file', { path: `f${writes + 1}.txt`, content: `note ${writes + 1}\n` }));
    return sse(res, text('All eight notes written.'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));
const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
const skillsDir = path.join(userData, 'skills');

const runTask = async (prompt, doneCount) => {
  await win.evaluate((t) => { document.querySelector('#prompt').value = t; document.querySelector('#btn-send').onclick(); }, prompt);
  await win.waitForFunction((n) => [...document.querySelectorAll('.msg.assistant .md')].filter((e) => e.textContent.includes('All eight notes written.')).length >= n, doneCount, { timeout: 30_000 })
    .catch(() => fail(`task "${prompt}" never finished`));
};
const mine = async () => (await win.evaluate(() => api.skillsList())).find((s) => s.name === NAME);

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate((b) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = b;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'skills-mock';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    document.querySelector('#s-heavy-enabled').checked = false;
    document.querySelector('#s-reviewPass').checked = false;
    document.querySelector('#s-planFirst').checked = false;
    document.querySelector('#s-lessonsEnabled').checked = false;
    document.querySelector('#s-skillWriter').checked = true;
    settingsNodes = settingsNodes.filter((n) => n.id === 'this-pc').map((n) => ({ ...n, enabled: true, highPerf: false }));
    return document.querySelector('#s-save').onclick();
  }, base);
  await win.evaluate(async (dir) => { await openWorkspace(dir); newChat(); }, ws);

  // --- 1. long task → card → Save
  await runTask('write the eight notes', 1);
  await win.waitForSelector('.skill-card', { timeout: 15_000 }).catch(() => fail('no skill card after an 8-step task'));
  const cardText = await win.evaluate(() => document.querySelector('.skill-card')?.textContent || '');
  if (!cardText.includes(`New skill: ${NAME}`) || !cardText.includes('Scaffold a set of numbered note files')) fail(`card text: ${cardText.slice(0, 160)}`);
  await win.evaluate(() => [...document.querySelectorAll('.skill-card button')].find((b) => b.textContent.includes('Save skill'))?.click());
  await win.waitForFunction(() => (state.conv.display || []).some((d) => d.t === 'notice' && /Saved skill/.test(d.text)), null, { timeout: 10_000 })
    .catch(() => fail('no "Saved skill" notice'));
  const file = path.join(skillsDir, NAME, 'SKILL.md');
  if (!fs.existsSync(file)) fail('SKILL.md was not written to the personal skills folder');
  else if (!/created_by: qws/.test(fs.readFileSync(file, 'utf8'))) fail('the saved skill is not marked as written by QWS');
  const s1 = await mine();
  if (s1?.createdBy !== 'qws' || s1.uses !== 0 || s1.scope !== 'user') fail(`skill list entry: ${JSON.stringify(s1)}`);

  // --- 2. a new conversation, same work → the duplicate draft is dropped
  await win.evaluate(() => newChat());
  await runTask('write the eight notes again', 1);
  await win.waitForFunction(() => !document.querySelector('#activity')?.textContent?.includes('reusable skill'), null, { timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  if (teacherCalls !== 2) fail(`expected the teacher to run twice, ran ${teacherCalls}`);
  if (await win.evaluate(() => !!document.querySelector('.skill-card'))) fail('a duplicate skill drew a second card');

  // --- 3. a task that loads the skill: use counted, no proposal
  await win.evaluate(() => newChat());
  await runTask('use the skill to write the notes', 1);
  await new Promise((r) => setTimeout(r, 1500));
  if (teacherCalls !== 2) fail(`a task that used a skill should not propose one (teacher ran ${teacherCalls} times)`);
  const s2 = await mine();
  if (s2?.uses !== 1 || !s2.lastUsed) fail(`use was not counted: ${JSON.stringify(s2)}`);

  // --- 4. curator + Settings
  const stale = await win.evaluate((t) => api.skillsCurate({ now: t, force: true }), Date.now() + 31 * DAY);
  if (!stale.stale.includes(NAME)) fail(`31 idle days should mark it stale: ${JSON.stringify(stale)}`);
  if ((await mine())?.state !== 'stale') fail('the list does not show the stale state');
  await win.evaluate(async () => { openSettings(); await renderSkillsSettings(); });
  const row = await win.evaluate((n) => [...document.querySelectorAll('#skills-list .skill-row')].find((r) => r.querySelector('.sk-name')?.textContent === n)?.textContent || '', NAME);
  if (!/written by QWS · used 1× · stale/.test(row)) fail(`Settings row: ${row}`);
  const arch = await win.evaluate((t) => api.skillsCurate({ now: t, force: true }), Date.now() + 61 * DAY);
  if (!arch.archived.includes(NAME)) fail(`61 idle days should archive it: ${JSON.stringify(arch)}`);
  if (await mine()) fail('an archived skill is still offered to the agent');
  if (!fs.existsSync(path.join(skillsDir, '.archive', NAME, 'SKILL.md'))) fail('the archived skill is not in skills/.archive');
  await win.evaluate(async () => { await renderSkillsSettings(); });
  const restoreBtn = await win.evaluate((n) => {
    const r = [...document.querySelectorAll('#skills-list .skill-row.archived')].find((x) => x.querySelector('.sk-name')?.textContent === n);
    const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent === 'Restore');
    b?.click();
    return !!b;
  }, NAME);
  if (!restoreBtn) fail('no Restore button for the archived skill');
  await win.waitForFunction(async (n) => (await api.skillsList()).some((s) => s.name === n), NAME, { timeout: 5000 }).catch(() => fail('Restore did not bring the skill back'));
  if ((await mine())?.state !== 'active') fail('a restored skill should be active again');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  try {
    fs.rmSync(path.join(skillsDir, NAME), { recursive: true, force: true });
    fs.rmSync(path.join(skillsDir, '.archive', NAME), { recursive: true, force: true });
    const idxFile = path.join(skillsDir, '.qws-index.json');
    if (fs.existsSync(idxFile)) {
      const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      delete idx.skills?.[NAME];
      idx.lastCurated = 0;
      fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
    }
  } catch {
    /* best effort */
  }
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
console.log('skills smoke ok: 8-step task drew a skill card and Save wrote it (by QWS), a duplicate draft was dropped, a skill use was counted with no proposal, curator staled → archived → restored');
