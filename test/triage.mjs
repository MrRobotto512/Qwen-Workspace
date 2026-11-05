// Triage: how did every recent task end, and why? Reads the app's saved conversations (their
// structured event logs — the same data "Save debug report" renders) and prints one line per
// task plus totals by cause, so a stuck app can be diagnosed from a terminal, or by pointing a
// model at the output, without anyone having to watch it fail.
//
//   npm run triage                 the last 7 days, real tasks only
//   npm run triage -- --days 30    further back
//   npm run triage -- --bench      include benchmark tasks
//   npm run triage -- --data <dir> another data folder (a copy from a different PC)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m) return [];
  const next = all[i + 1];
  return [m[1], m[2] !== undefined ? m[2] : next && !next.startsWith('--') ? next : true];
}).filter((x) => x.length));

const dataDir = args.data || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Qwen Workspace')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Qwen Workspace')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Qwen Workspace'));
const days = Number(args.days) || 7;
const since = Date.now() - days * 86_400_000;

const convDir = path.join(dataDir, 'conversations');
let index;
try {
  index = JSON.parse(fs.readFileSync(path.join(convDir, 'index.json'), 'utf8'));
} catch {
  console.error(`no conversations found under ${dataDir}`);
  process.exit(1);
}

const fmtMs = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`);

// One task's verdict: the end reason comes from the log first (it knows about loops, step limits
// and model errors), the saved status second.
function triage(c) {
  const log = c.log || [];
  const display = c.display || [];
  const responses = log.filter((e) => e.kind === 'response');
  const requests = log.filter((e) => e.kind === 'request');
  // A step's length: the response's own timing, or (older logs) the gap after its request.
  const steps = [];
  let lastReq = null;
  for (const e of log) {
    if (e.kind === 'request') lastReq = e;
    else if (e.kind === 'response') {
      steps.push(e.ms || (lastReq && e.at - lastReq.at) || 0);
      lastReq = null;
    }
  }
  const slowest = steps.length ? Math.max(...steps) : 0;
  const modelErrors = responses.filter((e) => e.ok === false).map((e) => String(e.error || ''));
  const errors = log.filter((e) => e.kind === 'error').map((e) => String(e.text || ''));
  const toolFails = log.filter((e) => e.kind === 'tool' && e.failed);
  const spill = log.find((e) => e.kind === 'notice' && /partly on the CPU/.test(e.text || ''));
  const escalations = log.filter((e) => e.kind === 'escalate');
  const loops = responses.filter((e) => e.aborted && e.by === 'loop').length;
  const stepLimit = display.some((d) => d.t === 'error' && /stopped after \d+ steps/.test(d.text || '')) || errors.some((t) => /stopped after \d+ steps/.test(t));
  const lastResponse = responses[responses.length - 1];
  const lastErr = [...modelErrors, ...errors].pop() || '';
  const lastTool = log.filter((e) => e.kind === 'tool').pop();

  let cause;
  if (stepLimit) cause = 'step limit';
  else if (lastResponse?.aborted && lastResponse.by === 'user') cause = 'stopped by user';
  else if (lastResponse?.ok === false && /timeout|BodyTimeout|HeadersTimeout/i.test(lastResponse.error || '')) cause = 'request timed out';
  else if (lastResponse?.ok === false && /connect|ECONN|ENOTFOUND|EHOSTUNREACH|socket/i.test(lastResponse.error || '')) cause = 'could not reach the model server';
  else if (lastResponse?.ok === false) cause = 'model error';
  else if (c.status === 'error') cause = 'app error';
  else if (c.status === 'stopped') cause = lastResponse?.aborted ? `aborted (${lastResponse.by || 'unknown'})` : 'stopped';
  else if (c.status === 'done' && lastTool?.failed && !responses.slice(-1)[0]?.toolCalls) cause = 'finished after a failed tool';
  else if (c.status === 'done') cause = 'done';
  else cause = c.status || 'unknown';

  const flags = [];
  if (spill) flags.push('CPU spill');
  if (loops) flags.push(`${loops} reasoning loop${loops === 1 ? '' : 's'}`);
  if (escalations.length) flags.push(`${escalations.length} escalation${escalations.length === 1 ? '' : 's'}`);
  if (toolFails.length) flags.push(`${toolFails.length} failed tool${toolFails.length === 1 ? '' : 's'}`);
  if (slowest > 120_000) flags.push(`slowest step ${fmtMs(slowest)}`);
  return { cause, flags, requests: requests.length, modelErrors, lastErr, slowest, spill: spill?.text || '', toolFails: toolFails.map((t) => `${t.name}${t.meta ? ` (${t.meta})` : ''}`) };
}

const rows = [];
for (const s of index) {
  if ((s.updatedAt || 0) < since) continue;
  const isBench = /^⏱ Benchmark/.test(s.title || '');
  if (isBench && !args.bench) continue;
  let c;
  try {
    c = JSON.parse(fs.readFileSync(path.join(convDir, `${s.id}.json`), 'utf8'));
  } catch {
    continue;
  }
  rows.push({ s, t: triage(c), isBench });
}
rows.sort((a, b) => (b.s.updatedAt || 0) - (a.s.updatedAt || 0));

console.log(`Tasks in the last ${days} days (${rows.length}${args.bench ? ', benchmark included' : ', benchmark tasks left out — add --bench'}) from ${dataDir}\n`);
for (const { s, t } of rows) {
  const when = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${when}  ${t.cause.toUpperCase().padEnd(30)} ${String(s.model || '').slice(0, 24).padEnd(24)} ${String(t.requests).padStart(3)} req  ${String(s.title || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  if (t.flags.length) console.log(`                  ${t.flags.join(' · ')}`);
  if (t.lastErr) console.log(`                  last error: ${t.lastErr.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (t.spill) console.log(`                  ${t.spill.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (t.toolFails.length) console.log(`                  failed tools: ${t.toolFails.slice(0, 6).join(', ')}`);
}

const by = {};
for (const { t } of rows) by[t.cause] = (by[t.cause] || 0) + 1;
const flagged = (re) => rows.filter(({ t }) => t.flags.some((f) => re.test(f))).length;
console.log('\nBy outcome:');
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log('\nContributing:');
console.log(`  ${String(flagged(/CPU spill/)).padStart(3)}  ran a model partly on the CPU (steps of minutes instead of seconds)`);
console.log(`  ${String(flagged(/reasoning loop/)).padStart(3)}  had the reasoning-loop watch step in`);
console.log(`  ${String(flagged(/escalation/)).padStart(3)}  needed a stronger model`);
console.log(`  ${String(flagged(/slowest step/)).padStart(3)}  had a step over 2 minutes`);
const unfinished = rows.filter(({ t }) => t.cause !== 'done').length;
console.log(`\n${rows.length - unfinished} of ${rows.length} finished on their own.`);
